from datetime import datetime, timedelta
from jose import JWTError, jwt
import bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
import database, models

import os

SECRET_KEY = os.getenv("JWT_SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("JWT_SECRET_KEY not set. Add it to backend/.env")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7 # 7 days

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/auth/login")

def verify_password(plain_password, hashed_password):
    return bcrypt.checkpw(plain_password.encode('utf-8'), hashed_password.encode('utf-8'))

def get_password_hash(password):
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

from typing import Optional

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=15)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(database.get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email: str = payload.get("sub")
        if email is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
        
    user = db.query(models.User).filter(models.User.email == email).first()
    if user is None:
        raise credentials_exception
    return user

import httpx

async def get_current_supabase_user(token: str = Depends(oauth2_scheme)):

    supabase_url = os.getenv("SUPABASE_URL")
    supabase_anon_key = os.getenv("SUPABASE_ANON_KEY")

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate Supabase credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not supabase_url or not supabase_anon_key:
        raise HTTPException(
            status_code=500,
            detail="Supabase is not configured on the server."
        )
    
    url = f"{supabase_url}/auth/v1/user"
    headers = {
        "Authorization": f"Bearer {token}",
        "apikey": supabase_anon_key
    }
    
    # Handle mock guest tokens directly without hitting Supabase
    if token.startswith("guest_"):
        return {
            "id": token,
            "email": "guest@tripco.app",
            "token": token
        }
    
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(url, headers=headers)
            if resp.status_code != 200:
                raise credentials_exception
            user_data = resp.json()
            # Inject token in user_data to make it available for PostgREST calls
            user_data["token"] = token
            return user_data
        except Exception:
            raise credentials_exception
