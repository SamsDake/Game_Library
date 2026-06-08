// Jetlag sync server — run with: node server.js
// Deploy on VPS: npm install, then node server.js (or pm2 start server.js)
// Set PORT env var if needed (default 8080)
const { WebSocketServer } = require('ws');
const http = require('http');
const http2 = require('http2');
const fs = require('fs');
const crypto = require('crypto');
const webpush = require('web-push');
const { applicationDefault, cert, getApps, initializeApp } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

const PORT = process.env.PORT || 8080;

// ── VAPID keys (generated once, persisted to disk) ────────────────
const VAPID_FILE = './vapid.json';
let vapidKeys;
if (fs.existsSync(VAPID_FILE)) {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys));
  console.log('[push] Generated new VAPID keys → vapid.json');
}
// Apple rejects VAPID tokens whose `sub` is a bogus contact (e.g. a `.local`
// domain) with 403 BadJwtToken — must be a real mailto:/https: contact.
webpush.setVapidDetails('mailto:admin@comicsams.cloud', vapidKeys.publicKey, vapidKeys.privateKey);
let fcm = null;
let apns = null;

const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1513567338694447376/OC8ZhE8CzvRedgZ3nxlhY_ODjhE-Nx6gnkne3QrSxhK5SAtUc7TFJkCPUS_VSsLJEgon';
const DISCORD_HIDERS_MENTION  = '<@&1513568198832951338>';
const DISCORD_SEEKERS_MENTION = '<@&1513568328612839434>';

// ── State ─────────────────────────────────────────────────────────
let gameState = null;

// Push subscriptions persisted to disk so they survive a server restart
// (systemd restarts/deploys would otherwise wipe them and phones only
// re-subscribe when the app is reopened).
const SUBS_FILE = './push-subs.json';
const pushSubs = fs.existsSync(SUBS_FILE) // { 'A': PushSubscription, 'B': PushSubscription }
  ? JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'))
  : {};
const NATIVE_SUBS_FILE = './native-push-tokens.json';
const nativePushTokens = fs.existsSync(NATIVE_SUBS_FILE) // { 'A': { token, platform }, 'B': { token, platform } }
  ? JSON.parse(fs.readFileSync(NATIVE_SUBS_FILE, 'utf8'))
  : {};

function saveSubs() {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(pushSubs)); } catch { /* best-effort persistence */ }
  try { fs.writeFileSync(NATIVE_SUBS_FILE, JSON.stringify(nativePushTokens)); } catch { /* best-effort persistence */ }
}

// ── Push helper ───────────────────────────────────────────────────
function sendPush(device, title, body) {
  const sub = pushSubs[device];
  const native = nativePushTokens[device];
  if (!sub && !native) { console.log(`[push] no subscription for device ${device}`); return; }
  if (sub) {
    webpush.sendNotification(sub, JSON.stringify({ title, body }))
      .then(() => console.log(`[push] web sent to ${device}: ${title}`))
      .catch((err) => {
        const code = err.statusCode;
        console.log(`[push] web FAILED to ${device} (status ${code}): ${err.body || err.message}`);
        if (code === 404 || code === 410) {
          delete pushSubs[device];
          saveSubs();
        }
      });
  }
  if (native) sendNativePush(device, native, title, body);
}

function sendNativePush(device, native, title, body) {
  if (native.platform === 'android') {
    if (!fcm) return;
    fcm.send({
      token: native.token,
      notification: { title, body },
      android: {
        priority: 'high',
        notification: { channelId: 'game' },
      },
    }).then(() => console.log(`[push] native sent to ${device}: ${title}`))
      .catch((err) => {
        console.log(`[push] native FAILED to ${device}: ${err.code || err.message}`);
        if (err.code === 'messaging/registration-token-not-registered') {
          delete nativePushTokens[device];
          saveSubs();
        }
      });
    return;
  }
  if (native.platform === 'ios' && apns) {
    apns.send(native.token, title, body)
      .then(() => console.log(`[push] native sent to ${device}: ${title}`))
      .catch((err) => {
        console.log(`[push] APNs FAILED to ${device} (status ${err.statusCode || 'n/a'}): ${err.message}`);
        if (err.statusCode === 400 || err.statusCode === 410) {
          delete nativePushTokens[device];
          saveSubs();
        }
      });
  }
}

function initFirebase() {
  try {
    if (!getApps().length) {
      const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
        || (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
          ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
          : '');
      initializeApp(json
        ? { credential: cert(JSON.parse(json)) }
        : { credential: applicationDefault() });
    }
    return getMessaging();
  } catch (err) {
    console.log(`[push] Firebase native push disabled: ${err.message}`);
    return null;
  }
}

function initApns() {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID || 'com.jetlagmobileapp.app';
  const rawKey = process.env.APNS_PRIVATE_KEY
    || (process.env.APNS_PRIVATE_KEY_BASE64
      ? Buffer.from(process.env.APNS_PRIVATE_KEY_BASE64, 'base64').toString('utf8')
      : '');
  if (!keyId || !teamId || !rawKey) {
    console.log('[push] APNs native push disabled: APNS_KEY_ID, APNS_TEAM_ID, and APNS_PRIVATE_KEY are required');
    return null;
  }
  return new ApnsSender({
    keyId,
    teamId,
    bundleId,
    privateKey: rawKey.replace(/\\n/g, '\n'),
    production: String(process.env.APNS_ENV || '').toLowerCase() === 'production',
  });
}

