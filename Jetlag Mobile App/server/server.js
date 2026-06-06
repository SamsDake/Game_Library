// Jetlag sync server — run with: node server.js
// Deploy on VPS: npm install, then node server.js (or pm2 start server.js)
// Set PORT env var if needed (default 8080)
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const webpush = require('web-push');

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

// ── State ─────────────────────────────────────────────────────────
let gameState = null;

// Push subscriptions persisted to disk so they survive a server restart
// (systemd restarts/deploys would otherwise wipe them and phones only
// re-subscribe when the app is reopened).
const SUBS_FILE = './push-subs.json';
const pushSubs = fs.existsSync(SUBS_FILE) // { 'A': PushSubscription, 'B': PushSubscription }
  ? JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'))
  : {};

function saveSubs() {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(pushSubs)); } catch { /* best-effort persistence */ }
}

// ── Push helper ───────────────────────────────────────────────────
function sendPush(device, title, body) {
  const sub = pushSubs[device];
  if (!sub) { console.log(`[push] no subscription for device ${device}`); return; }
  webpush.sendNotification(sub, JSON.stringify({ title, body }))
    .then(() => console.log(`[push] sent to ${device}: ${title}`))
    .catch((err) => {
      const code = err.statusCode;
      console.log(`[push] FAILED to ${device} (status ${code}): ${err.body || err.message}`);
      if (code === 404 || code === 410) { // subscription gone for good
        delete pushSubs[device];
        saveSubs();
      }
    });
}

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
  }
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
    const has = !!pushSubs[device];
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
        const { device, subscription } = JSON.parse(body);
        if (device && subscription) {
          pushSubs[device] = subscription;
          saveSubs();
          console.log(`[push] Subscription stored for device ${device}`);
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
