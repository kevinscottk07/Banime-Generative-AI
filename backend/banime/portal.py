"""Portal routes: projects, manga pages, library edits, sharing, profile,
data export and account deletion, Stripe billing, and the admin view."""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
import urllib.parse
import urllib.request

from . import ai, common
from .common import HttpError

PACKS = {  # credits, price in US cents (proposed; change here)
    "starter": {"name": "Starter", "credits": 100, "cents": 1500},
    "creator": {"name": "Creator", "credits": 400, "cents": 4900},
    "studio": {"name": "Studio", "credits": 1000, "cents": 10900},
}


def upk(who):
    return f"USER#{who['userId']}"


def _check_id(prefix: str, value: str | None, what: str) -> str:
    if not re.fullmatch(prefix + r"[0-9a-f]{12}", value or ""):
        raise HttpError(404, f"{what} not found.")
    return value


def _items(who, limit=500):
    return common.query_prefix(upk(who), "ITEM#", limit=limit)


def _clean_text(v, n):
    return str(v or "").strip()[:n]


# ------------------------------------------------------------------ profile + settings

def get_profile(who) -> dict:
    return common.get_item(upk(who), "PROFILE") or {}


def update_me(who, body, _p):
    prof = get_profile(who)
    if "name" in body:
        name = _clean_text(body.get("name"), 40)
        if not name:
            raise HttpError(400, "Your display name can't be empty.")
        prof["name"] = name
    if isinstance(body.get("prefs"), dict):
        p = body["prefs"]
        prefs = prof.get("prefs", {})
        if p.get("style") in ai.STYLES:
            prefs["style"] = p["style"]
        if p.get("model") in ai.TEXT_MODELS:
            prefs["model"] = p["model"]
        if p.get("aspect") in ai.ASPECTS:
            prefs["aspect"] = p["aspect"]
        prof["prefs"] = prefs
    common.put_item(upk(who), "PROFILE", prof)
    return 200, {"profile": prof}


def export_me(who, _b, _p):
    from .api import view, char_view  # late import: api imports this module
    rows = common.query_all(upk(who))
    out = {"exported": common.now(), "email": who["email"], "credits": common.get_credits(who["userId"]),
           "profile": {}, "ledger": [], "items": [], "characters": [], "projects": [], "pages": []}
    for sk, doc in rows:
        if sk == "PROFILE":
            out["profile"] = doc
        elif sk.startswith("LEDGER#"):
            out["ledger"].append(doc)
        elif sk.startswith("ITEM#"):
            out["items"].append(view(doc))
        elif sk.startswith("CHAR#"):
            out["characters"].append(char_view(doc))
        elif sk.startswith("PROJECT#"):
            out["projects"].append(doc)
        elif sk.startswith("PAGE#"):
            out["pages"].append(doc)
    return 200, out


def delete_me(who, body, _p):
    if body.get("confirm") != "DELETE":
        raise HttpError(400, 'Type DELETE to confirm.')
    s3, b = common.client("s3"), common.bucket()
    prefix, token = f"users/{who['userId']}/", None
    while True:
        kw = {"Bucket": b, "Prefix": prefix}
        if token:
            kw["ContinuationToken"] = token
        r = s3.list_objects_v2(**kw)
        keys = [{"Key": o["Key"]} for o in r.get("Contents", [])]
        for i in range(0, len(keys), 1000):
            s3.delete_objects(Bucket=b, Delete={"Objects": keys[i:i + 1000], "Quiet": True})
        token = r.get("NextContinuationToken")
        if not r.get("IsTruncated") or not token:
            break
    for sk, doc in common.query_all(upk(who)):
        if sk.startswith("ITEM#") and doc.get("shareId"):
            common.delete_item(f"SHARE#{doc['shareId']}", "META")
        common.delete_item(upk(who), sk)
    pool = common.env("USER_POOL_ID")
    if pool and who.get("username"):
        common.client("cognito-idp").admin_delete_user(UserPoolId=pool, Username=who["username"])
    return 200, {"deleted": True}


