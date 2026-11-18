"""Model layer: Stability image models + Stability image services, Amazon Nova
(prompt assistant), Luma Ray2 (animation), and the Bedrock Guardrail."""
from __future__ import annotations

import base64
import json

from . import common

# --------------------------------------------------------------------------- #
# Anime style presets. Generic descriptions only: no studio or artist names.
# --------------------------------------------------------------------------- #
STYLES = {
    "shonen": ("Shonen action", "dynamic shonen anime key visual, bold linework, dramatic speed lines, saturated colors, intense lighting"),
    "slice": ("Slice of life", "soft slice-of-life anime, gentle watercolor backgrounds, warm afternoon light, delicate linework"),
    "retro90": ("90s cel", "1990s cel-shaded anime, film grain, muted retro palette, hand-painted backgrounds, VHS softness"),
    "cyber": ("Cyberpunk", "cyberpunk anime, neon signage, rain-slick streets, magenta and cyan rim light, dense city"),
    "chibi": ("Chibi", "cute chibi anime style, big head small body, pastel colors, sticker-like clean outlines"),
    "manga": ("Manga ink", "black and white manga illustration, screentone shading, crisp ink lines, high contrast"),
    "mecha": ("Mecha", "mecha anime, giant robot, detailed mechanical design, hangar lights, epic scale"),
    "fantasy": ("Dark fantasy", "dark fantasy anime, moody lighting, ornate armor, mist and embers, painterly detail"),
}

NEGATIVE = ("photorealistic, 3d render, lowres, blurry, extra fingers, deformed hands, bad anatomy, "
            "watermark, signature, text, jpeg artifacts")

ASPECTS = ["1:1", "16:9", "9:16", "2:3", "3:2", "4:5", "5:4", "21:9", "9:21"]

TEXT_MODELS = {
    "core": "stability.stable-image-core-v1:1",
    "sd35": "stability.sd3-5-large-v1:0",
    "ultra": "stability.stable-image-ultra-v1:1",
}
SERVICES = {
    "character": "us.stability.stable-image-style-guide-v1:0",
    "sketch": "us.stability.stable-image-control-sketch-v1:0",
    "photo": "us.stability.stable-image-control-structure-v1:0",
    "removebg": "us.stability.stable-image-remove-background-v1:0",
    "upscale": "us.stability.stable-fast-upscale-v1:0",
}
RAY2 = "luma.ray-v2:0"
PROMPT_MODEL_DEFAULT = "us.amazon.nova-2-lite-v1:0"


def style_prompt(prompt: str, style: str) -> str:
    frag = STYLES.get(style, STYLES["shonen"])[1]
    return f"{prompt.strip().rstrip('.')}. {frag}, anime art"[:9000]


def _invoke(model_id: str, body: dict) -> bytes:
    r = common.client("bedrock-runtime").invoke_model(
        modelId=model_id, body=json.dumps(body), contentType="application/json", accept="application/json")
    out = json.loads(r["body"].read())
    reason = (out.get("finish_reasons") or [None])[0]
    if reason:
        raise common.HttpError(422, "The image model filtered this request. Try different wording or a different image.",
                               code="content_policy")
    return base64.b64decode(out["images"][0])


def generate(mode: str, prompt: str, style: str, aspect: str, model: str, seed: int,
             image_b64: str | None = None, strength: float = 0.7) -> bytes:
    full = style_prompt(prompt, style)
    common_args = {"prompt": full, "negative_prompt": NEGATIVE, "seed": int(seed) % 4294967294, "output_format": "png"}
    if mode == "text":
        body = {**common_args, "aspect_ratio": aspect if aspect in ASPECTS else "1:1"}
        if model == "sd35":
            body["mode"] = "text-to-image"
        return _invoke(TEXT_MODELS.get(model, TEXT_MODELS["core"]), body)
    if not image_b64:
        raise common.HttpError(400, "This mode needs an image.")
    body = {**common_args, "image": image_b64, "style_preset": "anime"}
    if mode == "character":
        body.update(fidelity=max(0.0, min(1.0, strength)), aspect_ratio=aspect if aspect in ASPECTS else "1:1")
    elif mode in ("sketch", "photo"):
        body["control_strength"] = max(0.0, min(1.0, strength))
    else:
        raise common.HttpError(400, "Unknown mode.")
    return _invoke(SERVICES[mode], body)


def remove_background(image_b64: str) -> bytes:
    return _invoke(SERVICES["removebg"], {"image": image_b64, "output_format": "png"})


