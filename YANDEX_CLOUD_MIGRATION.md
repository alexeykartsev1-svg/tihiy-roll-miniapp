# Тихий ролл — подготовка backend к Yandex Cloud

Этот файл описывает безопасную подготовку контейнера. Он **не переключает** рабочий магазин и не отключает Render.

## Что обнаружено в текущем backend

- Python / FastAPI, запуск: `uvicorn main:app`.
- Render service: `tihiy-roll-order-api`, root directory: `backend`.
- Данные админки хранятся в JSON-файлах: товары, категории, настройки магазина и контент сайта.
- История заказов хранится в SQLite. Текущий fallback-путь в коде: `/tmp/tihiy_roll_orders.sqlite3`.
- Отправка заказов выполняется сервером напрямую через HTTPS к Telegram Bot API.
- PostgreSQL в подключённом Render workspace не найден.

## Что подготовлено

`backend/Dockerfile` собирает существующий FastAPI backend и задаёт постоянные пути данных под `/var/lib/tihiy-roll`.

Для production этот каталог должен быть смонтирован на отдельный постоянный диск/том. Не хранить рабочие JSON и SQLite только внутри контейнера: при пересоздании контейнера такой слой может исчезнуть.

## Переменные окружения

Перенести значения из Render в защищённые переменные окружения новой VM (не добавлять их в Git, Dockerfile, логи или этот документ):

- `BOT_TOKEN`
- `ADMIN_CHAT_ID`
- `ADMIN_TELEGRAM_ID`
- `ALLOWED_ORIGINS` — origin опубликованного Mini App; сейчас backend по умолчанию ожидает `https://alexeykartsev1-svg.github.io`
- `MAX_INIT_DATA_AGE_SECONDS` — необязательно, по умолчанию 86400
- `LOG_LEVEL` — необязательно, по умолчанию INFO

Пути данных уже заданы в Dockerfile:
- `PRODUCTS_FILE=/var/lib/tihiy-roll/products.json`
- `CATEGORIES_FILE=/var/lib/tihiy-roll/categories.json`
- `ORDERS_DB_PATH=/var/lib/tihiy-roll/orders.sqlite3`
- `STORE_SETTINGS_FILE=/var/lib/tihiy-roll/store_settings.json`
- `SITE_CONTENT_FILE=/var/lib/tihiy-roll/site_content.json`

## Предварительная сборка и локальная проверка

Из каталога `backend/`:

```bash
docker build -t tihiy-roll-api:staging .
docker run --rm -p 8080:8080 \
  -e BOT_TOKEN='set-outside-git' \
  -e ADMIN_CHAT_ID='set-outside-git' \
  -e ADMIN_TELEGRAM_ID='set-outside-git' \
  -e ALLOWED_ORIGINS='https://alexeykartsev1-svg.github.io' \
  -v tihiy-roll-data:/var/lib/tihiy-roll \
  tihiy-roll-api:staging
```

Проверка health endpoint:

```bash
curl --fail http://127.0.0.1:8080/health
```

Не запускать тестовый заказ на реальном ADMIN_CHAT_ID без отдельного согласования.

## План переноса данных

Перед запуском новой копии получить согласованный snapshot со старого сервера, если данные доступны:

1. `products.json`
2. `categories.json`
3. `store_settings.json`
4. `site_content.json`
5. SQLite файл по фактическому значению `ORDERS_DB_PATH` (если он существует и нужен)

Копировать файлы только после согласованной короткой паузы изменений в админке, чтобы snapshot был целостным. Сначала сделать отдельную резервную копию. Не заменять файлы на новой VM пустыми defaults.

Важно: подключённый Render service сейчас отображается на плане Free и без найденной PostgreSQL. Текущий путь SQLite по умолчанию — `/tmp`, поэтому долговременное сохранение истории заказов на Render не подтверждено. До переключения нужно выяснить, настроен ли persistent disk и переопределён ли `ORDERS_DB_PATH`.

## Проверки до переключения DNS / frontend

- VM доступна по SSH только с доверенных адресов; firewall открывает наружу только необходимые порты.
- Постоянный диск смонтирован, принадлежит UID 10001 и переживает перезапуск VM.
- `/health` отвечает успешно.
- `/api/menu`, `/api/categories`, `/api/site-content` возвращают ожидаемые данные.
- Авторизация администратора через Telegram initData работает.
- Сохранение товара, категории, баннера и настроек переживает перезапуск контейнера.
- Исходящий HTTPS-запрос с VM к `https://api.telegram.org` проходит; проверить `getMe` с BOT_TOKEN, не раскрывая токен в выводе.
- Тестовый заказ доставляется в согласованный тестовый чат.
- Заказы и история корректно сохраняются в SQLite на постоянном диске.

## Правило переключения

Оставить Render включённым. Переключать frontend на новый API только после всех проверок и после согласованного финального snapshot. Сохранить возможность вернуть прежний API URL. Render не удалять до подтверждения стабильной работы нового сервера.
