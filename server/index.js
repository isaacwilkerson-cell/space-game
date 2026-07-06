const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { initDb, registerAuthRoutes, verifySessionToken } = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 10000,
  pingInterval: 5000,
});

registerAuthRoutes(app);
initDb().catch(err => console.error('[auth] initDb failed:', err.message));

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

// ── TDM zone arbitration ────────────────────────────────────────────────────
// Countdown/teleport used to be decided independently by each client's own clock, so one
// client's local timer could hit zero a moment before another's — only that one player
// would actually teleport. The server is now the single source of truth: it tracks who's
// standing in the zone, runs the one real countdown, and broadcasts a single 'tdm_go'
// event so every client starts the intro/teleport at the exact same instant.
const TDM_ZONE = { minX: -147, maxX: -82, minZ: -26, maxZ: 22 };
const TDM_COUNTDOWN_MS = 20000;
function inTDMZone(pos) {
  return pos && pos.x > TDM_ZONE.minX && pos.x < TDM_ZONE.maxX && pos.z > TDM_ZONE.minZ && pos.z < TDM_ZONE.maxZ;
}
let _tdmCountdownEndsAt = null;
let _tdmParticipants = [];
const TDM_MATCH_DURATION_MS = 3 * 60 * 1000;
let _tdmMatchEndsAt = null;
let _tdmMatchParticipants = [];

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

  // Logged-in players get their real username; anyone else (guests, or an expired/invalid
  // token) falls back to the same anonymous "Pilot-XXXX" naming as before — accounts are
  // additive, guest play still works exactly as it always did.
  const sessionPayload = verifySessionToken(socket.handshake.auth && socket.handshake.auth.token);
  const displayName = sessionPayload ? sessionPayload.username : `Pilot-${socket.id.slice(0, 4)}`;

  players[socket.id] = {
    id: socket.id,
    name: displayName,
    loggedIn: !!sessionPayload,
    position: { x: 0, y: 0, z: 150 },
    rotation: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    health: 100,
    inSafeZone: true,
    shipType: 'scout',
    fpMode: null,
    fpPos: null,
    fpYaw: null,
    tdmKills: 0,
    tdmDeaths: 0,
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
      player.fpAnim = (data.fpAnim && typeof data.fpAnim === 'object') ? {
        speed: typeof data.fpAnim.speed === 'number' && isFinite(data.fpAnim.speed) ? data.fpAnim.speed : 0,
        jumping: !!data.fpAnim.jumping,
        sliding: !!data.fpAnim.sliding,
        crouch: typeof data.fpAnim.crouch === 'number' && isFinite(data.fpAnim.crouch) ? data.fpAnim.crouch : 0,
      } : null;
      player.equippedWeaponId = typeof data.equippedWeaponId === 'string' ? data.equippedWeaponId : null;
      player.tdmZone = player.fpMode === 'lobby' && inTDMZone(player.fpPos);
    } catch(e) {
      console.error('player_update error:', e.message);
    }
  });

  socket.on('player_hit', (data) => {
    try {
      if (!data || typeof data.targetId !== 'string') return;
      const target = players[data.targetId];
      const killer = players[socket.id];
      if (!target || data.targetId === socket.id) return; // no self-damage
      const damage = typeof data.damage === 'number' && isFinite(data.damage)
        ? Math.max(0, Math.min(100, data.damage)) : 10;
      target.health = Math.max(0, target.health - damage);
      io.to(data.targetId).emit('took_damage', { health: target.health, damage });
      if (target.health <= 0) {
        target.health = 100; // respawn full health
        io.to(data.targetId).emit('you_died', { killerId: socket.id });
        // In an active TDM match (both players currently in the arena), the kill counts
        // toward the running match stats and both players respawn at their team's spawn
        // point instead of the normal "eject back to your room" flow.
        if (killer && killer.fpMode === 'tdm' && target.fpMode === 'tdm') {
          killer.tdmKills++;
          target.tdmDeaths++;
          io.emit('tdm_kill', { killerId: socket.id, victimId: data.targetId });
        }
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

// TDM zone countdown — single authoritative timer, ticked/broadcast every 500ms.
setInterval(() => {
  const inZoneIds = Object.values(players).filter(p => p.tdmZone).map(p => p.id);
  if (inZoneIds.length >= 2) {
    if (_tdmCountdownEndsAt === null) {
      _tdmCountdownEndsAt = Date.now() + TDM_COUNTDOWN_MS;
      _tdmParticipants = inZoneIds;
      io.emit('tdm_countdown_start', { endsAt: _tdmCountdownEndsAt, participants: _tdmParticipants });
    }
    if (Date.now() >= _tdmCountdownEndsAt) {
      io.emit('tdm_go', { participants: _tdmParticipants });
      // Start the match clock and reset each participant's running kill/death tally.
      _tdmMatchEndsAt = Date.now() + TDM_MATCH_DURATION_MS;
      _tdmMatchParticipants = _tdmParticipants;
      _tdmMatchParticipants.forEach(id => {
        if (players[id]) { players[id].tdmKills = 0; players[id].tdmDeaths = 0; }
      });
      _tdmCountdownEndsAt = null;
      _tdmParticipants = [];
    }
  } else if (_tdmCountdownEndsAt !== null) {
    _tdmCountdownEndsAt = null;
    _tdmParticipants = [];
    io.emit('tdm_countdown_cancel');
  }

  if (_tdmMatchEndsAt !== null && Date.now() >= _tdmMatchEndsAt) {
    const stats = _tdmMatchParticipants.map(id => ({
      id,
      name: players[id] ? players[id].name : 'Pilot',
      kills: players[id] ? players[id].tdmKills : 0,
      deaths: players[id] ? players[id].tdmDeaths : 0,
    }));
    io.emit('tdm_match_end', { participants: _tdmMatchParticipants, stats });
    _tdmMatchEndsAt = null;
    _tdmMatchParticipants = [];
  }
}, 500);

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
