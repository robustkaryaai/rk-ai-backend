import os
import io
import tempfile
import base64
import wave
import json
from fastapi import FastAPI, File, UploadFile, HTTPException, Form
from fastapi.responses import FileResponse, JSONResponse
from pydub import AudioSegment
from gtts import gTTS
import requests
import speech_recognition as sr

app = FastAPI(title="RK-AI STT/TTS Service")

VOSK_MODEL_PATH = os.environ.get("VOSK_MODEL_PATH")
HF_TOKEN = os.environ.get("HF_TOKEN")


def ensure_wav(bytes_data, filename_ext="input"):
    # Accept many formats and return path to a wav file
    tmp_in = tempfile.NamedTemporaryFile(delete=False, suffix=".bin")
    tmp_in.write(bytes_data)
    tmp_in.flush()
    tmp_out = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
    try:
        audio = AudioSegment.from_file(tmp_in.name)
        audio = audio.set_frame_rate(16000).set_channels(1)
        audio.export(tmp_out.name, format="wav")
        return tmp_out.name
    finally:
        try:
            tmp_in.close()
        except:
            pass


@app.post("/stt")
async def stt(file: UploadFile | None = File(None), audio_b64: str | None = Form(None)):
    if file is None and not audio_b64:
        raise HTTPException(status_code=400, detail="Provide multipart file 'audio' or form field 'audio_b64'")

    if file:
        data = await file.read()
    else:
        try:
            data = base64.b64decode(audio_b64)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid base64 audio")

    wav_path = ensure_wav(data)

    # Primary: speech_recognition using Google's free Web Speech API
    try:
        recognizer = sr.Recognizer()
        with sr.AudioFile(wav_path) as source:
            audio_data = recognizer.record(source)
        try:
            text = recognizer.recognize_google(audio_data)
            return JSONResponse({"text": text})
        except sr.UnknownValueError:
            return JSONResponse({"text": ""})
        except sr.RequestError:
            # network / API error -- fallthrough to other backends
            pass
    except Exception:
        # If speech_recognition can't process, continue to other options
        pass

    # Secondary: Try Vosk if model available
    if VOSK_MODEL_PATH and os.path.isdir(VOSK_MODEL_PATH):
        try:
            from vosk import Model, KaldiRecognizer
            wf = wave.open(wav_path, "rb")
            model = Model(VOSK_MODEL_PATH)
            rec = KaldiRecognizer(model, wf.getframerate())
            results = []
            while True:
                data_chunk = wf.readframes(4000)
                if len(data_chunk) == 0:
                    break
                if rec.AcceptWaveform(data_chunk):
                    results.append(json.loads(rec.Result()))
            results.append(json.loads(rec.FinalResult()))
            text = " ".join(r.get("text", "") for r in results)
            return JSONResponse({"text": text})
        except Exception as e:
            # If Vosk fails, continue to HF fallback
            pass

    # Tertiary: Fallback to Hugging Face inference if token provided
    if HF_TOKEN:
        try:
            headers = {"Authorization": f"Bearer {HF_TOKEN}", "Content-Type": "audio/wav"}
            with open(wav_path, "rb") as f:
                resp = requests.post(
                    "https://api-inference.huggingface.co/models/openai/whisper-large-v3-turbo",
                    headers=headers,
                    data=f.read(),
                    timeout=60,
                )
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail=f"HF inference error: {resp.status_code} {resp.text}")
            j = resp.json()
            return JSONResponse(j)
        except requests.RequestException as e:
            raise HTTPException(status_code=502, detail=f"HF request failed: {e}")

    raise HTTPException(status_code=400, detail="No STT backend available: set HF_TOKEN or provide VOSK_MODEL_PATH, and ensure SpeechRecognition package is installed.")


@app.post("/tts")
async def tts(text: str = Form(...)):
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail="Text is required")

    try:
        tts = gTTS(text)
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp3")
        tts.write_to_fp(open(tmp.name, "wb"))
        return FileResponse(tmp.name, media_type="audio/mpeg", filename="tts.mp3")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS error: {e}")


@app.get("/health")
def health():
    return {"ok": True, "vosk": bool(VOSK_MODEL_PATH and os.path.isdir(VOSK_MODEL_PATH)), "hf_token": bool(HF_TOKEN)}
