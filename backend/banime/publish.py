"""Release helper: publishes the web app bundled in this Lambda package
(studio/site/*) to the site bucket, writing config.js from stack outputs.
Invoked by the deploy tooling as worker action "publish_site"."""
from __future__ import annotations

import hashlib
import json
import os

from . import common

TYPES = {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml"}


def publish_site(event: dict) -> dict:
    bucket = common.env("SITE_BUCKET")
    site_dir = os.path.join(os.path.dirname(__file__), "site")
    s3 = common.client("s3")
    written = []
    files = {}
    for name in sorted(os.listdir(site_dir)):
        if os.path.splitext(name)[1] in TYPES and name != "config.js":
            with open(os.path.join(site_dir, name), "rb") as f:
                files[name] = f.read()
    files = versioned(files)
    for name, body in files.items():
        s3.put_object(Bucket=bucket, Key=name, Body=body, ContentType=TYPES[os.path.splitext(name)[1]] + "; charset=utf-8",
                      CacheControl="no-cache")
        written.append(name)
    cfg = {k: event[k] for k in ("apiUrl", "userPoolClientId", "authDomain", "google") if k in event}
    cfg["region"] = common.region()
    s3.put_object(Bucket=bucket, Key="config.js", ContentType="text/javascript; charset=utf-8", CacheControl="no-cache",
                  Body=f"window.BANIME_CONFIG = {json.dumps(cfg)};\n".encode())
    return {"published": written + ["config.js"]}


def versioned(files: dict[str, bytes]) -> dict[str, bytes]:
    """Stamp asset URLs with a content hash so browsers never run a stale app after a release."""
    v = {n: hashlib.sha256(b).hexdigest()[:10] for n, b in files.items()}
    out = dict(files)
    if "app.js" in out and "demo.js" in v:
        out["app.js"] = out["app.js"].replace(b'"./demo.js"', f'"./demo.js?v={v["demo.js"]}"'.encode())
        v["app.js"] = hashlib.sha256(out["app.js"]).hexdigest()[:10]
    if "index.html" in out:
        html = out["index.html"]
        for n in ("styles.css", "app.js"):
            if n in v:
                html = html.replace(f'"{n}"'.encode(), f'"{n}?v={v[n]}"'.encode())
        out["index.html"] = html
    return out
