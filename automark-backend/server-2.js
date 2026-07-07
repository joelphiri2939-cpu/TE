// ═══════════════════════════════════════════════════════════════════════════
//  TeachMate AutoMark — Backend Proxy (Render)
//
//  Purpose: hold the OpenRouter API key server-side so it never touches the
//  frontend / GitHub. The AutoMark.html module calls this server instead of
//  calling OpenRouter directly.
//
//  Security model:
//   - Every request must include a valid Firebase ID token (Authorization:
//     Bearer <token>) from a signed-in TeachMate user. We verify it with
//     firebase-admin, so a stranger who finds this URL can't spend your
//     OpenRouter credits.
//   - A simple per-user in-memory rate limit stops one runaway session from
//     burning through your quota. It resets on redeploy — that's fine, it's
//     just a safety net, not billing-grade metering.
//
//  Environment variables you must set in Render's dashboard:
//   OPENROUTER_API_KEY          - your OpenRouter key (never in git)
//   FIREBASE_SERVICE_ACCOUNT    - the full service account JSON, as a single
//                                  line string (see deploy notes below)
//   ALLOWED_ORIGIN               - your frontend's origin, e.g.
//                                  https://yourusername.github.io
//                                  (use "*" temporarily while testing, then
//                                  lock it down)
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(express.json({ limit: '15mb' })); // photos are base64, need headroom

// ── CORS: only allow your TeachMate frontend to call this ────────────────
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

// ── Firebase Admin init (same Firebase project as TeachMate) ─────────────
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('[AutoMark Backend] Firebase Admin initialized.');
  } catch (err) {
    console.error('[AutoMark Backend] FIREBASE_SERVICE_ACCOUNT missing or invalid JSON:', err.message);
  }
}

// ── Simple per-user rate limit (resets on redeploy, that's OK) ───────────
const _requestLog = new Map(); // uid -> [timestamps]
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20; // 20 vision calls/minute/user is generous for marking

function isRateLimited(uid) {
  const now = Date.now();
  const timestamps = (_requestLog.get(uid) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  _requestLog.set(uid, timestamps);
  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

// ── Auth middleware: verify Firebase ID token ─────────────────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return res.status(401).json({ error: 'Missing Authorization: Bearer <idToken> header.' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.uid = decoded.uid;
    if (isRateLimited(req.uid)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Wait a minute and try again.' });
    }
    next();
  } catch (err) {
    console.error('[AutoMark Backend] Token verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// ── Health check (Render pings this) ───────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'teachmate-automark-backend' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/vision
//  Body: { imageDataUrl, systemPrompt, userPrompt, model }
//  Used for: answer key extraction, student sheet OCR extraction.
//  Returns: { raw: <model's text response> }
//  The frontend is responsible for parsing/validating the JSON the model
//  returns — this endpoint just proxies, it doesn't interpret the content.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/vision', requireAuth, async (req, res) => {
  const { imageDataUrl, systemPrompt, userPrompt, model } = req.body || {};
  if (!imageDataUrl || !userPrompt) {
    return res.status(400).json({ error: 'imageDataUrl and userPrompt are required.' });
  }
  const chosenModel = model || 'google/gemini-2.5-flash';

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': allowedOrigin !== '*' ? allowedOrigin : 'https://teachmate.app',
        'X-Title': 'TeachMate AutoMark',
      },
      body: JSON.stringify({
        model: chosenModel,
        messages: [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
        max_tokens: 4000,
        temperature: 0.1, // marking needs consistency, not creativity
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('[AutoMark Backend] OpenRouter error:', JSON.stringify(data));
      return res.status(502).json({ error: 'OpenRouter request failed.', detail: data.error || data });
    }
    const raw = data.choices?.[0]?.message?.content ?? '';
    return res.json({ raw });
  } catch (err) {
    console.error('[AutoMark Backend] /api/vision error:', err.message);
    return res.status(500).json({ error: 'Server error calling OpenRouter.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/grade
//  Body: { systemPrompt, userPrompt, model }
//  Used for: text-only semantic grading of one student's answer against the
//  key's model answer (no image — the OCR step already happened).
//  Returns: { raw: <model's text response> }
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/grade', requireAuth, async (req, res) => {
  const { systemPrompt, userPrompt, model } = req.body || {};
  if (!userPrompt) {
    return res.status(400).json({ error: 'userPrompt is required.' });
  }
  const chosenModel = model || 'google/gemini-2.5-flash';

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': allowedOrigin !== '*' ? allowedOrigin : 'https://teachmate.app',
        'X-Title': 'TeachMate AutoMark',
      },
      body: JSON.stringify({
        model: chosenModel,
        messages: [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2000,
        temperature: 0.1,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('[AutoMark Backend] OpenRouter error:', JSON.stringify(data));
      return res.status(502).json({ error: 'OpenRouter request failed.', detail: data.error || data });
    }
    const raw = data.choices?.[0]?.message?.content ?? '';
    return res.json({ raw });
  } catch (err) {
    console.error('[AutoMark Backend] /api/grade error:', err.message);
    return res.status(500).json({ error: 'Server error calling OpenRouter.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/ocr
//  Body: { imageDataUrl }  (base64 data URL of a photographed answer sheet)
//  Proxies to OCR.space so the OCR API key never reaches the frontend.
//  Returns: { text, exitCode, ocrError }
//    exitCode 1 = success, 2 = partial success (some text extracted, some
//    errors), 3/4 = failed. Frontend should treat anything but a clean 1
//    as "flag this sheet for review" per your accuracy-check requirement.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/ocr', requireAuth, async (req, res) => {
  const { imageDataUrl } = req.body || {};
  if (!imageDataUrl) {
    return res.status(400).json({ error: 'imageDataUrl is required.' });
  }

  try {
    const form = new URLSearchParams();
    form.append('apikey', process.env.OCR_SPACE_API_KEY);
    form.append('base64Image', imageDataUrl);
    form.append('OCREngine', '2'); // engine 2 handles handwriting/mixed content better
    form.append('scale', 'true');
    form.append('detectOrientation', 'true');
    form.append('isTable', 'false');

    const response = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    const data = await response.json();

    if (data.IsErroredOnProcessing) {
      console.error('[AutoMark Backend] OCR.space error:', JSON.stringify(data.ErrorMessage));
      return res.json({ text: '', exitCode: 4, ocrError: data.ErrorMessage?.join(', ') || 'OCR failed.' });
    }

    const parsedResults = data.ParsedResults || [];
    const text = parsedResults.map(r => r.ParsedText || '').join('\n').trim();
    const exitCode = data.OCRExitCode ?? (text ? 1 : 4);

    return res.json({ text, exitCode, ocrError: null });
  } catch (err) {
    console.error('[AutoMark Backend] /api/ocr error:', err.message);
    return res.status(500).json({ error: 'Server error calling OCR.space.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[AutoMark Backend] Listening on port ${PORT}`));
