const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 10000,
  pingInterval: 5000,
});

app.use((req, res, next) => {
  if (req.path.endsWith('.js') || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});
app.use(express.static(path.join(__dirname, '../client')));

const STATION_POS = { x: 0, y: 0, z: 0 };
const SAFE_ZONE_RADIUS = 500;
const TICK_RATE = 50; // ms per server tick (was 20 — 20ms floods slow connections)

const players = {};

function isValidVec(v) {
  return v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number'
    && isFinite(v.x) && isFinite(v.y) && isFinite(v.z);
}

function inSafeZone(pos) {
  if (!isValidVec(pos)) return true;
  const dx = pos.x - STATION_POS.x;
  const dy = pos.y - STATION_POS.y;
  const dz = pos.z - STATION_POS.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) < SAFE_ZONE_RADIUS;
}

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  players[socket.id] = {
    id: socket.id,
    name: `Pilot-${socket.id.slice(0, 4)}`,
    position: { x: 0, y: 0, z: 150 },
    rotation: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    health: 100,
    inSafeZone: true,
    shipType: 'scout',
    fpMode: null,
    fpPos: null,
    fpYaw: null,
  };

  socket.emit('init', {
    self: players[socket.id],
    players: Object.values(players).filter(p => p.id !== socket.id),
    stationPos: STATION_POS,
    safeZoneRadius: SAFE_ZONE_RADIUS,
  });

  socket.broadcast.emit('player_joined', players[socket.id]);

  socket.on('player_update', (data) => {
    try {
      const player = players[socket.id];
      if (!player || !data) return;
      if (isValidVec(data.position)) player.position = data.position;
      if (isValidVec(data.rotation)) player.rotation = data.rotation;
      if (isValidVec(data.velocity)) player.velocity = data.velocity;
      player.inSafeZone = inSafeZone(player.position);
      player.fpMode = data.fpMode || null;
      player.fpPos  = isValidVec(data.fpPos) ? data.fpPos : null;
      player.fpYaw  = typeof data.fpYaw === 'number' && isFinite(data.fpYaw) ? data.fpYaw : null;
    } catch(e) {
      console.error('player_update error:', e.message);
    }
  });

  socket.on('player_hit', (data) => {
    try {
      if (!data || typeof data.targetId !== 'string') return;
      const target = players[data.targetId];
      if (!target || data.targetId === socket.id) return; // no self-damage
      const damage = typeof data.damage === 'number' && isFinite(data.damage)
        ? Math.max(0, Math.min(100, data.damage)) : 10;
      target.health = Math.max(0, target.health - damage);
      io.to(data.targetId).emit('took_damage', { health: target.health, damage });
      if (target.health <= 0) {
        target.health = 100; // respawn full health
        io.to(data.targetId).emit('you_died', { killerId: socket.id });
      }
    } catch(e) {
      console.error('player_hit error:', e.message);
    }
  });

  socket.on('chat', (data) => {
    try {
      if (!data || typeof data.text !== 'string' || !data.text.trim()) return;
      const safe = data.text.trim().slice(0, 120);
      socket.broadcast.emit('chat', { name: data.name || 'Pilot', text: safe });
    } catch(e) {}
  });

  socket.on('disconnect', (reason) => {
    console.log(`Player disconnected: ${socket.id} (${reason})`);
    delete players[socket.id];
    io.emit('player_left', socket.id);
  });

  socket.on('error', (err) => {
    console.error(`Socket error for ${socket.id}:`, err.message);
  });
});

// Broadcast world state
setInterval(() => {
  const list = Object.values(players);
  if (list.length > 0) io.emit('world_state', list);
}, TICK_RATE);

// Keep process alive on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server kept alive):', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server kept alive):', err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Space game server running on http://localhost:${PORT}`);
});
