# Household Admin

Track bills, renewals and subscriptions in one place. Accounts, login and saved items included.

## Run it

Needs Node 18 or newer. No packages to install.

```
node server.js
```

Open http://localhost:3000, sign up, and add an item.

Data is saved in `data/db.json` (created on first run). Back this file up.

## What is included

- Sign up, log in, log out, with the Privacy Policy accepted at sign up
- Per-user items: bills, renewals, subscriptions (amount, due date, monthly/yearly repeat, note)
- Home screen with 30-day total and due-soon list, All items, Subscriptions, Account
- Mark paid (repeating items roll to the next date)
- Download my data (JSON) and Delete my account, which the Privacy Policy promises
- Forgot password: emails a one-time link that works for 1 hour; changing the password logs the account out everywhere
- Privacy Policy at `/privacy.html`

## Password reset email (one-time setup)

Reset emails are sent through Brevo's email API (free plan). Create a Brevo account, verify a sender email address there, and create an API key. Then set:

| Variable | Value |
| --- | --- |
| `BREVO_API_KEY` | your Brevo API key |
| `MAIL_FROM` | the sender email you verified in Brevo |
| `BASE_URL` | your site address, e.g. `https://household-admin.onrender.com` (Render sets this automatically, so you can usually skip it) |

Without these, the app still runs but no reset emails are sent. For local testing only, `MAIL_MODE=console` prints emails to the terminal instead.

## Security already in place

- Passwords hashed with scrypt and a random salt per user
- Session tokens are random, stored only as a hash on the server, HttpOnly cookie, 30-day expiry
- Login and sign-up rate limiting, request size limit, input validation
- Content Security Policy with no third-party scripts, fonts or trackers
- Every item query is scoped to the logged-in user

## Before real users

1. **Fill in `public/privacy.html`.** Replace each [BRACKETED] item, delete the yellow note, and have a lawyer review it. Malaysia's PDPA expects the notice in English and Bahasa Malaysia, so add a Malay version.
2. **Use HTTPS.** Run behind a host that provides it, and start with `NODE_ENV=production` (adds the Secure cookie flag). If behind a proxy, also set `TRUST_PROXY=1`.
3. **Keep `data/` on a persistent disk**, and back it up. For serious scale, move users and items to Postgres or SQLite.
4. **Check your hosting provider's log retention** and make sure the Privacy Policy matches it.
5. **Keep the policy true.** It says you never share personal data. If you add affiliate offers, analytics or email tools later, update the policy first.

## Not built yet

- Email verification (confirming a new user owns their email address)
- Bill scanning from photos
- Push or email reminders (reminders are visible in the app only)

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | 3000 | Port to listen on |
| `DATA_DIR` | `./data` | Where `db.json` is stored |
| `NODE_ENV` | | Set to `production` for Secure cookies |
| `TRUST_PROXY` | | Set to `1` behind a proxy so rate limits use the real IP |
