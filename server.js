import express from 'express';
import fetch from 'node-fetch';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, 'config.json');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_API_KEY || '';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '';

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  return {};
}
function saveConfig(data) {
  const current = loadConfig();
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...current, ...data }, null, 2));
}

let config = loadConfig();
let BOT_URL = (config.botApiUrl || process.env.BOT_API_URL || '').replace(/\/$/, '');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── MAINTENANCE CHECK (before static) ──
app.use((req, res, next) => {
  const cfg = loadConfig();
  if (!cfg.maintenanceMode) return next();
  // Always allow: admin, auth, api routes, and static assets for admin
  if (
    req.path.startsWith('/admin') ||
    req.path.startsWith('/auth') ||
    req.path.startsWith('/api') ||
    req.path.startsWith('/maintenance')
  ) return next();
  // Serve maintenance page for root and pairing page
  return res.sendFile(path.join(__dirname, 'public', 'maintenance.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ── GUARDS ──
function requireBot(req, res, next) {
  if (!BOT_URL) return res.status(503).json({ error: 'BOT_API_URL not configured', notConfigured: true });
  next();
}
function requireAdmin(req, res, next) {
  const token = req.cookies?.admin_token || req.headers['x-admin-token'];
  if (!token || token !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── AUTH ──
app.post('/auth/login', (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASS || password !== ADMIN_PASS) return res.status(401).json({ success: false, error: 'Invalid password' });
  res.cookie('admin_token', ADMIN_PASS, { httpOnly: true, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 });
  res.json({ success: true });
});
app.post('/auth/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.json({ success: true });
});
app.get('/auth/check', requireAdmin, (req, res) => res.json({ success: true, authenticated: true }));

// ── MAINTENANCE PUBLIC API ──
app.get('/api/maintenance', (req, res) => {
  const cfg = loadConfig();
  res.json({ maintenance: cfg.maintenanceMode || false });
});
app.post('/api/admin/maintenance', requireAdmin, (req, res) => {
  const { enabled } = req.body;
  saveConfig({ maintenanceMode: !!enabled });
  console.log(`[WOLFY] Maintenance mode: ${!!enabled}`);
  res.json({ success: true, maintenance: !!enabled });
});

// ── HEROKU URL ──
app.get('/api/admin/heroku-url', requireAdmin, async (req, res) => {
  const url = BOT_URL || '';
  if (!url) return res.json({ configured: false, url: '', connected: false });
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(6000) });
    const data = await r.json();
    return res.json({ configured: true, url, connected: r.ok && data.ok === true, sessions: data.sessions ?? 0, uptime: data.uptime ?? 0, service: data.service ?? '' });
  } catch (err) {
    return res.json({ configured: true, url, connected: false, error: err.message });
  }
});
app.post('/api/admin/heroku-url', requireAdmin, async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ success: false, error: 'URL is required' });
  const clean = url.trim().replace(/\/$/, '');
  try { new URL(clean); } catch { return res.status(400).json({ success: false, error: 'Invalid URL format' }); }
  let pingOk = false, pingData = {};
  try {
    const r = await fetch(`${clean}/health`, { signal: AbortSignal.timeout(8000) });
    pingData = await r.json();
    pingOk = r.ok && pingData.ok === true;
  } catch (err) {
    return res.json({ success: false, connected: false, error: `Could not reach ${clean} — ${err.message}` });
  }
  if (!pingOk) return res.json({ success: false, connected: false, error: 'Health check failed — is this the right Heroku app?' });
  BOT_URL = clean;
  saveConfig({ botApiUrl: clean });
  console.log(`[WOLFY] Heroku URL updated: ${clean}`);
  return res.json({ success: true, connected: true, url: clean, sessions: pingData.sessions ?? 0, uptime: pingData.uptime ?? 0, service: pingData.service ?? '' });
});

