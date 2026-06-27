"""
TripCo Backend — FastAPI + Google Gemini LLM Engine
Generates curated travel itinerary JSON from natural-language queries.
"""

import os
import json
import re
import logging
from datetime import datetime

from fastapi import FastAPI, HTTPException, Depends, status, Query, Request
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, EmailStr
from google import genai
from google.genai import types
from dotenv import load_dotenv
from sqlalchemy.orm import Session
from typing import List, Optional
import httpx

import sys
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import models, database, auth

# Initialize DB tables
models.Base.metadata.create_all(bind=database.engine)

# ── Config ──────────────────────────────────────────────
load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

GEOAPIFY_API_KEY = os.getenv("GEOAPIFY_API_KEY")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")

import asyncio

client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tripco")

# Global cache to prevent re-fetching Gemini trips
generation_cache = {}

# ── FastAPI App ─────────────────────────────────────────
app = FastAPI(title="TripCo API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://localhost:8000",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://tripco.app"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
templates = Jinja2Templates(directory=FRONTEND_DIR)

# ── Route: Serve index.html ─────────────────────────────
@app.get("/manifest.json")
def serve_manifest():
    return FileResponse(os.path.join(FRONTEND_DIR, "manifest.json"))

@app.get("/sw.js")
def serve_sw():
    return FileResponse(os.path.join(FRONTEND_DIR, "sw.js"))

@app.get("/")
def serve_index(request: Request):
    return templates.TemplateResponse("index.html", {
        "request": request,
        "og_title": "TripCo | AI Curated Travel",
        "og_description": "Generate personalized, beautifully curated travel itineraries in seconds with AI.",
        "og_image": "https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&fit=crop&q=80&w=1200&h=630",
        "og_url": "https://tripco.app",
        "google_client_id": GOOGLE_CLIENT_ID or "",
        "supabase_url": SUPABASE_URL or "",
        "supabase_anon_key": SUPABASE_ANON_KEY or ""
    })

@app.get("/trip/{trip_id}")
def serve_trip(request: Request, trip_id: str, db: Session = Depends(database.get_db)):
    trip = db.query(models.Trip).filter(models.Trip.id == trip_id).first()
    if not trip:
        return templates.TemplateResponse("index.html", {
            "request": request,
            "og_title": "Trip Not Found | TripCo",
            "og_description": "We couldn't find this trip.",
            "og_image": "https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&fit=crop&q=80&w=1200&h=630",
            "og_url": f"https://tripco.app/trip/{trip_id}",
            "google_client_id": GOOGLE_CLIENT_ID or "",
            "supabase_url": SUPABASE_URL or "",
            "supabase_anon_key": SUPABASE_ANON_KEY or ""
        })
    
    # Try to grab the first variant's title to make it dynamic
    og_title = "TripCo | AI Curated Travel"
    if trip.variants and len(trip.variants) > 0:
        data = trip.variants[0].data
        if "title" in data:
            og_title = data["title"] + " | TripCo"

    # Default image or extract one from the JSON
    og_image = "https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&fit=crop&q=80&w=1200&h=630"
    if trip.variants and len(trip.variants) > 0:
        data = trip.variants[0].data
        if "spots" in data and len(data["spots"]) > 0:
            og_image = f"https://picsum.photos/seed/{data['spots'][0]['id']}/1200/630"

    return templates.TemplateResponse("index.html", {
        "request": request,
        "og_title": og_title,
        "og_description": f"Check out this curated travel itinerary!",
        "og_image": og_image,
        "og_url": f"https://tripco.app/trip/{trip_id}",
        "google_client_id": GOOGLE_CLIENT_ID or "",
        "supabase_url": SUPABASE_URL or "",
        "supabase_anon_key": SUPABASE_ANON_KEY or ""
    })

# ── Request / Response Models ───────────────────────────
class GenerateRequest(BaseModel):
    query: str
    style: str = "Moderate"
    group: str = "Couple"
    trip_type: str = "city"
    adventure: int = 50
    luxury: int = 50
    food: int = 50
    nature: int = 50

class CopilotRequest(BaseModel):
    message: str
    current_itinerary: dict

class UserCreate(BaseModel):
    email: EmailStr
    password: str
    username: Optional[str] = None

class SocialAuthRequest(BaseModel):
    provider: str
    token: str

class Token(BaseModel):
    access_token: str
    token_type: str

class SyncRequest(BaseModel):
    saved_spots: List[str] = []

# ── System Prompt (City) ───────────────────────────────────────
SYSTEM_PROMPT = """\
You are TripCo AI, an advanced AI Travel Operating System. You don't just plan; you reason, optimize, and assist.
The user will give you a travel query (city, duration, vibe, etc.).
You MUST respond with ONLY a single raw JSON object.

CRITICAL: Act as a multi-agent system (Budget, Hotel, Local Guide, Transit). Prioritize hidden gems, optimize routes to save time, and explain your reasoning.

The JSON MUST match this schema EXACTLY:

{
  "id": "<lowercase-city-name>",
  "tabLabel": "<City Name>",
  "copilotMessage": "<Optional explanation of edits if this is a replan request.>",
  "tripQualityScore": 96,
  "tripQualityBreakdown": [
    {"label": "Budget Efficiency", "score": 92},
    {"label": "Local Experience", "score": 95}
  ],
  "tripDashboard": {
    "walkingDistance": "12 km",
    "weatherSummary": "Mostly Sunny 26°C"
  },
  "packingList": [
    {"item": "Comfortable sneakers", "reason": "For 12km walking"},
    {"item": "Light jacket", "reason": "Chilly evenings"}
  ],
  "riskAlerts": ["<e.g. Heavy rain expected tomorrow>", "<e.g. Museums closed on Mondays>"],
  "tradeoffs": ["<e.g. We chose this central hotel to save 2 hours of transit, though it costs $20 more.>"],
  "suggestedQuestions": [
    "<Discovery Question: e.g. Find me a highly-rated local restaurant for dinner tonight in City>",
    "<Navigation Question: e.g. What is the fastest way to get to the airport from City center?>",
    "<Event Question: e.g. Are there any farmer's markets or local events happening in City this weekend?>",
    "<Contextual Question based on the specific city>"
  ],
  "budget": {
    "min": 500,
    "max": 800,
    "currency": "$",
    "reasoning": "Explanation of budget tradeoffs."
  },
  "hero": {
    "eyebrow": "<Country · Season>",
    "title": "<City Name>",
    "subtitle": "<Short poetic line>",
    "pills": [
      { "text": "<e.g. 2 Days>", "class": "amber" },
      { "text": "<e.g. Hidden Gems>", "class": "sage" }
    ]
  },
  "itineraries": [
    {
      "id": "all",
      "filterLabel": "All Trip",
      "clusters": [
        {
          "id": "<cluster-id>",
          "colorClass": "<amber|sage|slate>",
          "dayTag": "DAY 1",
          "title": "<Title>",
          "subtitle": "<subtitle>",
          "meta": ["3 spots", "~4 hrs"],
          "spots": [
            {
              "id": "<spot-id>",
              "num": "01",
              "type": "<aesthetic|food|transit>",
              "foodType": "<veg|non-veg|both>",
              "name": "<Real Place>",
              "desc": "<1 sentence description.>",
              "reasoning": "<e.g. Selected because it has vegetarian options and is 5 min away.>",
              "rating": "4.5",
              "time": "10:00 AM",
              "lat": 35.123,
              "lng": 139.456,
              "tags": ["Tag1", "Tag2"],
              "menu": {
                "note": "Must try",
                "items": [
                  { "name": "Dish", "price": "$10", "desc": "Short desc", "highlight": true },
                  { "name": "Dish2", "price": "$8", "desc": "Short desc", "highlight": false },
                  { "name": "Dish3", "price": "$6", "desc": "Short desc", "highlight": false }
                ]
              }
            }
          ],
          "transit": { "label": "10 min walk", "sub": "Scenic route" }
        }
      ]
    }
  ]
}

RULES:
1. Output ONLY raw JSON. No markdown, no text.
2. "type": "aesthetic", "food", or "transit" only.
3. "foodType" REQUIRED for food spots.
4. "colorClass": "amber", "sage", or "slate" only.
5. lat/lng MUST be real accurate coordinates.
6. Local currency for prices.
7. Include hidden gems and route optimization reasoning.
8. ALWAYS populate "riskAlerts" and "tradeoffs" to show OS-level intelligence.
"""

# ── System Prompt (Trek) ───────────────────────────────────────
SYSTEM_PROMPT_TREK = """\
You are TripCo AI, an expert Himalayan Trek Guide.
The user will give you a trek name (e.g. Kedarkantha, Hampta Pass). You can generate global treks if requested, but default to Indian treks if vague.
You MUST respond with ONLY a single raw JSON object matching the exact schema below, adapting it for a trek.

CRITICAL: Keep output COMPACT. Generate exactly 1 itinerary ("all"). Clusters represent Trekking Days. Spots represent waypoints, lunch spots, or campsites. 

The JSON MUST match this schema EXACTLY:

{
  "id": "<lowercase-trek-name>",
  "tabLabel": "<Trek Name>",
  "budget": {
    "min": 8000,
    "max": 12000,
    "currency": "₹",
    "reasoning": "Standard trek package cost plus local transport to basecamp."
  },
  "hero": {
    "eyebrow": "<Region · State>",
    "title": "<Trek Name>",
    "subtitle": "<Short poetic line about the trek>",
    "pills": [
      { "text": "<e.g. Difficulty: Moderate>", "class": "amber" },
      { "text": "<e.g. Max Alt: 12,500ft>", "class": "slate" },
      { "text": "<e.g. 6 Days>", "class": "sage" }
    ]
  },
  "itineraries": [
    {
      "id": "all",
      "filterLabel": "Trek Itinerary",
      "clusters": [
        {
          "id": "day-1",
          "colorClass": "<amber|sage|slate>",
          "dayTag": "DAY 1",
          "title": "<Start Point> to <End Point>",
          "subtitle": "Basecamp journey or trekking day",
          "meta": ["Distance: 5km", "Altitude: 9,000ft"],
          "spots": [
            {
              "id": "<waypoint-id>",
              "num": "01",
              "type": "aesthetic",
              "name": "<Campsite or Waypoint Name>",
              "desc": "<1 sentence about the trail or view.>",
              "rating": "5.0",
              "time": "08:00 AM",
              "lat": 31.123,
              "lng": 78.456,
              "tags": ["Mountain", "Trail"]
            }
          ],
          "transit": { "label": "Trekking", "sub": "Steep ascent" }
        }
      ]
    }
  ]
}

RULES:
1. Output ONLY raw JSON. No markdown.
2. "type" MUST be "aesthetic" for all spots (no food/menus for treks).
3. "colorClass": "amber", "sage", or "slate" only.
4. lat/lng MUST be approximate real coordinates for the trek.
5. Unique ids everywhere.
6. Max 6 clusters (days), max 3 spots each.
7. Budget in INR if India, otherwise local currency.
"""


# ── Endpoint ────────────────────────────────────────────
@app.post("/api/generate-city")
async def generate_city(req: GenerateRequest, current_user = Depends(auth.get_current_supabase_user)):
    query = req.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query cannot be empty.")

    # Rate Limiting via Supabase (skip for guests since they use mock tokens)
    if not current_user['id'].startswith("guest_"):
        today_str = datetime.utcnow().strftime("%Y-%m-%d")
        headers = {
            "Authorization": f"Bearer {current_user['token']}",
            "apikey": SUPABASE_ANON_KEY,
            "Prefer": "return=representation"
        }
        
        async with httpx.AsyncClient() as http_client:
            url = f"{SUPABASE_URL}/rest/v1/rate_limits?user_id=eq.{current_user['id']}&date_str=eq.{today_str}"
            resp = await http_client.get(url, headers=headers)
            limits = resp.json() if resp.status_code == 200 else []
            
            if limits:
                limit = limits[0]
                if limit["count"] >= 20:
                    raise HTTPException(status_code=429, detail="You have reached your daily limit of 20 AI generations.")
                
                # Update count
                new_count = limit["count"] + 1
                update_url = f"{SUPABASE_URL}/rest/v1/rate_limits?user_id=eq.{current_user['id']}&date_str=eq.{today_str}"
                await http_client.patch(update_url, headers=headers, json={"count": new_count})
            else:
                # Insert new limit
                insert_url = f"{SUPABASE_URL}/rest/v1/rate_limits"
                await http_client.post(insert_url, headers=headers, json={
                    "user_id": current_user["id"],
                    "date_str": today_str,
                    "count": 1
                })

    logger.info(f"Generating itinerary for: {query} (User ID: {current_user['id']})")

    trip_type = req.trip_type.lower()
    if trip_type == "trek":
        cache_key = f"trek_{query.lower().replace(' ', '-')}"
    else:
        cache_key = f"{query.lower().replace(' ', '-')}_{req.style.lower()}_{req.group.lower()}"
    cache_key = re.sub(r'[^a-z0-9_-]', '', cache_key)
    
    if cache_key in generation_cache:
        logger.info(f"Returning IN-MEMORY CACHED itinerary for: {cache_key}")
        data = generation_cache[cache_key]
    else:
        # Check global 'trips' table in Supabase
        db_cache_hit = False
        if SUPABASE_URL and SUPABASE_ANON_KEY:
            try:
                async with httpx.AsyncClient() as http_client:
                    db_cache_url = f"{SUPABASE_URL}/rest/v1/trips?id=eq.{cache_key}&select=trip_data"
                    admin_headers = {
                        "apikey": SUPABASE_ANON_KEY,
                        "Authorization": f"Bearer {SUPABASE_ANON_KEY}"
                    }
                    resp = await http_client.get(db_cache_url, headers=admin_headers)
                    if resp.status_code == 200 and resp.json():
                        logger.info(f"Returning DB CACHED itinerary for: {cache_key}")
                        data = resp.json()[0]['trip_data']
                        generation_cache[cache_key] = data
                        db_cache_hit = True
            except Exception as e:
                logger.error(f"Failed to read from DB cache: {e}")

        if not db_cache_hit:
            if trip_type == "trek":
                base_query = f"Trek Name: {query}"
                active_system_prompt = SYSTEM_PROMPT_TREK
            else:
                base_query = f"Query: {query}\nTravel Style: {req.style}\nGroup Size: {req.group}\nPersonality Sliders (1-100):\n- Adventure: {req.adventure}\n- Luxury: {req.luxury}\n- Food: {req.food}\n- Nature: {req.nature}\nEvaluate and score the trip quality and explicitly optimize based on these slider values."
                active_system_prompt = SYSTEM_PROMPT
                
            current_query = base_query
            data = None

            if not client:
                raise HTTPException(status_code=500, detail="GEMINI_API_KEY is not configured on the server.")

            for attempt in range(3):
                try:
                    response = client.models.generate_content(
                        model="gemini-2.5-flash",
                        contents=current_query,
                        config={
                            "system_instruction": active_system_prompt,
                            "temperature": 0.7,
                            "max_output_tokens": 8000,
                            "response_mime_type": "application/json",
                        },
                    )

                    raw = response.text.strip()
                    logger.info(f"Raw LLM response length (Attempt {attempt+1}): {len(raw)} chars")

                    # Strip markdown code fences if present
                    raw = re.sub(r"^```(?:json)?\s*", "", raw)
                    raw = re.sub(r"\s*```$", "", raw)
                    raw = raw.strip()

                    data = json.loads(raw)

                    # Basic validation
                    if "id" not in data or "itineraries" not in data or "hero" not in data or "budget" not in data:
                        raise ValueError("Response missing required top-level keys (id, itineraries, hero, budget).")
                    
                    # Force deterministic ID
                    data['id'] = cache_key

                    # Unsplash API injection removed due to missing API key / rate limiting 404s

                    # Cache the successful response
                    generation_cache[cache_key] = data

                    # Save globally to DB cache if configured
                    if SUPABASE_URL and SUPABASE_ANON_KEY:
                        async with httpx.AsyncClient() as http_client:
                            insert_global_url = f"{SUPABASE_URL}/rest/v1/trips"
                            admin_headers = {
                                "apikey": SUPABASE_ANON_KEY,
                                "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
                                "Content-Type": "application/json",
                                "Prefer": "resolution=ignore-duplicates"
                            }
                            try:
                                await http_client.post(insert_global_url, headers=admin_headers, json={
                                    "id": cache_key,
                                    "trip_data": data,
                                    "created_at": datetime.utcnow().isoformat()
                                })
                            except Exception as e:
                                logger.error(f"Failed to save global cache to DB: {e}")

                    break

                except (json.JSONDecodeError, ValueError) as e:
                    logger.error(f"Validation/parse error on attempt {attempt+1}: {e}\nRaw: {raw[:500]}")
                    if attempt < 2:
                        current_query = f"{base_query}\n\nWARNING: Your previous response failed with error: {str(e)}. Please try again and ensure the output is STRICTLY valid JSON."
                    else:
                        raise HTTPException(
                            status_code=502,
                            detail="LLM returned invalid JSON after 3 attempts. Please try again.",
                        )
                except Exception as e:
                    logger.error(f"LLM API error on attempt {attempt+1}: {e}")
                    if attempt < 2:
                        continue
                    raise HTTPException(
                        status_code=502,
                        detail=f"Failed to generate itinerary: {str(e)}",
                    )

    # Save searched city itinerary to user's saved_trips via Supabase
    if not current_user['id'].startswith("guest_"):
        async with httpx.AsyncClient() as http_client:
            check_url = f"{SUPABASE_URL}/rest/v1/saved_trips?user_id=eq.{current_user['id']}&city_id=eq.{data['id']}"
            check_resp = await http_client.get(check_url, headers=headers)
            trips = check_resp.json() if check_resp.status_code == 200 else []
            
            if trips:
                update_url = f"{SUPABASE_URL}/rest/v1/saved_trips?user_id=eq.{current_user['id']}&city_id=eq.{data['id']}"
                await http_client.patch(update_url, headers=headers, json={"trip_data": data})
            else:
                insert_url = f"{SUPABASE_URL}/rest/v1/saved_trips"
                await http_client.post(insert_url, headers=headers, json={
                    "user_id": current_user["id"],
                    "city_id": data["id"],
                    "trip_data": data
                })

    return data


@app.post("/api/copilot/replan")
async def copilot_replan(req: CopilotRequest, current_user = Depends(auth.get_current_supabase_user)):
    logger.info(f"Copilot replan requested by {current_user['id']}")
    
    if not client:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY is not configured on the server.")

    current_json_str = json.dumps(req.current_itinerary, indent=2)
    prompt = f"""You are TripCo Copilot. The user says: "{req.message}".
Here is their current itinerary JSON:
{current_json_str}

Return a fully updated JSON itinerary adhering to the strict schema. Only modify what is requested or logically necessary to fulfill the request. Preserve all other clusters, spots, and IDs.
Also include a 'copilotMessage' field at the top level of the JSON (e.g. 'I have replaced the morning beach visit with a museum as requested.')."""
    
    for attempt in range(3):
        try:
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=prompt,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    temperature=0.7,
                ),
            )
            raw = response.text
            match = re.search(r'\{.*\}', raw, re.DOTALL)
            if match:
                raw = match.group(0)
            data = json.loads(raw)
            if "id" not in data or "itineraries" not in data:
                raise ValueError("Missing essential keys in JSON structure")
                
            return data
            
        except Exception as e:
            logger.error(f"Copilot LLM API error on attempt {attempt+1}: {e}")
            if attempt < 2:
                prompt = f"{prompt}\n\nWARNING: Your previous response failed with error: {str(e)}. Please try again and ensure the output is STRICTLY valid JSON."
                continue
            raise HTTPException(
                status_code=502,
                detail=f"Failed to process copilot request: {str(e)}",
            )