def upscale(image_b64: str, prompt: str = "") -> bytes:
    """Stability Fast Upscale: 4x, a few seconds (fits the API's 30 s window). Input <= 1 MP."""
    return _invoke(SERVICES["upscale"], {"image": image_b64, "output_format": "jpeg"})


# --------------------------------------------------------------------------- #
# Prompt assistant (Amazon Nova): structured JSON through a forced tool call.
# --------------------------------------------------------------------------- #
ENHANCE_TOOL = {"toolSpec": {"name": "submit_prompt", "description": "Return the improved prompt.", "inputSchema": {"json": {
    "type": "object", "required": ["prompt", "title"],
    "properties": {
        "prompt": {"type": "string", "description": "A vivid anime illustration prompt, 40-90 words: subject, pose, expression, outfit, setting, lighting, camera angle."},
        "title": {"type": "string", "description": "A 2-5 word title."},
    }}}}}


def enhance(idea: str, style: str) -> dict:
    guard(idea)
    sys = ("You write prompts for an anime image model. Expand the user's idea into one concrete visual scene. "
           "Never depict real people, sexual content, or minors in any suggestive way. Do not name real artists or studios. "
           f"Target style: {STYLES.get(style, STYLES['shonen'])[0]}.")
    r = common.client("bedrock-runtime").converse(
        modelId=common.env("PROMPT_MODEL_ID", PROMPT_MODEL_DEFAULT),
        system=[{"text": sys}], messages=[{"role": "user", "content": [{"text": idea[:2000]}]}],
        toolConfig={"tools": [ENHANCE_TOOL], "toolChoice": {"tool": {"name": "submit_prompt"}}},
        inferenceConfig={"maxTokens": 600, "temperature": 0.8})
    for block in r["output"]["message"]["content"]:
        if "toolUse" in block:
            out = block["toolUse"]["input"]
            res = {"prompt": str(out.get("prompt", ""))[:1500], "title": str(out.get("title", ""))[:60]}
            guard(res["prompt"], "OUTPUT")
            return res
    raise common.HttpError(502, "The prompt assistant did not answer. Try again.")


# --------------------------------------------------------------------------- #
# Animation (Luma Ray2, async)
# --------------------------------------------------------------------------- #
def start_animation(image_b64: str, prompt: str, aspect: str, out_prefix: str, token: str) -> str:
    ray_aspect = aspect if aspect in ("1:1", "16:9", "9:16", "4:3", "3:4", "21:9", "9:21") else "1:1"
    r = common.client("bedrock-runtime").start_async_invoke(
        modelId=RAY2, clientRequestToken=token,
        modelInput={"prompt": (prompt or "subtle anime motion, hair and clothes moving in the wind")[:1500],
                    "aspect_ratio": ray_aspect, "duration": "5s", "resolution": "540p", "loop": False,
                    "keyframes": {"frame0": {"type": "image", "source": {
                        "type": "base64", "media_type": "image/png", "data": image_b64}}}},
        outputDataConfig={"s3OutputDataConfig": {"s3Uri": f"s3://{common.bucket()}/{out_prefix}"}})
    return r["invocationArn"]


def animation_status(arn: str) -> dict:
    r = common.client("bedrock-runtime").get_async_invoke(invocationArn=arn)
    out = {"status": r["status"], "error": r.get("failureMessage")}
    if r["status"] == "Completed":
        uri = r["outputDataConfig"]["s3OutputDataConfig"]["s3Uri"].rstrip("/")
        prefix = uri.split(f"s3://{common.bucket()}/", 1)[1]
        objs = common.client("s3").list_objects_v2(Bucket=common.bucket(), Prefix=prefix).get("Contents", [])
        out["key"] = next((o["Key"] for o in objs if o["Key"].endswith(".mp4")), None)
    return out


def guard(text: str, source: str = "INPUT") -> None:
    gid = common.env("GUARDRAIL_ID")
    if not gid or not (text or "").strip():
        return
    r = common.client("bedrock-runtime").apply_guardrail(
        guardrailIdentifier=gid, guardrailVersion=common.env("GUARDRAIL_VERSION", "DRAFT"),
        source=source, content=[{"text": {"text": text[:20000]}}])
    if r.get("action") == "GUARDRAIL_INTERVENED":
        raise common.HttpError(422, "That request goes against Banime's content policy (no sexual content, "
                                    "no real people, no hateful or violent content).", code="content_policy")
