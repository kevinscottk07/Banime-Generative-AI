# Banime — your anime studio

Ideas, sketches and photos become anime art, with characters that stay on-model, manga pages, and short animated clips. Fully serverless on AWS.

**Live:** https://d2sj8t7v5tnipg.cloudfront.net · **Demo (no sign-in):** https://d2sj8t7v5tnipg.cloudfront.net/?demo#/create

## Design

The palette comes from the key art: cobalt sky `#2b7bf0`, ultramarine ink `#0c1b4d`, cloud white `#f6f8fc` and raincoat yellow `#ffc81e` (primary actions only). Type is Dela Gothic One for display and Zen Kaku Gothic New for text. The hero stacks three layers on one 16:9 stage: the painting, the title, then the same painting masked to the character, so the title sits *behind* her. All art on the site (hero and the eight style samples) was generated with Banime's own Bedrock models; `tools/imgtool` turns the background-removed cutout into a 26 KB alpha mask.

| Feature | How |
|---|---|
| **Create** | Text to anime in 8 styles (Shonen, Slice of life, 90s cel, Cyberpunk, Chibi, Manga ink, Mecha, Dark fantasy) with Stable Image Core, SD 3.5 Large or Stable Image Ultra on Amazon Bedrock |
| **Prompt assist** | Amazon Nova 2 Lite expands a short idea into a detailed scene prompt (structured tool output) |
| **Character lock** | Each character gets a reference sheet; new scenes use Stability *Style Guide* with that reference so faces, hair and outfits stay consistent |
| **Sketch → anime** | Draw on an in-browser pad; Stability *Control Sketch* keeps your composition |
| **Photo → anime** | Stability *Control Structure* keeps the photo's structure in anime style |
| **Animate** | Luma Ray2 image-to-video, 5 s @ 540p (admin-gated, monthly budget cap) |
| **Polish** | Background removal and 4× fast upscale |
| **Manga page** | 4-koma, 2×2 and splash layouts with speech bubbles, rendered and exported in the browser |
| **Login** | Amazon Cognito managed login: email + verification code, and Sign in with Google (OAuth 2.0 code + PKCE) |
| **Safety** | Amazon Bedrock Guardrails (sexual content, minors, real-person depictions, hate, prompt attacks) plus Stability's own input/output filters |
| **Credits** | Atomic DynamoDB ledger, automatic refunds on failures, 30 free credits per new account |

## Portal (signed in)
Home · Create · Characters · Projects · Manga (pages saved to your account) · Library (filters, favorites, public share links) · Credits (Stripe Checkout, off until keys are added) · Settings (profile, defaults, data export, account delete) · Admin (owner only). Public pages: `#/pricing`, `#/help`, `#/legal/terms|privacy|content`, `#/s/{shareId}`.

Payments: put `{"secretKey": "sk_...", "webhookSecret": "whsec_..."}` in the `banime/stripe` secret and point a Stripe webhook (`checkout.session.completed`) at the `StripeWebhookUrl` stack output.

## Architecture
CloudFront + S3 (static SPA) → API Gateway HTTP API (Cognito JWT authorizer) → Lambda (Python) → Bedrock (Stability, Nova, Luma Ray2), DynamoDB, S3. Everything is in `infra/template.yaml`.

## Develop
```bash
cd backend && python -m unittest -v tests.test_banime     # no AWS needed
cd frontend && python -m http.server 8766                  # http://localhost:8766/?demo#/create
```

## Deploy
```bash
python infra/deploy.py --admin-email you@example.com [--google-client-id ID --google-client-secret SECRET]
```
Register `https://banime-<account>.auth.us-west-2.amazoncognito.com/oauth2/idpresponse` as an authorized redirect URI on the Google OAuth client.

The original upstream project (Open Generative AI, MIT) is kept in `legacy/`.