# ── Health check ────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "tripco-api", "model": "gemini-2.5-flash"}

# ── Auth & Database Endpoints ───────────────────────────

@app.post("/api/auth/register", response_model=Token)
def register_user(user: UserCreate, db: Session = Depends(database.get_db)):
    db_user = db.query(models.User).filter(models.User.email == user.email).first()
    if db_user:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    hashed_password = auth.get_password_hash(user.password)
    new_user = models.User(email=user.email, hashed_password=hashed_password, username=user.username)
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    
    access_token = auth.create_access_token(data={"sub": new_user.email})
    return {"access_token": access_token, "token_type": "bearer"}

@app.post("/api/auth/login", response_model=Token)
def login_user(user: UserCreate, db: Session = Depends(database.get_db)):
    # Standard OAuth2 requires form data, but we use JSON for simplicity here.
    # In a pure production app, use fastapi.security.OAuth2PasswordRequestForm
    db_user = db.query(models.User).filter(models.User.email == user.email).first()
    if not db_user or not auth.verify_password(user.password, db_user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    access_token = auth.create_access_token(data={"sub": db_user.email})
    return {"access_token": access_token, "token_type": "bearer"}

from google.oauth2 import id_token
from google.auth.transport import requests as google_requests
from jose import jwt

@app.post("/api/auth/social", response_model=Token)
def social_auth(request: SocialAuthRequest, db: Session = Depends(database.get_db)):
    if request.provider not in ["apple", "google"]:
        raise HTTPException(status_code=400, detail="Invalid provider")
    
    email = None
    username = None
    
    try:
        if request.provider == "google":
            if not GOOGLE_CLIENT_ID:
                raise ValueError("GOOGLE_CLIENT_ID is not configured on the server.")
            # Real Google OAuth Verification
            idinfo = id_token.verify_oauth2_token(
                request.token, google_requests.Request(), GOOGLE_CLIENT_ID
            )
            email = idinfo.get("email")
            username = idinfo.get("name")
        
        elif request.provider == "apple":
            # Real Apple OAuth Verification (Unverified decode for prototype, verify signature in production)
            payload = jwt.decode(request.token, options={"verify_signature": False})
            email = payload.get("email")
            
    except ValueError as e:
        logger.error(f"Social auth config error: {e}")
        raise HTTPException(status_code=500, detail="Server OAuth configuration is missing.")
    except Exception as e:
        logger.error(f"Social auth error: {e}")
        raise HTTPException(status_code=401, detail="Invalid social token")

    if not email:
        raise HTTPException(status_code=401, detail="Could not extract email from social token.")

    db_user = db.query(models.User).filter(models.User.email == email).first()
    
    if not db_user:
        hashed_password = auth.get_password_hash("mock_social_password_123!")
        new_user = models.User(email=email, hashed_password=hashed_password, username=username)
        db.add(new_user)
        db.commit()
        db.refresh(new_user)
        db_user = new_user
        
    access_token = auth.create_access_token(data={"sub": db_user.email})
    return {"access_token": access_token, "token_type": "bearer"}

@app.get("/api/user/data")
async def get_user_data(current_user = Depends(auth.get_current_supabase_user)):
    headers = {"Authorization": f"Bearer {current_user['token']}", "apikey": SUPABASE_ANON_KEY}
    async with httpx.AsyncClient() as client:
        # Fetch saved spots
        spots_resp = await client.get(f"{SUPABASE_URL}/rest/v1/saved_spots?user_id=eq.{current_user['id']}", headers=headers)
        spots = spots_resp.json() if spots_resp.status_code == 200 else []
        
        # Fetch saved trips
        trips_resp = await client.get(f"{SUPABASE_URL}/rest/v1/saved_trips?user_id=eq.{current_user['id']}", headers=headers)
        trips = trips_resp.json() if trips_resp.status_code == 200 else []
        
    username = current_user.get("user_metadata", {}).get("username") or current_user.get("user_metadata", {}).get("full_name") or ""
    return {
        "email": current_user["email"],
        "username": username,
        "saved_spots": [s["spot_id"] for s in spots],
        "saved_trips": [t["trip_data"] for t in trips if "trip_data" in t]
    }

@app.post("/api/user/sync")
async def sync_user_data(req: SyncRequest, current_user = Depends(auth.get_current_supabase_user)):
    headers = {"Authorization": f"Bearer {current_user['token']}", "apikey": SUPABASE_ANON_KEY}
    async with httpx.AsyncClient() as client:
        # Fetch existing
        spots_resp = await client.get(f"{SUPABASE_URL}/rest/v1/saved_spots?user_id=eq.{current_user['id']}", headers=headers)
        existing = {s["spot_id"] for s in spots_resp.json()} if spots_resp.status_code == 200 else set()
        
        # Insert new rows
        new_rows = []
        for spot_id in req.saved_spots:
            if spot_id not in existing:
                new_rows.append({
                    "user_id": current_user["id"],
                    "spot_id": spot_id,
                    "spot_data": {}
                })
        if new_rows:
            await client.post(f"{SUPABASE_URL}/rest/v1/saved_spots", headers=headers, json=new_rows)
    return {"status": "synced"}

@app.post("/api/user/spots/{spot_id}")
async def toggle_saved_spot(spot_id: str, current_user = Depends(auth.get_current_supabase_user)):
    headers = {"Authorization": f"Bearer {current_user['token']}", "apikey": SUPABASE_ANON_KEY}
    async with httpx.AsyncClient() as client:
        # Check if exists
        url = f"{SUPABASE_URL}/rest/v1/saved_spots?user_id=eq.{current_user['id']}&spot_id=eq.{spot_id}"
        resp = await client.get(url, headers=headers)
        existing = resp.json() if resp.status_code == 200 else []
        
        if existing:
            # Delete
            del_url = f"{SUPABASE_URL}/rest/v1/saved_spots?id=eq.{existing[0]['id']}"
            await client.delete(del_url, headers=headers)
            return {"status": "removed", "spot_id": spot_id}
        else:
            # Insert
            ins_url = f"{SUPABASE_URL}/rest/v1/saved_spots"
            await client.post(ins_url, headers=headers, json={
                "user_id": current_user["id"],
                "spot_id": spot_id,
                "spot_data": {}
            })
            return {"status": "added", "spot_id": spot_id}

@app.delete("/api/user/trips/{city_id}")
async def delete_saved_trip(city_id: str, current_user = Depends(auth.get_current_supabase_user)):
    headers = {"Authorization": f"Bearer {current_user['token']}", "apikey": SUPABASE_ANON_KEY}
    async with httpx.AsyncClient() as client:
        url = f"{SUPABASE_URL}/rest/v1/saved_trips?user_id=eq.{current_user['id']}&city_id=eq.{city_id}"
        resp = await client.get(url, headers=headers)
        existing = resp.json() if resp.status_code == 200 else []
        if existing:
            del_url = f"{SUPABASE_URL}/rest/v1/saved_trips?id=eq.{existing[0]['id']}"
            await client.delete(del_url, headers=headers)
            return {"status": "removed", "city_id": city_id}
    return {"status": "not_found"}

# ── Memories Endpoints ─────────────────────────────────

class MemoryCreate(BaseModel):
    spot_id: str
    trip_id: str
    photo_data: Optional[str] = None
    note: Optional[str] = None

@app.post("/api/memories")
def create_memory(req: MemoryCreate, db: Session = Depends(database.get_db), current_user = Depends(auth.get_current_supabase_user)):
    user = db.query(models.User).filter(models.User.email == current_user["email"]).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found in DB")
        
    memory = models.SpotMemory(
        user_id=user.id,
        spot_id=req.spot_id,
        trip_id=req.trip_id,
        photo_data=req.photo_data,
        note=req.note,
        created_at=datetime.utcnow().isoformat()
    )
    db.add(memory)
    db.commit()
    db.refresh(memory)
    return {"status": "success", "id": memory.id}

@app.get("/api/memories/{trip_id}")
def get_memories(trip_id: str, db: Session = Depends(database.get_db)):
    memories = db.query(models.SpotMemory).filter(models.SpotMemory.trip_id == trip_id).all()
    result = {}
    for m in memories:
        if m.spot_id not in result:
            result[m.spot_id] = []
        result[m.spot_id].append({
            "id": m.id,
            "photo_data": m.photo_data,
            "note": m.note,
            "created_at": m.created_at
        })
    return result

# ── Multiplayer Collaboration Endpoints ────────────────

import uuid
from datetime import datetime
from typing import Dict, Any

class TripCreate(BaseModel):
    trip_data: Dict[str, Any]

@app.post("/api/trips")
async def create_shared_trip(trip: TripCreate):
    trip_id = f"trip_{uuid.uuid4().hex[:8]}"
    headers = {"Authorization": f"Bearer {SUPABASE_ANON_KEY}", "apikey": SUPABASE_ANON_KEY}
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{SUPABASE_URL}/rest/v1/trips", headers=headers, json={
            "id": trip_id,
            "trip_data": trip.trip_data,
            "created_at": datetime.utcnow().isoformat()
        })
        if resp.status_code not in (200, 201):
            raise HTTPException(status_code=500, detail="Failed to save shared trip")
    return {"trip_id": trip_id}

