// ============================================================
// TeachMate — SMS Gateway Backend (Render)
// Keeps the Africa's Talking API key server-side.
// The frontend NEVER sees AT_API_KEY — it only talks to this
// server over HTTPS, and this server talks to Africa's Talking.
// ============================================================

const express = require('express');
const cors = require('cors');
const AfricasTalking = require('africastalking');

const app = express();
app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────
// Lock this down to your real TeachMate domain(s) once deployed.
// During development you can leave it open, but tighten it before
// the school starts using this in production.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS,
}));

// ── ENV VARS (set these in Render → Environment) ─────────────
//   AT_USERNAME   = your Africa's Talking app username (e.g. "teachmate")
//   AT_API_KEY    = your Africa's Talking API key (rotate it — never commit it)
//   AT_SENDER_ID  = optional alphanumeric sender ID, e.g. "TEACHMATE"
//   GATEWAY_TOKEN = a shared secret the frontend must send (see below)
const {
  AT_USERNAME,
  AT_API_KEY,
  AT_SENDER_ID,
  GATEWAY_TOKEN,
  PORT = 3000,
} = process.env;

if (!AT_USERNAME || !AT_API_KEY) {
  console.error('❌ Missing AT_USERNAME or AT_API_KEY environment variables.');
  console.error('   Set these in the Render dashboard under Environment.');
}

const africastalking = AfricasTalking({
  apiKey: AT_API_KEY,
  username: AT_USERNAME,
});

const sms = africastalking.SMS;

// ── SIMPLE AUTH GUARD ─────────────────────────────────────────
// This stops randoms from hitting your endpoint and burning your
// SMS credits. Set GATEWAY_TOKEN in Render, and have the frontend
// send the same value in the X-Gateway-Token header.
// This is NOT bulletproof security (it's still a shared secret
// visible in your frontend JS), but it filters out drive-by abuse
// of your public URL. Real protection = Firebase Auth token
// verification (see note at bottom of file).
function requireGatewayToken(req, res, next) {
  if (!GATEWAY_TOKEN) return next(); // not configured — skip (dev only)
  const token = req.headers['x-gateway-token'];
  if (token !== GATEWAY_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'teachmate-sms-gateway' });
});

// ── SEND SMS ───────────────────────────────────────────────────
// Body: { phone: "+260977123456", message: "..." }
// The frontend builds the message text (formatSMSMessage) and just
// asks this server to deliver it — no student/Firestore logic lives
// here, so this endpoint stays generic and reusable.
app.post('/send-sms', requireGatewayToken, async (req, res) => {
  const { phone, message } = req.body || {};

  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing or invalid "phone"' });
  }
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing or invalid "message"' });
  }

  const cleanPhone = phone.replace(/\s+/g, '');

  try {
    const options = {
      to: [cleanPhone],
      message,
    };
    if (AT_SENDER_ID) {
      options.from = AT_SENDER_ID;
    }

    const result = await sms.send(options);

    // Africa's Talking response shape:
    // { SMSMessageData: { Message: "...", Recipients: [{ statusCode, number, status, cost, messageId }] } }
    const recipient = result?.SMSMessageData?.Recipients?.[0];

    if (!recipient) {
      return res.json({ success: false, error: 'No recipient data in AT response', raw: result });
    }

    // statusCode 101 = "Success" in AT's SMS API
    const delivered = recipient.statusCode === 101 || /success/i.test(recipient.status || '');

    return res.json({
      success: delivered,
      messageId: recipient.messageId || null,
      status: recipient.status || null,
      cost: recipient.cost || null,
      error: delivered ? null : (recipient.status || 'Unknown failure'),
    });
  } catch (err) {
    console.error('AT send error:', err);
    return res.status(500).json({ success: false, error: err.message || 'SMS send failed' });
  }
});

// ── BULK SEND (optional convenience) ──────────────────────────
// Body: { messages: [{ phone, message }, ...] }
// Sends sequentially with a small delay, mirroring the frontend's
// existing batching behavior, but server-side. Frontend can switch
// to this later for fewer round trips; for now /send-sms alone is
// enough to drop in.
app.post('/send-sms-bulk', requireGatewayToken, async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ success: false, error: 'Missing or empty "messages" array' });
  }

  const results = [];
  for (const item of messages) {
    const { phone, message } = item || {};
    if (!phone || !message) {
      results.push({ success: false, phone, error: 'Missing phone or message' });
      continue;
    }
    try {
      const options = { to: [phone.replace(/\s+/g, '')], message };
      if (AT_SENDER_ID) options.from = AT_SENDER_ID;

      const result = await sms.send(options);
      const recipient = result?.SMSMessageData?.Recipients?.[0];
      const delivered = recipient && (recipient.statusCode === 101 || /success/i.test(recipient.status || ''));

      results.push({
        success: !!delivered,
        phone,
        messageId: recipient?.messageId || null,
        status: recipient?.status || null,
        error: delivered ? null : (recipient?.status || 'Unknown failure'),
      });
    } catch (err) {
      results.push({ success: false, phone, error: err.message });
    }
    // Small delay between sends to avoid hammering the API
    await new Promise(r => setTimeout(r, 250));
  }

  res.json({ success: true, results });
});

app.listen(PORT, () => {
  console.log(`✅ TeachMate SMS gateway running on port ${PORT}`);
  console.log(`   AT_USERNAME set: ${!!AT_USERNAME}`);
  console.log(`   AT_API_KEY set: ${!!AT_API_KEY}`);
  console.log(`   GATEWAY_TOKEN set: ${!!GATEWAY_TOKEN} ${!GATEWAY_TOKEN ? '(unprotected endpoint - set this before going live)' : ''}`);
});

// ============================================================
// NOTE ON STRONGER AUTH (read when you have time, not urgent):
// GATEWAY_TOKEN is a static shared secret baked into your frontend
// JS — better than nothing, but anyone who inspects your JS bundle
// can find it and hit your endpoint directly. Since TeachMate
// already uses Firebase Auth, a stronger version of this endpoint
// would verify a Firebase ID token (sent from the frontend after
// teacher login) using firebase-admin's verifyIdToken(), instead
// of / in addition to the static token. That ties SMS sending to
// an actual authenticated teacher session. Worth doing before the
// school onboarding goes live, not blocking for now.
// ============================================================
