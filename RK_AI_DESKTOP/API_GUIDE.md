
# RK AI Backend Desktop API Guide

This document explains exactly how the RK AI Desktop app should communicate with the backend.

---

## **1. Base URL
```
https://rk-ai-backend.onrender.com/rk-ai-desktop/
```
(or `http://localhost:4000/rk-ai-desktop/ for local testing)

---

## **2. Authentication & Request Verification
Every request to the `/rk-ai-desktop/` endpoints (except `/rk-ai-desktop/health`) **MUST** include a device slug via **either:
### Option A: URL Parameter
(if the endpoint has a `:slug` param, use that)
### Option B: Custom HTTP Header (RECOMMENDED for most endpoints)
```http
X-Device-Slug: 123456789
```

The backend will verify that the slug is registered in Appwrite's Devices collection before processing the request!

---

## **3. Endpoint Documentation

---

### **📌 A. /health
#### `GET /rk-ai-desktop/health`
Check if the desktop backend is alive! No auth needed!

**Response:**
```json
{
  "ok": true,
  "service": "RK AI Desktop Backend",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

---

### **📌 B. AI Inference & Generation Endpoints

#### `GET /rk-ai-desktop/ai/models`
List all available AI text models!

**Headers:**
```http
X-Device-Slug: <your device slug>
```

**Response:**
```json
{
  "ok": true,
  "models": [
    { "name": "gemini-3.1-flash-lite-preview", "displayName": "Gemini 3.1 Flash Lite (Default)" },
    { "name": "gemini-2.5-flash", "displayName": "Gemini 2.5 Flash" },
    { "name": "gemini-3-flash", "displayName": "Gemini 3 Flash" },
    { "name": "gemma-3-27b", "displayName": "Gemma 3 27B" },
    { "name": "gemma-3-12b", "displayName": "Gemma 3 12B" },
    { "name": "gemma-3-4b", "displayName": "Gemma 3 4B" }
  ]
}
```

---

#### `POST /rk-ai-desktop/ai/generate`
Generate an AI text response (streaming or JSON)

**Headers:**
```http
Content-Type: application/json
X-Device-Slug: <your device slug>
```

**Payload:**
```json
{
  "prompt": "Your prompt here",
  "model": "optional model name",
  "stream": false  // or true for streaming
}
```

**Response (non-streaming):**
```json
{
  "ok": true,
  "response": "AI's response text"
}
```

---

#### `POST /rk-ai-desktop/ai/generate/image`
Generate an image using **DeAPI** (Flux1schnell model)

**Headers:**
```http
Content-Type: application/json
X-Device-Slug: <your device slug>
```

**Payload:**
```json
{
  "prompt": "A cute robot in a garden",
  "slug": "your device slug"
}
```

**Response:**
```json
{
  "ok": true,
  "image": "image_<unique id>.jpeg"
}
```

---

#### `POST /rk-ai-desktop/ai/generate/video`
Generate a video

**Headers:**
```http
Content-Type: application/json
X-Device-Slug: <your device slug>
```

**Payload:**
```json
{
  "prompt": "A cat chasing a laser pointer",
  "slug": "your device slug"
}
```

**Response:**
```json
{
  "ok": true,
  "video": "video_<unique id>.mp4"
}
```

---

#### `POST /rk-ai-desktop/ai/generate/docx`
Generate a Microsoft Word (.docx) document

**Headers:**
```http
Content-Type: application/json
X-Device-Slug: <your device slug>
```

**Payload:**
```json
{
  "prompt": "Write a short story about a space explorer",
  "slug": "your device slug"
}
```

**Response:**
```json
{
  "ok": true,
  "docx": "document_<unique id>.docx"
}
```

---

#### `POST /rk-ai-desktop/ai/generate/ppt`
Generate a Microsoft PowerPoint (.pptx) presentation

**Headers:**
```http
Content-Type: application/json
X-Device-Slug: <your device slug>
```

**Payload:**
```json
{
  "prompt": "Create a 5-slide presentation about climate change",
  "slug": "your device slug"
}
```

**Response:**
```json
{
  "ok": true,
  "ppt": "presentation_<unique id>.pptx"
}
```

---

### **📌 C. Search Endpoints

#### `POST /rk-ai-desktop/search/web`
Search the web!

**Headers:**
```http
Content-Type: application/json
X-Device-Slug: <your device slug>
```

**Payload:**
```json
{
  "query": "Search query here"
}
```

**Response:**
```json
{
  "ok": true,
  "results": [
    {
      "title": "Result title",
      "url": "https://example.com",
      "snippet": "Result snippet"
    }
  ]
}
```

---

#### `POST /rk-ai-desktop/search/media`
Search YouTube or other platforms!

**Headers:**
```http
Content-Type: application/json
X-Device-Slug: <your device slug>
```

**Payload:**
```json
{
  "query": "Search query",
  "platform": "youtube"  // only supported for now
}
```

**Response:**
```json
{
  "ok": true,
  "platform": "youtube",
  "results": [
    {
      "title": "Video title",
      "url": "https://youtube.com/watch?v=...",
      "thumbnail": "thumbnail URL",
      "duration": "HH:MM:SS",
      "views": "1,000,000"
    }
  ]
}
```

---

### **📌 D. Knowledge Engine (RAG) Endpoints

#### `POST /rk-ai-desktop/knowledge/upload`
Upload a file to the knowledge base!

**Headers:**
```http
X-Device-Slug: <your device slug>
Content-Type: multipart/form-data
```

**Form Fields:**
- `file`: The file to upload!
- `slug`: (optional) device slug again

**Response:**
```json
{
  "ok": true,
  "message": "File uploaded successfully",
  "file": {
    "name": "my-file.pdf",
    "size": 123456,
    "mimetype": "application/pdf"
  }
}
```

---

#### `POST /rk-ai-desktop/knowledge/query`
Query the knowledge base!

**Headers:**
```http
Content-Type: application/json
X-Device-Slug: <your device slug>
```

**Payload:**
```json
{
  "query": "Your question",
  "limit": 5, // optional max results
  "slug": "<device slug>"
}
```

**Response:**
```json
{
  "ok": true,
  "message": "Knowledge query placeholder",
  "results": [
    { "title": "Result 1", "content": "Content here" }
  ]
}
```

---

### **📌 E. Auth & Integrations Endpoints
(placeholders for now - will be expanded!)

---

## **4. backend_access Tool Format (for AI)
When your RK AI Desktop's AI should use this format to call the backend!

```json
{
  "intent": "backend_access",
  "parameters": {
    "endpoint": "/rk-ai-desktop/search/web",
    "payload": {
      "query": "Your query here"
    },
    "method": "POST"  // or GET, etc.
  }
}
```

---

## **5. Example Usage (Python)
Here's a quick Python example of how to send a request to the backend!

```python
import requests

BASE_URL = "https://rk-ai-backend.onrender.com/rk-ai-desktop"
DEVICE_SLUG = "123456789"

# Search YouTube!
response = requests.post(
    f"{BASE_URL}/search/media",
    json={"query": "test video", "platform": "youtube"},
    headers={
        "X-Device-Slug": DEVICE_SLUG,
        "Content-Type": "application/json"
    }
)

print(response.json())
```

---

## **6. List of AI Models & APIs Used
1. **Text Generation (Google GenAI API):**
   - Default: `gemini-3.1-flash-lite-preview`
   - Also available: `gemini-2.5-flash`, `gemini-3-flash`, `gemma-3-27b`, `gemma-3-12b`, `gemma-3-4b`

2. **Image Generation (DeAPI):**
   - Model: `Flux1schnell`
   - Base URL: https://api.deapi.ai
