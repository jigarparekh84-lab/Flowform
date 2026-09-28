FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY apps/api/requirements.txt .
RUN pip install -r requirements.txt

COPY apps/api/app ./app

EXPOSE 5182

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "5182"]
