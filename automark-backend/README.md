# TeachMate AutoMark — Backend Proxy

Holds your OpenRouter API key server-side so it never appears in the
TeachMate frontend code or GitHub repo. AutoMark.html calls this instead of
calling OpenRouter directly.

## Deploy to Render (from your phone, via GitHub)

1. Push this folder (`automark-backend/`) to its own GitHub repo, or a
   subfolder of an existing one.
2. On Render: **New +** → **Web Service** → connect the repo.
   - Root directory: `automark-backend` (if it's a subfolder)
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free is fine to start.
3. Add these Environment Variables in Render's dashboard (never in code):

   | Key | Value |
   |---|---|
   | `OPENROUTER_API_KEY` | your OpenRouter key |
   | `FIREBASE_SERVICE_ACCOUNT` | the full service account JSON as one line (see below) |
   | `ALLOWED_ORIGIN` | where AutoMark.html will be hosted, e.g. `https://yourname.github.io` |

4. Deploy. Render gives you a URL like `https://teachmate-automark.onrender.com`
   — that's what AutoMark.html will call.

## Getting the FIREBASE_SERVICE_ACCOUNT value

1. Firebase Console → your `grok-7568a` project → ⚙️ **Project settings** →
   **Service accounts** tab → **Generate new private key**. This downloads
   a JSON file.
2. Open that file, copy its *entire* contents.
3. In Render's env var editor, paste it as one line (Render accepts
   multi-line values fine, so pasting it as-is works too — just make sure
   no extra characters got added).

**Never commit that JSON file to GitHub.** It grants admin access to your
Firebase project — treat it like a password.

## Free-tier note

Render's free web services spin down after ~15 minutes of no traffic and
take ~30-60 seconds to wake back up on the next request. The first marking
request of a session may feel slow — that's the server waking up, not a bug.
If that's annoying once you're marking daily, Render's cheapest paid tier
keeps it always-on.

## Testing it's alive

Visit `https://your-service.onrender.com/health` in a browser — should
return `{"status":"ok"}`. That endpoint needs no auth. Everything under
`/api/` requires a valid Firebase ID token from a signed-in TeachMate user.
