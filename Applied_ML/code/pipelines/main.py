import asyncio
import json
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from retrieval_pipeline import retrieve

print("[+] Loaded the Models")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

class QueryRequest(BaseModel):
    query: str

@app.post("/chat")
async def chat(request: QueryRequest):
    # 1. Kick off the heavy synchronous pipeline in the background threadpool
    task = asyncio.create_task(run_in_threadpool(retrieve, request.query))
    
    # 2. Define a generator to keep the connection alive
    async def event_generator():
        # While the model is thinking, keep sending spaces every 2 seconds
        # This keeps bytes flowing so the browser/proxy doesn't drop the connection
        while not task.done():
            yield " "  # Standard JSON ignores leading/insignificant whitespace
            await asyncio.sleep(2)
        
        # 3. Once the task is complete, gather the final result
        response_data = await task
        
        # 4. Stream the actual JSON string down to the frontend
        yield json.dumps(response_data)

    # Return as a streaming response immediately
    return StreamingResponse(event_generator(), media_type="application/json")