from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import logging
import os
import sqlite3
import shutil
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


class SetOrderItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(min_length=2, max_length=24, pattern=r"^[a-z0-9_-]+$")
    qty: int = Field(ge=1, le=20)


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
    sets: list[SetOrderItem] = Field(default_factory=list, max_length=8)

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
            "sets": ("sets", "set_items", "setItems"),
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
        available_stock = product.get("stock")
        if available_stock is not None and row.qty > int(available_stock):
            raise ValueError(f"Недостаточно товара «{product['name']}» в наличии. Осталось: {available_stock}.")
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
_configured_products_file = os.getenv("PRODUCTS_FILE", "").strip()
LEGACY_PRODUCTS_FILE = os.getenv("LEGACY_PRODUCTS_FILE", "").strip() or _configured_products_file or os.path.join(os.path.dirname(__file__), "products.json")
PRODUCTS_FILE = os.getenv("PERSISTENT_PRODUCTS_FILE", "/var/data/products.json")
CATALOG_SNAPSHOT_FILE = os.path.join(os.path.dirname(__file__), "catalog_migration_snapshot.json")
CHICKEN_SESAME_ROLL_PHOTO = "https://d2ol7oe51mr4n9.cloudfront.net/user_3Ko71bIJnzA2ooDrjzm38jCchY8/4c547d77-af4f-42b6-b6f7-be80f580bcdf.webp"
CALIFORNIA_ROLL_PHOTO = "https://d2ol7oe51mr4n9.cloudfront.net/user_3Ko71bIJnzA2ooDrjzm38jCchY8/a4905c63-e46d-4ccb-8f14-abfa2211ba80.png"
GEISHA_CRAB_PHOTO = "https://d2ol7oe51mr4n9.cloudfront.net/user_3Ko71bIJnzA2ooDrjzm38jCchY8/f0825c4f-a2e3-43eb-b7bf-d6bf2c023dbc.png"
DEFAULT_PRODUCTS = [
    {"id":"philadelphia","name":"Филадельфия","price":450,"cost":0,"weight":"280 г","cat":"classic","badge":"ХИТ","desc":"Нежный лосось, сливочный сыр, свежий огурец и рис.","photo":"","active":True,"sort_order":0},
    {"id":"lava","name":"Лава","price":350,"cost":0,"weight":"280 г","cat":"classic","badge":"","desc":"Нежный соус лава, сливочный сыр и свежие ингредиенты.","photo":"","active":True,"sort_order":1},
    {"id":"warm_crab","name":"Гейша с крабом","price":350,"weight":"280 г","cat":"warm","badge":"","desc":"Тёплый ролл с крабом и аппетитной золотистой корочкой.","photo":GEISHA_CRAB_PHOTO,"active":True,"sort_order":2},
    {"id":"warm_salmon","name":"Тёплый лосось","price":450,"weight":"280 г","cat":"warm","badge":"","desc":"Тёплый ролл с лососем, приготовленный до золотистой корочки.","photo":"","active":True,"sort_order":3},
    {"id":"california","name":"Калифорния","price":390,"cost":0,"weight":"280 г","cat":"classic","badge":"","desc":"Классический ролл с нежной начинкой и рисом.","photo":CALIFORNIA_ROLL_PHOTO,"active":True,"sort_order":4},
    {"id":"unagi","name":"Курица с кунжутом","price":460,"cost":0,"weight":"280 г","cat":"classic","badge":"","desc":"Курица, сливочный сыр, свежий огурец, рис и кунжут.","photo":CHICKEN_SESAME_ROLL_PHOTO,"active":True,"sort_order":5},
]

STARTER_CATEGORY_PRODUCTS = [
    {
        "id": "asian_hotdog_shrimp", "name": "Азиатский хот-дог с креветкой",
        "price": 390, "cost": 0, "weight": "240 г", "cat": "dogs",
        "badge": "", "desc": "Временная карточка-образец. Название, состав и фото можно изменить в админ-панели.",
        "details": "Креветка, рис, соус, хрустящая булочка", "pieces": 1,
        "stock": None, "photo": "", "gallery": [], "active": True, "sort_order": 20,
    },
    {
        "id": "asian_hotdog_chicken", "name": "Азиатский хот-дог с курицей",
        "price": 350, "cost": 0, "weight": "240 г", "cat": "dogs",
        "badge": "", "desc": "Временная карточка-образец. Название, состав и фото можно изменить в админ-панели.",
        "details": "Курица, сливочный соус, рис, хрустящая булочка", "pieces": 1,
        "stock": None, "photo": "", "gallery": [], "active": True, "sort_order": 21,
    },
    {
        "id": "snack_tempura_shrimp", "name": "Креветки темпура",
        "price": 390, "cost": 0, "weight": "220 г", "cat": "snacks",
        "badge": "", "desc": "Временная карточка-образец. Название, состав и фото можно изменить в админ-панели.",
        "details": "Креветка, темпура, соус", "pieces": 6,
        "stock": None, "photo": "", "gallery": [], "active": True, "sort_order": 22,
    },
    {
        "id": "snack_crispy_rolls", "name": "Хрустящая закуска",
        "price": 350, "cost": 0, "weight": "220 г", "cat": "snacks",
        "badge": "", "desc": "Временная карточка-образец. Название, состав и фото можно изменить в админ-панели.",
        "details": "Краб, сливочный сыр, рис, темпура", "pieces": 6,
        "stock": None, "photo": "", "gallery": [], "active": True, "sort_order": 23,
    },
]

# PERSISTENT_CATALOG_BOOTSTRAP_V1
def _atomic_storage_json_write(path: str, payload: Any) -> None:
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    temporary = path + ".migration.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _load_storage_json(path: str, validator: Any) -> list[dict[str, Any]] | None:
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Skipping unreadable legacy storage file %s: %s", path, exc)
        return None
    return payload if validator(payload) else None


def _bootstrap_persistent_json(
    target: str,
    legacy_candidates: list[str],
    snapshot_key: str,
    defaults: list[dict[str, Any]],
    validator: Any,
) -> list[dict[str, Any]]:
    folder = os.path.dirname(target)
    if folder:
        os.makedirs(folder, exist_ok=True)

    if os.path.isfile(target):
        existing = _load_storage_json(target, validator)
        if existing is None:
            corrupt_backup = target + ".corrupt-" + time.strftime("%Y%m%d-%H%M%S") + ".bak"
            try:
                shutil.copy2(target, corrupt_backup)
            except OSError:
                logger.exception("Could not preserve corrupt persistent storage %s", target)
            raise RuntimeError(
                f"Persistent catalog file {target} is invalid; preserved a backup at {corrupt_backup}. "
                "Refusing to replace it with default products."
            )
        initial_backup = target + ".before-storage-migration.bak"
        if not os.path.exists(initial_backup):
            shutil.copy2(target, initial_backup)
        logger.info("Using existing persistent storage: %s", target)
        return existing

    source_path = None
    data = None
    seen = set()
    for candidate in legacy_candidates:
        if not candidate:
            continue
        normalized = os.path.abspath(candidate)
        if normalized in seen or normalized == os.path.abspath(target):
            continue
        seen.add(normalized)
        data = _load_storage_json(candidate, validator)
        if data is not None:
            source_path = candidate
            break

    if data is None:
        try:
            with open(CATALOG_SNAPSHOT_FILE, "r", encoding="utf-8") as handle:
                snapshot = json.load(handle)
            candidate_data = snapshot.get(snapshot_key) if isinstance(snapshot, dict) else None
            if validator(candidate_data):
                data = candidate_data
                logger.warning(
                    "No legacy file found for %s; bootstrapping from the captured live catalog snapshot.",
                    target,
                )
        except (OSError, json.JSONDecodeError, AttributeError):
            logger.warning("No usable catalog snapshot found for %s; using built-in defaults.", target)

    if data is None:
        data = [dict(item) for item in defaults]
        logger.warning("No previous data file found for %s; initialized the built-in starter catalog.", target)

    _atomic_storage_json_write(target, data)
    backup_suffix = ".migration-source.bak" if source_path else ".initial-seed.bak"
    backup_path = target + backup_suffix
    if not os.path.exists(backup_path):
        if source_path:
            shutil.copy2(source_path, backup_path)
        else:
            shutil.copy2(target, backup_path)
    logger.info("Initialized persistent storage at %s from %s", target, source_path or "catalog snapshot/defaults")
    return data


