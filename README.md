# Banime — your anime studio

Ideas, sketches and photos become anime art, with characters that stay on-model, manga pages, and short animated clips. Fully serverless on AWS.

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