# ------------------------------------------------------------------ library edits + sharing

def patch_item(who, body, p):
    from .api import load_item, item_key, view
    it = load_item(who, p["id"])
    if "title" in body:
        it["title"] = _clean_text(body["title"], 60)
    if "favorite" in body:
        it["favorite"] = bool(body["favorite"])
    if "projectId" in body:
        pid = body["projectId"]
        if pid:
            load_project(who, pid)
        it["projectId"] = pid or None
    common.put_item(*item_key(who, it["id"]), it)
    return 200, {"item": view(it)}


def share_item(who, body, p):
    from .api import load_item, item_key, view
    it = load_item(who, p["id"])
    on = bool(body.get("on", True))
    if on and not it.get("shareId"):
        if it["kind"] == "video" and it.get("status") != "ready":
            raise HttpError(400, "Share a clip once it has finished animating.")
        sid = common.new_id("s")
        common.put_item(f"SHARE#{sid}", "META", {"id": sid, "userId": who["userId"], "itemId": it["id"],
                                                 "created": common.now()})
        it["shareId"] = sid
    elif not on and it.get("shareId"):
        common.delete_item(f"SHARE#{it['shareId']}", "META")
        it["shareId"] = None
    common.put_item(*item_key(who, it["id"]), it)
    return 200, {"item": view(it)}


def unshare_on_delete(it: dict) -> None:
    if it.get("shareId"):
        common.delete_item(f"SHARE#{it['shareId']}", "META")


def public_share(_w, _b, p):
    sid = _check_id("s", p["id"], "Link")
    sh = common.get_item(f"SHARE#{sid}", "META")
    if not sh:
        raise HttpError(404, "This link was turned off or never existed.")
    it = common.get_item(f"USER#{sh['userId']}", f"ITEM#{sh['itemId']}")
    if not it:
        raise HttpError(404, "This link was turned off or never existed.")
    prof = common.get_item(f"USER#{sh['userId']}", "PROFILE") or {}
    return 200, {"share": {
        "id": sid, "kind": it["kind"], "title": it.get("title", ""), "prompt": it.get("prompt", ""),
        "style": it.get("style"), "aspect": it.get("aspect"), "created": it.get("created"),
        "by": prof.get("name") or "a Banime artist",
        "url": common.presign(it.get("key"), 6 * 3600), "posterUrl": common.presign(it.get("posterKey"), 6 * 3600)}}


# ------------------------------------------------------------------ projects

def project_key(who, pid):
    return upk(who), f"PROJECT#{_check_id('p', pid, 'Project')}"


def load_project(who, pid):
    pr = common.get_item(*project_key(who, pid))
    if not pr:
        raise HttpError(404, "Project not found.")
    return pr


def list_projects(who, _b, _p):
    from .api import view
    projects = common.query_prefix(upk(who), "PROJECT#", limit=100)
    items = _items(who)
    pages = common.query_prefix(upk(who), "PAGE#", limit=200)
    for pr in projects:
        mine = [i for i in items if i.get("projectId") == pr["id"]]
        pr["itemCount"] = len(mine)
        pr["pageCount"] = sum(1 for g in pages if g.get("projectId") == pr["id"])
        cover = next((i for i in mine if i["id"] == pr.get("coverId")), None) or next(
            (i for i in mine if i["kind"] == "image"), None)
        pr["coverUrl"] = view(cover)["url"] if cover else None
    return 200, {"projects": projects}


def create_project(who, body, _p):
    name = _clean_text(body.get("name"), 60)
    if not name:
        raise HttpError(400, "Give the project a name.")
    if len(common.query_prefix(upk(who), "PROJECT#", limit=101)) >= 100:
        raise HttpError(400, "You can have up to 100 projects.")
    pr = {"id": common.new_id("p"), "name": name, "description": _clean_text(body.get("description"), 400),
          "created": common.now(), "coverId": None}
    common.put_item(*project_key(who, pr["id"]), pr)
    return 201, {"project": pr}