def _protect_existing_product_migrations(products: list[dict[str, Any]]) -> None:
    ids = {str(item.get("id", "")) for item in products}
    rules = [
        ("starter-category-cards-v1", {"asian_hotdog_shrimp", "asian_hotdog_chicken", "snack_tempura_shrimp", "snack_crispy_rolls"}),
        ("restore-philadelphia-hit-v1", {"philadelphia"}),
        ("asian-hotdog-salmon-v1", {"asian_hotdog_salmon"}),
        ("asian-hotdog-shrimp-v1", {"asian_hotdog_shrimp"}),
        ("asian-hotdog-chicken-v1", {"asian_hotdog_chicken"}),
        ("asian-hotdog-snow-crab-v1", {"asian_hotdog_crab"}),
        ("salmon-panko-roll-v1", {"salmon_panko"}),
        ("salmon-panko-approved-art-v2", {"salmon_panko"}),
        ("geisha-crab-card-v1", {"warm_crab"}),
        ("california-card-photo-v1", {"california"}),
        ("chicken-sesame-card-v1", {"unagi"}),
    ]
    for suffix, required_ids in rules:
        if required_ids.issubset(ids):
            marker_path = PRODUCTS_FILE + "." + suffix
            try:
                with open(marker_path, "a", encoding="utf-8"):
                    pass
            except OSError:
                logger.exception("Could not persist migration guard %s", marker_path)


_bootstrapped_products = _bootstrap_persistent_json(
    PRODUCTS_FILE,
    [LEGACY_PRODUCTS_FILE, os.path.join(os.path.dirname(__file__), "products.json")],
    "products",
    DEFAULT_PRODUCTS,
    lambda value: isinstance(value, list) and all(isinstance(item, dict) for item in value),
)
_protect_existing_product_migrations(_bootstrapped_products)

