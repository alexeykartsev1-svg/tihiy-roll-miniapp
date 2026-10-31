"""Offline smoke tests: python test_backend.py"""
import hashlib
import hmac
import json
import time
from urllib.parse import urlencode

from main import MENU, OrderItem, ProductPayload, calculate_order, verify_telegram_init_data


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
    try:
        ProductPayload(
            id="bad_roll",
            name="Неверный ролл",
            price=350,
            gallery=["file:///tmp/photo.jpg"],
        )
        raise AssertionError("Unsafe gallery source should fail")
    except Exception:
        pass

    items, total = calculate_order([OrderItem(id="philadelphia", qty=1), OrderItem(id="warm_salmon", qty=2)])
    assert total == MENU["philadelphia"]["price"] + 2 * MENU["warm_salmon"]["price"]
    assert len(items) == 2
    print("OK: Telegram initData checks, product gallery schema and server-side price calculation passed.")


if __name__ == "__main__":
    main()
