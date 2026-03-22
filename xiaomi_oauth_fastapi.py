from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import sqlite3
import time
from dataclasses import asdict, dataclass
from typing import Dict, List, Optional
from urllib.parse import urlencode

import requests
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

try:
    from cryptography.fernet import Fernet
except Exception:  # pragma: no cover
    Fernet = None


XIAOMI_AUTHORIZE_URL = "https://account.xiaomi.com/oauth2/authorize"
XIAOMI_TOKEN_URL = "https://account.xiaomi.com/oauth2/token"
XIAOMI_PROFILE_URL = "https://open.account.xiaomi.com/user/profile"

CLIENT_ID = os.getenv("CLIENT_ID", "").strip()
CLIENT_SECRET = os.getenv("CLIENT_SECRET", "").strip()
REDIRECT_URI = os.getenv("REDIRECT_URI", "https://rk-ai-backend.onrender.com/xiaomi/oauth/callback").strip()
FRONTEND_URL = os.getenv("FRONTEND_URL", "https://rexycore.vercel.app").strip()
XIAOMI_SCOPE = os.getenv("XIAOMI_SCOPE", "1 6000 6004").strip()
XIAOMI_DEVICE_FETCH_URL = os.getenv("XIAOMI_DEVICE_FETCH_URL", "").strip()
STORE_DB_PATH = os.getenv("XIAOMI_STORE_DB_PATH", "./xiaomi_oauth_store.db").strip()
FERNET_KEY = os.getenv("FERNET_KEY", "").strip()

REGION_ALIASES = {
    "all": "all",
    "cn": "cn",
    "china": "cn",
    "de": "de",
    "germany": "de",
    "i2": "i2",
    "in": "i2",
    "india": "i2",
    "ru": "ru",
    "russia": "ru",
    "sg": "sg",
    "singapore": "sg",
    "us": "us",
    "usa": "us",
}


@dataclass
class OAuthIdentity:
    user_id: str
    open_id: str
    region: str
    scope: str
    profile_name: str
    avatar_url: str
    linked_at: int


@dataclass
class OAuthTokenBundle:
    access_token: str
    refresh_token: str
    expires_in: int
    scope: str
    open_id: str
    created_at: int


@dataclass
class XiaomiDevice:
    ip: str
    token: str
    model: str
    did: str
    source: str
    cloud: bool
    region: str
    name: str = ""
    room: str = ""


class OAuthStartResponse(BaseModel):
    authorize_url: str
    state: str


class QRImportPayload(BaseModel):
    user_id: str
    region: str = "all"
    devices: List[dict] = Field(default_factory=list)