def read_products() -> list[dict[str, Any]]:
    try:
        with open(PRODUCTS_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if not isinstance(data, list) or not all(isinstance(item, dict) for item in data):
            raise RuntimeError(f"Persistent product catalog {PRODUCTS_FILE} has an invalid structure.")
    except (OSError, json.JSONDecodeError) as exc:
        logger.exception("Could not read persistent product catalog %s", PRODUCTS_FILE)
        raise RuntimeError(f"Could not read product catalog {PRODUCTS_FILE}; refusing to replace it with defaults.") from exc

    # Seed starter cards exactly once so they are real menu items accepted by
    # calculate_order/current_menu, while keeping later admin edits/deletions.
    seed_marker = PRODUCTS_FILE + ".starter-category-cards-v1"
    if not os.path.exists(seed_marker):
        existing_ids = {str(item.get("id", "")) for item in data}
        missing = [dict(item) for item in STARTER_CATEGORY_PRODUCTS if item["id"] not in existing_ids]
        if missing:
            data.extend(missing)
            write_products(data)
        try:
            marker_dir = os.path.dirname(seed_marker)
            if marker_dir:
                os.makedirs(marker_dir, exist_ok=True)
            with open(seed_marker, "w", encoding="utf-8") as handle:
                handle.write("seeded\n")
        except OSError:
            logger.warning("Could not create starter category seed marker at %s", seed_marker)
    # One-time owner-requested restoration of the original Philadelphia HIT card.
    # Preserve existing product data; only reactivate and re-enable its HIT artwork.
    hit_restore_marker = PRODUCTS_FILE + ".restore-philadelphia-hit-v1"
    if not os.path.exists(hit_restore_marker):
        restored_hit = next((item for item in data if str(item.get("id", "")) == "philadelphia"), None)
        if restored_hit is None:
            restored_hit = dict(DEFAULT_PRODUCTS[0])
            restored_hit["active"] = True
            restored_hit["hit_template"] = True
            restored_hit["badge"] = "ХИТ"
            data.insert(0, restored_hit)
            write_products(data)
            logger.info("Restored missing Philadelphia HIT product")
        else:
            hit_changed = False
            if restored_hit.get("active") is not True:
                restored_hit["active"] = True
                hit_changed = True
            if restored_hit.get("hit_template") is not True:
                restored_hit["hit_template"] = True
                hit_changed = True
            if not re.search(r"хит", str(restored_hit.get("badge", "")), re.IGNORECASE):
                restored_hit["badge"] = "ХИТ"
                hit_changed = True
            if hit_changed:
                write_products(data)
                logger.info("Restored Philadelphia HIT product visibility and artwork")
        try:
            marker_dir = os.path.dirname(hit_restore_marker)
            if marker_dir:
                os.makedirs(marker_dir, exist_ok=True)
            with open(hit_restore_marker, "w", encoding="utf-8") as handle:
                handle.write("restored\\n")
        except OSError:
            logger.warning("Could not create Philadelphia HIT restore marker at %s", hit_restore_marker)

    # One-time compatibility migration: copy the former card text into its own field.
    # Existing products keep the same visible catalogue copy until the owner edits it.
    migrated_card_descriptions = False
    for item in data:
        if "card_description" not in item:
            legacy_card_text = str(item.get("desc", "") or "").strip()
            details_text = str(item.get("details", "") or "").strip()
            if legacy_card_text and "временная карточка-образец" in legacy_card_text.lower() and details_text:
                legacy_card_text = details_text
            elif not legacy_card_text:
                legacy_card_text = details_text
            item["card_description"] = legacy_card_text
            migrated_card_descriptions = True
    if migrated_card_descriptions:
        write_products(data)

    # Owner-requested Asian hot dog with salmon. Its photo is artwork only;
    # all catalogue controls continue to be rendered by the normal product card.
    salmon_marker = PRODUCTS_FILE + ".asian-hotdog-salmon-v1"
    if not os.path.exists(salmon_marker):
        def _salmon_name_key(value: Any) -> str:
            return re.sub(r"[^a-zа-яё0-9]", "", str(value or "").lower())

        salmon_existing = next(
            (
                item for item in data
                if str(item.get("id", "")) == "asian_hotdog_salmon"
                or (
                    "азиатский" in _salmon_name_key(item.get("name"))
                    and "лосос" in _salmon_name_key(item.get("name"))
                    and "хотдог" in _salmon_name_key(item.get("name"))
                )
            ),
            None,
        )
        salmon_card = {
            "id": "asian_hotdog_salmon",
            "name": "Азиатский Хот-Дог Лосось",
            "price": 490,
            "cost": 0,
            "weight": "280 г",
            "pieces": 1,
            "cat": "dogs",
            "badge": "",
            "desc": "Сочный лосось, свежий огурец, сливочный сыр, хрустящий панко, соус терияки и спайси.",
            "card_description": "Сочный лосось, свежий огурец, сливочный сыр, хрустящий панко, соус терияки и спайси.",
            "details": "Лосось, свежий огурец, сливочный сыр, хрустящий панко, соус терияки, соус спайси.",
            "photo": "./assets/asian-hotdog-salmon-card.webp?v=20261107",
            "gallery": [],
            "stock": None,
            "hit_template": False,
            "active": True,
            "sort_order": 6,
        }
        if salmon_existing is not None:
            salmon_card["id"] = str(salmon_existing.get("id") or "asian_hotdog_salmon")
            salmon_existing.update(salmon_card)
        else:
            data.append(salmon_card)
        write_products(data)
        try:
            marker_dir = os.path.dirname(salmon_marker)
            if marker_dir:
                os.makedirs(marker_dir, exist_ok=True)
            with open(salmon_marker, "w", encoding="utf-8") as handle:
                handle.write("seeded\\n")
        except OSError:
            logger.warning("Could not create Asian hot dog salmon seed marker at %s", salmon_marker)

    # Owner-requested Asian hot dog with shrimp. Update the pre-existing starter placeholder
    # exactly once; keep all catalogue controls as native storefront elements.
    shrimp_marker = PRODUCTS_FILE + ".asian-hotdog-shrimp-v1"
    if not os.path.exists(shrimp_marker):
        def _shrimp_name_key(value: Any) -> str:
            return re.sub(r"[^a-zа-яё0-9]", "", str(value or "").lower())

        shrimp_existing = next(
            (
                item for item in data
                if str(item.get("id", "")) == "asian_hotdog_shrimp"
                or (
                    "азиатский" in _shrimp_name_key(item.get("name"))
                    and "кревет" in _shrimp_name_key(item.get("name"))
                    and "хотдог" in _shrimp_name_key(item.get("name"))
                )
            ),
            None,
        )
        shrimp_card = {
            "id": "asian_hotdog_shrimp",
            "name": "Азиатский Хот-Дог Креветка",
            "price": 490,
            "cost": 0,
            "weight": "280 г",
            "pieces": 1,
            "cat": "dogs",
            "badge": "",
            "desc": "Сочные креветки, сливочный сыр, свежий огурец, хрустящий панко, соус терияки и спайси.",
            "card_description": "Сочные креветки, сливочный сыр, свежий огурец, хрустящий панко, соус терияки и спайси.",
            "details": "Креветки, свежий огурец, сливочный сыр, хрустящий панко, соус терияки, соус спайси.",
            "photo": "https://d2ol7oe51mr4n9.cloudfront.net/user_3Ko71bIJnzA2ooDrjzm38jCchY8/782d8c4d-7e39-444d-9429-f775d5ab704e.webp",
            "gallery": [],
            "stock": None,
            "hit_template": False,
            "active": True,
            "sort_order": 7,
        }
        if shrimp_existing is not None:
            shrimp_card["id"] = str(shrimp_existing.get("id") or "asian_hotdog_shrimp")
            shrimp_existing.update(shrimp_card)
        else:
            data.append(shrimp_card)
        write_products(data)
        try:
            marker_dir = os.path.dirname(shrimp_marker)
            if marker_dir:
                os.makedirs(marker_dir, exist_ok=True)
            with open(shrimp_marker, "w", encoding="utf-8") as handle:
                handle.write("seeded\\n")
        except OSError:
            logger.warning("Could not create Asian hot dog shrimp seed marker at %s", shrimp_marker)

    # Owner-requested Asian hot dog with chicken. Update the existing placeholder once;
    # all catalogue interactions remain native storefront controls.
    chicken_marker = PRODUCTS_FILE + ".asian-hotdog-chicken-v1"
    if not os.path.exists(chicken_marker):
        def _chicken_name_key(value: Any) -> str:
            return re.sub(r"[^a-zа-яё0-9]", "", str(value or "").lower())

        chicken_existing = next(
            (
                item for item in data
                if str(item.get("id", "")) == "asian_hotdog_chicken"
                or (
                    "азиатский" in _chicken_name_key(item.get("name"))
                    and "куриц" in _chicken_name_key(item.get("name"))
                    and "хотдог" in _chicken_name_key(item.get("name"))
                )
            ),
            None,
        )
        chicken_card = {
            "id": "asian_hotdog_chicken",
            "name": "Азиатский Хот-Дог Курица",
            "price": 490,
            "cost": 0,
            "weight": "280 г",
            "pieces": 1,
            "cat": "dogs",
            "badge": "",
            "desc": "Сочная курица, сливочный сыр, свежий огурец, хрустящий панко, соус терияки и спайси.",
            "card_description": "Сочная курица, сливочный сыр, свежий огурец, хрустящий панко, соус терияки и спайси.",
            "details": "Курица, свежий огурец, сливочный сыр, хрустящий панко, соус терияки, соус спайси.",
            "photo": "https://d2ol7oe51mr4n9.cloudfront.net/user_3Ko71bIJnzA2ooDrjzm38jCchY8/77b66bf7-aeed-43e9-9dc8-102499c0f0ef.webp",
            "gallery": [],
            "stock": None,
            "hit_template": False,
            "active": True,
            "sort_order": 8,
        }
        if chicken_existing is not None:
            chicken_card["id"] = str(chicken_existing.get("id") or "asian_hotdog_chicken")
            chicken_existing.update(chicken_card)
        else:
            data.append(chicken_card)
        write_products(data)
        try:
            marker_dir = os.path.dirname(chicken_marker)
            if marker_dir:
                os.makedirs(marker_dir, exist_ok=True)
            with open(chicken_marker, "w", encoding="utf-8") as handle:
                handle.write("seeded\\n")
        except OSError:
            logger.warning("Could not create Asian hot dog chicken seed marker at %s", chicken_marker)

    # Owner-requested Asian hot dog with snow crab. It uses the existing product API,
    # catalogue card, cart, favorites, composition modal and order flow.
    crab_marker = PRODUCTS_FILE + ".asian-hotdog-snow-crab-v1"
    if not os.path.exists(crab_marker):
        def _crab_name_key(value: Any) -> str:
            return re.sub(r"[^a-zа-яё0-9]", "", str(value or "").lower())

        crab_existing = next(
            (
                item for item in data
                if str(item.get("id", "")) == "asian_hotdog_crab"
                or (
                    "азиатский" in _crab_name_key(item.get("name"))
                    and "краб" in _crab_name_key(item.get("name"))
                    and "хотдог" in _crab_name_key(item.get("name"))
                )
            ),
            None,
        )
        crab_card = {
            "id": "asian_hotdog_crab",
            "name": "Азиатский Хот-Дог Снежный краб",
            "price": 490,
            "cost": 0,
            "weight": "280 г",
            "pieces": 1,
            "cat": "dogs",
            "badge": "",
            "desc": "Снежный краб, свежий огурец, рис, нори, соус спайси, соус унаги, кунжут.",
            "card_description": "Снежный краб, свежий огурец, рис, нори, соус спайси, соус унаги, кунжут.",
            "details": "Снежный краб, свежий огурец, рис, нори, соус спайси, соус унаги, кунжут.",
            "photo": "https://d2ol7oe51mr4n9.cloudfront.net/user_3Ko71bIJnzA2ooDrjzm38jCchY8/0b80e5a1-ac8d-42bd-833b-75811a1ba70b.webp",
            "gallery": [],
            "stock": None,
            "hit_template": False,
            "active": True,
            "sort_order": 9,
        }
        if crab_existing is not None:
            crab_card["id"] = str(crab_existing.get("id") or "asian_hotdog_crab")
            crab_existing.update(crab_card)
        else:
            data.append(crab_card)
        write_products(data)
        try:
            marker_dir = os.path.dirname(crab_marker)
            if marker_dir:
                os.makedirs(marker_dir, exist_ok=True)
            with open(crab_marker, "w", encoding="utf-8") as handle:
                handle.write("seeded\\n")
        except OSError:
            logger.warning("Could not create Asian hot dog snow crab seed marker at %s", crab_marker)

    # Owner-requested Salmon Panko roll. It is a real menu item so the
    # existing cart, favorites, composition and order API work without special cases.
    salmon_panko_marker = PRODUCTS_FILE + ".salmon-panko-roll-v1"
    if not os.path.exists(salmon_panko_marker):
        salmon_panko_card = {
            "id": "salmon_panko",
            "name": "Лосось Панко",
            "price": 450,
            "cost": 0,
            "weight": "280 г",
            "pieces": 8,
            "cat": "classic",
            "badge": "ХИТ",
            "desc": "Нежный лосось, сливочный сыр, свежий огурец и рис.",
            "card_description": "Нежный лосось, сливочный сыр, свежий огурец и рис.",
            "details": "Лосось, сливочный сыр, огурец, рис, нори",
            "photo": "https://d2ol7oe51mr4n9.cloudfront.net/user_3Ko71bIJnzA2ooDrjzm38jCchY8/f71f2016-5e33-44af-bc4a-846e5b5ce72b.webp",
            "gallery": [],
            "stock": None,
            "hit_template": True,
            "active": True,
            "sort_order": 6,
        }
        salmon_panko_existing = next(
            (item for item in data if str(item.get("id", "")) == "salmon_panko"),
            None,
        )
        if salmon_panko_existing is not None:
            salmon_panko_existing.update(salmon_panko_card)
        else:
            data.append(salmon_panko_card)
        write_products(data)
        try:
            marker_dir = os.path.dirname(salmon_panko_marker)
            if marker_dir:
                os.makedirs(marker_dir, exist_ok=True)
            with open(salmon_panko_marker, "w", encoding="utf-8") as handle:
                handle.write("seeded\\n")
        except OSError:
            logger.warning("Could not create Salmon Panko seed marker at %s", salmon_panko_marker)

        # Versioned visual/composition update for the existing real Salmon Panko product.
    # Preserve its price, stock, category and active state; update only its correct art and ingredients.
    salmon_panko_visual_marker = PRODUCTS_FILE + ".salmon-panko-approved-art-v2"
    if not os.path.exists(salmon_panko_visual_marker):
        salmon_panko_existing = next(
            (item for item in data if str(item.get("id", "")) == "salmon_panko"),
            None,
        )
        if salmon_panko_existing is not None:
            salmon_panko_existing["photo"] = "https://d2ol7oe51mr4n9.cloudfront.net/user_3Ko71bIJnzA2ooDrjzm38jCchY8/e549c69f-0d66-496c-afbb-7d3c6e8d303f.webp"
            salmon_panko_existing["details"] = "Лосось, сливочный сыр, огурец, рис, нори, панировка панко"
            salmon_panko_existing["hit_template"] = True
            write_products(data)
        try:
            marker_dir = os.path.dirname(salmon_panko_visual_marker)
            if marker_dir:
                os.makedirs(marker_dir, exist_ok=True)
            with open(salmon_panko_visual_marker, "w", encoding="utf-8") as handle:
                handle.write("updated\\n")
        except OSError:
            logger.warning("Could not create Salmon Panko visual marker at %s", salmon_panko_visual_marker)

    # Keep all Asian hot dogs in the dedicated catalogue category. This also
    # migrates products already stored on the persistent Render disk.
    asian_hotdog_ids = {
        "asian_hotdog_salmon",
        "asian_hotdog_shrimp",
        "asian_hotdog_chicken",
        "asian_hotdog_crab",
    }
    asian_hotdogs_migrated = False
    for product in data:
        if str(product.get("id") or "") in asian_hotdog_ids and product.get("cat") != "dogs":
            product["cat"] = "dogs"
            asian_hotdogs_migrated = True
    if asian_hotdogs_migrated:
        write_products(data)

    # Owner-requested image and title update for the existing standard crab roll card.
    # Only these two fields change; price, category, weight, composition and controls stay intact.
    geisha_crab_marker = PRODUCTS_FILE + ".geisha-crab-card-v1"
    if not os.path.exists(geisha_crab_marker):
        geisha_crab = next((item for item in data if str(item.get("id", "")) == "warm_crab"), None)
        if geisha_crab is not None:
            geisha_crab["name"] = "Гейша с крабом"
            geisha_crab["photo"] = GEISHA_CRAB_PHOTO
            write_products(data)
            try:
                marker_dir = os.path.dirname(geisha_crab_marker)
                if marker_dir:
                    os.makedirs(marker_dir, exist_ok=True)
                with open(geisha_crab_marker, "w", encoding="utf-8") as handle:
                    handle.write("updated\\n")
            except OSError:
                logger.warning("Could not create Geisha with crab migration marker at %s", geisha_crab_marker)

    # Owner-requested image and title confirmation for the existing California card.
    # Keep its existing price, category, weight, ingredients and standard storefront controls.
    california_card_marker = PRODUCTS_FILE + ".california-card-photo-v1"
    if not os.path.exists(california_card_marker):
        california_product = next((item for item in data if str(item.get("id", "")) == "california"), None)
        if california_product is not None:
            california_product["name"] = "Калифорния"
            california_product["photo"] = CALIFORNIA_ROLL_PHOTO
            write_products(data)
            try:
                marker_dir = os.path.dirname(california_card_marker)
                if marker_dir:
                    os.makedirs(marker_dir, exist_ok=True)
                with open(california_card_marker, "w", encoding="utf-8") as handle:
                    handle.write("updated\\n")
            except OSError:
                logger.warning("Could not create California card migration marker at %s", california_card_marker)

    # Owner-requested photo/title update for the next standard roll card.
    # Keep the original product ID, price, category, weight, stock and order integrations.
    chicken_sesame_marker = PRODUCTS_FILE + ".chicken-sesame-card-v1"
    if not os.path.exists(chicken_sesame_marker):
        chicken_sesame_product = next((item for item in data if str(item.get("id", "")) == "unagi"), None)
        if chicken_sesame_product is not None:
            chicken_sesame_product["name"] = "Курица с кунжутом"
            chicken_sesame_product["photo"] = CHICKEN_SESAME_ROLL_PHOTO
            chicken_sesame_product["desc"] = "Курица, сливочный сыр, свежий огурец, рис и кунжут."
            chicken_sesame_product["card_description"] = "Курица, сливочный сыр, свежий огурец, рис и кунжут."
            chicken_sesame_product["details"] = "Курица, сливочный сыр, свежий огурец, рис, нори, кунжут."
            write_products(data)
            try:
                marker_dir = os.path.dirname(chicken_sesame_marker)
                if marker_dir:
                    os.makedirs(marker_dir, exist_ok=True)
                with open(chicken_sesame_marker, "w", encoding="utf-8") as handle:
                    handle.write("updated\\n")
            except OSError:
                logger.warning("Could not create Chicken Sesame card migration marker at %s", chicken_sesame_marker)

    return data

def write_products(products: list[dict[str, Any]]) -> None:
    folder = os.path.dirname(PRODUCTS_FILE)
    if folder:
        os.makedirs(folder, exist_ok=True)
    if os.path.isfile(PRODUCTS_FILE):
        backup_temporary = PRODUCTS_FILE + ".bak.tmp"
        shutil.copy2(PRODUCTS_FILE, backup_temporary)
        os.replace(backup_temporary, PRODUCTS_FILE + ".bak")
    temporary = PRODUCTS_FILE + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(products, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
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
                result[str(p["id"])] = {"name": str(p["name"]), "price": price, "cost": max(0, int(p.get("cost", 0) or 0)), "stock": (None if p.get("stock") is None else max(0, int(p.get("stock", 0) or 0)))}
    return result

_configured_categories_file = os.getenv("CATEGORIES_FILE", "").strip()
LEGACY_CATEGORIES_FILE = os.getenv("LEGACY_CATEGORIES_FILE", "").strip() or _configured_categories_file or os.path.join(os.path.dirname(__file__), "categories.json")
CATEGORIES_FILE = os.getenv("PERSISTENT_CATEGORIES_FILE", "/var/data/categories.json")
DEFAULT_CATEGORIES = [
    {"id":"classic","name":"Классические","icon":"🍣","sort_order":0},
    {"id":"warm","name":"Тёплые и мясные","icon":"🔥","sort_order":1},
    {"id":"dogs","name":"Азиатские хот-доги","icon":"🌭","sort_order":2},
    {"id":"snacks","name":"Закуски","icon":"🍤","sort_order":3},
    {"id":"sets","name":"Сеты","icon":"🎁","sort_order":4},
    {"id":"all","name":"Другое","sort_order":5},
]
_bootstrapped_categories = _bootstrap_persistent_json(
    CATEGORIES_FILE,
    [LEGACY_CATEGORIES_FILE, os.path.join(os.path.dirname(__file__), "categories.json")],
    "categories",
    DEFAULT_CATEGORIES,
    lambda value: isinstance(value, list) and all(isinstance(item, dict) and item.get("id") and item.get("name") for item in value),
)


def read_categories() -> list[dict[str, Any]]:
    try:
        with open(CATEGORIES_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if not isinstance(data, list) or not all(isinstance(item, dict) and item.get("id") and item.get("name") for item in data):
            raise RuntimeError(f"Persistent category file {CATEGORIES_FILE} has an invalid structure.")
        return data
    except (OSError, json.JSONDecodeError) as exc:
        logger.exception("Could not read persistent category file %s", CATEGORIES_FILE)
        raise RuntimeError(f"Could not read category file {CATEGORIES_FILE}; refusing to replace it with defaults.") from exc
def write_categories(categories: list[dict[str, Any]]) -> None:
    folder = os.path.dirname(CATEGORIES_FILE)
    if folder:
        os.makedirs(folder, exist_ok=True)
    if os.path.isfile(CATEGORIES_FILE):
        backup_temporary = CATEGORIES_FILE + ".bak.tmp"
        shutil.copy2(CATEGORIES_FILE, backup_temporary)
        os.replace(backup_temporary, CATEGORIES_FILE + ".bak")
    temporary = CATEGORIES_FILE + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(categories, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, CATEGORIES_FILE)

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
    card_description: str = Field(default="", max_length=1000)
    photo: str = Field(default="", max_length=1200000)
    pieces: int = Field(default=8, ge=1, le=100)
    stock: int | None = Field(default=None, ge=0, le=10000)
    details: str = Field(default="", max_length=1000)
    gallery: list[str] = Field(default_factory=list, max_length=5)
    hit_template: bool = False
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

def validate_category_update(category_id: str, payload: dict[str, Any], existing: list[dict[str, Any]]) -> dict[str, Any]:
    current = next((dict(row) for row in existing if row.get("id") == category_id), None)
    if current is None:
        raise ValueError("Категория не найдена.")
    name = payload.get("name", current.get("name", ""))
    sort_order = payload.get("sort_order", current.get("sort_order", 0))
    icon = payload.get("icon", current.get("icon", ""))
    image = payload.get("image", current.get("image", ""))
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 60:
        raise ValueError("Название категории должно содержать от 1 до 60 символов.")
    if any(row.get("id") != category_id and str(row.get("name", "")).casefold() == name.strip().casefold() for row in existing):
        raise ValueError("Категория с таким названием уже существует.")
    if not isinstance(sort_order, int) or isinstance(sort_order, bool) or not 0 <= sort_order <= 1000:
        raise ValueError("Порядок категории должен быть от 0 до 1000.")
    if not isinstance(icon, str) or len(icon) > 16:
        raise ValueError("Значок категории должен быть коротким текстом.")
    if not isinstance(image, str) or len(image) > 1_000_000:
        raise ValueError("Изображение категории слишком большое.")
    if image and not (image.startswith("https://") or re.match(r"^data:image/(jpeg|png|webp);base64,", image)):
        raise ValueError("Изображение категории должно быть HTTPS-ссылкой или JPG, PNG, WebP.")
    current.update({"name": name.strip(), "sort_order": sort_order, "icon": icon.strip(), "image": image.strip()})
    return current

@app.put("/api/admin/categories/{category_id}")
async def admin_update_category(category_id: str, payload: dict[str, Any], x_telegram_init_data: str | None = Header(default=None)) -> dict[str, Any]:
    admin_from_header(x_telegram_init_data)
    categories = read_categories()
    try:
        updated_item = validate_category_update(category_id, payload, categories)
    except ValueError as exc:
        if str(exc) == "Категория не найдена.":
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_categories([updated_item if row.get("id") == category_id else row for row in categories])
    return {"ok": True, "category": updated_item}

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
    icon=payload.get("icon","")
    image=payload.get("image","")
    if not isinstance(icon,str) or len(icon)>16:
        raise HTTPException(status_code=400,detail="Значок категории должен быть коротким текстом.")
    if not isinstance(image,str) or len(image)>1_000_000 or (image and not (image.startswith("https://") or re.match(r"^data:image/(jpeg|png|webp);base64,",image))):
        raise HTTPException(status_code=400,detail="Изображение категории должно быть HTTPS-ссылкой или JPG, PNG, WebP.")
    item={"id":category_id,"name":name,"icon":icon.strip(),"image":image.strip(),"sort_order":max([int(c.get("sort_order",0)) for c in categories],default=-1)+1}
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
_configured_orders_db_path = os.getenv("ORDERS_DB_PATH", "").strip()
LEGACY_ORDERS_DB_PATH = os.getenv("LEGACY_ORDERS_DB_PATH", "").strip() or _configured_orders_db_path or "/tmp/tihiy_roll_orders.sqlite3"
ORDERS_DB_PATH = os.getenv("PERSISTENT_ORDERS_DB_PATH", "/var/data/tihiy_roll_orders.sqlite3")


def _bootstrap_orders_database() -> None:
    folder = os.path.dirname(ORDERS_DB_PATH)
    if folder:
        os.makedirs(folder, exist_ok=True)
    if os.path.isfile(ORDERS_DB_PATH):
        backup_path = ORDERS_DB_PATH + ".before-storage-migration.bak"
        if not os.path.exists(backup_path):
            shutil.copy2(ORDERS_DB_PATH, backup_path)
        logger.info("Using existing persistent order database: %s", ORDERS_DB_PATH)
        return
    if LEGACY_ORDERS_DB_PATH and os.path.isfile(LEGACY_ORDERS_DB_PATH) and os.path.abspath(LEGACY_ORDERS_DB_PATH) != os.path.abspath(ORDERS_DB_PATH):
        shutil.copy2(LEGACY_ORDERS_DB_PATH, ORDERS_DB_PATH)
        shutil.copy2(LEGACY_ORDERS_DB_PATH, ORDERS_DB_PATH + ".migration-source.bak")
        logger.info("Copied legacy order database %s to persistent storage %s", LEGACY_ORDERS_DB_PATH, ORDERS_DB_PATH)
    else:
        logger.warning("No legacy SQLite file found; a new persistent order database will be initialized at %s", ORDERS_DB_PATH)


_bootstrap_orders_database()
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

@app.get("/api/my-orders")
async def get_customer_orders(x_telegram_init_data: str | None = Header(default=None), limit: int = 20) -> dict[str, Any]:
    if not BOT_TOKEN:
        raise HTTPException(status_code=503, detail="Сервис заказов временно не настроен.")
    if not x_telegram_init_data:
        raise HTTPException(status_code=401, detail="Откройте магазин через Telegram, чтобы посмотреть заказы.")
    try:
        auth = verify_telegram_init_data(x_telegram_init_data, BOT_TOKEN)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    telegram_id = int(auth["user"]["id"])
    safe_limit = max(1, min(int(limit), 50))
    with order_db() as connection:
        rows = connection.execute(
            "SELECT order_id,created_at,customer_name,pickup_time,notes,items_json,total,status FROM orders WHERE telegram_id=? ORDER BY created_at DESC LIMIT ?",
            (telegram_id, safe_limit),
        ).fetchall()
    orders = []
    for row in rows:
        item = dict(row)
        item["items"] = json.loads(item.pop("items_json"))
        orders.append(item)
    return {"orders": orders}

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
    valid_rows = [row for row in rows if row["status"] != "cancelled"]
    revenue = sum(int(row["total"] or 0) for row in valid_rows)
    gross_profit = sum(
        sum(int(item.get("gross_profit", 0)) for item in json.loads(row["items_json"]))
        for row in valid_rows
    )
    active_orders = sum(row["status"] not in ("completed", "cancelled") for row in rows)
    status_counts = {status: sum(row["status"] == status for row in rows) for status in VALID_ORDER_STATUSES}
    popular: dict[str, int] = {}
    for row in valid_rows:
        for item in json.loads(row["items_json"]):
            name = str(item.get("name", item.get("id", "Блюдо")))
            popular[name] = popular.get(name, 0) + int(item.get("qty", 0))
    daily: dict[str, dict[str, Any]] = {}
    for row in rows:
        try:
            day = datetime.fromisoformat(str(row["created_at"])).date().isoformat()
        except (TypeError, ValueError):
            continue
        entry = daily.setdefault(day, {"date": day, "orders": 0, "revenue": 0})
        entry["orders"] += 1
        if row["status"] != "cancelled":
            entry["revenue"] += int(row["total"] or 0)
    daily_rows = sorted(daily.values(), key=lambda item: item["date"])[-30:]
    valid_count = len(valid_rows)
    return {
        "orders_count": len(rows),
        "valid_orders_count": valid_count,
        "revenue": revenue,
        "average_check": round(revenue / valid_count) if valid_count else 0,
        "gross_profit": gross_profit,
        "active_orders": active_orders,
        "status_counts": status_counts,
        "daily": daily_rows,
        "popular_items": sorted(
            [{"name": name, "qty": qty} for name, qty in popular.items()],
            key=lambda item: item["qty"],
            reverse=True,
        )[:10],
    }

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
STORE_SETTINGS_FILE = os.getenv("STORE_SETTINGS_FILE", os.path.join(os.path.dirname(__file__), "store_settings.json"))
DEFAULT_STORE_SETTINGS = {
    "shop_name": "Тихий ролл",
    "phone": "+7 923 000-58-57",
    "description": "Свежие роллы и азиатские блюда, приготовленные к выбранному времени.",
    "pickup_address": "Социалистическая, 26, район «Остров», Чарышское",
    "pickup_map_url": "https://yandex.ru/maps/?text=%D0%A2%D0%B8%D1%85%D0%B8%D0%B9%20%D1%80%D0%BE%D0%BB%D0%BB%2C%20%D0%A1%D0%BE%D1%86%D0%B8%D0%B0%D0%BB%D0%B8%D1%81%D1%82%D0%B8%D1%87%D0%B5%D1%81%D0%BA%D0%B0%D1%8F%2C%2026%2C%20%D0%A7%D0%B0%D1%80%D1%8B%D1%88%D1%81%D0%BA%D0%BE%D0%B5",
    "pickup_enabled": True,
    "delivery_enabled": True,
    "minimum_order": 0,
    "delivery_note": "Стоимость и возможность доставки подтвердим отдельно после получения заказа.",
    "delivery_zones": [],
    "weekly_hours": [
        {"day": "Понедельник", "open": "12:00", "close": "21:00", "closed": False},
        {"day": "Вторник", "open": "12:00", "close": "21:00", "closed": False},
        {"day": "Среда", "open": "", "close": "", "closed": True},
        {"day": "Четверг", "open": "12:00", "close": "21:00", "closed": False},
        {"day": "Пятница", "open": "12:00", "close": "21:00", "closed": False},
        {"day": "Суббота", "open": "12:00", "close": "21:00", "closed": False},
        {"day": "Воскресенье", "open": "", "close": "", "closed": True},
    ],
}

def _valid_clock(value: Any) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value))

def validate_store_settings(payload: dict[str, Any], current: dict[str, Any] | None = None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Настройки должны быть объектом.")
    result = dict(current or DEFAULT_STORE_SETTINGS)
    text_limits = {
        "shop_name": 80, "phone": 50, "description": 300,
        "pickup_address": 300, "delivery_note": 300,
    }
    for key, limit in text_limits.items():
        if key in payload:
            value = payload[key]
            if not isinstance(value, str) or len(value.strip()) > limit:
                raise ValueError(f"Поле {key}: проверь длину текста.")
            result[key] = value.strip()
    if "pickup_map_url" in payload:
        value = payload["pickup_map_url"]
        if not isinstance(value, str) or len(value) > 1000 or (value and not value.startswith("https://")):
            raise ValueError("Ссылка на карту должна начинаться с HTTPS.")
        result["pickup_map_url"] = value.strip()
    for key in ("pickup_enabled", "delivery_enabled"):
        if key in payload:
            if not isinstance(payload[key], bool):
                raise ValueError(f"Поле {key} должно быть переключателем.")
            result[key] = payload[key]
    if "minimum_order" in payload:
        value = payload["minimum_order"]
        if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 100000:
            raise ValueError("Минимальная сумма заказа должна быть от 0 до 100 000 ₽.")
        result["minimum_order"] = value
    if "weekly_hours" in payload:
        hours = payload["weekly_hours"]
        if not isinstance(hours, list) or len(hours) != 7:
            raise ValueError("График должен содержать ровно семь дней.")
        clean_hours = []
        for index, row in enumerate(hours):
            if not isinstance(row, dict):
                raise ValueError(f"График: неверная запись для дня {index + 1}.")
            day = str(row.get("day", DEFAULT_STORE_SETTINGS["weekly_hours"][index]["day"]))[:30]
            closed = row.get("closed", False)
            opened, closed_at = row.get("open", ""), row.get("close", "")
            if not isinstance(closed, bool):
                raise ValueError("Признак выходного дня должен быть true/false.")
            if not closed and (not _valid_clock(opened) or not _valid_clock(closed_at) or opened >= closed_at):
                raise ValueError(f"Укажи корректное время открытия и закрытия для дня «{day}».")
            clean_hours.append({"day": day, "open": "" if closed else opened, "close": "" if closed else closed_at, "closed": closed})
        result["weekly_hours"] = clean_hours
    if "delivery_zones" in payload:
        zones = payload["delivery_zones"]
        if not isinstance(zones, list) or len(zones) > 10:
            raise ValueError("Можно добавить не более десяти зон доставки.")
        clean_zones = []
        for index, zone in enumerate(zones):
            if not isinstance(zone, dict):
                raise ValueError(f"Зона доставки {index + 1}: неверный формат.")
            name = zone.get("name", "")
            fee = zone.get("fee", 0)
            active = zone.get("active", True)
            radius = zone.get("radius_km", 0)
            if not isinstance(name, str) or not name.strip() or len(name.strip()) > 80:
                raise ValueError(f"Зона доставки {index + 1}: укажи название до 80 символов.")
            if not isinstance(fee, int) or isinstance(fee, bool) or not 0 <= fee <= 20000:
                raise ValueError(f"Зона доставки {index + 1}: стоимость должна быть от 0 до 20 000 ₽.")
            if not isinstance(active, bool):
                raise ValueError(f"Зона доставки {index + 1}: неверный статус.")
            if not isinstance(radius, (int, float)) or isinstance(radius, bool) or not 0 <= float(radius) <= 100:
                raise ValueError(f"Зона доставки {index + 1}: радиус должен быть от 0 до 100 км.")
            clean_zones.append({"name": name.strip(), "fee": fee, "active": active, "radius_km": float(radius)})
        result["delivery_zones"] = clean_zones
    return result

def read_store_settings() -> dict[str, Any]:
    try:
        with open(STORE_SETTINGS_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict):
            return validate_store_settings(data, DEFAULT_STORE_SETTINGS)
    except (OSError, json.JSONDecodeError, ValueError):
        pass
    return json.loads(json.dumps(DEFAULT_STORE_SETTINGS, ensure_ascii=False))

def write_store_settings(settings: dict[str, Any]) -> None:
    folder = os.path.dirname(STORE_SETTINGS_FILE)
    if folder:
        os.makedirs(folder, exist_ok=True)
    temporary = STORE_SETTINGS_FILE + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(settings, handle, ensure_ascii=False, indent=2)
    os.replace(temporary, STORE_SETTINGS_FILE)

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
        {"id":"solo","description":"Филадельфия и Лава — для уютного ужина.","image":"","photos":[],"items":[{"id":"philadelphia","qty":1},{"id":"lava","qty":1}],"active":True,"stock":None},
        {"id":"duo","description":"Филадельфия, Тёплый краб и Лава — поделиться вкусом.","image":"","photos":[],"items":[{"id":"philadelphia","qty":1},{"id":"warm_crab","qty":1},{"id":"lava","qty":1}],"active":True,"stock":None},
        {"id":"party","description":"Две Филадельфии, Лава, Тёплый краб и Тёплый лосось.","image":"","photos":[],"items":[{"id":"philadelphia","qty":2},{"id":"lava","qty":1},{"id":"warm_crab","qty":1},{"id":"warm_salmon","qty":1}],"active":True,"stock":None},
        {"id":"newyear","description":"Праздничная подборка: Филадельфия, Калифорния, Лава, Тёплый краб и Тёплый лосось.","image":"","photos":[],"items":[{"id":"philadelphia","qty":1},{"id":"california","qty":1},{"id":"lava","qty":1},{"id":"warm_crab","qty":1},{"id":"warm_salmon","qty":1}],"active":True,"stock":None},
        {"id":"autumn","description":"Осенний сет «Хорошее настроение»: любимые роллы с рыбой, нежным сыром и насыщенными соусами для уютного вечера.","image":"","photos":[],"items":[{"id":"philadelphia","qty":1},{"id":"lava","qty":1},{"id":"california","qty":1},{"id":"unagi","qty":1}],"active":True,"stock":None},
        {"id":"winter","description":"Зимний сет «Согревающий»: горячие роллы и азиатские хот-доги — сытное сочетание для холодного вечера.","image":"","photos":[],"items":[{"id":"warm_crab","qty":1},{"id":"warm_salmon","qty":1},{"id":"asian_hotdog_chicken","qty":1},{"id":"asian_hotdog_shrimp","qty":1}],"active":True,"stock":None},
        {"id":"spring","description":"Весенний сет «Цветение»: лёгкое сочетание роллов с рыбой, свежими овощами и нежными вкусами.","image":"","photos":[],"items":[{"id":"philadelphia","qty":1},{"id":"california","qty":1},{"id":"lava","qty":1}],"active":True,"stock":None},
        {"id":"summer","description":"Летний сет «Охлаждающий»: сочные роллы и хрустящие закуски для яркого летнего перекуса.","image":"","photos":[],"items":[{"id":"unagi","qty":1},{"id":"california","qty":1},{"id":"asian_hotdog_shrimp","qty":1},{"id":"snack_tempura_shrimp","qty":1}],"active":True,"stock":None}
    ],
    "promo_title":"Закажи к удобному времени",
    "promo_text":"Выбирай блюда заранее — мы приготовим заказ к согласованному времени.",
    "promo_button":"Перейти к меню",
    "promo_link":"#menu",
    "promo_image":""
}
DEFAULT_SEASONAL_BANNERS = [
    {"id": "newyear", "active": True},
    {"id": "autumn", "active": True},
    {"id": "winter", "active": True},
    {"id": "spring", "active": True},
    {"id": "summer", "active": True},
]
DEFAULT_SET_ITEMS = {
    "solo": [{"id": "philadelphia", "qty": 1}, {"id": "lava", "qty": 1}],
    "duo": [{"id": "philadelphia", "qty": 1}, {"id": "warm_crab", "qty": 1}, {"id": "lava", "qty": 1}],
    "party": [{"id": "philadelphia", "qty": 2}, {"id": "lava", "qty": 1}, {"id": "warm_crab", "qty": 1}, {"id": "warm_salmon", "qty": 1}],
    "newyear": [{"id": "philadelphia", "qty": 1}, {"id": "california", "qty": 1}, {"id": "lava", "qty": 1}, {"id": "warm_crab", "qty": 1}, {"id": "warm_salmon", "qty": 1}],
    "autumn": [{"id": "philadelphia", "qty": 1}, {"id": "lava", "qty": 1}, {"id": "california", "qty": 1}, {"id": "unagi", "qty": 1}],
    "winter": [{"id": "warm_crab", "qty": 1}, {"id": "warm_salmon", "qty": 1}, {"id": "asian_hotdog_chicken", "qty": 1}, {"id": "asian_hotdog_shrimp", "qty": 1}],
    "spring": [{"id": "philadelphia", "qty": 1}, {"id": "california", "qty": 1}, {"id": "lava", "qty": 1}],
    "summer": [{"id": "unagi", "qty": 1}, {"id": "california", "qty": 1}, {"id": "asian_hotdog_shrimp", "qty": 1}, {"id": "snack_tempura_shrimp", "qty": 1}],
}
def read_site_content() -> dict[str, Any]:
    try:
        with open(SITE_CONTENT_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict):
            merged = dict(DEFAULT_SITE_CONTENT)
            merged.update(data)
            merged["slides"] = data.get("slides", DEFAULT_SITE_CONTENT["slides"])
            saved_sets = data.get("sets", DEFAULT_SITE_CONTENT["sets"])
            default_by_id = {row["id"]: row for row in DEFAULT_SITE_CONTENT["sets"]}
            merged_sets = []
            for row in saved_sets if isinstance(saved_sets, list) else DEFAULT_SITE_CONTENT["sets"]:
                if not isinstance(row, dict):
                    continue
                defaults = default_by_id.get(row.get("id"), {})
                merged_row = dict(defaults)
                merged_row.update(row)
                merged_row.setdefault("items", DEFAULT_SET_ITEMS.get(merged_row.get("id"), []))
                merged_row.setdefault("active", True)
                merged_row.setdefault("stock", None)
                merged_sets.append(merged_row)
            present_set_ids = {row.get("id") for row in merged_sets}
            merged_sets.extend(dict(row) for row in DEFAULT_SITE_CONTENT["sets"] if row["id"] not in present_set_ids)
            merged["sets"] = merged_sets
            saved_banners = data.get("seasonal_banners", DEFAULT_SEASONAL_BANNERS)
            banner_by_id = {row["id"]: row for row in DEFAULT_SEASONAL_BANNERS}
            merged_banners = []
            for row in saved_banners if isinstance(saved_banners, list) else DEFAULT_SEASONAL_BANNERS:
                if not isinstance(row, dict) or row.get("id") not in banner_by_id:
                    continue
                banner = dict(banner_by_id[row["id"]])
                banner.update(row)
                banner["active"] = banner.get("active") is not False
                merged_banners.append(banner)
            present_banner_ids = {row["id"] for row in merged_banners}
            merged_banners.extend(dict(row) for row in DEFAULT_SEASONAL_BANNERS if row["id"] not in present_banner_ids)
            merged["seasonal_banners"] = merged_banners
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

