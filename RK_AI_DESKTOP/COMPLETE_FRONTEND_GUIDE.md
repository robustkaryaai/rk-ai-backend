
# RK AI Desktop: Complete Frontend Integration Guide
---
This is a **full, step-by-step guide** for building all RK AI Desktop features using our new backend!

---

## 🚀 Table of Contents
1. [Base URL & Authentication](#1-base-url--authentication)
2. [Core AI Features (Text/Image/Video/Doc/PPT)](#2-core-ai-features-textimagevideodocppt)
3. [Search (Web & YouTube)](#3-search-web--youtube)
4. [Knowledge Base (File Upload & Query)](#4-knowledge-base-file-upload--query)
5. [Billing & Upgrades](#5-billing--upgrades)
6. [Health Check](#6-health-check)

---

## 1. Base URL & Authentication
All requests to the RK AI Backend use the following base URL:
```
https://rk-ai-backend.onrender.com
```

### Authentication
**Every endpoint (except `/health`) requires an `X-Device-Slug` header!**
Your 9-digit device slug is stored locally (in `config.json` or similar).

**Example Request Headers:**
```javascript
{
  "Content-Type": "application/json",
  "X-Device-Slug": "123456789"
}
```

---

## 2. Core AI Features (Text/Image/Video/Doc/PPT)
All these are under `/rk-ai-desktop/ai/`!

### A. Text Generation (Streaming & Non-Streaming)
**Endpoint:** `POST /rk-ai-desktop/ai/generate`

**Payload:**
```javascript
{
  "prompt": "Write a short poem about robots",
  "model": "gemini-3.1-flash-lite-preview", // optional
  "stream": false // or true for streaming
}
```

**Response:**
```javascript
{
  "ok": true,
  "response": "Why did the robot cross the road? To get to the other byte!"
}
```

---

### B. Image Generation
**Endpoint:** `POST /rk-ai-desktop/ai/generate/image`

**Payload:**
```javascript
{
  "prompt": "A cute robot sitting in a garden",
  "slug": "123456789" // optional (redundant with header)
}
```

**Response:**
```javascript
{
  "ok": true,
  "image": "image_123456789abc.jpeg"
}
```

---

### C. Video Generation
**Endpoint:** `POST /rk-ai-desktop/ai/generate/video`

**Payload:**
```javascript
{
  "prompt": "A cat chasing a laser pointer",
  "slug": "123456789"
}
```

**Response:**
```javascript
{
  "ok": true,
  "video": "video_123456789abc.mp4"
}
```

---

### D. Document Generation (.docx)
**Endpoint:** `POST /rk-ai-desktop/ai/generate/docx`

**Payload:**
```javascript
{
  "prompt": "Write a short story about a space explorer",
  "slug": "123456789"
}
```

**Response:**
```javascript
{
  "ok": true,
  "docx": "document_123456789abc.docx"
}
```

---

### E. PowerPoint Generation (.pptx)
**Endpoint:** `POST /rk-ai-desktop/ai/generate/ppt`

**Payload:**
```javascript
{
  "prompt": "Create a 5-slide presentation about climate change",
  "slug": "123456789"
}
```

**Response:**
```javascript
{
  "ok": true,
  "ppt": "presentation_123456789abc.pptx"
}
```

---

### F. List AI Models
**Endpoint:** `GET /rk-ai-desktop/ai/models`
**Headers:** `X-Device-Slug`

**Response:**
```javascript
{
  "ok": true,
  "models": [
    { "name": "gemini-3.1-flash-lite-preview", "displayName": "Gemini 3.1 Flash Lite (Default)" },
    { "name": "gemini-2.5-flash", "displayName": "Gemini 2.5 Flash" },
    { "name": "gemma-3-27b", "displayName": "Gemma 3 27B" }
  ]
}
```

---

## 3. Search (Web & YouTube)
Endpoints under `/rk-ai-desktop/search/`!

### A. Web Search (DuckDuckGo)
**Endpoint:** `POST /rk-ai-desktop/search/web`

**Payload:**
```javascript
{
  "query": "Latest AI news"
}
```

**Response:**
```javascript
{
  "ok": true,
  "results": [
    {
      "title": "Latest AI Breakthrough Announced!",
      "url": "https://example.com/ai-news",
      "snippet": "Scientists announced a major AI breakthrough..."
    }
  ]
}
```

---

### B. YouTube Search
**Endpoint:** `POST /rk-ai-desktop/search/media`

**Payload:**
```javascript
{
  "query": "Funny cat videos",
  "platform": "youtube"
}
```

**Response:**
```javascript
{
  "ok": true,
  "platform": "youtube",
  "results": [
    {
      "title": "Cat Does Amazing Trick!",
      "url": "https://youtube.com/watch?v=abc123",
      "thumbnail": "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
      "duration": "0:30",
      "views": "1,000,000",
      "author": "Funny Animals"
    }
  ]
}
```

---

## 4. Knowledge Base (File Upload & Query)
Endpoints under `/rk-ai-desktop/knowledge/`!

### A. Upload File
**Endpoint:** `POST /rk-ai-desktop/knowledge/upload`
**Content-Type:** `multipart/form-data`

**Form Data:**
- `file`: The file to upload
- `slug`: Optional (redundant with header)

**Response:**
```javascript
{
  "ok": true,
  "message": "File uploaded successfully",
  "file": {
    "name": "1234567890_my-file.pdf",
    "originalName": "my-file.pdf",
    "size": 1024000,
    "mimetype": "application/pdf"
  }
}
```

---

### B. Query Knowledge Base
**Endpoint:** `POST /rk-ai-desktop/knowledge/query`

**Payload:**
```javascript
{
  "query": "What's the main topic of the uploaded file?",
  "slug": "123456789"
}
```

**Response:**
```javascript
{
  "ok": true,
  "answer": "The uploaded file is about climate change.",
  "availableFiles": ["1234567890_my-file.pdf"],
  "message": "Note: Full RAG coming soon!"
}
```

---

## 5. Billing & Upgrades
Endpoint under `/rk-ai-desktop/billing/`!

### Upgrade Subscription
**Endpoint:** `POST /rk-ai-desktop/billing/upgrade`

**Payload:**
```javascript
{
  "plan": "studio", // "free" | "core" | "studio"
  "payment_token": "tok_xyz", // Payment token
  "slug": "123456789" // Optional, but recommended
}
```

**Response:**
```javascript
{
  "ok": true,
  "message": "Payment successful. Upgraded to Studio tier.",
  "unlocked_features": ["matrix_memory", "priority_queue", "custom_models"]
}
```

---

## 6. Health Check
**Endpoint:** `GET /rk-ai-desktop/health`
**Authentication:** Not required!

**Response:**
```javascript
{
  "ok": true,
  "service": "RK AI Desktop Backend",
  "timestamp": "2026-06-13T12:34:56.789Z"
}
```

---

## 📚 Complete API Documentation
For full details, see `API_GUIDE.md`! For Appwrite schema, see `APPWRITE_SCHEMA.md`!

---

## 🎉 That's It!
You now have everything you need to build RK AI Desktop! Let's go! 🚀
