"""Notifications (clip ready / failed), the public Explore feed, reports, and story planning."""
from __future__ import annotations

import re
import time

from . import ai, common
from .common import HttpError

FEED = "FEED"
REPORT_REASONS = {"sexual", "minor", "real_person", "hate", "violence", "spam", "other"}


def upk(uid: str) -> str:
    return f"USER#{uid}"


# ------------------------------------------------------------------ notifications

def notify(uid: str, kind: str, item: dict, text: str) -> None:
    nid = "n" + format(time.time_ns(), "x")
    common.put_item(upk(uid), f"NOTIF#{nid}", {"id": nid, "kind": kind, "itemId": item.get("id"),
                                                "title": item.get("title") or "", "text": text,
                                                "created": common.now(), "read": False})


def unread_count(uid: str) -> int:
    return sum(1 for n in common.query_prefix(upk(uid), "NOTIF#", limit=30) if not n.get("read"))


def list_notifications(who, _b, _p):
    items = common.query_prefix(upk(who["userId"]), "NOTIF#", limit=30)
    return 200, {"notifications": items, "unread": sum(1 for n in items if not n.get("read"))}


def mark_read(who, body, _p):
    ids = body.get("ids")
    n = 0
    for doc in common.query_prefix(upk(who["userId"]), "NOTIF#", limit=30):
        if not doc.get("read") and (ids is None or doc["id"] in ids):
            doc["read"] = True
            common.put_item(upk(who["userId"]), f"NOTIF#{doc['id']}", doc)
            n += 1
    return 200, {"marked": n}


def watch_clip(uid: str, iid: str) -> None:
    common.put_item("CONFIG", f"PENDING#{iid}", {"userId": uid, "itemId": iid, "started": common.now()})


def sweep(settle) -> dict:
    """Scheduled: finish clips nobody is watching, so their owners still get told."""
    done = 0
    for p in common.query_prefix("CONFIG", "PENDING#", limit=50, newest_first=False):
        it = common.get_item(upk(p["userId"]), f"ITEM#{p['itemId']}")
        if not it or it.get("status") != "rendering":
            common.delete_item("CONFIG", f"PENDING#{p['itemId']}")
            continue
        if settle({"userId": p["userId"]}, it):
            done += 1
        elif common.now() - p.get("started", 0) > 3 * 3600:  # Bedrock should never take this long
            common.delete_item("CONFIG", f"PENDING#{p['itemId']}")
    return {"settled": done}


# ------------------------------------------------------------------ explore

def feed_add(who, it: dict) -> dict:
    if it.get("feedSk"):
        return it
    sk = f"{format(time.time_ns(), 'x')}#{it['shareId']}"
    common.put_item(FEED, sk, {"shareId": it["shareId"], "userId": who["userId"], "itemId": it["id"],
                               "kind": it["kind"], "style": it.get("style"), "created": common.now()})
    it["feedSk"] = sk
    return it


def feed_remove(it: dict) -> dict:
    if it.get("feedSk"):
        common.delete_item(FEED, it["feedSk"])
    it["feedSk"] = None
    return it


def explore_toggle(who, body, p):
    from .api import load_item, item_key, view
    from .portal import share_item
    it = load_item(who, p["id"])
    if body.get("on", True):
        if it["kind"] == "video" and it.get("status") != "ready":
            raise HttpError(400, "Post a clip once it has finished animating.")
        if it.get("hidden"):
            raise HttpError(403, "This creation was removed from Explore by a moderator.")
        if not it.get("shareId"):
            share_item(who, {"on": True}, p)
            it = load_item(who, p["id"])
        feed_add(who, it)
    else:
        feed_remove(it)
    common.put_item(*item_key(who, it["id"]), it)
    return 200, {"item": view(it)}


def explore(_w, _b, p):
    qs = p.get("qs", {})
    cursor = qs.get("cursor") or None
    if cursor and not re.fullmatch(r"[0-9a-f]{8,20}#s[0-9a-f]{12}", cursor):
        cursor = None
    rows = common.query_before(FEED, cursor, 24)
    names: dict[str, str] = {}
    out = []
    for sk, f in rows:
        it = common.get_item(upk(f["userId"]), f"ITEM#{f['itemId']}")
        if not it or it.get("feedSk") != sk or it.get("hidden"):
            continue
        if f["userId"] not in names:
            names[f["userId"]] = (common.get_item(upk(f["userId"]), "PROFILE") or {}).get("name") or "a Banime artist"
        out.append({"shareId": f["shareId"], "kind": it["kind"], "style": it.get("style"), "aspect": it.get("aspect"),
                    "title": it.get("title", ""), "prompt": it.get("prompt", ""), "by": names[f["userId"]],
                    "created": it.get("created"), "url": common.presign(it.get("key"), 6 * 3600),
                    "posterUrl": common.presign(it.get("posterKey"), 6 * 3600)})
    return 200, {"items": out, "cursor": rows[-1][0] if len(rows) == 24 else None}


