# Garmin bridge — tiny FastAPI service over garth/garminconnect.
FROM python:3.12-slim

WORKDIR /app

# Deps first for layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py garmin_client.py garmin_login.py ./

# Token dir is a mounted volume (never baked into the image). Default matches
# docker-compose's volume mount + GARMIN_TOKENSTORE.
ENV GARMIN_TOKENSTORE=/tokens

EXPOSE 8655

# Single worker: garminconnect holds one authenticated session; the client
# serialises calls behind a lock anyway.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8655", "--workers", "1"]