def get_project(who, _b, p):
    from .api import view
    pr = load_project(who, p["id"])
    items = [view(i) for i in _items(who) if i.get("projectId") == pr["id"]]
    pages = [g for g in common.query_prefix(upk(who), "PAGE#", limit=200) if g.get("projectId") == pr["id"]]
    return 200, {"project": pr, "items": items, "pages": pages}


def patch_project(who, body, p):
    pr = load_project(who, p["id"])
    if "name" in body:
        name = _clean_text(body["name"], 60)
        if not name:
            raise HttpError(400, "Give the project a name.")
        pr["name"] = name
    if "description" in body:
        pr["description"] = _clean_text(body["description"], 400)
    if "coverId" in body:
        pr["coverId"] = body["coverId"] or None
    common.put_item(*project_key(who, pr["id"]), pr)
    return 200, {"project": pr}


def delete_project(who, _b, p):
    """Deletes the project only. Its frames and pages stay in your library, unassigned."""
    from .api import item_key
    pr = load_project(who, p["id"])
    for it in _items(who):
        if it.get("projectId") == pr["id"]:
            it["projectId"] = None
            common.put_item(*item_key(who, it["id"]), it)
    for g in common.query_prefix(upk(who), "PAGE#", limit=200):
        if g.get("projectId") == pr["id"]:
            g["projectId"] = None
            common.put_item(upk(who), f"PAGE#{g['id']}", g)
    common.delete_item(*project_key(who, pr["id"]))
    return 200, {"deleted": pr["id"]}


# ------------------------------------------------------------------ manga pages

LAYOUTS = {"yonkoma": 4, "grid": 4, "hero": 3}


def _page_doc(who, body, base=None):
    g = dict(base or {})
    layout = body.get("layout", g.get("layout", "grid"))
    if layout not in LAYOUTS:
        raise HttpError(400, "Unknown layout.")
    pid = body.get("projectId", g.get("projectId"))
    if pid:
        load_project(who, pid)
    panels = []
    for raw in (body.get("panels") if isinstance(body.get("panels"), list) else g.get("panels", []))[:LAYOUTS[layout] + 1]:
        iid = raw.get("itemId") if isinstance(raw, dict) else None
        if iid and not re.fullmatch(r"i[0-9a-f]{12,20}", iid):
            iid = None
        panels.append({"itemId": iid, "text": _clean_text(raw.get("text") if isinstance(raw, dict) else "", 200)})
    g.update(layout=layout, title=_clean_text(body.get("title", g.get("title", "")), 80), projectId=pid or None,
             panels=panels, updatedAt=common.now())
    return g


def _page_view(g, by_id):
    out = dict(g)
    out["panels"] = [{**pn, "url": by_id.get(pn.get("itemId"))} for pn in g.get("panels", [])]
    return out


def _url_map(who):
    from .api import view
    return {i["id"]: view(i)["url"] for i in _items(who) if i["kind"] == "image"}


def list_pages(who, _b, _p):
    m = _url_map(who)
    return 200, {"pages": [_page_view(g, m) for g in common.query_prefix(upk(who), "PAGE#", limit=200)]}


def create_page(who, body, _p):
    g = _page_doc(who, body)
    g.update(id=common.new_id("g"), created=common.now())
    common.put_item(upk(who), f"PAGE#{g['id']}", g)
    return 201, {"page": _page_view(g, _url_map(who))}


def load_page(who, gid):
    g = common.get_item(upk(who), f"PAGE#{_check_id('g', gid, 'Page')}")
    if not g:
        raise HttpError(404, "Page not found.")
    return g


