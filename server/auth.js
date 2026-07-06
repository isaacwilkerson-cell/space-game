// ── Accounts: signup / login / email verification ──────────────────────────
// Needs two Railway env vars to actually work: DATABASE_URL (Postgres, add the addon in
// the Railway dashboard) and RESEND_API_KEY (resend.com free tier). If either is missing,
// the routes below return a clear "not configured yet" error instead of crashing — guest
// play (no account) keeps working regardless.
const crypto = require('crypto');
const { Pool } = require('pg');

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me-in-railway-vars';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

let _ready = false;
async function initDb() {
  if (!pool) { console.warn('[auth] DATABASE_URL not set — accounts disabled, guest play only'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      verify_token TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  _ready = true;
  console.log('[auth] Postgres ready, users table ensured');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createSessionToken(user) {
  const payload = JSON.stringify({ uid: user.id, username: user.username, exp: Date.now() + SESSION_MAX_AGE_MS });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}
function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  try {
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload; // { uid, username, exp }
  } catch { return null; }
}

async function sendVerificationEmail(email, token, baseUrl) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const verifyUrl = `${baseUrl}/api/verify?token=${encodeURIComponent(token)}`;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Starbound Nexus <onboarding@resend.dev>',
      to: [email],
      subject: 'Verify your Starbound Nexus account',
      html: `<p>Welcome to Starbound Nexus!</p><p><a href="${verifyUrl}">Click here to verify your email</a></p><p>Or paste this link in your browser: ${verifyUrl}</p>`,
    }),
  });
  if (!resp.ok) throw new Error('Resend API error: ' + (await resp.text()));
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function registerAuthRoutes(app) {
  app.use(require('express').json());

  app.post('/api/signup', async (req, res) => {
    if (!pool || !_ready) return res.status(503).json({ error: 'Accounts are not set up yet on this server.' });
    try {
      const { username, email, password } = req.body || {};
      if (!USERNAME_RE.test(username || '')) return res.status(400).json({ error: 'Username must be 3-20 letters/numbers/underscores.' });
      if (!EMAIL_RE.test(email || '')) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

      const existing = await pool.query('SELECT id FROM users WHERE username = $1 OR email = $2', [username, email.toLowerCase()]);
      if (existing.rows.length > 0) return res.status(409).json({ error: 'That username or email is already taken.' });

      const passwordHash = hashPassword(password);
      const verifyToken = crypto.randomBytes(32).toString('hex');
      await pool.query(
        'INSERT INTO users (username, email, password_hash, verify_token) VALUES ($1, $2, $3, $4)',
        [username, email.toLowerCase(), passwordHash, verifyToken]
      );

      const baseUrl = `${req.protocol}://${req.get('host')}`;
      try {
        await sendVerificationEmail(email, verifyToken, baseUrl);
      } catch (emailErr) {
        console.error('[auth] verification email failed:', emailErr.message);
        return res.status(201).json({ ok: true, warning: 'Account created, but the verification email failed to send. Contact support.' });
      }
      res.status(201).json({ ok: true, message: 'Account created — check your email to verify before logging in.' });
    } catch (e) {
      console.error('[auth] signup error:', e.message);
      res.status(500).json({ error: 'Signup failed, try again.' });
    }
  });

  app.get('/api/verify', async (req, res) => {
    if (!pool || !_ready) return res.status(503).send('Accounts are not set up yet on this server.');
    try {
      const { token } = req.query;
      if (!token) return res.status(400).send('Missing verification token.');
      const result = await pool.query('UPDATE users SET verified = TRUE, verify_token = NULL WHERE verify_token = $1 RETURNING username', [token]);
      if (result.rows.length === 0) return res.status(400).send('Invalid or already-used verification link.');
      res.send(`<html><body style="font-family:monospace;background:#001428;color:#0ff;text-align:center;padding-top:15vh;">
        <h2>Email verified, ${result.rows[0].username}!</h2><p>You can close this tab and log in on the title screen.</p>
      </body></html>`);
    } catch (e) {
      console.error('[auth] verify error:', e.message);
      res.status(500).send('Verification failed, try again.');
    }
  });

  app.post('/api/login', async (req, res) => {
    if (!pool || !_ready) return res.status(503).json({ error: 'Accounts are not set up yet on this server.' });
    try {
      const { email, password } = req.body || {};
      if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
      const result = await pool.query('SELECT * FROM users WHERE email = $1', [(email || '').toLowerCase()]);
      const user = result.rows[0];
      if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: 'Invalid email or password.' });
      if (!user.verified) return res.status(403).json({ error: 'Please verify your email first — check your inbox.' });
      const token = createSessionToken(user);
      res.json({ ok: true, token, username: user.username });
    } catch (e) {
      console.error('[auth] login error:', e.message);
      res.status(500).json({ error: 'Login failed, try again.' });
    }
  });
}

module.exports = { initDb, registerAuthRoutes, verifySessionToken };