class SecureStore:
    def __init__(self, db_path: str, fernet_key: str = "") -> None:
        self.db_path = db_path
        self.memory: Dict[str, dict] = {}
        self.fernet = Fernet(fernet_key.encode()) if fernet_key and Fernet else None
        self._init_db()

    def _init_db(self) -> None:
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS secure_store (
                namespace TEXT NOT NULL,
                item_key TEXT NOT NULL,
                item_value BLOB NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(namespace, item_key)
            )
            """
        )
        conn.commit()
        conn.close()

    def _seal(self, payload: dict) -> bytes:
        raw = json.dumps(payload, separators=(",", ":")).encode()
        if self.fernet:
            return self.fernet.encrypt(raw)
        return base64.b64encode(raw)

    def _open(self, payload: bytes) -> dict:
        raw = self.fernet.decrypt(payload) if self.fernet else base64.b64decode(payload)
        return json.loads(raw.decode())

    def put(self, namespace: str, item_key: str, value: dict) -> None:
        self.memory[f"{namespace}:{item_key}"] = value
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            "REPLACE INTO secure_store(namespace, item_key, item_value, updated_at) VALUES (?, ?, ?, ?)",
            (namespace, item_key, self._seal(value), int(time.time())),
        )
        conn.commit()
        conn.close()

    def get(self, namespace: str, item_key: str) -> Optional[dict]:
        cache_key = f"{namespace}:{item_key}"
        if cache_key in self.memory:
            return self.memory[cache_key]

        conn = sqlite3.connect(self.db_path)
        row = conn.execute(
            "SELECT item_value FROM secure_store WHERE namespace=? AND item_key=?",
            (namespace, item_key),
        ).fetchone()
        conn.close()
        if not row:
            return None
        value = self._open(row[0])
        self.memory[cache_key] = value
        return value


class XiaomiDeviceAdapter:
    def fetch_devices(self, access_token: str, region: str) -> List[XiaomiDevice]:
        return []


class ConfiguredEndpointDeviceAdapter(XiaomiDeviceAdapter):
    def fetch_devices(self, access_token: str, region: str) -> List[XiaomiDevice]:
        if not XIAOMI_DEVICE_FETCH_URL:
            return []

        params = {}
        if region != "all":
            params["region"] = region

        response = requests.get(
            XIAOMI_DEVICE_FETCH_URL,
            headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
            params=params,
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()

        raw_devices = payload.get("devices", payload) if isinstance(payload, dict) else payload
        if not isinstance(raw_devices, list):
            return []

        devices: List[XiaomiDevice] = []
        for raw in raw_devices:
            if not isinstance(raw, dict):
                continue
            token = str(raw.get("token") or raw.get("local_token") or "").strip().lower()
            ip = str(raw.get("ip") or raw.get("localip") or "").strip()
            if not token or len(token) != 32 or not ip:
                continue
            devices.append(
                XiaomiDevice(
                    ip=ip,
                    token=token,
                    model=str(raw.get("model") or "").strip(),
                    did=str(raw.get("did") or raw.get("id") or "").strip(),
                    source="oauth",
                    cloud=True,
                    region=region,
                    name=str(raw.get("name") or "").strip(),
                    room=str(raw.get("room") or raw.get("room_name") or "").strip(),
                )
            )
        return devices


def normalize_region(region: str) -> str:
    return REGION_ALIASES.get((region or "all").strip().lower(), "all")


def strip_xiaomi_prefix(text: str) -> str:
    return str(text or "").replace("&&&START&&&", "", 1).strip()


def stable_fallback_user_id(access_token: str) -> str:
    digest = hashlib.sha256(access_token.encode()).hexdigest()
    return f"xiaomi_{digest[:24]}"


def key_for_device(device: XiaomiDevice) -> str:
    if device.did:
        return f"did:{device.did}"
    if device.ip:
        return f"ip:{device.ip}"
    return f"model:{device.model}:{device.name.lower()}"


def merge_device_lists(*groups: List[XiaomiDevice]) -> List[dict]:
    merged: Dict[str, XiaomiDevice] = {}
    for group in groups:
        for device in group or []:
            key = key_for_device(device)
            if key not in merged:
                merged[key] = device
                continue
            prev = merged[key]
            merged[key] = XiaomiDevice(
                ip=prev.ip or device.ip,
                token=prev.token or device.token,
                model=prev.model or device.model,
                did=prev.did or device.did,
                source=prev.source if prev.source == device.source else "hybrid",
                cloud=prev.cloud or device.cloud,
                region=prev.region or device.region,
                name=prev.name or device.name,
                room=prev.room or device.room,
            )
    return [asdict(device) for device in merged.values()]


def frontend_smarthome_url(query: Dict[str, str]) -> str:
    base = FRONTEND_URL.rstrip("/")
    return f"{base}/smarthome?{urlencode({k: v for k, v in query.items() if v not in (None, '')})}"


store = SecureStore(STORE_DB_PATH, FERNET_KEY)
device_adapter = ConfiguredEndpointDeviceAdapter()

app = FastAPI(title="RK AI Xiaomi OAuth Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def save_identity(identity: OAuthIdentity) -> None:
    store.put("identity", identity.user_id, asdict(identity))


def save_tokens(user_id: str, tokens: OAuthTokenBundle) -> None:
    store.put("tokens", user_id, asdict(tokens))


def save_devices(user_id: str, source: str, devices: List[dict]) -> None:
    store.put("devices", f"{user_id}:{source}", {"devices": devices})


def load_devices(user_id: str, source: str) -> List[XiaomiDevice]:
    data = store.get("devices", f"{user_id}:{source}") or {}
    entries = data.get("devices") or []
    output: List[XiaomiDevice] = []
    for raw in entries:
        if not isinstance(raw, dict):
            continue
        output.append(
            XiaomiDevice(
                ip=str(raw.get("ip") or "").strip(),
                token=str(raw.get("token") or "").strip().lower(),
                model=str(raw.get("model") or raw.get("miio_model") or "").strip(),
                did=str(raw.get("did") or "").strip(),
                source=str(raw.get("source") or source).strip() or source,
                cloud=bool(raw.get("cloud")),
                region=normalize_region(str(raw.get("region") or "all")),
                name=str(raw.get("name") or "").strip(),
                room=str(raw.get("room") or "").strip(),
            )
        )
    return output


def build_merged_devices(user_id: str) -> List[dict]:
    oauth_devices = load_devices(user_id, "oauth")
    qr_devices = load_devices(user_id, "qr")
    return merge_device_lists(oauth_devices, qr_devices)


@app.get("/xiaomi/oauth/start", response_model=OAuthStartResponse)
def xiaomi_oauth_start(
    device_slug: str = Query(default=""),
    region: str = Query(default="all"),
):
    if not CLIENT_ID or not CLIENT_SECRET or not REDIRECT_URI:
        raise HTTPException(status_code=500, detail="Missing Xiaomi OAuth environment config.")

    normalized_region = normalize_region(region)
    state = secrets.token_urlsafe(24)
    store.put(
        "oauth_state",
        state,
        {
            "device_slug": device_slug,
            "region": normalized_region,
            "created_at": int(time.time()),
        },
    )

    params = {
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": XIAOMI_SCOPE,
        "state": state,
    }
    return OAuthStartResponse(authorize_url=f"{XIAOMI_AUTHORIZE_URL}?{urlencode(params)}", state=state)


@app.get("/xiaomi/oauth/callback")
def xiaomi_oauth_callback(
    code: Optional[str] = Query(default=None),
    state: Optional[str] = Query(default=None),
    error: Optional[str] = Query(default=None),
    error_description: Optional[str] = Query(default=None),
):
    if error:
        return RedirectResponse(frontend_smarthome_url({"xiaomi_error": error_description or error}))

    if not code or not state:
        return RedirectResponse(frontend_smarthome_url({"xiaomi_error": "missing_code_or_state"}))

    state_payload = store.get("oauth_state", state)
    if not state_payload:
        return RedirectResponse(frontend_smarthome_url({"xiaomi_error": "invalid_state"}))

    region = normalize_region(str(state_payload.get("region") or "all"))
    try:
        token_response = requests.get(
            XIAOMI_TOKEN_URL,
            params={
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
                "redirect_uri": REDIRECT_URI,
                "response_type": "code",
                "grant_type": "authorization_code",
                "code": code,
            },
            timeout=30,
        )
        token_response.raise_for_status()
        token_payload = json.loads(strip_xiaomi_prefix(token_response.text))
        access_token = str(token_payload.get("access_token") or "").strip()
        if not access_token:
            raise HTTPException(status_code=502, detail="Xiaomi OAuth did not return an access token.")

        profile_response = requests.get(
            XIAOMI_PROFILE_URL,
            params={"clientId": CLIENT_ID, "token": access_token},
            timeout=20,
        )
        profile_data = {}
        if profile_response.ok:
            profile_payload = profile_response.json()
            profile_data = profile_payload.get("data") or {}

        user_id = str(profile_data.get("userId") or "").strip() or stable_fallback_user_id(access_token)
        identity = OAuthIdentity(
            user_id=user_id,
            open_id=str(token_payload.get("openId") or "").strip(),
            region=region,
            scope=str(token_payload.get("scope") or XIAOMI_SCOPE).strip(),
            profile_name=str(profile_data.get("miliaoNick") or "").strip(),
            avatar_url=str(profile_data.get("miliaoIcon") or "").strip(),
            linked_at=int(time.time()),
        )
        tokens = OAuthTokenBundle(
            access_token=access_token,
            refresh_token=str(token_payload.get("refresh_token") or "").strip(),
            expires_in=int(token_payload.get("expires_in") or 0),
            scope=identity.scope,
            open_id=identity.open_id,
            created_at=int(time.time()),
        )
        save_identity(identity)
        save_tokens(user_id, tokens)

        oauth_devices = device_adapter.fetch_devices(access_token, region)
        if oauth_devices:
            save_devices(user_id, "oauth", [asdict(device) for device in oauth_devices])

        query = {
            "xiaomi_oauth": "success",
            "user_id": user_id,
            "region": region,
        }
        if not oauth_devices:
            query["xiaomi_warning"] = "identity_only_use_qr_fallback"
        return RedirectResponse(frontend_smarthome_url(query))
    except HTTPException as exc:
        return RedirectResponse(frontend_smarthome_url({"xiaomi_error": str(exc.detail)}))
    except Exception as exc:
        return RedirectResponse(frontend_smarthome_url({"xiaomi_error": str(exc)}))


@app.post("/xiaomi/qr/import")
def xiaomi_qr_import(payload: QRImportPayload):
    identity = store.get("identity", payload.user_id)
    if not identity:
        raise HTTPException(status_code=404, detail="Xiaomi user identity not linked yet.")

    region = normalize_region(payload.region)
    qr_devices: List[XiaomiDevice] = []
    for raw in payload.devices:
        if not isinstance(raw, dict):
            continue
        ip = str(raw.get("ip") or raw.get("localip") or "").strip()
        token = str(raw.get("token") or "").strip().lower()
        if not ip or len(token) != 32:
            continue
        qr_devices.append(
            XiaomiDevice(
                ip=ip,
                token=token,
                model=str(raw.get("model") or raw.get("miio_model") or "").strip(),
                did=str(raw.get("did") or raw.get("id") or "").strip(),
                source="qr",
                cloud=False,
                region=region,
                name=str(raw.get("name") or "").strip(),
                room=str(raw.get("room") or "").strip(),
            )
        )

    if not qr_devices:
        raise HTTPException(status_code=400, detail="No valid QR token devices found in payload.")

    save_devices(payload.user_id, "qr", [asdict(device) for device in qr_devices])
    return {
        "ok": True,
        "imported": len(qr_devices),
        "devices": build_merged_devices(payload.user_id),
    }


@app.get("/xiaomi/devices/{user_id}")
def xiaomi_devices(user_id: str):
    identity = store.get("identity", user_id)
    if not identity:
        raise HTTPException(status_code=404, detail="Xiaomi user not linked.")
    return {
        "ok": True,
        "identity": identity,
        "devices": build_merged_devices(user_id),
    }


@app.get("/health")
def health():
    return {"ok": True, "service": "xiaomi_oauth_fastapi"}
