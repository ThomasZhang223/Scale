FROM python:3.11.9-slim-bookworm

WORKDIR /app

COPY requirements-embedding-linux-py311.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements-embedding-linux-py311.txt

COPY app ./app

ENV EMBEDDING_CACHE_DIR=/models \
    EMBEDDING_RESULT_CACHE=/data/embeddings.sqlite3 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8004
# Mount an explicitly downloaded model cache and set EMBEDDING_CACHE_DIR/API_KEY.
# One worker keeps one model resident; ordinary startup never downloads weights.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8004", "--workers", "1"]
