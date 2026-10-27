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
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
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
    for row in items:
        if row.id not in MENU:
            raise ValueError(f"Неизвестная позиция меню: {row.id}")
        if row.id in seen:
            raise ValueError("В заказе повторяется одна и та же позиция")
        seen.add(row.id)
        product = MENU[row.id]
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
