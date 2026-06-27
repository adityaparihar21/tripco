# TripCo Design System

## Overview
TripCo utilizes a **Premium Warm Editorial Theme** inspired by the aesthetics of Airbnb (coral warmth), Notion (sand/paper feel), and Stripe (sleek slate accents). The design focuses on presenting travel itineraries like a high-end digital journal.

---

## 🎨 Color Palette

### Backgrounds (Warm Dark Mode)
The application uses a rich, warm dark background scale instead of pure black to reduce eye strain and give a premium feel.
- **Base Background:** `#0f0d0b` (Deepest warm brown/black)
- **Surface:** `#161310` (Elevated containers)
- **Card:** `#1c1814` (Main card elements)
- **Inset:** `#211d18` (Hover states / embedded sections)
- **Raised:** `#261f18` (Highest elevation)

### Brand & Accents
These colors are used to denote specific types of spots or actions.
- **Amber (Primary):** `#c8875a` (Warm terracotta) - Used for primary UI accents and "Aesthetic" spots.
- **Sage (Secondary):** `#7ba882` (Muted green) - Used to highlight "Food Gem" spots.
- **Slate (Neutral/Cool):** `#8b9db5` (Cool slate-blue) - Used for Transit elements and specific neutral tags.
- **Rose (Accent):** `#c47d8a` (Muted pink) - Used for Delhi specific accents and Non-veg indicators.

### Typography Colors (Text Scale)
- **Primary Text:** `#ede8e2` (Warm off-white, high readability)
- **Secondary Text:** `#9e9085` (Subdued contrast for subtitles)
- **Muted Text:** `#635c54` (For metadata and timestamps)
- **Faint Text:** `#3a3530` (For disabled or subtle numbering)

### Borders
- **Hairline:** `rgba(255,255,255,0.05)`
- **Subtle:** `rgba(255,255,255,0.08)`
- **Visible:** `rgba(255,255,255,0.13)`

---

## ✍️ Typography

TripCo relies on a high-contrast pairing between a classic serif for headings and a modern sans-serif for UI elements.

**1. Serif (Headings & Display)**
- **Font Family:** `Playfair Display`, Georgia, serif
- **Weights used:** 400 (Regular), 600 (Semi-bold), 700 (Bold)
- **Usage:** City Titles, Spot Names, Core Headings.

**2. Sans-Serif (Body & UI)**
- **Font Family:** `Inter`, -apple-system, sans-serif
- **Weights used:** 400 (Regular), 500 (Medium), 600 (Semi-bold), 800 (Extra Bold)
- **Usage:** Descriptions, Metadata, Buttons, Tags, Navigation.

---

## 📐 Spacing & Radii (Border-Radius)
Used to create a soft, approachable, yet structured interface.
- **XS:** `6px`
- **SM:** `10px`
- **MD:** `14px`
- **LG:** `18px`
- **XL:** `22px`
- **Pill:** `100px` (Used for buttons, tags, and badges)

---

## ⏱️ Animation & Transitions
Smooth micro-interactions are key to the app's premium feel.
- **Fast:** `0.15s ease` (Hover states, button presses)
- **Base:** `0.25s ease` (Tab switching, drawer toggles)
- **Slow:** `0.4s cubic-bezier(.4,0,.2,1)` (View transitions, map zooming, complex element reveals)
