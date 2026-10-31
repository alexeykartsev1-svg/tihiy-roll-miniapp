from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import logging
import os
import sqlite3
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime
from typing import Any
from urllib.parse import parse_qsl

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("tihiy-roll-api")

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
ADMIN_CHAT_ID = os.getenv("ADMIN_CHAT_ID", "").strip()
MAX_INIT_DATA_AGE_SECONDS = int(os.getenv("MAX_INIT_DATA_AGE_SECONDS", "86400"))
ALLOWED_ORIGINS = [
    value.strip().rstrip("/")
    for value in os.getenv(
        "ALLOWED_ORIGINS",
        "https://alexeykartsev1-svg.github.io",
    ).split(",")
    if value.strip()
]

# The server, not the browser, is authoritative for names and prices.
MENU: dict[str, dict[str, Any]] = {
    "philadelphia": {"name": "Филадельфия", "price": 450},
    "lava": {"name": "Лава", "price": 350},
    "warm_crab": {"name": "Тёплый краб", "price": 350},
    "warm_salmon": {"name": "Тёплый лосось", "price": 450},
    "california": {"name": "Калифорния", "price": 390},
    "unagi": {"name": "Унаги", "price": 460},
}

app = FastAPI(title="Тихий ролл — заказ API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-Telegram-Init-Data"],
    max_age=600,
)