@app.get("/api/trips/{trip_id}")
async def get_shared_trip(trip_id: str):
    headers = {"Authorization": f"Bearer {SUPABASE_ANON_KEY}", "apikey": SUPABASE_ANON_KEY}
    async with httpx.AsyncClient() as client:
        # Fetch trip
        trip_resp = await client.get(f"{SUPABASE_URL}/rest/v1/trips?id=eq.{trip_id}", headers=headers)
        trips = trip_resp.json() if trip_resp.status_code == 200 else []
        if not trips:
            raise HTTPException(status_code=404, detail="Trip not found")
        
        # Fetch votes
        votes_resp = await client.get(f"{SUPABASE_URL}/rest/v1/trip_votes?trip_id=eq.{trip_id}", headers=headers)
        votes = votes_resp.json() if votes_resp.status_code == 200 else []
        
    vote_counts = {}
    for v in votes:
        vote_counts[v["spot_id"]] = vote_counts.get(v["spot_id"], 0) + v["vote_value"]
        
    return {
        "trip_id": trips[0]["id"],
        "trip_data": trips[0]["trip_data"],
        "vote_counts": vote_counts
    }

class VoteRequest(BaseModel):
    vote_value: int # 1 or -1

@app.post("/api/trips/{trip_id}/vote/{spot_id}")
async def vote_spot(trip_id: str, spot_id: str, req: VoteRequest, current_user = Depends(auth.get_current_supabase_user)):
    headers = {"Authorization": f"Bearer {current_user['token']}", "apikey": SUPABASE_ANON_KEY}
    async with httpx.AsyncClient() as client:
        # Get existing vote
        url = f"{SUPABASE_URL}/rest/v1/trip_votes?trip_id=eq.{trip_id}&spot_id=eq.{spot_id}&user_id=eq.{current_user['id']}"
        resp = await client.get(url, headers=headers)
        votes = resp.json() if resp.status_code == 200 else []
        
        if votes:
            existing = votes[0]
            if existing["vote_value"] == req.vote_value:
                # Toggle off (Delete)
                del_url = f"{SUPABASE_URL}/rest/v1/trip_votes?id=eq.{existing['id']}"
                await client.delete(del_url, headers=headers)
            else:
                # Update
                up_url = f"{SUPABASE_URL}/rest/v1/trip_votes?id=eq.{existing['id']}"
                await client.patch(up_url, headers=headers, json={"vote_value": req.vote_value})
        else:
            # Insert
            ins_url = f"{SUPABASE_URL}/rest/v1/trip_votes"
            await client.post(ins_url, headers=headers, json={
                "trip_id": trip_id,
                "spot_id": spot_id,
                "user_id": current_user["id"],
                "vote_value": req.vote_value
            })
            
        # Get new total
        total_url = f"{SUPABASE_URL}/rest/v1/trip_votes?trip_id=eq.{trip_id}&spot_id=eq.{spot_id}"
        total_resp = await client.get(total_url, headers=headers)
        all_votes = total_resp.json() if total_resp.status_code == 200 else []
        total = sum(v["vote_value"] for v in all_votes)
        
    return {"status": "success", "total": total}

@app.get("/api/autocomplete")
async def autocomplete(text: str = Query(...)):
    if not GEOAPIFY_API_KEY:
        raise HTTPException(status_code=500, detail="GEOAPIFY_API_KEY not configured on server")
    
    url = f"https://api.geoapify.com/v1/geocode/autocomplete?text={text}&type=city&limit=5&apiKey={GEOAPIFY_API_KEY}"
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(url)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"Geoapify request failed: {e}")
            raise HTTPException(status_code=500, detail="Failed to fetch from Geoapify")

# Mount static files at root (must be at the bottom so it doesn't shadow API routes)
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=False), name="static")
