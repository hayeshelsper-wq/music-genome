"""Crossfader session tokens: the web app mints `${expMs}.${b64url(HMAC-SHA256(expMs))}`
with CROSSFADE_TOKEN_SECRET (10-min expiry); the browser hands it to the
audio-service WS proxy as ?token=. Standalone module so it's unit-testable
without FastAPI/librosa imports."""
import base64
import hashlib
import hmac
import time


def _sig(msg: str, secret: str) -> str:
    digest = hmac.new(secret.encode(), msg.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def verify_token(token: str, secret: str, now_ms: int | None = None) -> bool:
    if not token or not secret or "." not in token:
        return False
    exp_s, _, sig = token.partition(".")
    try:
        exp = int(exp_s)
    except ValueError:
        return False
    if exp <= (now_ms if now_ms is not None else int(time.time() * 1000)):
        return False
    return hmac.compare_digest(_sig(exp_s, secret), sig)
