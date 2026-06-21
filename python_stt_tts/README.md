RK-AI Python STT/TTS service

Overview
- FastAPI service providing small, free STT/TTS endpoints.

Endpoints
- POST /stt (multipart file 'audio' or form field 'audio_b64') -> JSON {text}
- POST /tts (form field 'text') -> returns audio/mpeg file
- GET /health -> basic status

Deployment notes (Render)
- Add a new Web Service on Render using this repository and set the "Start Command" to:

  uvicorn app:app --host 0.0.0.0 --port $PORT

- Ensure the correct Python version (3.11 recommended). Do NOT upload a virtualenv — Render will create the environment and install packages from `requirements.txt`.
- If you want offline STT via Vosk, set the `VOSK_MODEL_PATH` environment variable to a folder path containing a Vosk model. On Render, add this as an environment variable and also include model files in the repo or download them at startup (large files).
- If you prefer Hugging Face STT (Whisper), set `HF_TOKEN` in environment variables and the service will call Hugging Face inference API.

System packages (for Linux / Render)
- For `pyttsx3` fallback or some audio conversions you may need system packages such as `ffmpeg` and `espeak`.
- On Render you can use a Docker service if you need custom apt packages. For a plain Web Service, `ffmpeg` is usually present; confirm via the service shell.

Local testing
1. Create a virtual environment and install requirements:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. Run locally:

```bash
uvicorn app:app --reload
```

3. Test TTS:

```bash
curl -X POST -F "text=hello world" http://localhost:8000/tts --output hello.mp3
```

4. Test STT (wav file):

```bash
curl -X POST -F "audio=@test.wav" http://localhost:8000/stt
```
