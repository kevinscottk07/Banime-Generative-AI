"""Banime HTTP API (API Gateway HTTP API -> Lambda, Cognito JWT authorizer)."""
from __future__ import annotations

import base64
import json
import random
import re
import time
import traceback

from . import ai, common
from .common import HttpError

CREDIT_USD = 0.10
COST = {  # credits per action (1 credit ~ $0.10 of AWS usage)
    "text:core": 1, "text:sd35": 1, "text:ultra": 2, "character": 1, "sketch": 1, "photo": 1,
    "character:create": 1, "removebg": 1, "upscale": 1, "animate": 38, "enhance": 0,
}
MAX_UPLOAD = 5_500_000


# ------------------------------ identity ----------------------------------- #

def identity(event: dict) -> dict:
    claims = (event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}) or {}).get("claims", {})
    if not claims.get("sub"):
        raise HttpError(401, "Sign in required.")
    email = (claims.get("email") or "").lower()
    admins = {e.strip().lower() for e in common.env("ADMIN_EMAILS").split(",") if e.strip()}
    return {"userId": claims["sub"], "email": email, "name": claims.get("name") or email.split("@")[0],
            "isAdmin": bool(email) and email in admins}


def can_animate(who: dict) -> bool:
    return common.env("ANIMATE_POLICY", "admins") == "all" or who["isAdmin"]


def ensure_profile(who: dict) -> None:
    pk = f"USER#{who['userId']}"
    if common.get_item(pk, "PROFILE"):
        return
    common.put_item(pk, "PROFILE", {"userId": who["userId"], "email": who["email"], "name": who["name"],
                                    "created": common.now()})
    if common.get_credits(who["userId"]) is None:
        start = int(common.env("ADMIN_START_CREDITS" if who["isAdmin"] else "WELCOME_CREDITS", "30"))
        common.adjust_credits(who["userId"], start, "welcome credits")


# ------------------------------- helpers ----------------------------------- #

def charge(who, action: str, ref: str = "") -> int:
    cost = COST[action]
    if cost:
        common.adjust_credits(who["userId"], -cost, action, ref)
    return cost


def refund(who, cost: int, action: str, ref: str = "") -> None:
    if cost:
        common.adjust_credits(who["userId"], cost, f"{action} refund", ref)


def decode_upload(b64: str | None) -> str:
    if not b64:
        raise HttpError(400, "Add an image first.")
    b64 = b64.split(",", 1)[1] if b64.startswith("data:") else b64
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception:
        raise HttpError(400, "That image could not be read.")
    if len(raw) > MAX_UPLOAD:
        raise HttpError(400, "Images must be under 5 MB.")
    if not (raw.startswith(b"\xff\xd8") or raw.startswith(b"\x89PNG") or raw[8:12] == b"WEBP"):
        raise HttpError(400, "Use a JPEG, PNG or WebP image.")
    return b64


def object_b64(key: str) -> str:
    return base64.b64encode(common.client("s3").get_object(Bucket=common.bucket(), Key=key)["Body"].read()).decode()


def item_key(who, iid):
    if not re.fullmatch(r"i[0-9a-f]{12,20}", iid or ""):
        raise HttpError(404, "Not found.")
    return f"USER#{who['userId']}", f"ITEM#{iid}"


def load_item(who, iid):
    it = common.get_item(*item_key(who, iid))
    if not it:
        raise HttpError(404, "Not found.")
    return it


def view(it: dict) -> dict:
    out = dict(it)
    out.pop("arn", None)
    out["url"] = common.presign(it.get("key"), 6 * 3600)
    out["posterUrl"] = common.presign(it.get("posterKey"), 6 * 3600)
    return out


def save_image(who, data: bytes, meta: dict, ext: str = "png") -> dict:
    iid = "i" + format(time.time_ns(), "x")
    key = f"users/{who['userId']}/{iid}.{ext}"
    common.put_bytes(key, data, "image/png" if ext == "png" else "image/jpeg")
    it = {"id": iid, "kind": "image", "key": key, "created": common.now(), **meta}
    common.put_item(*item_key(who, iid), it)
    return it


