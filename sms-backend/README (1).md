# TeachMate SMS Gateway (Render Backend)

This is the secretary that holds your Africa's Talking API key so it
never has to live in the TeachMate frontend JavaScript.

## 1. Rotate your API key first

If you've ever pasted or committed your Africa's Talking API key anywhere
it shouldn't be, generate a new one in the AT dashboard before deploying
this. Old key = dead key from that point on.

## 2. Deploy to Render

1. Push this `render-backend` folder to its own GitHub repo (or a
   subfolder of an existing repo — Render lets you set a root directory).
2. In Render: **New + → Web Service** → connect the repo.
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free is fine to start.
4. Under **Environment**, add:
   - `AT_USERNAME` → your Africa's Talking app username (e.g. `teachmate`)
   - `AT_API_KEY` → your new, rotated API key
   - `AT_SENDER_ID` → `TEACHMATE` (optional, must be a registered
     alphanumeric sender ID on your AT account, otherwise omit it and
     AT will use its default sandbox sender)
   - `GATEWAY_TOKEN` → any long random string, e.g. generate one with
     `openssl rand -hex 32` — this is shared between Render and your
     frontend so randoms can't hit your endpoint and burn your credits
   - `ALLOWED_ORIGINS` → your real TeachMate domain (comma-separate if
     more than one), e.g. `https://teachmate.app`
5. Deploy. Render gives you a URL like
   `https://teachmate-sms-gateway.onrender.com`.
6. Test the health check: open that URL in a browser — you should see
   `{"status":"ok","service":"teachmate-sms-gateway"}`.

## 3. Sandbox vs production on Africa's Talking

- If you're still testing, use `username: "sandbox"` and your sandbox
  app's API key — sandbox SMS doesn't actually deliver to real phones
  but is free and useful for verifying connectivity.
- Switch `AT_USERNAME`/`AT_API_KEY` to your production app's values
  once you're ready to send real messages to real parents.

## 4. Test it directly before wiring up the frontend

```bash
curl -X POST https://your-app.onrender.com/send-sms \
  -H "Content-Type: application/json" \
  -H "X-Gateway-Token: your_gateway_token_here" \
  -d '{"phone":"+260977123456","message":"Test from TeachMate"}'
```

You should get back something like:

```json
{"success":true,"messageId":"ATXid_xxxxx","status":"Success","cost":"KES 0.0000","error":null}
```

## 5. Free tier note

Render's free web services spin down after inactivity and take a few
seconds to "wake up" on the first request after idling. For a school
sending results occasionally, this is usually fine — just expect the
first SMS batch of the day to have a short delay before it starts.
If that delay becomes a problem once you're live with the school,
Render's cheapest paid tier removes the spin-down.

## 6. Security note for later (not urgent)

`GATEWAY_TOKEN` is a static secret baked into your frontend bundle —
good enough to stop casual abuse of a public URL, but anyone who reads
your JS can find it. When you have time, swap this for verifying a
Firebase ID token from the logged-in teacher's session instead (using
`firebase-admin`'s `verifyIdToken`), so SMS sending is tied to an actual
authenticated account rather than a shared password-like string.
