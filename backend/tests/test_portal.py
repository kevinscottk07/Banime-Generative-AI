import hashlib
import hmac
import json
import os
import time
import unittest
from datetime import datetime, timezone

from banime import common, portal
from tests import fakes
from tests.test_banime import ADMIN, call


class FakeCognito:
    def __init__(self):
        self.deleted = []

    def list_users(self, UserPoolId, Limit, PaginationToken=None):
        return {"Users": [{"Username": "u1", "UserStatus": "CONFIRMED", "Enabled": True,
                           "UserCreateDate": datetime(2026, 11, 1, tzinfo=timezone.utc),
                           "Attributes": [{"Name": "sub", "Value": "u1"}, {"Name": "email", "Value": ADMIN}]}]}

    def admin_delete_user(self, UserPoolId, Username):
        self.deleted.append(Username)


class FakeSecrets:
    def __init__(self, val):
        self.val = val

    def get_secret_value(self, SecretId):
        return {"SecretString": json.dumps(self.val)}


class PortalTest(unittest.TestCase):
    def setUp(self):
        os.environ.update(TABLE_NAME="t", MEDIA_BUCKET="bucket", ADMIN_EMAILS=ADMIN, ANIMATE_POLICY="admins",
                          WELCOME_CREDITS="30", ADMIN_START_CREDITS="300", MONTHLY_VIDEO_CAP_USD="40",
                          GUARDRAIL_ID="g", USER_POOL_ID="pool", SITE_URL="https://site.example")
        os.environ.pop("STRIPE_SECRET_ARN", None)
        portal._SECRET.update(at=0, val={})
        common.reset_clients()
        self.ddb, self.s3 = fakes.FakeDynamo(), fakes.FakeS3()
        self.br, self.cog = fakes.FakeBedrock(self.s3), FakeCognito()
        for n, f in (("dynamodb", self.ddb), ("s3", self.s3), ("bedrock-runtime", self.br), ("cognito-idp", self.cog)):
            common.set_client(n, f)

    def gen(self, **kw):
        st, r = call("POST", "/generate", {"prompt": "x", **kw})
        self.assertEqual(st, 200, r)
        return r["item"]

    def test_profile_and_prefs(self):
        st, r = call("PATCH", "/me", {"name": "Kev", "prefs": {"style": "cyber", "model": "ultra", "aspect": "bogus"}})
        self.assertEqual(st, 200, r)
        me = call("GET", "/me")[1]
        self.assertEqual((me["name"], me["prefs"]), ("Kev", {"style": "cyber", "model": "ultra"}))
        self.assertFalse(me["billingEnabled"])
        self.assertIn("starter", me["packs"])
        self.assertEqual(call("PATCH", "/me", {"name": "  "})[0], 400)

    def test_projects_items_and_pages(self):
        st, r = call("POST", "/projects", {"name": "Rooftop Saga", "description": "chapter one"})
        self.assertEqual(st, 201, r)
        pid = r["project"]["id"]
        a = self.gen(projectId=pid)
        b = self.gen()
        self.assertEqual(a["projectId"], pid)
        self.assertIsNone(b["projectId"])
        st, r = call("PATCH", f"/gallery/{b['id']}", {"projectId": pid, "favorite": True, "title": "Dusk"})
        self.assertEqual((st, r["item"]["favorite"], r["item"]["title"]), (200, True, "Dusk"))
        self.assertEqual(call("PATCH", f"/gallery/{b['id']}", {"projectId": "p000000000000"})[0], 404)
        projects = call("GET", "/projects")[1]["projects"]
        self.assertEqual((projects[0]["itemCount"], bool(projects[0]["coverUrl"])), (2, True))
        st, r = call("POST", "/pages", {"projectId": pid, "layout": "grid", "title": "Page 1",
                                        "panels": [{"itemId": a["id"], "text": "Hey!"}, {"itemId": None, "text": ""}]})
        self.assertEqual(st, 201, r)
        gid = r["page"]["id"]
        self.assertTrue(r["page"]["panels"][0]["url"].startswith("https://signed.example/"))
        st, r = call("PUT", f"/pages/{gid}", {"title": "Page one", "panels": [{"itemId": b["id"], "text": "Yo"}]})
        self.assertEqual((st, r["page"]["title"], r["page"]["panels"][0]["itemId"]), (200, "Page one", b["id"]))
        self.assertEqual(call("POST", "/pages", {"layout": "nope"})[0], 400)
        detail = call("GET", f"/projects/{pid}")[1]
        self.assertEqual((len(detail["items"]), len(detail["pages"])), (2, 1))
        # another user cannot see or touch it
        self.assertEqual(call("GET", f"/projects/{pid}", email="z@x.com", sub="z")[0], 404)
        self.assertEqual(call("PUT", f"/pages/{gid}", {}, email="z@x.com", sub="z")[0], 404)
        # deleting the project keeps the frames and the page
        self.assertEqual(call("DELETE", f"/projects/{pid}")[0], 200)
        self.assertEqual(len(call("GET", "/gallery")[1]["items"]), 2)
        self.assertIsNone(call("GET", "/pages")[1]["pages"][0]["projectId"])

    def test_share_link_is_public_and_revocable(self):
        it = self.gen(title="Rooftop")
        st, r = call("POST", f"/gallery/{it['id']}/share", {"on": True})
        sid = r["item"]["shareId"]
        self.assertTrue(sid.startswith("s"))
        st, r = call("GET", f"/public/s/{sid}", email=None)
        self.assertEqual(st, 200, r)
        self.assertEqual(r["share"]["kind"], "image")
        self.assertNotIn("userId", r["share"])
        call("POST", f"/gallery/{it['id']}/share", {"on": False})
        self.assertEqual(call("GET", f"/public/s/{sid}", email=None)[0], 404)
        call("POST", f"/gallery/{it['id']}/share", {"on": True})
        sid2 = call("GET", f"/gallery/{it['id']}")[1]["item"]["shareId"]
        call("DELETE", f"/gallery/{it['id']}")
        self.assertEqual(call("GET", f"/public/s/{sid2}", email=None)[0], 404)
        self.assertEqual(call("GET", "/public/s/../x", email=None)[0], 404)

    def test_export_and_delete_account(self):
        self.gen()
        call("POST", "/projects", {"name": "P"})
        st, ex = call("GET", "/me/export")
        self.assertEqual((st, len(ex["items"]), len(ex["projects"]), ex["credits"]), (200, 1, 1, 299))
        self.assertEqual(call("DELETE", "/me", {})[0], 400)
        st, r = call("DELETE", "/me", {"confirm": "DELETE"})
        self.assertEqual(st, 200, r)
        self.assertEqual(self.s3.objects, {})
        self.assertFalse([k for k in self.ddb.items if k[0] == "USER#u1"])
        self.assertEqual(self.cog.deleted, ["u1"])

    def test_admin_views(self):
        self.gen()
        st, r = call("GET", "/admin/overview")
        self.assertEqual(st, 200, r)
        self.assertEqual((r["users"], r["counts"].get("images")), (1, 1))
        st, r = call("GET", "/admin/users")
        self.assertEqual(r["users"][0]["credits"], 299)
        self.assertEqual(call("GET", "/admin/users", email="fan@x.com", sub="fan")[0], 403)

    def test_billing_off_then_webhook_credits_once(self):
        st, r = call("POST", "/billing/checkout", {"pack": "starter"})
        self.assertEqual((st, r["code"]), (503, "billing_off"))
        os.environ["STRIPE_SECRET_ARN"] = "arn:secret"
        common.set_client("secretsmanager", FakeSecrets({"secretKey": "sk_test_x", "webhookSecret": "whsec_x"}))
        portal._SECRET.update(at=0)
        self.assertTrue(call("GET", "/me")[1]["billingEnabled"])
        before = call("GET", "/me")[1]["credits"]
        ev = json.dumps({"type": "checkout.session.completed", "data": {"object": {
            "id": "cs_test_1", "payment_status": "paid", "amount_total": 1500,
            "metadata": {"userId": "u1", "pack": "starter"}}}})
        t = str(int(time.time()))
        sig = hmac.new(b"whsec_x", f"{t}.{ev}".encode(), hashlib.sha256).hexdigest()

        def hook(signature):
            from banime import api
            r = api.handler({"rawPath": "/public/stripe-webhook", "requestContext": {"http": {"method": "POST"}},
                             "headers": {"stripe-signature": signature}, "body": ev})
            return r["statusCode"], json.loads(r["body"])

        self.assertEqual(hook(f"t={t},v1=deadbeef")[0], 400)
        self.assertEqual(hook(f"t={t},v1={sig}"), (200, {"credited": 100}))
        self.assertEqual(hook(f"t={t},v1={sig}"), (200, {"duplicate": True}))
        self.assertEqual(call("GET", "/me")[1]["credits"], before + 100)
        self.assertEqual(len(call("GET", "/admin/overview")[1]["orders"]), 1)


if __name__ == "__main__":
    unittest.main()