def update_page(who, body, p):
    g = _page_doc(who, body, load_page(who, p["id"]))
    common.put_item(upk(who), f"PAGE#{g['id']}", g)
    return 200, {"page": _page_view(g, _url_map(who))}


def delete_page(who, _b, p):
    g = load_page(who, p["id"])
    common.delete_item(upk(who), f"PAGE#{g['id']}")
    return 200, {"deleted": g["id"]}


# ------------------------------------------------------------------ billing (Stripe Checkout)

_SECRET = {"at": 0, "val": {}}


def stripe_conf() -> dict:
    arn = common.env("STRIPE_SECRET_ARN")
    if not arn:
        return {}
    if time.time() - _SECRET["at"] > 300:
        try:
            raw = common.client("secretsmanager").get_secret_value(SecretId=arn)["SecretString"]
            _SECRET["val"] = json.loads(raw or "{}")
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"level": "warn", "stripe_secret": repr(e)}))
            _SECRET["val"] = {}
        _SECRET["at"] = time.time()
    return _SECRET["val"]


def billing_enabled() -> bool:
    return str(stripe_conf().get("secretKey", "")).startswith(("sk_live_", "sk_test_"))


def _stripe(path: str, form: dict) -> dict:
    req = urllib.request.Request("https://api.stripe.com/v1/" + path, data=urllib.parse.urlencode(form).encode(),
                                 headers={"Authorization": f"Bearer {stripe_conf()['secretKey']}"})
    with urllib.request.urlopen(req, timeout=15) as r:  # noqa: S310 (fixed https host)
        return json.loads(r.read())


def checkout(who, body, _p):
    pack = PACKS.get(body.get("pack"))
    if not pack:
        raise HttpError(400, "Pick a credit pack.")
    if not billing_enabled():
        raise HttpError(503, "Payments open soon.", code="billing_off")
    site = common.env("SITE_URL").rstrip("/")
    form = {
        "mode": "payment", "success_url": f"{site}/#/credits?paid=1", "cancel_url": f"{site}/#/credits",
        "client_reference_id": who["userId"],
        "metadata[userId]": who["userId"], "metadata[pack]": body["pack"],
        "line_items[0][quantity]": 1, "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": pack["cents"],
        "line_items[0][price_data][product_data][name]": f"Banime {pack['name']} pack: {pack['credits']} credits",
    }
    if who["email"]:
        form["customer_email"] = who["email"]
    s = _stripe("checkout/sessions", form)
    return 200, {"url": s["url"]}


def verify_stripe(raw: str, header: str, secret: str, tolerance: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in (header or "").split(",") if "=" in p)
    sigs = [p.split("=", 1)[1] for p in (header or "").split(",") if p.startswith("v1=")]
    t = parts.get("t", "")
    if not t.isdigit() or abs(time.time() - int(t)) > tolerance or not sigs:
        return False
    want = hmac.new(secret.encode(), f"{t}.{raw}".encode(), hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(want, s) for s in sigs)


def stripe_webhook(raw: str, header: str) -> tuple[int, dict]:
    secret = stripe_conf().get("webhookSecret", "")
    if not secret or not verify_stripe(raw, header, secret):
        return 400, {"error": "bad signature"}
    ev = json.loads(raw)
    if ev.get("type") not in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
        return 200, {"ignored": ev.get("type")}
    s = ev["data"]["object"]
    if s.get("payment_status") != "paid":
        return 200, {"ignored": "unpaid"}
    meta = s.get("metadata") or {}
    pack, uid = PACKS.get(meta.get("pack")), meta.get("userId")
    if not pack or not uid:
        return 200, {"ignored": "no metadata"}
    order = {"id": s["id"], "userId": uid, "pack": meta["pack"], "credits": pack["credits"],
             "amount": s.get("amount_total"), "email": (s.get("customer_details") or {}).get("email"),
             "created": common.now()}
    if not common.put_new(f"ORDER#{s['id']}", "META", order):
        return 200, {"duplicate": True}
    common.adjust_credits(uid, pack["credits"], f"bought {pack['name']} pack", s["id"])
    common.put_item("CONFIG", f"ORDER#{time.time_ns()}", order)
    common.bump("orders")
    common.bump("revenueCents", int(s.get("amount_total") or 0))
    return 200, {"credited": pack["credits"]}


