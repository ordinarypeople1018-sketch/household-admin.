'use strict';
// Household Admin: zero-dependency Node server (Node 18+).
// Accounts, sessions and per-user items stored in a JSON file.
// For real production traffic, swap the JSON file for Postgres/SQLite and run behind HTTPS.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
// Static files live in ./public, or beside server.js when the project is uploaded flat (no folders).
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
const STATIC_FILES = new Set(['index.html', 'styles.css', 'app.js', 'privacy.html']);
const SECURE_COOKIE = process.env.NODE_ENV === 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY = 50 * 1024;
const MAX_ITEMS_PER_USER = 500;
const HOUR = 60 * 60 * 1000;
const RESET_MS = HOUR;

// Password-reset email settings. The link in the email is built from BASE_URL, never from the
// request's Host header (that would let an attacker point reset links at their own site).
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || (SECURE_COOKIE ? '' : `http://localhost:${PORT}`)).replace(/\/+$/, '');
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || '';
const MAIL_MODE = process.env.MAIL_MODE || ''; // "console" prints emails to the server log: local testing only

const CATEGORIES = ['insurance', 'utilities', 'subscription', 'tax', 'rent', 'loan', 'warranty', 'other'];
const REPEATS = ['none', 'monthly', 'yearly'];

// ---------- storage ----------
let db = { users: [], sessions: [], items: [], resets: [] };

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db.resets = db.resets || [];
}

function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}

// ---------- helpers ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newId = () => crypto.randomBytes(12).toString('hex');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(httpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function send(res, status, body, extra = {}) {
  const isObj = typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(payload);
}