class OrderItem(BaseModel):
    # Normalize common client formats before validation; prices are always read from MENU.
    model_config = ConfigDict(extra="ignore")
    id: str = Field(min_length=1, max_length=40)
    qty: int = Field(ge=1, le=99)

    @model_validator(mode="before")
    @classmethod
    def normalize_item(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        row = dict(value)
        if "id" not in row:
            for alias in ("product_id", "productId", "key"):
                if alias in row:
                    row["id"] = row[alias]
                    break
        if "qty" not in row:
            for alias in ("quantity", "count"):
                if alias in row:
                    row["qty"] = row[alias]
                    break
        item_id = row.get("id")
        # IDs used in earlier versions of the Mini App.
        item_id = {"p": "philadelphia", "l": "lava", "c": "warm_crab", "s": "warm_salmon"}.get(item_id, item_id)
        return {"id": item_id, "qty": row.get("qty")}


class OrderPayload(BaseModel):
    # Accept common field spellings from previously published Mini App builds.
    model_config = ConfigDict(extra="ignore")
    init_data: str = Field(min_length=1, max_length=10000)
    client_order_id: str = Field(min_length=8, max_length=80)
    name: str = Field(min_length=1, max_length=100)
    phone: str = Field(min_length=5, max_length=50)
    time: str = Field(min_length=2, max_length=100)
    notes: str = Field(default="", max_length=1000)
    items: list[OrderItem] = Field(min_length=1, max_length=20)

    @model_validator(mode="before")
    @classmethod
    def normalize_legacy_payload(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        # Some earlier builds wrapped the form fields inside an `order` object.
        if isinstance(data.get("order"), dict):
            wrapped = dict(data.pop("order"))
            wrapped.update(data)
            data = wrapped
        aliases = {
            "init_data": ("init_data", "initData", "telegram_init_data", "telegramInitData"),
            "client_order_id": ("client_order_id", "clientOrderId", "order_id", "orderId", "idempotency_key"),
            "name": ("name", "customer_name", "customerName"),
            "phone": ("phone", "phone_number", "phoneNumber", "telephone"),
            "time": ("time", "pickup_time", "pickupTime", "desired_time"),
            "notes": ("notes", "comment", "order_notes"),
            "items": ("items", "cart", "order_items", "orderItems"),
        }
        normalized: dict[str, Any] = {}
        for field, keys in aliases.items():
            for key in keys:
                if key in data and data[key] is not None:
                    normalized[field] = data[key]
                    break
        # Some old carts were serialized as {product_id: quantity}; normalize to a list.
        if isinstance(normalized.get("items"), dict):
            normalized["items"] = [
                {"id": item_id, "qty": quantity}
                for item_id, quantity in normalized["items"].items()
                if quantity is not None
            ]
        # Old site builds may omit an idempotency key. Generate one server-side;
        # this does not weaken Telegram initData signature verification.
        if not normalized.get("client_order_id"):
            normalized["client_order_id"] = str(uuid.uuid4())
        return normalized

    @field_validator("name", "phone", "time")
    @classmethod
    def trim_text(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Поле не может быть пустым")
        if any(ord(ch) < 32 and ch not in "\t" for ch in cleaned):
            raise ValueError("Недопустимые управляющие символы")
        return cleaned

    @field_validator("client_order_id")
    @classmethod
    def check_order_id(cls, value: str) -> str:
        # Accept UUIDs generated by crypto.randomUUID and the fallback format.
        try:
            return str(uuid.UUID(value))
        except (ValueError, AttributeError):
            if not all(ch.isalnum() or ch in "-_" for ch in value):
                raise ValueError("Некорректный идентификатор заказа")
            return value


def verify_telegram_init_data(raw_init_data: str, bot_token: str, now: int | None = None) -> dict[str, Any]:
    """Verify Telegram Mini App initData per Telegram's HMAC-SHA-256 algorithm."""
    if not raw_init_data or len(raw_init_data) > 10000:
        raise ValueError("Отсутствуют данные авторизации Telegram")

    pairs = parse_qsl(raw_init_data, keep_blank_values=True, strict_parsing=True)
    data: dict[str, str] = {}
    for key, value in pairs:
        if key in data:
            raise ValueError("Повторяющиеся параметры initData")
        data[key] = value

    received_hash = data.pop("hash", None)
    if not received_hash or len(received_hash) != 64:
        raise ValueError("В initData нет корректной подписи Telegram")

    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(data.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    calculated_hash = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calculated_hash, received_hash):
        raise ValueError("Подпись Telegram не прошла проверку")

    try:
        auth_date = int(data.get("auth_date", "0"))
    except ValueError as exc:
        raise ValueError("Некорректная дата авторизации Telegram") from exc
    current = int(time.time()) if now is None else now
    if auth_date <= 0 or auth_date > current + 60:
        raise ValueError("Некорректная дата авторизации Telegram")
    if current - auth_date > MAX_INIT_DATA_AGE_SECONDS:
        raise ValueError("Сеанс Telegram устарел. Закройте магазин и откройте его заново.")

    try:
        user = json.loads(data.get("user", ""))
    except json.JSONDecodeError as exc:
        raise ValueError("Не найден пользователь Telegram") from exc
    if not isinstance(user, dict) or not isinstance(user.get("id"), int):
        raise ValueError("В данных Telegram нет подтверждённого пользователя")

    return {"user": user, "auth_date": auth_date, "query_id": data.get("query_id", "")}


def format_money(value: int) -> str:
    return f"{value:,}".replace(",", " ") + " ₽"


def calculate_order(items: list[OrderItem]) -> tuple[list[dict[str, Any]], int]:
    seen: set[str] = set()
    clean_items: list[dict[str, Any]] = []
    total = 0
    live_menu = current_menu()
    for row in items:
        if row.id not in live_menu:
            raise ValueError(f"Неизвестная позиция меню: {row.id}")
        if row.id in seen:
            raise ValueError("В заказе повторяется одна и та же позиция")
        seen.add(row.id)
        product = live_menu[row.id]
        subtotal = product["price"] * row.qty
        total += subtotal
        clean_items.append({
            "id": row.id,
            "name": product["name"],
            "price": product["price"],
            "cost": product.get("cost", 0),
            "qty": row.qty,
            "subtotal": subtotal,
            "gross_profit": (product["price"] - product.get("cost", 0)) * row.qty,
        })
    if total <= 0 or total > 250000:
        raise ValueError("Некорректная сумма заказа")
    return clean_items, total


# In-memory idempotency and rate-limit safeguards for normal retries. Orders are sent
# immediately to Telegram; this service intentionally does not store customer data.
_idempotency: dict[tuple[int, str], tuple[float, str, dict[str, Any]]] = {}
_recent_orders: dict[int, deque[float]] = defaultdict(deque)
_order_lock = asyncio.Lock()
_IDEMPOTENCY_TTL = 3 * 60 * 60
_RATE_WINDOW = 60 * 60
_MAX_ORDERS_PER_HOUR = 12


def prune_memory(now: float) -> None:
    for key, (created_at, _fingerprint, _result) in list(_idempotency.items()):
        if now - created_at > _IDEMPOTENCY_TTL:
            _idempotency.pop(key, None)
    for user_id, timestamps in list(_recent_orders.items()):
        while timestamps and now - timestamps[0] > _RATE_WINDOW:
            timestamps.popleft()
        if not timestamps:
            _recent_orders.pop(user_id, None)


@app.exception_handler(RequestValidationError)
async def request_validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    # Log only field paths and validation messages, never log initData, phone, or customer details.
    safe_errors = [
        {"loc": [str(part) for part in error.get("loc", ())],
         "msg": str(error.get("msg", "Некорректное значение")),
         "type": str(error.get("type", "validation_error"))}
        for error in exc.errors()
    ]
    body_keys: list[str] = []
    try:
        body = await request.json()
        if isinstance(body, dict):
            body_keys = sorted(str(key) for key in body.keys())
    except Exception:
        pass
    logger.warning("Request validation failed path=%s body_keys=%s errors=%s", request.url.path, body_keys, safe_errors)
    return JSONResponse(
        status_code=422,
        content={
            "ok": False,
            "detail": safe_errors,
            "message": "Некоторые поля заказа не распознаны. Обновите магазин и попробуйте ещё раз.",
        },
    )



ADMIN_TELEGRAM_ID = os.getenv("ADMIN_TELEGRAM_ID", "").strip()
PRODUCTS_FILE = os.getenv("PRODUCTS_FILE", os.path.join(os.path.dirname(__file__), "products.json"))
DEFAULT_PRODUCTS = [
    {"id":"philadelphia","name":"Филадельфия","price":450,"cost":0,"weight":"280 г","cat":"classic","badge":"ХИТ","desc":"Нежный лосось, сливочный сыр, свежий огурец и рис.","photo":"","active":True,"sort_order":0},
    {"id":"lava","name":"Лава","price":350,"cost":0,"weight":"280 г","cat":"classic","badge":"","desc":"Нежный соус лава, сливочный сыр и свежие ингредиенты.","photo":"","active":True,"sort_order":1},
    {"id":"warm_crab","name":"Тёплый краб","price":350,"weight":"280 г","cat":"warm","badge":"","desc":"Тёплый ролл с крабом и аппетитной золотистой корочкой.","photo":"","active":True,"sort_order":2},
    {"id":"warm_salmon","name":"Тёплый лосось","price":450,"weight":"280 г","cat":"warm","badge":"","desc":"Тёплый ролл с лососем, приготовленный до золотистой корочки.","photo":"","active":True,"sort_order":3},
    {"id":"california","name":"Калифорния","price":390,"cost":0,"weight":"280 г","cat":"classic","badge":"","desc":"Классический ролл с нежной начинкой и рисом.","photo":"","active":True,"sort_order":4},
    {"id":"unagi","name":"Унаги","price":460,"cost":0,"weight":"280 г","cat":"classic","badge":"","desc":"Ролл с угрём и насыщенным соусом унаги.","photo":"","active":True,"sort_order":5},
]

def read_products() -> list[dict[str, Any]]:
    try:
        with open(PRODUCTS_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, list) and all(isinstance(item, dict) for item in data):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return [dict(item) for item in DEFAULT_PRODUCTS]

def write_products(products: list[dict[str, Any]]) -> None:
    folder = os.path.dirname(PRODUCTS_FILE)
    if folder:
        os.makedirs(folder, exist_ok=True)
    temporary = PRODUCTS_FILE + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(products, handle, ensure_ascii=False, indent=2)
    os.replace(temporary, PRODUCTS_FILE)

def current_menu() -> dict[str, dict[str, Any]]:
    result = {}
    for p in read_products():
        if p.get("active", True) and p.get("id") and p.get("name"):
            try:
                price = int(p.get("price", 0))
            except (TypeError, ValueError):
                continue
            if price > 0:
                result[str(p["id"])] = {"name": str(p["name"]), "price": price, "cost": max(0, int(p.get("cost", 0) or 0))}
    return result

CATEGORIES_FILE = os.getenv("CATEGORIES_FILE", os.path.join(os.path.dirname(__file__), "categories.json"))
DEFAULT_CATEGORIES = [
    {"id":"classic","name":"Классические","sort_order":0},
    {"id":"warm","name":"Тёплые и мясные","sort_order":1},
    {"id":"dogs","name":"Азиатские хот-доги","sort_order":2},
    {"id":"snacks","name":"Закуски","sort_order":3},
    {"id":"sets","name":"Сеты","sort_order":4},
    {"id":"all","name":"Другое","sort_order":5},
]
def read_categories() -> list[dict[str, Any]]:
    try:
        with open(CATEGORIES_FILE, "r", encoding="utf-8") as handle:
            data=json.load(handle)
        if isinstance(data,list) and all(isinstance(x,dict) and x.get("id") and x.get("name") for x in data):
            return data
    except (OSError,json.JSONDecodeError):
        pass
    return [dict(x) for x in DEFAULT_CATEGORIES]
def write_categories(categories: list[dict[str, Any]]) -> None:
    folder=os.path.dirname(CATEGORIES_FILE)
    if folder: os.makedirs(folder,exist_ok=True)
    temporary=CATEGORIES_FILE+".tmp"
    with open(temporary,"w",encoding="utf-8") as handle: json.dump(categories,handle,ensure_ascii=False,indent=2)
    os.replace(temporary,CATEGORIES_FILE)

def require_admin_init_data(raw: str) -> dict[str, Any]:
    if not BOT_TOKEN:
        raise HTTPException(status_code=503, detail="На сервере не настроен BOT_TOKEN.")
    if not ADMIN_TELEGRAM_ID.isdigit():
        raise HTTPException(status_code=503, detail="На сервере не задан ADMIN_TELEGRAM_ID.")
    try:
        auth = verify_telegram_init_data(raw, BOT_TOKEN)
    except (ValueError, Exception) as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    if str(auth["user"].get("id")) != ADMIN_TELEGRAM_ID:
        raise HTTPException(status_code=403, detail="Доступ разрешён только владельцу магазина.")
    return auth

class ProductPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(min_length=2, max_length=48, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=100)
    price: int = Field(ge=1, le=100000)
    cost: int = Field(default=0, ge=0, le=100000)
    weight: str = Field(default="280 г", max_length=30)
    cat: str = Field(default="all", max_length=30)
    badge: str = Field(default="", max_length=30)
    desc: str = Field(default="", max_length=1000)
    photo: str = Field(default="", max_length=1200000)
    pieces: int = Field(default=8, ge=1, le=100)
    details: str = Field(default="", max_length=1000)
    gallery: list[str] = Field(default_factory=list, max_length=5)
    active: bool = True
    sort_order: int = Field(default=0, ge=0, le=10000)

    @field_validator("gallery")
    @classmethod
    def validate_gallery(cls, value: list[str]) -> list[str]:
        for image in value:
            if not isinstance(image, str) or len(image) > 1_000_000:
                raise ValueError("Каждая дополнительная фотография должна быть не больше 1 МБ.")
            if image and not (image.startswith("https://") or re.match(r"^data:image/(jpeg|png|webp);base64,", image)):
                raise ValueError("Дополнительные фотографии должны быть HTTPS-ссылками или JPG, PNG, WebP.")
        return value

def admin_from_header(x_telegram_init_data: str | None) -> None:
    if not x_telegram_init_data:
        raise HTTPException(status_code=401, detail="Нет данных авторизации Telegram. Откройте панель из Telegram.")
    require_admin_init_data(x_telegram_init_data)

@app.get("/api/categories")
async def get_categories() -> list[dict[str, Any]]:
    return sorted(read_categories(), key=lambda c: int(c.get("sort_order",0)))

@app.get("/api/admin/categories")
async def admin_get_categories(x_telegram_init_data: str | None = Header(default=None)) -> list[dict[str, Any]]:
    admin_from_header(x_telegram_init_data)
    return sorted(read_categories(), key=lambda c: int(c.get("sort_order",0)))

@app.post("/api/admin/categories")
async def admin_create_category(payload: dict[str, Any], x_telegram_init_data: str | None = Header(default=None)) -> dict[str, Any]:
    admin_from_header(x_telegram_init_data)
    category_id=str(payload.get("id","")).strip()
    name=str(payload.get("name","")).strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{2,30}",category_id) or not name or len(name)>60:
        raise HTTPException(status_code=400,detail="Укажите ID категории латиницей и название до 60 символов.")
    categories=read_categories()
    if any(c["id"]==category_id or c["name"].casefold()==name.casefold() for c in categories):
        raise HTTPException(status_code=409,detail="Категория с таким ID или названием уже существует.")
    item={"id":category_id,"name":name,"sort_order":max([int(c.get("sort_order",0)) for c in categories],default=-1)+1}
    categories.append(item);write_categories(categories)
    return {"ok":True,"category":item}

@app.delete("/api/admin/categories/{category_id}")
async def admin_delete_category(category_id: str, x_telegram_init_data: str | None = Header(default=None)) -> dict[str, Any]:
    admin_from_header(x_telegram_init_data)
    if any(str(p.get("cat","all"))==category_id for p in read_products()):
        raise HTTPException(status_code=409,detail="Сначала перенесите товары из этой категории в другую.")
    categories=read_categories();updated=[c for c in categories if c["id"]!=category_id]
    if len(updated)==len(categories): raise HTTPException(status_code=404,detail="Категория не найдена.")
    write_categories(updated)
    return {"ok":True}

@app.get("/api/menu")
async def get_menu() -> list[dict[str, Any]]:
    return sorted([p for p in read_products() if p.get("active", True)], key=lambda p: (int(p.get("sort_order", 0)), str(p.get("name", ""))))

@app.post("/api/admin/check")
async def admin_check(payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get("init_data", "")
    try:
        auth = require_admin_init_data(raw if isinstance(raw, str) else "")
        return {"ok": True, "is_admin": True, "user_id": auth["user"]["id"]}
    except HTTPException as exc:
        if exc.status_code in (401, 403):
            return {"ok": True, "is_admin": False, "detail": exc.detail}
        raise

@app.get("/api/admin/products")
async def admin_get_products(x_telegram_init_data: str | None = Header(default=None)) -> list[dict[str, Any]]:
    admin_from_header(x_telegram_init_data)
    return sorted(read_products(), key=lambda p: (int(p.get("sort_order", 0)), str(p.get("name", ""))))

@app.post("/api/admin/products")
async def admin_create_product(payload: ProductPayload, x_telegram_init_data: str | None = Header(default=None)) -> dict[str, Any]:
    admin_from_header(x_telegram_init_data)
    products = read_products()
    if any(p.get("id") == payload.id for p in products):
        raise HTTPException(status_code=409, detail="Товар с таким ID уже существует.")
    item = payload.model_dump()
    products.append(item)
    write_products(products)
    return {"ok": True, "product": item}

@app.put("/api/admin/products/{product_id}")
async def admin_update_product(product_id: str, payload: ProductPayload, x_telegram_init_data: str | None = Header(default=None)) -> dict[str, Any]:
    admin_from_header(x_telegram_init_data)
    if payload.id != product_id:
        raise HTTPException(status_code=400, detail="ID существующего товара менять нельзя.")
    products = read_products()
    for index, item in enumerate(products):
        if item.get("id") == product_id:
            products[index] = payload.model_dump()
            write_products(products)
            return {"ok": True, "product": products[index]}
    raise HTTPException(status_code=404, detail="Товар не найден.")

@app.delete("/api/admin/products/{product_id}")
async def admin_delete_product(product_id: str, x_telegram_init_data: str | None = Header(default=None)) -> dict[str, Any]:
    admin_from_header(x_telegram_init_data)
    products = read_products()
    updated = [p for p in products if p.get("id") != product_id]
    if len(updated) == len(products):
        raise HTTPException(status_code=404, detail="Товар не найден.")
    write_products(updated)
    return {"ok": True}


# Order history is stored in SQLite. Set ORDERS_DB_PATH to a persistent disk path
# on hosting providers if order history must survive service redeploys.
ORDERS_DB_PATH = os.getenv("ORDERS_DB_PATH", "/tmp/tihiy_roll_orders.sqlite3")
VALID_ORDER_STATUSES = {"new", "accepted", "preparing", "ready", "completed", "cancelled"}

def order_db():
    connection = sqlite3.connect(ORDERS_DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection

def init_order_db():
    folder = os.path.dirname(ORDERS_DB_PATH)
    if folder:
        os.makedirs(folder, exist_ok=True)
    with order_db() as connection:
        connection.execute("""CREATE TABLE IF NOT EXISTS orders (
            order_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, telegram_id INTEGER NOT NULL DEFAULT 0, customer_name TEXT NOT NULL,
            phone TEXT NOT NULL, pickup_time TEXT NOT NULL, notes TEXT NOT NULL,
            items_json TEXT NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new'
        )""")
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(orders)").fetchall()}
        if "telegram_id" not in columns:
            connection.execute("ALTER TABLE orders ADD COLUMN telegram_id INTEGER NOT NULL DEFAULT 0")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)")

init_order_db()

@app.get("/api/admin/orders")
async def admin_get_orders(x_telegram_init_data: str | None = Header(default=None), limit: int = 100) -> dict[str, Any]:
    admin_from_header(x_telegram_init_data)
    limit = max(1, min(limit, 200))
    with order_db() as connection:
        rows = connection.execute("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    orders = []
    for row in rows:
        item = dict(row)
        item["items"] = json.loads(item.pop("items_json"))
        orders.append(item)
    totals = {"orders": len(orders), "revenue": sum(o["total"] for o in orders),
              "new": sum(o["status"] == "new" for o in orders),
              "completed": sum(o["status"] == "completed" for o in orders)}
    return {"orders": orders, "summary": totals}

@app.patch("/api/admin/orders/{order_id}")
async def admin_update_order(order_id: str, payload: dict[str, Any], x_telegram_init_data: str | None = Header(default=None)) -> dict[str, Any]:
    admin_from_header(x_telegram_init_data)
    status_value = payload.get("status")
    if status_value not in VALID_ORDER_STATUSES:
        raise HTTPException(status_code=400, detail="Неизвестный статус заказа.")
    with order_db() as connection:
        row = connection.execute("SELECT telegram_id,customer_name FROM orders WHERE order_id=?", (order_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Заказ не найден.")
        connection.execute("UPDATE orders SET status=? WHERE order_id=?", (status_value, order_id))
        customer_telegram_id = int(row["telegram_id"] or 0)
    # Telegram only permits proactive messages when the customer has started the bot.
    notify_text = {"accepted":"Заказ принят! Скоро начнём готовить 🍣","preparing":"Ваш заказ уже готовится 👨‍🍳","ready":"Ваш заказ готов! Можно забирать 📦","completed":"Спасибо за заказ! Будем рады видеть вас снова ❤️","cancelled":"К сожалению, заказ отменён. Если это ошибка, свяжитесь с владельцем магазина."}.get(status_value)
    if BOT_TOKEN and customer_telegram_id and notify_text:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                await client.post(f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage", json={"chat_id":customer_telegram_id,"text":f"🍣 Тихий ролл · заказ #{order_id}\n\n{notify_text}"})
        except httpx.HTTPError:
            logger.warning("Customer status notification failed for order %s", order_id)
    return {"ok": True, "order_id": order_id, "status": status_value, "customer_notified": bool(BOT_TOKEN and customer_telegram_id)}

@app.get("/api/admin/analytics")
async def admin_analytics(x_telegram_init_data: str | None = Header(default=None)) -> dict[str, Any]:
    admin_from_header(x_telegram_init_data)
    with order_db() as connection:
        rows = connection.execute("SELECT items_json,total,status,created_at FROM orders ORDER BY created_at DESC").fetchall()
    revenue = sum(row["total"] for row in rows if row["status"] != "cancelled")
    gross_profit = sum(sum(int(item.get("gross_profit", 0)) for item in json.loads(row["items_json"])) for row in rows if row["status"] != "cancelled")
    active_orders = sum(row["status"] not in ("completed", "cancelled") for row in rows)
    popular: dict[str, int] = {}
    for row in rows:
        if row["status"] == "cancelled":
            continue
        for item in json.loads(row["items_json"]):
            name = str(item.get("name", item.get("id", "Блюдо")))
            popular[name] = popular.get(name, 0) + int(item.get("qty", 0))
    return {"orders_count": len(rows), "revenue": revenue, "gross_profit": gross_profit,
            "active_orders": active_orders, "popular_items": sorted(
                [{"name": name, "qty": qty} for name, qty in popular.items()],
                key=lambda item: item["qty"], reverse=True)[:10]}

MAX_ORDERS_PER_SLOT = max(1, int(os.getenv("MAX_ORDERS_PER_SLOT", "5")))

@app.get("/api/availability")
async def get_availability(date: str) -> dict[str, Any]:
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Дата должна быть в формате ГГГГ-ММ-ДД.") from exc
    with order_db() as connection:
        rows = connection.execute(
            "SELECT pickup_time, COUNT(*) AS amount FROM orders WHERE pickup_time LIKE ? AND status != 'cancelled' GROUP BY pickup_time",
            (f"%{date}%",)
        ).fetchall()
    full_times = []
    for row in rows:
        match = __import__("re").search(r"в (\d{2}:\d{2})$", row["pickup_time"])
        if match and int(row["amount"]) >= MAX_ORDERS_PER_SLOT:
            full_times.append(match.group(1))
    return {"date": date, "unavailable_times": sorted(set(full_times)), "max_orders_per_slot": MAX_ORDERS_PER_SLOT}


# Editable homepage content managed by the store owner.
SITE_CONTENT_FILE = os.getenv("SITE_CONTENT_FILE", os.path.join(os.path.dirname(__file__), "site_content.json"))
DEFAULT_SITE_CONTENT = {
    "hero_title": "Тихо готовим, громко вкусно",
    "hero_subtitle": "Свежие роллы и азиатские блюда — приготовим к выбранному времени.",
    "hero_button": "Выбрать блюда",
    "slides": [
        {"title":"Тихо готовим,","accent":"громко вкусно","desc":"Свежие роллы и азиатские блюда — приготовим к выбранному времени.","image":"","button":"Выбрать блюда","active":True},
        {"title":"Азиатский хот-дог","accent":"хрустящий снаружи","desc":"Щедрая начинка и яркие соусы в каждом кусочке.","image":"","button":"Попробовать новинку","active":True},
        {"title":"Собери свой сет","accent":"на свой вкус","desc":"Выбирай любимые роллы и создай собственное сочетание.","image":"","button":"Собрать сет","active":True}
    ],
    "sets": [
        {"id":"solo","description":"Филадельфия и Лава — для уютного ужина.","image":"","photos":[]},
        {"id":"duo","description":"Филадельфия, Тёплый краб и Лава — поделиться вкусом.","image":"","photos":[]},
        {"id":"party","description":"Две Филадельфии, Лава, Тёплый краб и Тёплый лосось.","image":"","photos":[]},
        {"id":"newyear","description":"Праздничная подборка: Филадельфия, Калифорния, Лава, Тёплый краб и Тёплый лосось.","image":"","photos":[]}
    ],
    "promo_title":"Закажи к удобному времени",
    "promo_text":"Выбирай блюда заранее — мы приготовим заказ к согласованному времени.",
    "promo_button":"Перейти к меню",
    "promo_link":"#menu",
    "promo_image":""
}
def read_site_content() -> dict[str, Any]:
    try:
        with open(SITE_CONTENT_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict):
            merged = dict(DEFAULT_SITE_CONTENT)
            merged.update(data)
            merged["slides"] = data.get("slides", DEFAULT_SITE_CONTENT["slides"])
            merged["sets"] = data.get("sets", DEFAULT_SITE_CONTENT["sets"])
            return merged
    except (OSError, json.JSONDecodeError):
        pass
    return json.loads(json.dumps(DEFAULT_SITE_CONTENT, ensure_ascii=False))
def write_site_content(data: dict[str, Any]) -> None:
    folder = os.path.dirname(SITE_CONTENT_FILE)
    if folder:
        os.makedirs(folder, exist_ok=True)
    temporary = SITE_CONTENT_FILE + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
    os.replace(temporary, SITE_CONTENT_FILE)

@app.get("/api/site-content")
async def get_site_content() -> dict[str, Any]:
    return read_site_content()

@app.get("/api/admin/site-content")
async def admin_get_site_content(x_telegram_init_data: str | None = Header(default=None)) -> dict[str, Any]:
    admin_from_header(x_telegram_init_data)
    return read_site_content()

@app.put("/api/admin/site-content")
async def admin_update_site_content(payload: dict[str, Any], x_telegram_init_data: str | None = Header(default=None)) -> dict[str, Any]:
    admin_from_header(x_telegram_init_data)
    current = read_site_content()
    limits = {"hero_title":160, "hero_subtitle":300, "hero_button":50, "promo_title":120, "promo_text":500, "promo_button":50, "promo_link":300, "promo_image":1_000_000}
    for key, limit in limits.items():
        if key in payload:
            value = payload[key]
            if not isinstance(value, str) or len(value.strip()) > limit:
                raise HTTPException(status_code=400, detail=f"Поле {key}: слишком длинный текст или неверный формат.")
            if key == "promo_image" and value and not (value.startswith("https://") or re.match(r"^data:image/(jpeg|png|webp);base64,", value)):
                raise HTTPException(status_code=400, detail="Для рекламного фото загрузи JPG, PNG, WebP или укажи HTTPS-ссылку.")
            current[key] = value.strip()
    if "slides" in payload:
        slides = payload["slides"]
        if not isinstance(slides, list) or len(slides) > 5:
            raise HTTPException(status_code=400, detail="Можно настроить не более 5 слайдов.")
        clean = []
        for i, slide in enumerate(slides):
            if not isinstance(slide, dict):
                raise HTTPException(status_code=400, detail=f"Слайд {i+1}: неверный формат.")
            row = {}
            for key, limit in (("title",120),("accent",120),("desc",300),("image",1_000_000),("button",50)):
                value = slide.get(key, "")
                if not isinstance(value, str) or len(value) > limit:
                    raise HTTPException(status_code=400, detail=f"Слайд {i+1}: проверь поле {key}.")
                if key == "image" and value and not (value.startswith("https://") or re.match(r"^data:image/(jpeg|png|webp);base64,", value)):
                    raise HTTPException(status_code=400, detail="Для изображения укажи HTTPS-ссылку или загрузи JPG, PNG, WebP.")
                row[key] = value.strip()
            row["active"] = bool(slide.get("active", True))
            clean.append(row)
        current["slides"] = clean
    if "sets" in payload:
        sets = payload["sets"]
        allowed_set_ids = {"solo", "duo", "party", "newyear"}
        if not isinstance(sets, list) or len(sets) > 4:
            raise HTTPException(status_code=400, detail="Можно настроить не более 4 готовых сетов.")
        clean_sets = []
        seen = set()
        for index, item in enumerate(sets):
            if not isinstance(item, dict):
                raise HTTPException(status_code=400, detail=f"Сет {index+1}: неверный формат.")
            set_id = item.get("id")
            if set_id not in allowed_set_ids or set_id in seen:
                raise HTTPException(status_code=400, detail=f"Сет {index+1}: неизвестный или повторяющийся ID.")
            description = item.get("description", "")
            image = item.get("image", "")
            if not isinstance(description, str) or len(description) > 300:
                raise HTTPException(status_code=400, detail=f"Сет {index+1}: описание должно быть до 300 символов.")
            if not isinstance(image, str) or len(image) > 1_000_000:
                raise HTTPException(status_code=400, detail=f"Сет {index+1}: фотография слишком большая.")
            if image and not (image.startswith("https://") or re.match(r"^data:image/(jpeg|png|webp);base64,", image)):
                raise HTTPException(status_code=400, detail=f"Сет {index+1}: используй HTTPS-ссылку или загрузи JPG, PNG, WebP.")
            photos = item.get("photos", [])
            if not isinstance(photos, list) or len(photos) > 5:
                raise HTTPException(status_code=400, detail=f"Сет {index+1}: можно загрузить не более 5 дополнительных фотографий.")
            clean_photos = []
            for photo_index, photo in enumerate(photos):
                if not isinstance(photo, str) or len(photo) > 1_000_000:
                    raise HTTPException(status_code=400, detail=f"Фото {photo_index+1} сета {index+1}: файл слишком большой.")
                if photo and not (photo.startswith("https://") or re.match(r"^data:image/(jpeg|png|webp);base64,", photo)):
                    raise HTTPException(status_code=400, detail=f"Фото {photo_index+1} сета {index+1}: нужен HTTPS URL или JPG, PNG, WebP.")
                clean_photos.append(photo.strip())
            clean_sets.append({"id": set_id, "description": description.strip(), "image": image.strip(), "photos": clean_photos})
            seen.add(set_id)
        current["sets"] = clean_sets
    write_site_content(current)
    return {"ok": True, "content": current}

@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "tihiy-roll-order-api",
        "configured": bool(BOT_TOKEN and ADMIN_CHAT_ID),
        "allowed_origins": ALLOWED_ORIGINS,
    }


@app.post("/api/order")
async def create_order(payload: OrderPayload, origin: str | None = Header(default=None)) -> dict[str, Any]:
    if not BOT_TOKEN or not ADMIN_CHAT_ID:
        logger.error("Order endpoint is not configured: BOT_TOKEN or ADMIN_CHAT_ID missing")
        raise HTTPException(status_code=503, detail="Сервер заказов ещё не настроен. Сообщите владельцу магазина.")

    # CORS is enforced by the browser; this explicit check also rejects unwanted origins.
    if not origin or origin.rstrip("/") not in ALLOWED_ORIGINS:
        raise HTTPException(status_code=403, detail="Источник запроса не разрешён.")

    try:
        auth = verify_telegram_init_data(payload.init_data, BOT_TOKEN)
        items, total = calculate_order(payload.items)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    user = auth["user"]
    user_id = user["id"]
    canonical = {
        "name": payload.name,
        "phone": payload.phone,
        "time": payload.time,
        "notes": payload.notes,
        "items": [{"id": item["id"], "qty": item["qty"]} for item in items],
    }
    fingerprint = hashlib.sha256(json.dumps(canonical, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    idem_key = (user_id, payload.client_order_id)

    async with _order_lock:
        now = time.time()
        prune_memory(now)
        cached = _idempotency.get(idem_key)
        if cached:
            _created, previous_fingerprint, previous_result = cached
            if not hmac.compare_digest(fingerprint, previous_fingerprint):
                raise HTTPException(status_code=409, detail="Этот идентификатор уже использован для другого заказа. Обновите страницу корзины.")
            return previous_result

        recent = _recent_orders[user_id]
        if len(recent) >= _MAX_ORDERS_PER_HOUR:
            raise HTTPException(status_code=429, detail="Слишком много попыток заказа. Попробуйте позже.")

        order_code = f"TR-{datetime.now().strftime('%y%m%d')}-{uuid.uuid4().hex[:6].upper()}"
        lines = [f"• {item['name']} × {item['qty']} — {format_money(item['subtotal'])}" for item in items]
        username = user.get("username")
        telegram_label = f"@{username}" if username else "username не указан"
        first_name = str(user.get("first_name", ""))[:100]
        last_name = str(user.get("last_name", ""))[:100]
        telegram_name = (first_name + " " + last_name).strip() or "не указано"
        message_text = (
            f"🆕 НОВЫЙ ЗАКАЗ #{order_code}\n\n"
            f"Имя: {payload.name}\n"
            f"Телефон: {payload.phone}\n"
            f"Время получения: {payload.time}\n"
            f"Telegram клиента: {telegram_label} (ID {user_id}, {telegram_name})\n\n"
            + "\n".join(lines)
            + (f"\n\nДополнение / способ получения:\n{payload.notes}" if payload.notes.strip() else "")
            + f"\n\nИТОГО: {format_money(total)}\n\n"
            "Время выдачи необходимо подтвердить отдельно."
        )

        url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=8.0)) as client:
                response = await client.post(url, json={"chat_id": ADMIN_CHAT_ID, "text": message_text})
                response_json = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            logger.exception("Telegram Bot API request failed for order %s", order_code)
            raise HTTPException(status_code=502, detail="Не удалось связаться с Telegram. Заказ не подтверждён; можно повторить попытку.") from exc

        if response.status_code >= 400 or not response_json.get("ok"):
            description = str(response_json.get("description", "Telegram Bot API error"))[:400]
            logger.error("Telegram sendMessage failed for %s: status=%s description=%s", order_code, response.status_code, description)
            if response.status_code == 403:
                detail = "Бот не может написать владельцу. Проверьте ADMIN_CHAT_ID и запустите бота командой /start от имени владельца."
            elif response.status_code == 400:
                detail = "Telegram не принял сообщение. Проверьте ADMIN_CHAT_ID и доступность чата владельца."
            else:
                detail = "Telegram временно не принял заказ. Попробуйте ещё раз чуть позже."
            raise HTTPException(status_code=502, detail=detail)

        with order_db() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO orders (order_id,created_at,telegram_id,customer_name,phone,pickup_time,notes,items_json,total,status) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (order_code, datetime.now().isoformat(timespec="seconds"), user_id, payload.name, payload.phone,
                 payload.time, payload.notes, json.dumps(items, ensure_ascii=False), total, "new")
            )

        result = {
            "ok": True,
            "order_id": order_code,
            "total": total,
            "currency": "RUB",
            "message": "Заказ отправлен владельцу в Telegram. Время получения подтвердят отдельно.",
        }
        _idempotency[idem_key] = (now, fingerprint, result)
        recent.append(now)
        logger.info("Order delivered: order_id=%s telegram_user_id=%s item_count=%s total=%s", order_code, user_id, len(items), total)
        return result