# ------------------------------------------------------------------ admin

def _admin(who):
    if not who["isAdmin"]:
        raise HttpError(403, "Admins only.")


def _cognito_users(limit_pages=10):
    pool = common.env("USER_POOL_ID")
    if not pool:
        return []
    users, token = [], None
    for _ in range(limit_pages):
        kw = {"UserPoolId": pool, "Limit": 60}
        if token:
            kw["PaginationToken"] = token
        r = common.client("cognito-idp").list_users(**kw)
        for u in r.get("Users", []):
            a = {x["Name"]: x["Value"] for x in u.get("Attributes", [])}
            users.append({"userId": a.get("sub"), "email": a.get("email"), "name": a.get("name"),
                          "status": u.get("UserStatus"), "enabled": u.get("Enabled", True),
                          "created": int(u["UserCreateDate"].timestamp()) if hasattr(u.get("UserCreateDate"), "timestamp")
                          else u.get("UserCreateDate")})
        token = r.get("PaginationToken")
        if not token:
            break
    return users


def admin_overview(who, _b, _p):
    _admin(who)
    month = time.strftime("%Y%m", time.gmtime())
    stats = common.get_raw("CONFIG", f"STATS#{month}") or {}
    spend = common.get_raw("CONFIG", f"SPEND#{month}") or {}
    counts = {k: int(v["N"]) for k, v in stats.items() if isinstance(v, dict) and "N" in v and k != "updated"}
    orders = common.query_prefix("CONFIG", "ORDER#", limit=20)
    return 200, {"month": month, "users": len(_cognito_users()), "counts": counts,
                 "videoSpendUsd": float(spend.get("usd", {}).get("N", 0)) if spend else 0.0,
                 "videoCapUsd": float(common.env("MONTHLY_VIDEO_CAP_USD", "40")),
                 "animatePolicy": common.env("ANIMATE_POLICY", "admins"), "billingEnabled": billing_enabled(),
                 "orders": orders}


def admin_users(who, _b, _p):
    _admin(who)
    users = _cognito_users()
    for u in users:
        u["credits"] = common.get_credits(u["userId"]) if u.get("userId") else None
    users.sort(key=lambda u: u.get("created") or 0, reverse=True)
    return 200, {"users": users}


ROUTES = [
    ("PATCH", r"/me", update_me, True),
    ("GET", r"/me/export", export_me, True),
    ("DELETE", r"/me", delete_me, True),
    ("PATCH", r"/gallery/(?P<id>[^/]+)", patch_item, True),
    ("POST", r"/gallery/(?P<id>[^/]+)/share", share_item, True),
    ("GET", r"/projects", list_projects, True),
    ("POST", r"/projects", create_project, True),
    ("GET", r"/projects/(?P<id>[^/]+)", get_project, True),
    ("PATCH", r"/projects/(?P<id>[^/]+)", patch_project, True),
    ("DELETE", r"/projects/(?P<id>[^/]+)", delete_project, True),
    ("GET", r"/pages", list_pages, True),
    ("POST", r"/pages", create_page, True),
    ("PUT", r"/pages/(?P<id>[^/]+)", update_page, True),
    ("DELETE", r"/pages/(?P<id>[^/]+)", delete_page, True),
    ("POST", r"/billing/checkout", checkout, True),
    ("GET", r"/admin/overview", admin_overview, True),
    ("GET", r"/admin/users", admin_users, True),
    ("GET", r"/public/s/(?P<id>[^/]+)", public_share, False),
]
