// Jet Lag deduction board — sync server
// Holds one game state per room, broadcasts changes to all connected clients,
// and persists state to disk so rooms survive a server restart.
//
// Deploy on VPS:
//   npm install
//   node server.js          (or: PORT=3001 node server.js)
//   pm2 start server.js     (recommended for production)

const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const STATE_DIR = path.join(__dirname, 'state');

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

// rooms: Map<roomId, { clients: Set<ws>, state: object|null }>
const rooms = new Map();

function loadRoomState(roomId) {
  const file = path.join(STATE_DIR, `${roomId}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function saveRoomState(roomId, state) {
  const file = path.join(STATE_DIR, `${roomId}.json`);
  fs.writeFile(file, JSON.stringify(state), (err) => {
    if (err) console.error(`[room ${roomId}] save failed:`, err.message);
  });
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { clients: new Set(), state: loadRoomState(roomId) });
  }
  return rooms.get(roomId);
}

wss.on('connection', (ws, req) => {
  const match = req.url?.match(/^\/room\/([a-zA-Z0-9_-]{2,32})$/);
  if (!match) {
    ws.close(4000, 'bad-room');
    return;
  }

  const roomId = match[1];
  const room = getRoom(roomId);
  room.clients.add(ws);
  console.log(`[room ${roomId}] client connected (${room.clients.size} total)`);

  // Send current persisted state immediately so the joining phone catches up.
  if (room.state) {
    ws.send(JSON.stringify({ type: 'state', data: room.state }));
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'state' && msg.data && typeof msg.data === 'object') {
      room.state = msg.data;
      saveRoomState(roomId, msg.data);

      // Broadcast to every OTHER client in the room.
      let fanned = 0;
      for (const client of room.clients) {
        if (client !== ws && client.readyState === 1 /* OPEN */) {
          client.send(JSON.stringify({ type: 'state', data: msg.data }));
          fanned++;
        }
      }
      if (fanned) console.log(`[room ${roomId}] state fanned out to ${fanned} client(s)`);
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    console.log(`[room ${roomId}] client disconnected (${room.clients.size} remaining)`);
  });

  ws.on('error', (err) => {
    console.error(`[room ${roomId}] ws error:`, err.message);
  });
});

server.listen(PORT, () => {
  console.log(`Jetlag sync server listening on port ${PORT}`);
  console.log(`State directory: ${STATE_DIR}`);
});