# ------------------------------- routes ------------------------------------ #

def health(_w, _b, _p):
    return 200, {"ok": True, "service": "banime", "time": common.now()}


def me(who, _b, _p):
    return 200, {"userId": who["userId"], "email": who["email"], "name": who["name"], "isAdmin": who["isAdmin"],
                 "credits": common.get_credits(who["userId"]), "canAnimate": can_animate(who),
                 "costs": COST, "creditUsd": CREDIT_USD,
                 "styles": {k: v[0] for k, v in ai.STYLES.items()}}


def ledger(who, _b, _p):
    return 200, {"entries": common.query_prefix(f"USER#{who['userId']}", "LEDGER#", limit=50)}


def enhance(who, body, _p):
    idea = (body.get("prompt") or "").strip()
    if not idea:
        raise HttpError(400, "Type an idea first.")
    return 200, ai.enhance(idea, body.get("style", "shonen"))


def generate(who, body, _p):
    mode = body.get("mode", "text")
    prompt = (body.get("prompt") or "").strip()
    style = body.get("style") if body.get("style") in ai.STYLES else "shonen"
    aspect = body.get("aspect") if body.get("aspect") in ai.ASPECTS else "1:1"
    model = body.get("model") if body.get("model") in ai.TEXT_MODELS else "core"
    if not prompt:
        raise HttpError(400, "Describe what you want to see.")
    if len(prompt) > 3000:
        raise HttpError(400, "Keep the prompt under 3,000 characters.")
    seed = random.randint(0, 4294967293)
    image_b64, char = None, None
    if mode == "character":
        char = load_char(who, body.get("characterId"))
        prompt = f"{char['name']}, {char['look']}. {prompt}"
        image_b64 = object_b64(char["refKey"])
    elif mode in ("sketch", "photo"):
        image_b64 = decode_upload(body.get("imageBase64"))
    elif mode != "text":
        raise HttpError(400, "Unknown mode.")
    ai.guard(prompt)
    action = f"text:{model}" if mode == "text" else mode
    cost = charge(who, action)
    try:
        data = ai.generate(mode, prompt, style, aspect, model, seed, image_b64,
                           float(body.get("strength", 0.65 if mode == "character" else 0.7)))
    except Exception:
        refund(who, cost, action)
        raise
    it = save_image(who, data, {"prompt": body.get("prompt", "")[:3000], "style": style, "aspect": aspect,
                                "mode": mode, "model": model if mode == "text" else ai.SERVICES[mode].split(".")[2],
                                "characterId": char["id"] if char else None, "title": body.get("title", "")[:60],
                                "seed": seed, "credits": cost})
    return 200, {"item": view(it), "credits": common.get_credits(who["userId"])}


def gallery(who, _b, _p):
    items = common.query_prefix(f"USER#{who['userId']}", "ITEM#", limit=120)
    return 200, {"items": [view(i) for i in items]}


def get_item(who, _b, p):
    it = load_item(who, p["id"])
    if it["kind"] == "video" and it.get("status") == "rendering":
        st = ai.animation_status(it["arn"])
        if st["status"] == "Completed" and st.get("key"):
            it.update(status="ready", key=st["key"], finished=common.now())
            common.put_item(*item_key(who, it["id"]), it)
        elif st["status"] == "Failed" or (st["status"] == "Completed" and not st.get("key")):
            it.update(status="failed", error=(st.get("error") or "animation failed")[:300], finished=common.now())
            if not it.get("refunded"):
                refund(who, it.get("credits", 0), "animate", it["id"])
                it["refunded"] = True
            common.put_item(*item_key(who, it["id"]), it)
    return 200, {"item": view(it), "credits": common.get_credits(who["userId"])}


def delete_item(who, _b, p):
    it = load_item(who, p["id"])
    if it.get("key"):  # a video's poster belongs to its source image, so only the item's own file goes
        common.client("s3").delete_object(Bucket=common.bucket(), Key=it["key"])
    common.delete_item(*item_key(who, it["id"]))
    return 200, {"deleted": it["id"]}