@app.get("/api/store-settings")
async def get_store_settings() -> dict[str, Any]:
    return read_store_settings()

@app.get("/api/admin/store-settings")
async def admin_get_store_settings(x_telegram_init_data: str | None = Header(default=None)) -> dict[str, Any]:
    admin_from_header(x_telegram_init_data)
    return {
        "settings": read_store_settings(),
        "integrations": {
            "telegram_orders": bool(BOT_TOKEN and ADMIN_CHAT_ID),
            "telegram_customer_updates": bool(BOT_TOKEN),
            "online_payments": False,
            "whatsapp": False,
        },
    }

@app.put("/api/admin/store-settings")
async def admin_update_store_settings(payload: dict[str, Any], x_telegram_init_data: str | None = Header(default=None)) -> dict[str, Any]:
    admin_from_header(x_telegram_init_data)
    try:
        updated = validate_store_settings(payload, read_store_settings())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    write_store_settings(updated)
    return {"ok": True, "settings": updated}

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
        allowed_set_ids = {"solo", "duo", "party", "newyear", "autumn", "winter", "spring", "summer"}
        if not isinstance(sets, list) or len(sets) > 8:
            raise HTTPException(status_code=400, detail="Можно настроить не более 8 готовых сетов.")
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
            items = item.get("items", DEFAULT_SET_ITEMS[set_id])
            if not isinstance(items, list) or not items or len(items) > 12:
                raise HTTPException(status_code=400, detail=f"Сет {index+1}: укажи от 1 до 12 позиций.")
            available_ids = {str(product.get("id")) for product in read_products()}
            clean_items = []
            used_item_ids = set()
            for item_index, row in enumerate(items):
                if not isinstance(row, dict):
                    raise HTTPException(status_code=400, detail=f"Сет {index+1}, позиция {item_index+1}: неверный формат.")
                product_id = row.get("id")
                quantity = row.get("qty", 1)
                if product_id not in available_ids or product_id in used_item_ids:
                    raise HTTPException(status_code=400, detail=f"Сет {index+1}: товар не найден или повторяется.")
                if not isinstance(quantity, int) or isinstance(quantity, bool) or not 1 <= quantity <= 50:
                    raise HTTPException(status_code=400, detail=f"Сет {index+1}: количество позиции должно быть от 1 до 50.")
                clean_items.append({"id": product_id, "qty": quantity})
                used_item_ids.add(product_id)
            active = item.get("active", True)
            stock = item.get("stock")
            if not isinstance(active, bool):
                raise HTTPException(status_code=400, detail=f"Сет {index+1}: признак активности должен быть true/false.")
            if stock is not None and (not isinstance(stock, int) or isinstance(stock, bool) or not 0 <= stock <= 10000):
                raise HTTPException(status_code=400, detail=f"Сет {index+1}: остаток должен быть пустым (без учёта) или от 0 до 10 000.")
            clean_sets.append({"id": set_id, "description": description.strip(), "image": image.strip(), "photos": clean_photos, "items": clean_items, "active": active, "stock": stock})
            seen.add(set_id)
        current["sets"] = clean_sets
    if "seasonal_banners" in payload:
        banners = payload["seasonal_banners"]
        allowed_banner_ids = {"newyear", "autumn", "winter", "spring", "summer"}
        if not isinstance(banners, list) or len(banners) > 5:
            raise HTTPException(status_code=400, detail="Можно настроить не более 5 баннеров.")
        clean_banners = []
        seen_banner_ids = set()
        for index, banner in enumerate(banners):
            if not isinstance(banner, dict):
                raise HTTPException(status_code=400, detail=f"Баннер {index+1}: неверный формат.")
            banner_id = banner.get("id")
            active = banner.get("active", True)
            if banner_id not in allowed_banner_ids or banner_id in seen_banner_ids:
                raise HTTPException(status_code=400, detail=f"Баннер {index+1}: неизвестный или повторяющийся ID.")
            if not isinstance(active, bool):
                raise HTTPException(status_code=400, detail=f"Баннер {index+1}: признак видимости должен быть true/false.")
            clean_banners.append({"id": banner_id, "active": active})
            seen_banner_ids.add(banner_id)
        for default_banner in DEFAULT_SEASONAL_BANNERS:
            if default_banner["id"] not in seen_banner_ids:
                clean_banners.append(dict(default_banner))
        current["seasonal_banners"] = clean_banners
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
        "sets": [{"id": item.id, "qty": item.qty} for item in payload.sets],
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

        # Re-check managed stock while holding the order lock so concurrent orders cannot oversell.
        try:
            items, total = calculate_order(payload.items)
            saved_sets = read_site_content().get("sets", [])
            sets_by_id = {str(row.get("id")): row for row in saved_sets if isinstance(row, dict)}
            required_products: dict[str, int] = {}
            seen_set_ids: set[str] = set()
            for requested_set in payload.sets:
                if requested_set.id in seen_set_ids:
                    raise ValueError("Один и тот же сет не может повторяться в составе заказа.")
                seen_set_ids.add(requested_set.id)
                set_row = sets_by_id.get(requested_set.id)
                if not set_row or set_row.get("active") is False:
                    raise ValueError("Один из выбранных сетов временно недоступен.")
                set_stock = set_row.get("stock")
                if set_stock is not None and requested_set.qty > int(set_stock):
                    raise ValueError(f"Сета «{requested_set.id}» осталось: {int(set_stock)}.")
                composition = set_row.get("items") or DEFAULT_SET_ITEMS.get(requested_set.id, [])
                for component in composition:
                    product_id = str(component.get("id", ""))
                    required_products[product_id] = required_products.get(product_id, 0) + int(component.get("qty", 0)) * requested_set.qty
            cart_quantities = {item.id: item.qty for item in payload.items}
            if any(cart_quantities.get(product_id, 0) < required for product_id, required in required_products.items()):
                raise ValueError("Состав корзины не совпадает с выбранными сетами. Обновите корзину и попробуйте ещё раз.")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

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

        # Decrement explicitly managed stock only after Telegram accepted the order.
        stock_by_id = {item["id"]: item["qty"] for item in items}
        if stock_by_id:
            products_on_disk = read_products()
            changed_stock = False
            for product in products_on_disk:
                product_id = str(product.get("id", ""))
                if product_id in stock_by_id:
                    available_stock = product.get("stock")
                    if available_stock is not None:
                        product["stock"] = max(0, int(available_stock) - stock_by_id[product_id])
                        changed_stock = True
            if changed_stock:
                write_products(products_on_disk)
        if payload.sets:
            site_content = read_site_content()
            content_sets = [dict(row) for row in site_content.get("sets", []) if isinstance(row, dict)]
            requested_counts = {row.id: row.qty for row in payload.sets}
            for set_row in content_sets:
                set_id = str(set_row.get("id", ""))
                if set_id in requested_counts and set_row.get("stock") is not None:
                    set_row["stock"] = max(0, int(set_row.get("stock", 0)) - requested_counts[set_id])
            site_content["sets"] = content_sets
            write_site_content(site_content)

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
