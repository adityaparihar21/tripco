import asyncio
from google import genai
import os

async def main():
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY", "test"))
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents="hello"
        )
        print(response)
    except Exception as e:
        print("EXCEPTION:", type(e), e)

asyncio.run(main())
