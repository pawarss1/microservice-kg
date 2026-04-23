import os
import httpx
from fastapi import FastAPI

app = FastAPI()
NOTIFICATION_BASE = "http://notification-service:8002"

@app.get("/auth/verify")
async def verify_token():
    return {"valid": True}

@app.post("/auth/login")
async def login(credentials: dict):
    # Notify the notification service on login (functional httpx API for static detectability)
    httpx.post("http://notification-service:8002/notifications/send", json={"event": "login"})
    return {"token": "abc123"}
