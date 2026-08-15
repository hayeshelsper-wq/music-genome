#!/usr/bin/env python3
"""Seed V2 demo content on the live site (no Claude credits needed):
1. melody transcriptions for every showcase track (Firestore symbolic cache)
2. SAM extractions for three standard prompts per track (GCS + Firestore)
3. one hum -> production demo into the library

Usage: AUTH_PASSWORD=... python3 scripts/seed_demo.py [--skip-transcribe] [--skip-extract] [--skip-hum]
Idempotent: everything lands in permanent caches; re-runs skip finished work.
"""
import json
import os
import sys
import time
import urllib.request
import uuid
from http.cookiejar import CookieJar

WEB = os.environ.get("WEB", "https://web-717795396324.us-central1.run.app")
PROMPTS = ["the drums", "the bass line", "the lead vocal"]
SABBATH = "5182c1d9-c7d2-4dad-afa0-ccfeada921a8"

jar = CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(path: str, body=None, timeout=400, raw: bytes = None, content_type=None):
    url = f"{WEB}{path}"
    data = None
    headers = {}
    if raw is not None:
        data = raw
        headers["Content-Type"] = content_type
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {"error": f"http {e.code}"}
    except Exception as e:  # noqa: BLE001
        return 0, {"error": str(e)[:200]}


def main() -> int:
    args = set(sys.argv[1:])
    pw = os.environ.get("AUTH_PASSWORD", "")
    status, j = call("/api/auth/login", {"password": pw})
    if not j.get("ok"):
        print(f"login failed: {status} {j}")
        return 1
    print("▸ login ok")

    _, sc = call("/api/showcase", timeout=60)
    songs = [s for s in sc.get("songs", []) if s.get("previewUrl")]
    print(f"▸ {len(songs)} showcase tracks")

    if "--skip-transcribe" not in args:
        print("▸ 1/3 melody transcriptions")
        for s in songs:
            t0 = time.time()
            _, r = call(
                "/api/track/transcribe",
                {"previewUrl": s["previewUrl"], "artist": s["artist"], "title": s["title"], "mode": "melody"},
            )
            note = r.get("error") or f"{len(r.get('notes', []))} notes ({r.get('stem')})"
            print(f"  {s['artist']} — {s['title']}: {note} [{time.time()-t0:.0f}s]")

    if "--skip-extract" not in args:
        print("▸ 2/3 SAM extractions")
        for s in songs:
            for prompt in PROMPTS:
                label = f"  {s['artist']} — {s['title']} / {prompt}"
                for _ in range(60):
                    _, r = call("/api/track/extract", {"previewUrl": s["previewUrl"], "text": prompt})
                    if r.get("warming"):
                        time.sleep(20)
                        continue
                    print(f"{label}: {r.get('error') or ('cached' if r.get('cached') else 'extracted')}")
                    break
                else:
                    print(f"{label}: gave up (still warming)")

    if "--skip-hum" not in args:
        print("▸ 3/3 hum demo")
        fixture = os.path.join(os.path.dirname(__file__), "..", "mocks", "fixtures", "hum.webm")
        with open(fixture, "rb") as f:
            blob = f.read()
        boundary = uuid.uuid4().hex
        raw = (
            (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
             f"filename=\"hum.webm\"\r\nContent-Type: audio/webm\r\n\r\n").encode()
            + blob
            + f"\r\n--{boundary}--\r\n".encode()
        )
        _, hum = call("/api/hum", raw=raw, content_type=f"multipart/form-data; boundary={boundary}", timeout=300)
        if not hum.get("humId"):
            print(f"  hum failed: {hum}")
        else:
            print(f"  hum {hum['humId']}: {len(hum.get('notes', []))} notes, "
                  f"neighbors {[n['artist'] for n in (hum.get('map') or {}).get('neighbors', [])]}")
            _, prod = call(
                "/api/hum/produce",
                {"humId": hum["humId"], "styleMbid": SABBATH, "engine": "musicgen-melody", "verify": True},
                timeout=580,
            )
            ok_msg = f"{prod.get('producedId')} fidelity={prod.get('melodicFidelity')}"
            print(f"  produce: {prod.get('error') or ok_msg}")

    print("✅ seeding done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
