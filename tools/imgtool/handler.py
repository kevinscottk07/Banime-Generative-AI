"""Build-time image tool for the Banime site art.

Ops
- alpha_mask: {"op": "alpha_mask", "bucket", "src", "dst", "scale"}: gray+alpha PNG mask from an RGBA
  cutout (pure Python, see maskpng.py).
- resize: {"op": "resize", "bucket", "jobs": [{"src", "dst", "width", "quality", "format"}]}: re-encode
  images for the web with Pillow. Pillow isn't in the Lambda runtime, so the matching wheel is fetched
  from PyPI into /tmp on first use (build-time tool only; never part of the live app).
"""
import io
import json
import os
import platform
import sys
import urllib.request
import zipfile

import boto3

s3 = boto3.client("s3")
_PIL = "/tmp/pillow"


def _pillow():
    if not os.path.isdir(os.path.join(_PIL, "PIL")):
        arch = "aarch64" if platform.machine() in ("aarch64", "arm64") else "x86_64"
        meta = json.loads(urllib.request.urlopen("https://pypi.org/pypi/pillow/json", timeout=30).read())
        tag = f"cp{sys.version_info.major}{sys.version_info.minor}"
        wheel = next(u["url"] for u in meta["urls"] if u["filename"].endswith(".whl") and f"-{tag}-{tag}-" in u["filename"]
                     and "manylinux" in u["filename"] and arch in u["filename"] and "musl" not in u["filename"])
        zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(wheel, timeout=60).read())).extractall(_PIL)
    if _PIL not in sys.path:
        sys.path.insert(0, _PIL)
    from PIL import Image
    return Image


def resize(event):
    Image = _pillow()
    out = []
    for j in event["jobs"]:
        im = Image.open(io.BytesIO(s3.get_object(Bucket=event["bucket"], Key=j["src"])["Body"].read()))
        im.load()
        src_size = im.size
        if j.get("width") and im.width > j["width"]:
            im = im.resize((j["width"], round(im.height * j["width"] / im.width)), Image.LANCZOS)
        fmt = j.get("format", "webp").lower()
        buf = io.BytesIO()
        if fmt == "webp":
            im.save(buf, "WEBP", quality=j.get("quality", 80), method=6)
            ctype = "image/webp"
        else:
            im.convert("RGB").save(buf, "JPEG", quality=j.get("quality", 82), optimize=True, progressive=True)
            ctype = "image/jpeg"
        s3.put_object(Bucket=event["bucket"], Key=j["dst"], Body=buf.getvalue(), ContentType=ctype,
                      CacheControl="public, max-age=31536000, immutable")
        out.append({"dst": j["dst"], "from": list(src_size), "to": list(im.size), "bytes": len(buf.getvalue())})
    return out


def handler(event, _ctx=None):
    if event.get("op") == "resize":
        return resize(event)
    from maskpng import alpha_mask
    return alpha_mask(s3, event)
