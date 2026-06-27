import requests
import json
import time

cities = ["Shimla", "Dehradun", "Delhi", "New York"]
out_data = {}

for city in cities:
    success = False
    print(f"Generating {city}...")
    while not success:
        try:
            resp = requests.post("http://localhost:8000/api/generate-city", json={
                "prompt": city,
                "num_days": 3,
                "travel_group": "Solo Traveler",
                "personality": {"Adventure": 50, "Luxury": 50, "Food": 50, "Nature": 50}
            })
            if resp.status_code == 200:
                out_data[city.lower().replace(" ", "")] = resp.json()
                print(f"Success for {city}!")
                success = True
            elif resp.status_code == 503:
                print(f"503 Unavailable. Retrying {city} in 5 seconds...")
                time.sleep(5)
            else:
                print(f"Error {resp.status_code}: {resp.text}")
                time.sleep(2)
        except Exception as e:
            print(f"Exception: {e}")
            time.sleep(2)

with open("public/demo_data.js", "w") as f:
    f.write("window.DEMO_CITIES = " + json.dumps(out_data, indent=2) + ";\n")
print("Done writing to public/demo_data.js")