def tool(who, body, p):
    name = p["tool"]
    if name not in ("removebg", "upscale"):
        raise HttpError(404, "Unknown tool.")
    src = load_item(who, body.get("itemId"))
    if src["kind"] != "image":
        raise HttpError(400, "Pick an image.")
    cost = charge(who, name, src["id"])
    try:
        if name == "upscale" and src.get("mode") in ("upscale",):
            raise HttpError(400, "This image is already upscaled.")
        b64 = object_b64(src["key"])
        data = ai.remove_background(b64) if name == "removebg" else ai.upscale(b64)
    except Exception:
        refund(who, cost, name, src["id"])
        raise
    it = save_image(who, data, {"prompt": src.get("prompt", ""), "style": src.get("style"), "aspect": src.get("aspect"),
                                "mode": name, "parentId": src["id"], "title": src.get("title", ""), "credits": cost},
                    ext="png" if name == "removebg" else "jpg")
    return 200, {"item": view(it), "credits": common.get_credits(who["userId"])}


def animate(who, body, _p):
    if not can_animate(who):
        raise HttpError(403, "Animation is limited to studio admins on this deployment.", code="animate_disabled")
    src = load_item(who, body.get("itemId"))
    if src["kind"] != "image":
        raise HttpError(400, "Pick an image to animate.")
    motion = (body.get("prompt") or "").strip()
    ai.guard(motion)
    month = time.strftime("%Y%m", time.gmtime())
    cap = float(common.env("MONTHLY_VIDEO_CAP_USD", "40"))
    usd = COST["animate"] * CREDIT_USD
    if usd > cap:
        raise HttpError(429, "This month's animation budget is used up.", code="budget")
    try:
        common.client("dynamodb").update_item(
            TableName=common.table(), Key={"pk": {"S": "CONFIG"}, "sk": {"S": f"SPEND#{month}"}},
            UpdateExpression="ADD usd :u", ConditionExpression="attribute_not_exists(usd) OR usd <= :room",
            ExpressionAttributeValues={":u": {"N": str(usd)}, ":room": {"N": str(cap - usd)}})
    except Exception as e:
        if "ConditionalCheckFailed" in str(e) or "ConditionalCheckFailed" in type(e).__name__:
            raise HttpError(429, "This month's animation budget is used up.", code="budget")
        raise
    iid = "i" + format(time.time_ns(), "x")
    cost = charge(who, "animate", iid)
    try:
        arn = ai.start_animation(object_b64(src["key"]), motion, src.get("aspect", "1:1"),
                                 f"users/{who['userId']}/video/{iid}", iid)
    except Exception:
        refund(who, cost, "animate", iid)
        raise
    it = {"id": iid, "kind": "video", "status": "rendering", "arn": arn, "posterKey": src["key"], "parentId": src["id"],
          "prompt": motion, "aspect": src.get("aspect"), "title": src.get("title", ""), "created": common.now(),
          "credits": cost}
    common.put_item(*item_key(who, iid), it)
    return 202, {"item": view(it), "credits": common.get_credits(who["userId"])}


# ------------------------------ characters --------------------------------- #

def char_key(who, cid):
    if not re.fullmatch(r"c[0-9a-f]{12}", cid or ""):
        raise HttpError(404, "Character not found.")
    return f"USER#{who['userId']}", f"CHAR#{cid}"


def load_char(who, cid):
    c = common.get_item(*char_key(who, cid))
    if not c:
        raise HttpError(404, "Character not found.")
    return c


def char_view(c):
    return {**c, "url": common.presign(c.get("refKey"), 6 * 3600)}


def list_chars(who, _b, _p):
    return 200, {"characters": [char_view(c) for c in common.query_prefix(f"USER#{who['userId']}", "CHAR#", limit=50)]}


