import express from 'express';
import fetch from 'node-fetch';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, 'config.json');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_API_KEY || '';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '';

// ====== CONFIG — persists Heroku URL across restarts ======
function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveConfig(data) {
  const current = loadConfig();
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...current, ...data }, null, 2));
}

let config = loadConfig();

// BOT_URL: config.json wins over env var (config.json is set from admin dashboard)
let BOT_URL = (config.botApiUrl || process.env.BOT_API_URL || '').replace(/\/$/, '');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ====== GUARDS ======
function requireBot(req, res, next) {
  if (!BOT_URL) {
    return res.status(503).json({ error: 'BOT_API_URL not configured', notConfigured: true });
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
    httpOnly: true, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000
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

// ====== HEROKU URL MANAGEMENT ======

// GET /api/admin/heroku-url — returns current URL + live ping result
app.get('/api/admin/heroku-url', requireAdmin, async (req, res) => {
  const url = BOT_URL || '';
  if (!url) {
    return res.json({ configured: false, url: '', connected: false });
  }
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(6000) });
    const data = await r.json();
    return res.json({
      configured: true,
      url,
      connected: r.ok && data.ok === true,
      sessions: data.sessions ?? 0,
      uptime: data.uptime ?? 0,
      service: data.service ?? ''
    });
  } catch (err) {
    return res.json({ configured: true, url, connected: false, error: err.message });
  }
});

// POST /api/admin/heroku-url — saves URL, pings it, returns result
app.post('/api/admin/heroku-url', requireAdmin, async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }
  const clean = url.trim().replace(/\/$/, '');
  try {
    new URL(clean); // validate URL format
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid URL format' });
  }

  // Ping the health endpoint before saving
  let pingOk = false;
  let pingData = {};
  try {
    const r = await fetch(`${clean}/health`, { signal: AbortSignal.timeout(8000) });
    pingData = await r.json();
    pingOk = r.ok && pingData.ok === true;
  } catch (err) {
    return res.json({
      success: false,
      connected: false,
      error: `Could not reach ${clean} — ${err.message}`
    });
  }

  if (!pingOk) {
    return res.json({
      success: false,
      connected: false,
      error: 'URL responded but health check failed — is this the right Heroku app?'
    });
  }

  // Save to config.json and update runtime
  BOT_URL = clean;
  saveConfig({ botApiUrl: clean });
  console.log(`[WOLFY] Heroku URL updated: ${clean}`);

  return res.json({
    success: true,
    connected: true,
    url: clean,
    sessions: pingData.sessions ?? 0,
    uptime: pingData.uptime ?? 0,
    service: pingData.service ?? ''
  });
});

// ====== PAIRING PROXY ======
app.post('/api/pair', requireBot, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    res.json(await r.json());
  } catch {
    res.status(502).json({ success: false, error: 'Could not reach bot server' });
  }
});

app.post('/api/session', requireBot, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    res.json(await r.json());
  } catch {
    res.status(502).json({ success: false, error: 'Could not reach bot server' });
  }
});

app.get('/api/status', requireBot, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/status`);
    res.json(await r.json());
  } catch {
    res.status(502).json({ success: false, error: 'Bot server unreachable' });
  }
});

app.get('/api/events', requireBot, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  let botRes;
  try {
    botRes = await fetch(`${BOT_URL}/events`);
  } catch {
    res.write(`data: ${JSON.stringify({ event: 'error', message: 'Bot server unreachable' })}\n\n`);
    return res.end();
  }
  botRes.body.on('data', chunk => { try { res.write(chunk); } catch {} });
  botRes.body.on('end', () => res.end());
  botRes.body.on('error', () => res.end());
  req.on('close', () => { try { botRes.body.destroy(); } catch {} });
});

// ====== ADMIN API PROXY ======
app.get('/api/admin/stats', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/stats`, { headers: { 'x-admin-key': ADMIN_KEY } });
    res.json(await r.json());
  } catch {
    res.status(502).json({ success: false, error: 'Bot server unreachable' });
  }
});

app.get('/api/admin/sessions', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/sessions`, { headers: { 'x-admin-key': ADMIN_KEY } });
    res.json(await r.json());
  } catch {
    res.status(502).json({ success: false, error: 'Bot server unreachable' });
  }
});

app.get('/api/admin/sessions/active', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/sessions/active`, { headers: { 'x-admin-key': ADMIN_KEY } });
    res.json(await r.json());
  } catch {
    res.status(502).json({ success: false, error: 'Bot server unreachable' });
  }
});

app.delete('/api/admin/session/:phone', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/session/${req.params.phone}`, {
      method: 'DELETE', headers: { 'x-admin-key': ADMIN_KEY }
    });
    res.json(await r.json());
  } catch {
    res.status(502).json({ success: false, error: 'Bot server unreachable' });
  }
});

// ====== PAGE ROUTES ======
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ====== START ======
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[WOLFY WebServer] Running on port ${PORT}`);
  if (!BOT_URL) console.warn('[WOLFY WebServer] WARNING: BOT_API_URL not configured — set via admin dashboard.');
  else console.log(`[WOLFY WebServer] Bot URL: ${BOT_URL}`);
  if (!ADMIN_PASS) console.warn('[WOLFY WebServer] WARNING: ADMIN_PASSWORD not set!');
});

// ====== UPDATE / RESTART PROXY ======

// GET /api/admin/version — latest GitHub commit info
app.get('/api/admin/version', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/version`, { headers: { 'x-admin-key': ADMIN_KEY } });
    res.json(await r.json());
  } catch {
    res.status(502).json({ success: false, error: 'Bot server unreachable' });
  }
});

// POST /api/admin/restart-all — restart all running bot processes
app.post('/api/admin/restart-all', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/restart-all`, {
      method: 'POST', headers: { 'x-admin-key': ADMIN_KEY }
    });
    res.json(await r.json());
  } catch {
    res.status(502).json({ success: false, error: 'Bot server unreachable' });
  }
});

// POST /api/admin/update-all — check GitHub + restart all bot processes
app.post('/api/admin/update-all', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/update-all`, {
      method: 'POST', headers: { 'x-admin-key': ADMIN_KEY }
    });
    res.json(await r.json());
  } catch {
    res.status(502).json({ success: false, error: 'Bot server unreachable' });
  }
});
