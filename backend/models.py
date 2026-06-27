from sqlalchemy import Column, Integer, String, ForeignKey, JSON
from sqlalchemy.orm import relationship
from database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, nullable=True)
    email = Column(String, unique=True, index=True)
    hashed_password = Column(String)

    saved_spots = relationship("SavedSpot", back_populates="owner")
    saved_trips = relationship("SavedTrip", back_populates="owner")
    spot_memories = relationship("SpotMemory", back_populates="owner")

class RateLimit(Base):
    __tablename__ = "rate_limits"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True)
    date_str = Column(String, index=True) # Format: YYYY-MM-DD
    count = Column(Integer, default=0)

class SavedSpot(Base):
    __tablename__ = "saved_spots"

    id = Column(Integer, primary_key=True, index=True)
    spot_id = Column(String, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    spot_data = Column(JSON) # Store full JSON for rendering
    
    owner = relationship("User", back_populates="saved_spots")

class SavedTrip(Base):
    __tablename__ = "saved_trips"

    id = Column(Integer, primary_key=True, index=True)
    city_id = Column(String, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    trip_data = Column(JSON) # Store full JSON itinerary
    
    owner = relationship("User", back_populates="saved_trips")

class Trip(Base):
    __tablename__ = "trips"

    id = Column(String, primary_key=True, index=True) # E.g., 'trip_abc123'
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True) # Anonymous or registered
    trip_data = Column(JSON)
    created_at = Column(String) # Simple timestamp

    votes = relationship("TripVote", back_populates="trip")

class TripVote(Base):
    __tablename__ = "trip_votes"

    id = Column(Integer, primary_key=True, index=True)
    trip_id = Column(String, ForeignKey("trips.id"))
    spot_id = Column(String, index=True)
    user_id = Column(Integer, ForeignKey("users.id")) # Nullable if we allow anon votes, but let's restrict to logged-in users for integrity
    vote_value = Column(Integer) # +1 or -1

    trip = relationship("Trip", back_populates="votes")

class SpotMemory(Base):
    __tablename__ = "spot_memories"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    spot_id = Column(String, index=True)
    trip_id = Column(String, index=True)
    photo_data = Column(String) # Base64 encoded string
    note = Column(String)
    created_at = Column(String)

    owner = relationship("User", back_populates="spot_memories")
