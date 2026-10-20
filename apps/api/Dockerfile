FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY apps/engine /engine
COPY apps/api/requirements.txt .
RUN grep -v '^-e ../engine' requirements.txt > req.txt && pip install -r req.txt /engine

COPY apps/api/app ./app

EXPOSE 5182

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "5182"]