def create_char(who, body, _p):
    name, look = (body.get("name") or "").strip()[:40], (body.get("look") or "").strip()[:600]
    style = body.get("style") if body.get("style") in ai.STYLES else "shonen"
    if not name or not look:
        raise HttpError(400, "Give your character a name and a description.")
    ai.guard(f"{name}. {look}")
    cid = common.new_id("c")
    key = f"users/{who['userId']}/chars/{cid}.png"
    if body.get("imageBase64"):
        common.put_bytes(key, base64.b64decode(decode_upload(body["imageBase64"])), "image/png")
        cost = 0
    else:
        cost = charge(who, "character:create", cid)
        try:
            img = ai.generate("text", f"character reference portrait of {name}, {look}, upper body, facing viewer, "
                                      "plain light background", style, "2:3", "core", random.randint(0, 4294967293))
        except Exception:
            refund(who, cost, "character:create", cid)
            raise
        common.put_bytes(key, img, "image/png")
    c = {"id": cid, "name": name, "look": look, "style": style, "refKey": key, "created": common.now()}
    common.put_item(*char_key(who, cid), c)
    return 201, {"character": char_view(c), "credits": common.get_credits(who["userId"])}


def delete_char(who, _b, p):
    c = load_char(who, p["id"])
    common.client("s3").delete_object(Bucket=common.bucket(), Key=c["refKey"])
    common.delete_item(*char_key(who, c["id"]))
    return 200, {"deleted": c["id"]}


def admin_grant(who, body, _p):
    if not who["isAdmin"]:
        raise HttpError(403, "Admins only.")
    uid, amount = body.get("userId"), int(body.get("credits", 0))
    if not uid or not -10000 < amount < 10000:
        raise HttpError(400, "userId and credits required.")
    return 200, {"balance": common.adjust_credits(uid, amount, f"admin grant by {who['email']}")}


ROUTES = [
    ("GET", r"/health", health, False),
    ("GET", r"/me", me, True),
    ("GET", r"/me/ledger", ledger, True),
    ("POST", r"/enhance", enhance, True),
    ("POST", r"/generate", generate, True),
    ("GET", r"/gallery", gallery, True),
    ("GET", r"/gallery/(?P<id>[^/]+)", get_item, True),
    ("DELETE", r"/gallery/(?P<id>[^/]+)", delete_item, True),
    ("POST", r"/tools/(?P<tool>[^/]+)", tool, True),
    ("POST", r"/animate", animate, True),
    ("GET", r"/characters", list_chars, True),
    ("POST", r"/characters", create_char, True),
    ("DELETE", r"/characters/(?P<id>[^/]+)", delete_char, True),
    ("POST", r"/admin/grant", admin_grant, True),
]


def route(method, path):
    for m, pat, fn, auth in ROUTES:
        mt = re.fullmatch(pat, path)
        if mt and m == method:
            return fn, mt.groupdict(), auth
    raise HttpError(404, "Not found.")


def handler(event, _ctx=None):
    try:
        if event.get("action") == "publish_site":
            from . import publish
            return publish.publish_site(event["payload"])
        method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
        path = event.get("rawPath", "/").rstrip("/") or "/"
        fn, params, auth = route(method, path)
        who = identity(event) if auth else None
        if who:
            ensure_profile(who)
        raw = event.get("body") or "{}"
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw).decode()
        status, payload = fn(who, json.loads(raw) if raw.strip() else {}, params)
        return common.response(status, payload)
    except HttpError as e:
        return common.response(e.status, {"error": e.message, **e.extra})
    except common.InsufficientCredits:
        return common.response(402, {"error": "Not enough credits for this.", "code": "credits"})
    except json.JSONDecodeError:
        return common.response(400, {"error": "Invalid JSON body."})
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"level": "error", "error": repr(e), "trace": traceback.format_exc()}))
        msg = "Something went wrong."
        r = repr(e)
        if "Throttling" in r or "ServiceQuota" in r or "TooManyRequests" in r:
            msg = "The AI service is busy. Please retry in a moment."
        elif "AccessDenied" in r and "model" in r.lower():
            msg = "That AI model isn't enabled for this AWS account yet."
        return common.response(500, {"error": msg})
