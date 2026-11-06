FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    DATA_DIR=/var/lib/tihiy-roll \
    PRODUCTS_FILE=/var/lib/tihiy-roll/products.json \
    CATEGORIES_FILE=/var/lib/tihiy-roll/categories.json \
    ORDERS_DB_PATH=/var/lib/tihiy-roll/orders.sqlite3 \
    STORE_SETTINGS_FILE=/var/lib/tihiy-roll/store_settings.json \
    SITE_CONTENT_FILE=/var/lib/tihiy-roll/site_content.json

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /var/lib/tihiy-roll \
    && useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app /var/lib/tihiy-roll

USER appuser

EXPOSE 8080

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
