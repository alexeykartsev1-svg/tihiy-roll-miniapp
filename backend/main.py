from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
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
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
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
            "qty": row.qty,
            "subtotal": subtotal,
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
    {"id":"philadelphia","name":"Филадельфия","price":450,"weight":"280 г","cat":"classic","badge":"ХИТ","desc":"Нежный лосось, сливочный сыр, свежий огурец и рис.","photo":"","active":True,"sort_order":0},
    {"id":"lava","name":"Лава","price":350,"weight":"280 г","cat":"classic","badge":"","desc":"Нежный соус лава, сливочный сыр и свежие ингредиенты.","photo":"","active":True,"sort_order":1},
    {"id":"warm_crab","name":"Тёплый краб","price":350,"weight":"280 г","cat":"warm","badge":"","desc":"Тёплый ролл с крабом и аппетитной золотистой корочкой.","photo":"","active":True,"sort_order":2},
    {"id":"warm_salmon","name":"Тёплый лосось","price":450,"weight":"280 г","cat":"warm","badge":"","desc":"Тёплый ролл с лососем, приготовленный до золотистой корочки.","photo":"","active":True,"sort_order":3},
    {"id":"california","name":"Калифорния","price":390,"weight":"280 г","cat":"classic","badge":"","desc":"Классический ролл с нежной начинкой и рисом.","photo":"","active":True,"sort_order":4},
    {"id":"unagi","name":"Унаги","price":460,"weight":"280 г","cat":"classic","badge":"","desc":"Ролл с угрём и насыщенным соусом унаги.","photo":"","active":True,"sort_order":5},
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
                result[str(p["id"])] = {"name": str(p["name"]), "price": price}
    return result

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
    weight: str = Field(default="280 г", max_length=30)
    cat: str = Field(default="all", max_length=30)
    badge: str = Field(default="", max_length=30)
    desc: str = Field(default="", max_length=1000)
    photo: str = Field(default="", max_length=1200000)
    active: bool = True
    sort_order: int = Field(default=0, ge=0, le=10000)

def admin_from_header(x_telegram_init_data: str | None) -> None:
    if not x_telegram_init_data:
        raise HTTPException(status_code=401, detail="Нет данных авторизации Telegram. Откройте панель из Telegram.")
    require_admin_init_data(x_telegram_init_data)

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
