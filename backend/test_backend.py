"""Offline smoke tests: python test_backend.py"""
import asyncio
import hashlib
import hmac
import json
import time
from pydantic import ValidationError
from urllib.parse import urlencode
import tempfile
import os
import main as backend

from main import MENU, OrderItem, ProductPayload, calculate_order, verify_telegram_init_data, DEFAULT_STORE_SETTINGS, validate_store_settings, validate_category_update


def make_init_data(token: str, auth_date: int, user: dict) -> str:
    fields = {
        "auth_date": str(auth_date),
        "query_id": "test-query-id",
        "user": json.dumps(user, ensure_ascii=False, separators=(",", ":")),
    }
    check = "\n".join(f"{key}={value}" for key, value in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


def main() -> None:
    token = "test-token-only-not-a-real-secret"
    now = int(time.time())
    user = {"id": 123456789, "first_name": "Test", "username": "test_user"}
    signed = make_init_data(token, now, user)
    verified = verify_telegram_init_data(signed, token, now=now)
    assert verified["user"]["id"] == user["id"]

    try:
        verify_telegram_init_data(signed.replace("Test", "Attacker"), token, now=now)
        raise AssertionError("Tampered initData should fail")
    except ValueError:
        pass

    stale = make_init_data(token, now - 90000, user)
    try:
        verify_telegram_init_data(stale, token, now=now)
        raise AssertionError("Stale initData should fail")
    except ValueError:
        pass

    catalog_item = ProductPayload(
        id="test_roll",
        name="Тестовый ролл",
        price=350,
        pieces=8,
        details="Рис, нори, лосось",
        gallery=["data:image/jpeg;base64,YQ=="],
    )
    assert catalog_item.pieces == 8
    assert catalog_item.gallery == ["data:image/jpeg;base64,YQ=="]

    # Large image blobs are no longer embedded in catalogue responses.
    image_data = "data:image/jpeg;base64,YQ=="
    image_parts = backend._data_image_parts(image_data)
    assert image_parts is not None and image_parts[0] == "image/jpeg" and image_parts[1] == b"a"
    image_response = backend._serve_data_image(image_data)
    assert image_response.body == b"a"
    assert image_response.headers.get("cache-control") == "public, max-age=31536000, immutable"
    compact_product = backend._catalog_product_payload({
        "id": "test_roll", "name": "Тестовый ролл", "photo": image_data, "gallery": [image_data]
    })
    assert "gallery" not in compact_product and "photo" not in compact_product
    assert compact_product["photo_url"].startswith("https://tihiy-roll-order-api.onrender.com/api/products/test_roll/photo?v=")
    compact_set = backend._catalog_set_payload({
        "id": "test_set", "image": image_data, "photos": [image_data], "items": []
    })
    assert "photos" not in compact_set and "image" not in compact_set
    assert compact_set["image_url"].startswith("https://tihiy-roll-order-api.onrender.com/api/sets/test_set/photo?v=")
    admin_summary = backend._admin_site_content_payload({"sets": [{"id": "test_set", "image": image_data, "photos": [image_data]}]})
    assert "photos" not in admin_summary["sets"][0] and admin_summary["sets"][0]["photos_count"] == 1

    # Set editor metadata is persisted and returned to both admin and storefront payloads.
    original_site_content_file = backend.SITE_CONTENT_FILE
    original_products_file_for_sets = backend.PRODUCTS_FILE
    original_admin_from_header = backend.admin_from_header
    try:
        with tempfile.TemporaryDirectory() as temporary:
            backend.SITE_CONTENT_FILE = os.path.join(temporary, "site-content.json")
            backend.PRODUCTS_FILE = os.path.join(temporary, "products.json")
            backend.write_products([
                {"id": "philadelphia", "name": "Филадельфия", "price": 500, "pieces": 8, "weight": "300 г", "active": True},
                {"id": "lava", "name": "Лава", "price": 450, "pieces": 8, "weight": "280 г", "active": True},
            ])
            backend.admin_from_header = lambda _header: None
            saved_content = asyncio.run(backend.admin_update_site_content({
                "sets": [{
                    "id": "solo", "description": "Карточка", "desc": "Страница", "card_description": "Карточка",
                    "details": "Лосось, сыр, рис, нори", "weight": "640 г", "pieces": 16, "pieces_manual": True, "badge": "ХИТ",
                    "image": "", "photos": [], "items": [{"id": "philadelphia", "qty": 1}, {"id": "lava", "qty": 2}], "active": True, "stock": None
                }]
            }, "test-init-data"))
            saved_set = saved_content["content"]["sets"][0]
            assert saved_set["desc"] == "Страница"
            assert saved_set["card_description"] == "Карточка"
            assert saved_set["description"] == "Карточка"
            assert saved_set["details"] == "Лосось, сыр, рис, нори"
            assert saved_set["weight"] == "640 г" and saved_set["pieces"] == 16
            assert saved_set["pieces_manual"] is True
            assert saved_set["badge"] == "ХИТ"
            assert saved_set["items"] == [{"id": "philadelphia", "qty": 1}, {"id": "lava", "qty": 2}]
            public_set = backend._catalog_set_payload(saved_set)
            assert public_set["desc"] == "Страница" and public_set["details"] == "Лосось, сыр, рис, нори"
            assert public_set["weight"] == "640 г" and public_set["pieces"] == 16 and public_set["pieces_manual"] is True and public_set["badge"] == "ХИТ"
    finally:
        backend.SITE_CONTENT_FILE = original_site_content_file
        backend.PRODUCTS_FILE = original_products_file_for_sets
        backend.admin_from_header = original_admin_from_header
    try:
        ProductPayload(
            id="bad_roll",
            name="Неверный ролл",
            price=350,
            gallery=["file:///tmp/photo.jpg"],
        )
    except ValidationError:
        pass
    else:
        raise AssertionError("Unsafe gallery source should fail")

    items, total = calculate_order([OrderItem(id="philadelphia", qty=1), OrderItem(id="warm_salmon", qty=2)])
    assert total == MENU["philadelphia"]["price"] + 2 * MENU["warm_salmon"]["price"]
    assert len(items) == 2
    # Shop settings validation: valid hours/zones are accepted, malformed data is rejected.
    settings = validate_store_settings({
        "shop_name": "Тихий ролл",
        "delivery_enabled": True,
        "weekly_hours": [
            {"day": "Пн", "open": "10:00", "close": "22:00", "closed": False},
            {"day": "Вт", "open": "10:00", "close": "22:00", "closed": False},
            {"day": "Ср", "open": "", "close": "", "closed": True},
            {"day": "Чт", "open": "10:00", "close": "22:00", "closed": False},
            {"day": "Пт", "open": "10:00", "close": "22:00", "closed": False},
            {"day": "Сб", "open": "10:00", "close": "22:00", "closed": False},
            {"day": "Вс", "open": "", "close": "", "closed": True},
        ],
        "delivery_zones": [{"name": "Центр", "fee": 150, "radius_km": 3, "active": True}],
    }, DEFAULT_STORE_SETTINGS)
    assert settings["delivery_zones"][0]["fee"] == 150
    assert settings["weekly_hours"][2]["closed"] is True
    try:
        validate_store_settings({"pickup_map_url": "javascript:alert(1)"}, settings)
    except ValueError:
        pass
    else:
        raise AssertionError("Unsafe map URL should be rejected")
    try:
        bad_hours = list(settings["weekly_hours"])
        bad_hours[0] = {"day": "Пн", "open": "22:00", "close": "10:00", "closed": False}
        validate_store_settings({"weekly_hours": bad_hours}, settings)
    except ValueError:
        pass
    else:
        raise AssertionError("Invalid opening hours should be rejected")

    # Explicit product stock is enforced by the server-side order calculator; null means unlimited.
    original_products_file = backend.PRODUCTS_FILE
    try:
        with tempfile.TemporaryDirectory() as temporary:
            backend.PRODUCTS_FILE = os.path.join(temporary, "products.json")
            backend.write_products([{
                "id": "limited_roll", "name": "Ограниченный ролл", "price": 300, "cost": 100,
                "weight": "250 г", "pieces": 8, "stock": 2, "active": True
            }])
            _, stock_total = backend.calculate_order([OrderItem(id="limited_roll", qty=2)])
            assert stock_total == 600
            try:
                backend.calculate_order([OrderItem(id="limited_roll", qty=3)])
            except ValueError:
                pass
            else:
                raise AssertionError("Order calculator should reject quantities above managed stock")
            backend.write_products([{
                "id": "unlimited_roll", "name": "Ролл без лимита", "price": 300, "stock": None, "active": True
            }])
            _, unlimited_total = backend.calculate_order([OrderItem(id="unlimited_roll", qty=3)])
            assert unlimited_total == 900
    finally:
        backend.PRODUCTS_FILE = original_products_file

    # Category editing supports rename/order/icon and rejects unsafe image URLs.
    category = {"id": "classic", "name": "Роллы", "sort_order": 0}
    updated = validate_category_update("classic", {"name": "Классические роллы", "sort_order": 2, "icon": "🍣"}, [category])
    assert updated["name"] == "Классические роллы"
    assert updated["sort_order"] == 2
    try:
        validate_category_update("classic", {"image": "javascript:alert(1)"}, [category])
    except ValueError:
        pass
    else:
        raise AssertionError("Unsafe category image URL should be rejected")
    try:
        validate_category_update("missing", {"name": "Нет"}, [category])
    except ValueError:
        pass
    else:
        raise AssertionError("Unknown category should be rejected")

    print("OK: Telegram auth, product/set metadata, galleries, pricing, category and shop settings validation passed.")


if __name__ == "__main__":
    main()
