# Porta prototype

Porta is a Qatar-first peer-learning concept: people learn from each other, with optional AI support to help learners choose a next step. This repository contains a runnable account-first prototype—not a hosted service or live tutor directory.

## What works

- An accessible, responsive learning experience shown after members log in, with a login-first account gate.
- A login-first flow and profile questionnaire for learners, peer tutors, or people who want to do both. Sign-up captures first/last name, a unique username, phone number with country calling code, a searchable country selection, custom interest/learning/sharing tags, and up to three searchable languages. Learning and sharing prompts appear according to the selected role.
- A Python API that saves accounts and learning profiles to local SQLite for development or PostgreSQL when `DATABASE_URL` is configured, hashes passwords with PBKDF2, and issues revocable bearer-token sessions.
- A social-app workspace with a hover-expanding sidebar for the feed, people search, class discovery, communities, chats, dashboard/Porta Pay, and profile. Members can switch between the violet light theme and a custom dark theme.
- A community discovery screen that turns profile interests into clearly labeled future community concepts, without presenting them as live groups.
- Authenticated people search across complete member profiles. Search results intentionally omit email addresses and phone numbers.
- A profile editor for names, username, learning interests, teaching skills, goals, learning style, location, languages, and introduction. Members can upload a browser-local profile photo or customize an illustrated avatar using face shape, expressions, eyes, hair, accessories, outfits, skin tones, and backgrounds.
- Clear empty states for posts, stories, classes, conversations, and payments. These screens are ready for those features, but the prototype does not yet have post/story, class/session, chat, or payment data and does not pretend that sample activity is real.
- An explainable scikit-learn TF-IDF/cosine-similarity matcher that ranks learning topics against a member's interests and goals. Its scores are relative text similarity, not predicted success or probability.
- An optional generative learning-plan coach using an OpenAI-compatible API. The page clearly reports whether it is configured. The coach sends a learning goal to that provider only after the signed-in member submits the coach form.
- Learning-topic cards are ideas for the product, not claimed active tutors or existing members.

Account creation verifies a new member's WhatsApp number first and email address second. Only after both six-digit codes are confirmed does Porta create the account and log the member in. Codes expire after 10 minutes; incorrect attempts and resend requests are limited. Social sign-in verifies email with the identity provider and asks new members to verify their WhatsApp number before completing the profile. Existing members log in with their email and password. Membership and recommendation APIs require an active session. Logging out revokes the server session when the prototype is reachable.

The login screen includes password recovery by email. Reset and verification email is sent through your configured SMTP server; it cannot send until real mail-provider settings are supplied. The local `.env` is prefilled with Porta's Gmail sender address, `thealiameen2031@gmail.com`. For Gmail, use `smtp.gmail.com`, port `465`, this full Gmail address as the username and sender, and a Google app password (not the regular account password; Google requires 2-Step Verification). Add the app password to `PORTA_SMTP_PASSWORD` in `.env` and restart Porta. A mail provider may also require sender/domain verification. Reset links are single-use, expire after 30 minutes, and invalidate existing sessions when used. A successful SMTP handoff means the provider accepted the message, not that it reached the inbox; check spam and the provider's delivery logs if it is missing.

WhatsApp verification uses Meta's WhatsApp Cloud API. Create/configure a Meta app with WhatsApp Cloud API and use its **Phone Number ID** for Porta's WhatsApp Business sender `+974 66409227` (the displayed number itself is not the ID). Create and get approval for a WhatsApp message template named `porta_verification_code` in the configured language; its body must contain one text placeholder for the six-digit code (for example, “Your Porta verification code is {{1}}. It expires in 10 minutes.”). Set `PORTA_WHATSAPP_PHONE_NUMBER_ID`, `PORTA_WHATSAPP_ACCESS_TOKEN`, `PORTA_WHATSAPP_TEMPLATE_NAME`, and, if needed, `PORTA_WHATSAPP_TEMPLATE_LANGUAGE` / `PORTA_WHATSAPP_API_VERSION` in `.env`, then restart Porta. Recipients must be able to receive WhatsApp messages from the configured business sender. A phone number alone cannot send WhatsApp messages: Meta sender verification, template approval, and a valid access token are required.

