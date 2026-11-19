import os
import unittest

from banime import api, common
from tests import fakes
from tests.test_banime import ADMIN, call
from tests.test_portal import FakeCognito


class SocialTest(unittest.TestCase):
    def setUp(self):
        os.environ.update(TABLE_NAME="t", MEDIA_BUCKET="bucket", ADMIN_EMAILS=ADMIN, ANIMATE_POLICY="admins",
                          WELCOME_CREDITS="30", ADMIN_START_CREDITS="300", MONTHLY_VIDEO_CAP_USD="40",
                          GUARDRAIL_ID="g", USER_POOL_ID="pool", SITE_URL="https://site.example")
        os.environ.pop("STRIPE_SECRET_ARN", None)
        common.reset_clients()
        self.ddb, self.s3 = fakes.FakeDynamo(), fakes.FakeS3()
        self.br = fakes.FakeBedrock(self.s3)
        for n, f in (("dynamodb", self.ddb), ("s3", self.s3), ("bedrock-runtime", self.br), ("cognito-idp", FakeCognito())):
            common.set_client(n, f)

    def gen(self, **kw):
        st, r = call("POST", "/generate", {"prompt": "x", **kw})
        self.assertEqual(st, 200, r)
        return r["item"]

    def test_scheduled_sweep_finishes_clip_and_notifies(self):
        img = self.gen()
        st, r = call("POST", "/animate", {"itemId": img["id"], "prompt": "wind"})
        self.assertEqual(st, 202, r)
        vid = r["item"]["id"]
        self.assertTrue(any(k[1] == f"PENDING#{vid}" for k in self.ddb.items))
        self.assertEqual(api.handler({"source": "aws.events"}), {"settled": 0})  # first poll: still rendering
        self.assertEqual(api.handler({"source": "aws.events"}), {"settled": 1})
        self.assertFalse(any(k[1].startswith("PENDING#") for k in self.ddb.items))
        me = call("GET", "/me")[1]
        self.assertEqual(me["unread"], 1)
        st, r = call("GET", "/notifications")
        self.assertEqual((r["notifications"][0]["kind"], r["notifications"][0]["itemId"]), ("clip_ready", vid))
        call("POST", "/notifications/read", {})
        self.assertEqual(call("GET", "/me")[1]["unread"], 0)
        self.assertEqual(call("GET", f"/gallery/{vid}")[1]["item"]["status"], "ready")

    def test_failed_clip_refunds_and_notifies_once(self):
        self.br.fail_all = True
        img = self.gen()
        before = call("GET", "/me")[1]["credits"]
        vid = call("POST", "/animate", {"itemId": img["id"], "prompt": "wind"})[1]["item"]["id"]
        call("GET", f"/gallery/{vid}")
        call("GET", f"/gallery/{vid}")
        api.handler({"action": "sweep"})
        self.assertEqual(call("GET", "/me")[1]["credits"], before)
        kinds = [n["kind"] for n in call("GET", "/notifications")[1]["notifications"]]
        self.assertEqual(kinds, ["clip_failed"])

    def test_explore_feed_post_remove_and_moderate(self):
        a = self.gen(title="A")
        b = self.gen(title="B")
        st, r = call("POST", f"/gallery/{a['id']}/explore", {"on": True})
        self.assertEqual(st, 200, r)
        self.assertTrue(r["item"]["shareId"])  # posting creates the share link
        call("POST", f"/gallery/{b['id']}/explore", {"on": True})
        st, feed = call("GET", "/public/explore", email=None)
        self.assertEqual([x["title"] for x in feed["items"]], ["B", "A"])
        self.assertNotIn("userId", feed["items"][0])
        # turning the link off also takes it off Explore
        call("POST", f"/gallery/{b['id']}/share", {"on": False})
        self.assertEqual([x["title"] for x in call("GET", "/public/explore", email=None)[1]["items"]], ["A"])
        # someone reports it, the admin hides it
        sid = feed["items"][1]["shareId"]
        self.assertEqual(call("POST", "/report", {"shareId": sid, "reason": "spam"}, email="fan@x.com", sub="fan")[0], 200)
        self.assertEqual(len(call("GET", "/admin/reports")[1]["reports"]), 1)
        self.assertEqual(call("POST", f"/admin/hide/{sid}", email="fan@x.com", sub="fan")[0], 403)
        self.assertEqual(call("POST", f"/admin/hide/{sid}")[0], 200)
        self.assertEqual(call("GET", "/public/explore", email=None)[1]["items"], [])
        self.assertEqual(call("GET", f"/public/s/{sid}", email=None)[0], 404)
        self.assertEqual(call("GET", "/admin/reports")[1]["reports"], [])
        self.assertEqual(call("POST", f"/gallery/{a['id']}/explore", {"on": True})[0], 403)

    def test_explore_pages_with_cursor(self):
        for i in range(26):
            it = self.gen(title=f"T{i}")
            call("POST", f"/gallery/{it['id']}/explore", {"on": True})
        p1 = call("GET", "/public/explore", email=None)[1]
        self.assertEqual(len(p1["items"]), 24)
        p2 = api.handler({"rawPath": "/public/explore", "requestContext": {"http": {"method": "GET"}},
                          "queryStringParameters": {"cursor": p1["cursor"]}})
        import json
        body = json.loads(p2["body"])
        self.assertEqual([x["title"] for x in body["items"]], ["T1", "T0"])

    def test_plan_story_and_story_project(self):
        st, r = call("POST", "/stories/plan", {"premise": "A wind courier races a storm across rooftops", "count": 3})
        self.assertEqual(st, 200, r)
        self.assertEqual((r["title"], len(r["scenes"])), ("Wind Courier", 3))
        self.assertEqual(call("POST", "/stories/plan", {"premise": "hi"})[0], 400)
        st, p = call("POST", "/projects", {"name": r["title"], "story": {"premise": "x", "style": "cyber", "scenes": r["scenes"], "characterId": "bad"}})
        self.assertEqual(st, 201)
        self.assertEqual((p["project"]["story"]["style"], p["project"]["story"]["characterId"], len(p["project"]["story"]["scenes"])), ("cyber", None, 3))


if __name__ == "__main__":
    unittest.main()