def report(who, body, _p):
    sid = body.get("shareId") or ""
    if not re.fullmatch(r"s[0-9a-f]{12}", sid) or not common.get_item(f"SHARE#{sid}", "META"):
        raise HttpError(404, "That creation wasn't found.")
    reason = body.get("reason") if body.get("reason") in REPORT_REASONS else "other"
    common.put_item("CONFIG", f"REPORT#{format(time.time_ns(), 'x')}", {
        "shareId": sid, "reason": reason, "note": str(body.get("note") or "")[:300],
        "by": who["email"] or who["userId"], "created": common.now()})
    common.bump("reports")
    return 200, {"reported": True}


def admin_reports(who, _b, _p):
    if not who["isAdmin"]:
        raise HttpError(403, "Admins only.")
    return 200, {"reports": common.query_prefix("CONFIG", "REPORT#", limit=30)}


def admin_hide(who, _b, p):
    """Take a creation off Explore and turn its public link off. The owner keeps it in their library."""
    if not who["isAdmin"]:
        raise HttpError(403, "Admins only.")
    sid = p["id"]
    sh = common.get_item(f"SHARE#{sid}", "META") if re.fullmatch(r"s[0-9a-f]{12}", sid) else None
    if not sh:
        raise HttpError(404, "Not found.")
    it = common.get_item(upk(sh["userId"]), f"ITEM#{sh['itemId']}")
    common.delete_item(f"SHARE#{sid}", "META")
    if it:
        feed_remove(it)
        it.update(shareId=None, hidden=True)
        common.put_item(upk(sh["userId"]), f"ITEM#{it['id']}", it)
    for r in common.query_all("CONFIG"):
        if r[0].startswith("REPORT#") and r[1].get("shareId") == sid:
            common.delete_item("CONFIG", r[0])
    return 200, {"hidden": sid}


# ------------------------------------------------------------------ story planning

STORY_TOOL = {"toolSpec": {"name": "submit_story", "description": "Return the story plan.", "inputSchema": {"json": {
    "type": "object", "required": ["title", "scenes"],
    "properties": {
        "title": {"type": "string", "description": "A short story title, 2-6 words."},
        "scenes": {"type": "array", "items": {"type": "object", "required": ["prompt", "caption"], "properties": {
            "prompt": {"type": "string", "description": "One concrete visual scene for an anime image model, 30-70 words: the main character's action, pose and expression, setting, lighting, camera angle. Refer to the main character as 'the character', never by a description of their looks."},
            "caption": {"type": "string", "description": "Speech or narration for this panel, under 15 words."}}}},
    }}}}}


def plan_story(who, body, _p):
    premise = str(body.get("premise") or "").strip()
    if len(premise) < 8:
        raise HttpError(400, "Describe the story in a sentence or two.")
    count = max(2, min(6, int(body.get("count") or 4)))
    style = body.get("style") if body.get("style") in ai.STYLES else "shonen"
    name = ""
    if body.get("characterId"):
        from .api import load_char
        name = load_char(who, body["characterId"]).get("name", "")
    ai.guard(premise)
    sys = (f"You plan short anime comics. Split the user's premise into exactly {count} scenes that tell a clear story with "
           "a beginning, a turn and an ending, one moment per panel. Vary the camera (wide, medium, close-up). "
           "Never depict real people, sexual content, gore, or minors in any suggestive way. Do not name real artists or studios. "
           f"Target style: {ai.STYLES[style][0]}." + (f" The main character is named {name}." if name else ""))
    r = common.client("bedrock-runtime").converse(
        modelId=common.env("PROMPT_MODEL_ID", ai.PROMPT_MODEL_DEFAULT),
        system=[{"text": sys}], messages=[{"role": "user", "content": [{"text": premise[:1500]}]}],
        toolConfig={"tools": [STORY_TOOL], "toolChoice": {"tool": {"name": "submit_story"}}},
        inferenceConfig={"maxTokens": 1600, "temperature": 0.8})
    for block in r["output"]["message"]["content"]:
        if "toolUse" in block:
            out = block["toolUse"]["input"]
            scenes = [{"prompt": str(s.get("prompt", ""))[:600], "caption": str(s.get("caption", ""))[:120]}
                      for s in (out.get("scenes") or [])[:count] if isinstance(s, dict) and s.get("prompt")]
            if not scenes:
                break
            ai.guard(" ".join(s["prompt"] + " " + s["caption"] for s in scenes), "OUTPUT")
            common.bump("storyPlans")
            return 200, {"title": str(out.get("title", ""))[:60], "scenes": scenes}
    raise HttpError(502, "The story planner did not answer. Try again.")


ROUTES = [
    ("GET", r"/notifications", list_notifications, True),
    ("POST", r"/notifications/read", mark_read, True),
    ("POST", r"/gallery/(?P<id>[^/]+)/explore", explore_toggle, True),
    ("POST", r"/report", report, True),
    ("POST", r"/stories/plan", plan_story, True),
    ("GET", r"/admin/reports", admin_reports, True),
    ("POST", r"/admin/hide/(?P<id>[^/]+)", admin_hide, True),
    ("GET", r"/public/explore", explore, False),
]