class ApnsSender {
  constructor(config) {
    this.config = config;
    this.jwt = '';
    this.jwtCreatedAt = 0;
    this.host = config.production ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  }

  send(deviceToken, title, body) {
    return new Promise((resolve, reject) => {
      const client = http2.connect(`https://${this.host}`);
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${this.token()}`,
        'apns-topic': this.config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
      });
      let responseBody = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { responseBody += chunk; });
      req.on('response', headers => {
        const status = Number(headers[':status'] || 0);
        req.on('end', () => {
          client.close();
          if (status >= 200 && status < 300) resolve();
          else {
            const err = new Error(responseBody || `APNs returned ${status}`);
            err.statusCode = status;
            reject(err);
          }
        });
      });
      req.on('error', err => {
        client.close();
        reject(err);
      });
      req.end(JSON.stringify({
        aps: {
          alert: { title, body },
          sound: 'default',
        },
      }));
    });
  }

  token() {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && now - this.jwtCreatedAt < 50 * 60) return this.jwt;
    const header = base64Url(JSON.stringify({ alg: 'ES256', kid: this.config.keyId }));
    const payload = base64Url(JSON.stringify({ iss: this.config.teamId, iat: now }));
    const input = `${header}.${payload}`;
    const signature = crypto.sign('sha256', Buffer.from(input), {
      key: this.config.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    this.jwt = `${input}.${base64Url(signature)}`;
    this.jwtCreatedAt = now;
    return this.jwt;
  }
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

fcm = initFirebase();
apns = initApns();

function diffAndPush(prev, next) {
  const prevUids = new Set((prev?.notifications || []).map(n => n.uid));
  for (const n of (next.notifications || [])) {
    if (prevUids.has(n.uid)) continue;
    if (n.to === 'both') {
      sendPush('A', n.title, n.text);
      sendPush('B', n.title, n.text);
    } else {
      const device = Object.entries(next.roles || {}).find(([, r]) => r === n.to)?.[0];
      if (device) sendPush(device, n.title, n.text);
    }
    sendDiscordWebhook(n.title, n.text, n.to);
  }
}

function sendDiscordWebhook(title, text, to) {
  let mention = '';
  if (to === 'both') mention = `${DISCORD_HIDERS_MENTION} ${DISCORD_SEEKERS_MENTION} `;
  else if (to === 'hider') mention = `${DISCORD_HIDERS_MENTION} `;
  else if (to === 'seeker') mention = `${DISCORD_SEEKERS_MENTION} `;

  const content = `${mention}**${title}** — ${text}`;
  const payload = JSON.stringify({
    content,
    allowed_mentions: { roles: ['1513568198832951338', '1513568328612839434'] },
  });

  const url = new URL(DISCORD_WEBHOOK_URL);
  const req = require('https').request({
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, (res) => {
    if (res.statusCode >= 300) console.log(`[discord] webhook FAILED (status ${res.statusCode}) for: ${title}`);
    else console.log(`[discord] sent: ${title} (to ${to})`);
  });
  req.on('error', (err) => console.log(`[discord] webhook error: ${err.message}`));
  req.end(payload);
}

// ── HTTP server (health + push endpoints) ────────────────────────
const server = http.createServer((req, res) => {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/vapid-public-key') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ publicKey: vapidKeys.publicKey }));
    return;
  }

  // Locked-phone push test: hit /push-test?device=A to send a canned push.
  if (req.method === 'GET' && req.url.startsWith('/push-test')) {
    const device = new URL(req.url, 'http://x').searchParams.get('device');
    const has = !!pushSubs[device] || !!nativePushTokens[device];
    if (has) sendPush(device, 'Test', 'Locked-phone push test');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ device, subscribed: has }));
    return;
  }

  if (req.method === 'POST' && req.url === '/push-subscribe') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { device, subscription, nativeToken, platform } = JSON.parse(body);
        if (device && subscription) {
          pushSubs[device] = subscription;
          saveSubs();
          console.log(`[push] Web subscription stored for device ${device}`);
        }
        if (device && nativeToken && ['android', 'ios'].includes(platform)) {
          nativePushTokens[device] = { token: nativeToken, platform };
          saveSubs();
          console.log(`[push] Native ${platform} token stored for device ${device}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400); res.end();
      }
    });
    return;
  }

  res.writeHead(200); res.end('Jetlag sync server');
});

// ── WebSocket ─────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log(`[+] client connected (total: ${wss.clients.size})`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'hello') {
        if (gameState) {
          ws.send(JSON.stringify({ type: 'state', state: gameState }));
        } else {
          ws.send(JSON.stringify({ type: 'empty' }));
        }
      } else if (msg.type === 'state') {
        const prev = gameState;
        gameState = msg.state;
        diffAndPush(prev, gameState);
        for (const client of wss.clients) {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify({ type: 'state', state: gameState }));
          }
        }
      } else if (msg.type === 'reset') {
        gameState = null;
        for (const client of wss.clients) {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify({ type: 'reset' }));
          }
        }
      }
    } catch { /* ignore malformed client messages */ }
  });

  ws.on('close', () => console.log(`[-] client disconnected (total: ${wss.clients.size})`));
  ws.on('error', () => { /* connection errors are handled by close/reconnect */ });
});

server.listen(PORT, () => console.log(`Jetlag sync server on :${PORT}`));
