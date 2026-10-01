from fastapi import HTTPException

from app.db import db
from app.security import verify_password


async def login(email: str, password: str):
    user = await db.get_user(email)
    if not verify_password(password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return {"user_id": user.id, "email": user.email}
