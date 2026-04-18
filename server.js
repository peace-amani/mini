import express from 'express';
import fetch from 'node-fetch';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_URL = (process.env.BOT_API_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_API_KEY || '';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ====== GUARD ======
function requireBot(req, res, next) {
  if (!BOT_URL) {
    return res.status(503).json({ error: 'BOT_API_URL not configured' });
  }
  next();
}

function requireAdmin(req, res, next) {
  const token = req.cookies?.admin_token || req.headers['x-admin-token'];
  if (!token || token !== ADMIN_PASS) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ====== ADMIN LOGIN ======
app.post('/auth/login', (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASS || password !== ADMIN_PASS) {
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }
  res.cookie('admin_token', ADMIN_PASS, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000
  });
  res.json({ success: true });
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.json({ success: true });
});

app.get('/auth/check', requireAdmin, (req, res) => {
  res.json({ success: true, authenticated: true });
});

// ====== PAIRING PROXY ======

// Proxy: POST /api/pair → bot /pair
app.post('/api/pair', requireBot, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ success: false, error: 'Could not reach bot server' });
  }
});

// Proxy: POST /api/session → bot /session
app.post('/api/session', requireBot, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ success: false, error: 'Could not reach bot server' });
  }
});

// Proxy: GET /api/status → bot /status
app.get('/api/status', requireBot, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/status`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ success: false, error: 'Bot server unreachable' });
  }
});

// Proxy: SSE /api/events → bot /events (stream)
app.get('/api/events', requireBot, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let botRes;
  try {
    botRes = await fetch(`${BOT_URL}/events`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ event: 'error', message: 'Bot server unreachable' })}\n\n`);
    return res.end();
  }

  botRes.body.on('data', chunk => {
    try { res.write(chunk); } catch {}
  });
  botRes.body.on('end', () => res.end());
  botRes.body.on('error', () => res.end());
  req.on('close', () => {
    try { botRes.body.destroy(); } catch {}
  });
});

// ====== ADMIN API PROXY ======

// GET /api/admin/stats
app.get('/api/admin/stats', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/stats`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ success: false, error: 'Bot server unreachable' });
  }
});

// GET /api/admin/sessions
app.get('/api/admin/sessions', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/sessions`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ success: false, error: 'Bot server unreachable' });
  }
});

// GET /api/admin/sessions/active
app.get('/api/admin/sessions/active', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/sessions/active`, {
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ success: false, error: 'Bot server unreachable' });
  }
});

// DELETE /api/admin/session/:phone
app.delete('/api/admin/session/:phone', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/session/${req.params.phone}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': ADMIN_KEY }
    });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ success: false, error: 'Bot server unreachable' });
  }
});

// ====== PAGE ROUTES ======
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ====== START ======
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[WOLFY WebServer] Running on port ${PORT}`);
  if (!BOT_URL) console.warn('[WOLFY WebServer] WARNING: BOT_API_URL not set!');
  if (!ADMIN_PASS) console.warn('[WOLFY WebServer] WARNING: ADMIN_PASSWORD not set!');
});