// ── HEROKU API KEY ──
app.get('/api/admin/heroku-api-key', requireAdmin, async (req, res) => {
  const cfg = loadConfig();
  const key = cfg.herokuApiKey || '';
  if (!key) return res.json({ configured: false });
  // Return masked key + email if we have it cached
  return res.json({ configured: true, keyPreview: key.slice(0, 8) + '...', email: cfg.herokuEmail || '' });
});
app.post('/api/admin/heroku-api-key', requireAdmin, async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ success: false, error: 'API key required' });
  try {
    const r = await fetch('https://api.heroku.com/account', {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/vnd.heroku+json; version=3' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return res.json({ success: false, error: 'Invalid Heroku API key — check your key and try again' });
    const data = await r.json();
    saveConfig({ herokuApiKey: apiKey, herokuEmail: data.email || '' });
    console.log(`[WOLFY] Heroku API key saved for: ${data.email}`);
    return res.json({ success: true, email: data.email || '' });
  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
});

// ── HEROKU DYNO STATUS ──
// Heroku URLs have a dyno-ID suffix (e.g. wolfy-mini-44d170622f02.herokuapp.com)
// but the Heroku API app name is just "wolfy-mini". Resolve via apps list.
async function resolveHerokuAppName(apiKey, botUrl) {
  try {
    const r = await fetch('https://api.heroku.com/apps', {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/vnd.heroku+json; version=3' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return null;
    const apps = await r.json();
    const norm = u => u.replace(/\/+$/, '').toLowerCase();
    const t = norm(botUrl);
    const found = apps.find(a => norm(a.web_url).startsWith(t) || t.startsWith(norm(a.web_url)));
    return found ? found.name : null;
  } catch { return null; }
}

app.get('/api/admin/heroku-dyno-status', requireAdmin, async (req, res) => {
  const cfg = loadConfig();
  const apiKey = cfg.herokuApiKey;
  const url = BOT_URL;
  if (!apiKey) return res.json({ success: false, error: 'Heroku API key not configured — add it in the Heroku tab' });
  if (!url) return res.json({ success: false, error: 'Heroku bot URL not configured' });
  const appName = await resolveHerokuAppName(apiKey, url);
  if (!appName) return res.json({ success: false, error: 'Could not resolve Heroku app name — check API key and URL' });
  try {
    const r = await fetch(`https://api.heroku.com/apps/${appName}/dynos`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/vnd.heroku+json; version=3' },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.json({ success: false, error: err.message || `HTTP ${r.status}` });
    }
    const dynos = await r.json();
    return res.json({ success: true, dynos, appName });
  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
});

// ── HEROKU DYNO RESTART ──
app.post('/api/admin/heroku-restart-dyno', requireAdmin, async (req, res) => {
  const cfg = loadConfig();
  const apiKey = cfg.herokuApiKey;
  const url = BOT_URL;
  if (!apiKey) return res.json({ success: false, error: 'Heroku API key not configured' });
  if (!url) return res.json({ success: false, error: 'Heroku bot URL not configured' });
  const appName = await resolveHerokuAppName(apiKey, url);
  if (!appName) return res.json({ success: false, error: 'Could not resolve Heroku app name — check API key and URL' });
  try {
    const r = await fetch(`https://api.heroku.com/apps/${appName}/dynos`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(12000)
    });
    if (r.status === 202 || r.ok) {
      console.log(`[WOLFY] Heroku dyno restart triggered for ${appName}`);
      return res.json({ success: true, message: 'Dyno restart triggered', appName });
    }
    const err = await r.json().catch(() => ({}));
    return res.json({ success: false, error: err.message || `HTTP ${r.status}` });
  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
});


// ── HEROKU DEPLOY (trigger build from GitHub main) ──
app.post('/api/admin/heroku-deploy', requireAdmin, async (req, res) => {
  const cfg = loadConfig();
  const apiKey = cfg.herokuApiKey;
  if (!apiKey) return res.json({ success: false, error: 'Heroku API key not configured' });
  if (!BOT_URL) return res.json({ success: false, error: 'Heroku bot URL not configured' });
  try {
    const appName = await resolveHerokuAppName(apiKey, BOT_URL);
    if (!appName) return res.json({ success: false, error: 'Could not resolve Heroku app name' });
    const r = await fetch(`https://api.heroku.com/apps/${appName}/builds`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_blob: { url: 'https://github.com/peace-amani/wolfy/archive/refs/heads/main.tar.gz', version: 'main' } }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await r.json();
    if (data.id) return res.json({ success: true, buildId: data.id, status: data.status });
    return res.json({ success: false, error: data.message || `HTTP ${r.status}` });
  } catch (err) { return res.json({ success: false, error: err.message }); }
});

app.get('/api/admin/heroku-deploy-status/:buildId', requireAdmin, async (req, res) => {
  const cfg = loadConfig();
  const apiKey = cfg.herokuApiKey;
  if (!apiKey) return res.json({ success: false });
  try {
    const appName = await resolveHerokuAppName(apiKey, BOT_URL);
    if (!appName) return res.json({ success: false });
    const r = await fetch(`https://api.heroku.com/apps/${appName}/builds/${req.params.buildId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/vnd.heroku+json; version=3' },
      signal: AbortSignal.timeout(8000)
    });
    const data = await r.json();
    return res.json({ success: true, status: data.status, updatedAt: data.updated_at });
  } catch (err) { return res.json({ success: false, error: err.message }); }
});

// ── PAIRING PROXY ──
app.post('/api/pair', requireBot, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
    res.json(await r.json());
  } catch { res.status(502).json({ success: false, error: 'Could not reach bot server' }); }
});
app.post('/api/session', requireBot, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
    res.json(await r.json());
  } catch { res.status(502).json({ success: false, error: 'Could not reach bot server' }); }
});
app.post('/api/pair-reset', requireBot, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/pair-reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
    res.json(await r.json());
  } catch { res.status(502).json({ success: false, error: 'Could not reach bot server' }); }
});

app.get('/api/status', requireBot, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/status`);
    res.json(await r.json());
  } catch { res.status(502).json({ success: false, error: 'Bot server unreachable' }); }
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

// ── ADMIN API PROXY ──
app.get('/api/admin/stats', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/stats`, { headers: { 'x-admin-key': ADMIN_KEY } });
    res.json(await r.json());
  } catch { res.status(502).json({ success: false, error: 'Bot server unreachable' }); }
});
app.get('/api/admin/sessions', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/sessions`, { headers: { 'x-admin-key': ADMIN_KEY } });
    res.json(await r.json());
  } catch { res.status(502).json({ success: false, error: 'Bot server unreachable' }); }
});
app.delete('/api/admin/session/:phone', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/session/${req.params.phone}`, { method: 'DELETE', headers: { 'x-admin-key': ADMIN_KEY } });
    res.json(await r.json());
  } catch { res.status(502).json({ success: false, error: 'Bot server unreachable' }); }
});
app.post('/api/admin/restart-bot/:phone', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/restart-bot/${req.params.phone}`, { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
    res.json(await r.json());
  } catch { res.status(502).json({ success: false, error: 'Bot server unreachable' }); }
});
app.get('/api/admin/version', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/version`, { headers: { 'x-admin-key': ADMIN_KEY } });
    res.json(await r.json());
  } catch { res.status(502).json({ success: false, error: 'Bot server unreachable' }); }
});
app.post('/api/admin/restart-all', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/restart-all`, { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
    res.json(await r.json());
  } catch { res.status(502).json({ success: false, error: 'Bot server unreachable' }); }
});
app.post('/api/admin/update-all', requireBot, requireAdmin, async (req, res) => {
  try {
    const r = await fetch(`${BOT_URL}/admin/update-all`, { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
    res.json(await r.json());
  } catch { res.status(502).json({ success: false, error: 'Bot server unreachable' }); }
});

// ── PAGE ROUTES ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[WOLFY WebServer] Running on port ${PORT}`);
  if (!BOT_URL) console.warn('[WOLFY WebServer] WARNING: BOT_API_URL not configured — set via admin dashboard.');
  else console.log(`[WOLFY WebServer] Bot URL: ${BOT_URL}`);
  if (!ADMIN_PASS) console.warn('[WOLFY WebServer] WARNING: ADMIN_PASSWORD not set!');
});