Google and LinkedIn OpenID Connect buttons appear on the login screen. They cannot redirect to a real account until provider applications have been created and their client IDs and secrets are set in `.env`. For local development, open Porta at `http://localhost:8000` consistently. In Google Cloud Console, create an OAuth web client and add `http://localhost:8000/api/auth/google/callback` as an authorized redirect URI. In the LinkedIn Developer Portal, create an app, enable its OpenID Connect sign-in product, and register `http://localhost:8000/api/auth/linkedin/callback` as its redirect URL if accepted for your app; otherwise use an HTTPS development/deployment URL. Enable the `openid`, `profile`, and `email` scopes. Set `PORTA_PUBLIC_URL` to the exact origin used in the registered callbacks and restart Porta after changing `.env`. For deployment, use the exact public HTTPS origin and a persistent random `PORTA_SESSION_SECRET`; OAuth login requires signed state cookies. Providers must return a verified email address. New social accounts finish the Porta profile questionnaire before accessing member features. Social accounts are linked to an existing Porta account only when the provider confirms the same email address.

## Run locally

Python 3.11 or newer is recommended.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open http://localhost:8000. The first run creates a private `data/porta.sqlite3` database. To create an account, configure both SMTP email delivery and Meta WhatsApp Cloud API as described above.

To enable email, WhatsApp verification, or social sign-in locally, copy `.env.example` to `.env`, add credentials for the services you have configured, and restart the app. Porta loads `.env` on startup. The login page's setup indicators show whether each integration is ready; without provider credentials, social sign-in will explain the missing setup instead of silently pretending to log in.

To run the tests:

```bash
python -m pip install -r requirements-dev.txt
pytest
```

## Deploy on Vercel with Neon

Vercel detects the FastAPI application in `app/main.py` directly; no catch-all rewrite is needed. For deployment, create a Neon PostgreSQL project and use its **pooled** connection string as `DATABASE_URL` in the Vercel project's production environment. Porta creates or migrates its schema when the service starts. The local SQLite database is not copied to Neon; the production database starts empty unless you separately arrange a deliberate data migration.

Import this GitHub repository into Vercel and set the following environment variables before the first production deployment:

- `DATABASE_URL`: the Neon pooled PostgreSQL connection string.
- `PORTA_SESSION_SECRET`: a persistent, randomly generated secret. Do not reuse or commit it.
- `PORTA_PUBLIC_URL`: the exact public HTTPS origin assigned to the Vercel deployment.
- `PORTA_SMTP_HOST`, `PORTA_SMTP_PORT`, `PORTA_SMTP_FROM`, `PORTA_SMTP_USERNAME`, and `PORTA_SMTP_PASSWORD`: a verified email sender for email verification and password recovery.
- `PORTA_WHATSAPP_PHONE_NUMBER_ID`, `PORTA_WHATSAPP_ACCESS_TOKEN`, `PORTA_WHATSAPP_TEMPLATE_NAME`, and `PORTA_WHATSAPP_TEMPLATE_LANGUAGE`: an approved Meta WhatsApp Cloud API sender and template for the first signup-verification step.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET`, if social sign-in is needed.

Set the Google and LinkedIn callback URLs to `https://<your-public-origin>/api/auth/google/callback` and `https://<your-public-origin>/api/auth/linkedin/callback` respectively. Keep all credentials in Vercel's environment settings, not in GitHub or chat. Redeploy after changing variables. The account-creation flow intentionally remains unavailable until both SMTP email delivery and WhatsApp verification are configured. A Vercel deployment can be created from the connected GitHub repository; this checkout does not contain Vercel account credentials and cannot create or configure external Neon/Vercel resources on your behalf.

## Configure the optional AI coach

The matcher and account creation work locally without an API key. To enable generative learning plans, configure an OpenAI-compatible provider in the server environment:

```bash
export OPENAI_API_KEY="your-provider-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_MODEL="gpt-4o-mini"
uvicorn app.main:app --reload
```

Do not commit API keys, SMTP credentials, or real account data. Use `.env.example` as a reference for configuration names; credentials should stay in the server environment.

## Before a public launch

This is a prototype, not a production identity system. Before inviting real users at scale, add a reviewed privacy policy and retention/deletion workflows, production database backups and access controls, email verification, rate limiting and abuse protection, secure HTTPS deployment, operational monitoring, and a deployment-specific security review. Bearer tokens are kept in the browser's local storage in this prototype; consider secure, HttpOnly cookies and CSRF protection for a public deployment. Password-reset requests have a one-minute per-email cooldown; add edge-level/IP-based rate limits for a public deployment.
