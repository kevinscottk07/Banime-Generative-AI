import base64
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from banime import ai, api, common  # noqa: E402
from tests import fakes  # noqa: E402

ADMIN = "kevin@example.com"
PNG = base64.b64encode(b"\x89PNG" + b"0" * 200).decode()


def call(method, path, body=None, email=ADMIN, sub="u1"):
    e = {"rawPath": path, "requestContext": {"http": {"method": method}}, "body": json.dumps(body or {})}
    if email is not None:
        e["requestContext"]["authorizer"] = {"jwt": {"claims": {"sub": sub, "email": email}}}
    r = api.handler(e)
    return r["statusCode"], json.loads(r["body"])


class BanimeTest(unittest.TestCase):
    def setUp(self):
        os.environ.update(TABLE_NAME="t", MEDIA_BUCKET="bucket", ADMIN_EMAILS=ADMIN, ANIMATE_POLICY="admins",
                          WELCOME_CREDITS="30", ADMIN_START_CREDITS="300", MONTHLY_VIDEO_CAP_USD="40", GUARDRAIL_ID="g")
        common.reset_clients()
        self.ddb, self.s3 = fakes.FakeDynamo(), fakes.FakeS3()
        self.br = fakes.FakeBedrock(self.s3)
        for n, f in (("dynamodb", self.ddb), ("s3", self.s3), ("bedrock-runtime", self.br)):
            common.set_client(n, f)

    def credits(self, **kw):
        return call("GET", "/me", **kw)[1]["credits"]

    def test_auth_and_welcome(self):
        self.assertEqual(call("GET", "/me", email=None)[0], 401)
        self.assertEqual(call("GET", "/health", email=None)[0], 200)
        st, me = call("GET", "/me", email="fan@x.com", sub="u2")
        self.assertEqual((me["credits"], me["canAnimate"], me["isAdmin"]), (30, False, False))
        self.assertEqual(self.credits(), 300)

    def test_text_generation_styles_and_models(self):
        st, r = call("POST", "/generate", {"prompt": "a fox spirit in a bamboo forest", "style": "slice", "aspect": "16:9", "model": "ultra"})
        self.assertEqual(st, 200, r)
        model, body = self.br.invocations[-1]
        self.assertEqual(model, ai.TEXT_MODELS["ultra"])
        self.assertIn("watercolor", body["prompt"])
        self.assertEqual(body["aspect_ratio"], "16:9")
        self.assertTrue(r["item"]["url"].startswith("https://signed.example/users/u1/"))
        self.assertEqual(r["credits"], 298)
        st, g = call("GET", "/gallery")
        self.assertEqual(len(g["items"]), 1)

    def test_sketch_and_photo_use_control_services(self):
        for mode, svc in (("sketch", "control-sketch"), ("photo", "control-structure")):
            st, r = call("POST", "/generate", {"mode": mode, "prompt": "hero pose", "imageBase64": "data:image/png;base64," + PNG})
            self.assertEqual(st, 200, r)
            model, body = self.br.invocations[-1]
            self.assertIn(svc, model)
            self.assertEqual(body["style_preset"], "anime")
        st, r = call("POST", "/generate", {"mode": "photo", "prompt": "x", "imageBase64": base64.b64encode(b"GIF89a").decode()})
        self.assertEqual(st, 400)

    def test_character_lock(self):
        st, c = call("POST", "/characters", {"name": "Aiko", "look": "silver bob haircut, red scarf, amber eyes"})
        self.assertEqual(st, 201, c)
        cid = c["character"]["id"]
        st, r = call("POST", "/generate", {"mode": "character", "characterId": cid, "prompt": "eating ramen at night"})
        self.assertEqual(st, 200, r)
        model, body = self.br.invocations[-1]
        self.assertIn("style-guide", model)
        self.assertIn("Aiko, silver bob haircut", body["prompt"])
        self.assertEqual(base64.b64decode(body["image"]), self.s3.objects[c["character"]["refKey"]])
        self.assertEqual(call("GET", f"/characters/{cid}".replace("/characters/", "/characters/"), )[0], 404)  # no GET route
        self.assertEqual(len(call("GET", "/characters")[1]["characters"]), 1)
        self.assertEqual(call("DELETE", f"/characters/{cid}")[0], 200)

    def test_guardrail_blocks_and_does_not_charge(self):
        self.br.block_text = "nsfw"
        st, r = call("POST", "/generate", {"prompt": "nsfw thing"})
        self.assertEqual((st, r["code"]), (422, "content_policy"))
        self.assertEqual(self.credits(), 300)

    def test_enhance(self):
        st, r = call("POST", "/enhance", {"prompt": "girl with sword", "style": "cyber"})
        self.assertEqual((st, r["title"]), (200, "Rooftop Duel"))
        self.assertIn("Cyberpunk", self.br.converse_calls[-1]["system"][0]["text"])

    def test_insufficient_credits(self):
        os.environ["WELCOME_CREDITS"] = "1"
        st, r = call("POST", "/generate", {"prompt": "x", "model": "ultra"}, email="p@x.com", sub="poor")
        self.assertEqual((st, r["code"]), (402, "credits"))

    def test_tools(self):
        iid = call("POST", "/generate", {"prompt": "x"})[1]["item"]["id"]
        st, r = call("POST", "/tools/removebg", {"itemId": iid})
        self.assertEqual((st, r["item"]["parentId"]), (200, iid))
        st, r = call("POST", "/tools/upscale", {"itemId": iid})
        self.assertEqual(st, 200)
        self.assertIn("fast-upscale", self.br.invocations[-1][0])
        self.assertEqual(self.credits(), 300 - 1 - 1 - 1)
        self.assertEqual(call("POST", "/tools/upscale", {"itemId": r["item"]["id"]})[0], 400)

    def test_other_user_isolation(self):
        iid = call("POST", "/generate", {"prompt": "x"})[1]["item"]["id"]
        self.assertEqual(call("GET", f"/gallery/{iid}", email="z@x.com", sub="intruder")[0], 404)
        self.assertEqual(call("POST", "/tools/removebg", {"itemId": iid}, email="z@x.com", sub="intruder")[0], 404)

    def test_animate_flow_and_gate(self):
        iid = call("POST", "/generate", {"prompt": "x", "aspect": "16:9"})[1]["item"]["id"]
        st, r = call("POST", "/animate", {"itemId": iid}, email="fan@x.com", sub="fan")
        self.assertEqual(st, 403)  # the admin gate is checked before ownership
        fan_item = call("POST", "/generate", {"prompt": "y"}, email="fan@x.com", sub="fan")[1]["item"]["id"]
        st, r = call("POST", "/animate", {"itemId": fan_item}, email="fan@x.com", sub="fan")
        self.assertEqual((st, r["code"]), (403, "animate_disabled"))
        before = self.credits()
        st, r = call("POST", "/animate", {"itemId": iid, "prompt": "wind blows"})
        self.assertEqual(st, 202, r)
        vid = r["item"]["id"]
        self.assertEqual(self.credits(), before - 38)
        job = list(self.br.async_jobs.values())[0]["input"]
        self.assertEqual((job["aspect_ratio"], job["resolution"]), ("16:9", "540p"))
        st, r = call("GET", f"/gallery/{vid}")
        self.assertEqual(r["item"]["status"], "rendering")
        st, r = call("GET", f"/gallery/{vid}")
        self.assertEqual(r["item"]["status"], "ready")
        self.assertTrue(r["item"]["url"].endswith(".mp4"))
        self.assertNotIn("arn", r["item"])

    def test_animate_failure_refunds_once(self):
        iid = call("POST", "/generate", {"prompt": "x"})[1]["item"]["id"]
        self.br.fail_all = True
        before = self.credits()
        vid = call("POST", "/animate", {"itemId": iid})[1]["item"]["id"]
        call("GET", f"/gallery/{vid}")
        st, r = call("GET", f"/gallery/{vid}")
        self.assertEqual(r["item"]["status"], "failed")
        call("GET", f"/gallery/{vid}")
        self.assertEqual(self.credits(), before)

    def test_video_budget_cap(self):
        os.environ["MONTHLY_VIDEO_CAP_USD"] = "3"
        iid = call("POST", "/generate", {"prompt": "x"})[1]["item"]["id"]
        st, r = call("POST", "/animate", {"itemId": iid})
        self.assertEqual((st, r["code"]), (429, "budget"))

    def test_delete_item(self):
        it = call("POST", "/generate", {"prompt": "x"})[1]["item"]
        self.assertEqual(call("DELETE", f"/gallery/{it['id']}")[0], 200)
        self.assertEqual(self.s3.objects, {})


if __name__ == "__main__":
    unittest.main()