function setSessionCookie(res, token, maxAgeMs) {
  const parts = [
    `sid=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (SECURE_COOKIE) parts.push('Secure');
  return parts.join('; ');
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions.push({ hash: sha256(token), userId, expires: Date.now() + SESSION_MS });
  return token;
}

function currentUser(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const hash = sha256(token);
  const now = Date.now();
  const s = db.sessions.find((x) => x.hash === hash && x.expires > now);
  return s ? db.users.find((u) => u.id === s.userId) || null : null;
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, createdAt: u.createdAt };
}

// simple in-memory login/signup throttle
const attempts = new Map();
function throttle(key, max = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const rec = (attempts.get(key) || []).filter((t) => now - t < windowMs);
  if (rec.length >= max) throw httpError(429, 'Too many attempts. Try again in a few minutes.');
  rec.push(now);
  attempts.set(key, rec);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (!v.some((t) => now - t < HOUR)) attempts.delete(k);
  db.sessions = db.sessions.filter((s) => s.expires > now);
  db.resets = db.resets.filter((r) => r.expires > now);
}, 10 * 60 * 1000).unref();

// ---------- email ----------
async function sendMail(to, subject, text, html) {
  if (MAIL_MODE === 'console') {
    console.log(`[mail] to=${to}\nsubject=${subject}\n${text}\n[/mail]`);
    if (html) console.log(`[html]${html}[/html]`);
    return;
  }
  if (!BREVO_API_KEY || !MAIL_FROM) {
    console.error('Email is not set up (BREVO_API_KEY or MAIL_FROM is missing). No email was sent.');
    return;
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: 'Household Admin', email: MAIL_FROM }, to: [{ email: to }], subject, textContent: text, ...(html ? { htmlContent: html } : {}) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) console.error('The email provider refused the message. Status:', res.status);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Email-safe layout: tables and inline styles only, no images or tracking, so nothing loads from outside.
function emailHtml({ preheader, heading, paragraphs, button, footer }) {
  const font = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const paras = paragraphs.map((t) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#1b1f23">${esc(t)}</p>`).join('');
  const btn = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td bgcolor="#0f6b5c" style="border-radius:12px"><a href="${esc(button.url)}" style="display:inline-block;padding:15px 30px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px">${esc(button.label)}</a></td></tr></table>` +
      `<p style="margin:0 0 24px;font-size:13px;line-height:1.5;color:#5a6068">Button not working? Copy this link into your browser:<br><span style="word-break:break-all;color:#0f6b5c">${esc(button.url)}</span></p>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#f6f4ef;font-family:${font}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f6f4ef"><tr><td align="center" style="padding:28px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">
<tr><td style="padding:0 0 18px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="38" height="38" bgcolor="#0f6b5c" align="center" style="border-radius:10px;color:#ffffff;font-size:19px;font-weight:700">H</td><td style="padding-left:10px;font-size:18px;font-weight:700;color:#1b1f23">Household Admin</td></tr></table></td></tr>
<tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid #ece8df;border-radius:18px;padding:32px 28px">
<h1 style="margin:0 0 18px;font-size:24px;line-height:1.25;color:#1b1f23">${esc(heading)}</h1>
${paras}${btn}
<p style="margin:0;font-size:13px;line-height:1.5;color:#5a6068">${esc(footer)}</p>
</td></tr>
<tr><td align="center" style="padding:18px 8px 0;font-size:12px;line-height:1.5;color:#5a6068">Household Admin keeps your bills and renewals in one place.<br>We never sell or share your personal information.</td></tr>
</table></td></tr></table></body></html>`;
}

// ---------- validation ----------
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function cleanItem(body) {
  const title = String(body.title || '').trim();
  if (!title || title.length > 80) throw httpError(400, 'Name is required (max 80 characters).');
  const category = CATEGORIES.includes(body.category) ? body.category : 'other';
  const repeat = REPEATS.includes(body.repeat) ? body.repeat : 'none';
  if (!validDate(body.dueDate)) throw httpError(400, 'Please choose a valid due date.');
  let amount = null;
  if (body.amount !== null && body.amount !== undefined && body.amount !== '') {
    amount = Math.round(Number(body.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount < 0 || amount > 10000000) throw httpError(400, 'Amount looks wrong.');
  }
  const note = String(body.note || '').trim().slice(0, 200);
  return { title, category, repeat, dueDate: body.dueDate, amount, note };
}

function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = m - 1 + months;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ny, nm, Math.min(d, last))).toISOString().slice(0, 10);
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const method = req.method;
  const route = url.pathname;

  if (method !== 'GET' && method !== 'HEAD') {
    if (req.headers['x-requested-with'] !== 'household-admin') throw httpError(403, 'Bad request');
  }

  if (route === '/api/signup' && method === 'POST') {
    const b = await readJson(req);
    throttle('signup:' + clientIp(req), 10);
    const name = String(b.name || '').trim().slice(0, 60);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!name) throw httpError(400, 'Please enter your name.');
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Please enter a valid email.');
    if (password.length < 8 || password.length > 200) throw httpError(400, 'Password must be at least 8 characters.');
    if (b.agree !== true) throw httpError(400, 'Please accept the Privacy Policy to create an account.');
    if (db.users.some((u) => u.email === email)) throw httpError(409, 'An account with this email already exists.');
    const user = {
      id: newId(),
      name,
      email,
      passwordHash: await hashPassword(password),
      createdAt: new Date().toISOString(),
      privacyAcceptedAt: new Date().toISOString(),
    };
    db.users.push(user);
    const token = createSession(user.id);
    saveDb();
    return send(res, 201, { user: publicUser(user) }, { 'Set-Cookie': setSessionCookie(res, token, SESSION_MS) });
  }

  if (route === '/api/login' && method === 'POST') {
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase();
    throttle(`login:${clientIp(req)}:${email}`, 10);
    const user = db.users.find((u) => u.email === email);
    const ok = user ? await verifyPassword(String(b.password || ''), user.passwordHash) : false;
    if (!ok) throw httpError(401, 'Email or password is incorrect.');
    const token = createSession(user.id);
    saveDb();
    return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': setSessionCookie(res, token, SESSION_MS) });
  }

  if (route === '/api/logout' && method === 'POST') {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) {
      const hash = sha256(token);
      db.sessions = db.sessions.filter((s) => s.hash !== hash);
      saveDb();
    }
    return send(res, 200, { ok: true }, { 'Set-Cookie': setSessionCookie(res, '', 0) });
  }

  if (route === '/api/forgot' && method === 'POST') {
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase();
    throttle('forgot-ip:' + clientIp(req), 8, HOUR);
    if (EMAIL_RE.test(email)) {
      throttle('forgot-email:' + email, 3, HOUR);
      const user = db.users.find((u) => u.email === email);
      if (user && BASE_URL) {
        const token = crypto.randomBytes(32).toString('hex');
        db.resets = db.resets.filter((r) => r.userId !== user.id);
        db.resets.push({ hash: sha256(token), userId: user.id, expires: Date.now() + RESET_MS });
        saveDb();
        // sent in the background so the response time does not reveal whether the account exists
        sendMail(
          user.email,
          'Reset your Household Admin password',
          `Hi ${user.name},\n\nSomeone asked to reset the password for your Household Admin account.\n\nChoose a new password here (the link works once, for one hour):\n${BASE_URL}/#reset=${token}\n\nIf this was not you, ignore this email. Your password stays the same.`,
          emailHtml({
            preheader: 'Your reset link works once and expires in one hour.',
            heading: 'Reset your password',
            paragraphs: [`Hi ${user.name},`, 'Someone asked to reset the password for your Household Admin account. Tap the button to choose a new one. The link works once and expires in one hour.'],
            button: { label: 'Choose a new password', url: `${BASE_URL}/#reset=${token}` },
            footer: 'If this was not you, ignore this email. Your password stays the same.',
          })
        ).catch(() => console.error('Could not send the reset email.'));
      } else if (user) {
        console.error('BASE_URL is not set, so a reset link cannot be built.');
      }
    }
    // same answer whether or not the account exists
    return send(res, 200, { ok: true });
  }

  if (route === '/api/reset' && method === 'POST') {
    const b = await readJson(req);
    throttle('reset:' + clientIp(req), 10);
    const token = String(b.token || '');
    const password = String(b.password || '');
    if (!/^[a-f0-9]{64}$/.test(token)) throw httpError(400, 'This reset link is not valid.');
    if (password.length < 8 || password.length > 200) throw httpError(400, 'Password must be at least 8 characters.');
    const hash = sha256(token);
    const rec = db.resets.find((r) => r.hash === hash && r.expires > Date.now());
    const user = rec && db.users.find((u) => u.id === rec.userId);
    if (!user) throw httpError(400, 'This reset link has expired or was already used. Please request a new one.');
    user.passwordHash = await hashPassword(password);
    db.resets = db.resets.filter((r) => r.userId !== user.id);
    db.sessions = db.sessions.filter((s) => s.userId !== user.id); // log out everywhere
    saveDb();
    sendMail(
      user.email,
      'Your Household Admin password was changed',
      `Hi ${user.name},\n\nThe password for your Household Admin account was just changed. If this was you, nothing more to do.\n\nIf it was not you, reset your password again right away using "Forgot password" on the login screen.`,
      emailHtml({
        preheader: 'Your Household Admin password was just changed.',
        heading: 'Your password was changed',
        paragraphs: [`Hi ${user.name},`, 'The password for your Household Admin account was just changed. If this was you, there is nothing more to do.'],
        footer: 'If it was not you, tap "Forgot password" on the login screen right away to take back your account.',
      })
    ).catch(() => console.error('Could not send the password-changed email.'));
    return send(res, 200, { ok: true }, { 'Set-Cookie': setSessionCookie(res, '', 0) });
  }

  // everything below needs a logged-in user
  const user = currentUser(req);
  if (!user) throw httpError(401, 'Please log in.');

  if (route === '/api/me' && method === 'GET') return send(res, 200, { user: publicUser(user) });

  if (route === '/api/items' && method === 'GET') {
    return send(res, 200, { items: db.items.filter((i) => i.userId === user.id) });
  }

  if (route === '/api/items' && method === 'POST') {
    if (db.items.filter((i) => i.userId === user.id).length >= MAX_ITEMS_PER_USER) {
      throw httpError(400, 'Item limit reached.');
    }
    const item = { id: newId(), userId: user.id, done: false, createdAt: new Date().toISOString(), ...cleanItem(await readJson(req)) };
    db.items.push(item);
    saveDb();
    return send(res, 201, { item });
  }

  const m = route.match(/^\/api\/items\/([a-f0-9]{24})(\/paid)?$/);
  if (m) {
    const item = db.items.find((i) => i.id === m[1] && i.userId === user.id);
    if (!item) throw httpError(404, 'Not found');
    if (m[2] && method === 'POST') {
      if (item.repeat === 'none') item.done = true;
      else item.dueDate = addMonths(item.dueDate, item.repeat === 'monthly' ? 1 : 12);
      saveDb();
      return send(res, 200, { item });
    }
    if (!m[2] && method === 'PUT') {
      Object.assign(item, cleanItem(await readJson(req)));
      item.done = false;
      saveDb();
      return send(res, 200, { item });
    }
    if (!m[2] && method === 'DELETE') {
      db.items = db.items.filter((i) => i !== item);
      saveDb();
      return send(res, 200, { ok: true });
    }
  }

  if (route === '/api/export' && method === 'GET') {
    const data = {
      exportedAt: new Date().toISOString(),
      account: { ...publicUser(user), privacyAcceptedAt: user.privacyAcceptedAt },
      items: db.items.filter((i) => i.userId === user.id).map(({ userId, ...rest }) => rest),
    };
    return send(res, 200, JSON.stringify(data, null, 2), {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="household-admin-my-data.json"',
    });
  }

  if (route === '/api/account' && method === 'DELETE') {
    const b = await readJson(req);
    throttle(`delete:${user.id}`, 5);
    if (!(await verifyPassword(String(b.password || ''), user.passwordHash))) {
      throw httpError(401, 'Password is incorrect.');
    }
    db.items = db.items.filter((i) => i.userId !== user.id);
    db.sessions = db.sessions.filter((s) => s.userId !== user.id);
    db.resets = db.resets.filter((r) => r.userId !== user.id);
    db.users = db.users.filter((u) => u.id !== user.id);
    saveDb();
    return send(res, 200, { ok: true }, { 'Set-Cookie': setSessionCookie(res, '', 0) });
  }

  throw httpError(404, 'Not found');
}

// ---------- static files ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/privacy') rel = '/privacy.html';
  if (!STATIC_FILES.has(rel.slice(1))) return send(res, 404, 'Not found');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

// ---------- server ----------
loadDb();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    serveStatic(req, res, url);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong.' : err.message });
  }
});

server.listen(PORT, () => console.log(`Household Admin running on http://localhost:${PORT}`));
