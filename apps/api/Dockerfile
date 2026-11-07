FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Application dependencies come from the pinned, hashed lock (CR-034): the
# solver version in the image is the one the lock names, not whatever resolves.
COPY apps/api/requirements.txt .
RUN pip install -r requirements.txt

# The engine is a local package, so it cannot live in a hashed lock; install it
# with --no-deps so the lock stays the only source of third-party versions.
COPY apps/engine /engine
RUN pip install --no-deps /engine

COPY apps/api/app ./app

EXPOSE 5182

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "5182"]
