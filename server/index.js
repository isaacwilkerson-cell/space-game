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

// ── Economy ──────────────────────────────────────────────────────────────────
const CREDIT_REWARD = { fp: 30, tdm: 15, ship: 60, crate: 150 };

// ── Cargo ship / crate event ─────────────────────────────────────────────────
// A cargo ship carrying a valuable crate periodically appears out in open space. Its
// position/health/existence is entirely server-owned (not tied to any one player's
// connection) so every client sees the exact same thing at the exact same time — shoot it
// down (ship combat) and the crate is left floating at the wreck site for anyone to fly
// over/eject near and collect.
const CARGO_SHIP_HP = 150;
const CARGO_SHIP_SPAWN_MIN_MS = 3 * 60 * 1000;
const CARGO_SHIP_SPAWN_MAX_MS = 6 * 60 * 1000;
const CARGO_SHIP_SPAWN_RADIUS = 60000; // out among the planets, not right on top of the station
const CRATE_COLLECT_RADIUS = 80;
let _cargoShip = null; // { id, position, hp } while alive
let _floatingCrate = null; // { position } once the cargo ship is destroyed, until collected
let _nextCargoShipAt = Date.now() + 20000; // first one appears reasonably soon after boot

function spawnCargoShip() {
  const ang = Math.random() * Math.PI * 2;
  const elevAng = (Math.random() - 0.5) * Math.PI * 0.6;
  const r = CARGO_SHIP_SPAWN_RADIUS * (0.5 + Math.random() * 0.5);
  const position = {
    x: Math.cos(ang) * Math.cos(elevAng) * r,
    y: Math.sin(elevAng) * r,
    z: Math.sin(ang) * Math.cos(elevAng) * r,
  };
  _cargoShip = { id: 'cargo-' + Date.now(), position, hp: CARGO_SHIP_HP };
  _floatingCrate = null;
  io.emit('cargo_ship_spawned', _cargoShip);
  io.emit('chat', { name: '📦 SERVER', text: `A supply ship carrying a crate has been spotted! Shoot it down to claim the cargo.` });
}

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

  // Just a plain client-supplied display name — no account, no password, no verification.
  // Falls back to the anonymous Pilot-XXXX naming if blank or invalid.
  const _rawUsername = socket.handshake.auth && typeof socket.handshake.auth.username === 'string' ? socket.handshake.auth.username.trim() : '';
  const displayName = (_rawUsername.length >= 1 && _rawUsername.length <= 20) ? _rawUsername : `Pilot-${socket.id.slice(0, 4)}`;

  players[socket.id] = {
    id: socket.id,
    name: displayName,
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
    credits: 0,
  };

  socket.emit('init', {
    self: players[socket.id],
    players: Object.values(players).filter(p => p.id !== socket.id),
    stationPos: STATION_POS,
    safeZoneRadius: SAFE_ZONE_RADIUS,
    cargoShip: _cargoShip,
    floatingCrate: _floatingCrate,
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
        // Credit reward — ship-vs-ship kills (both flying, fpMode null) pay the most,
        // TDM the least (matches are long and kills are frequent there), anything else
        // (FP combat in the lobby/range/etc.) in between.
        if (killer) {
          const isShipKill = killer.fpMode === null && target.fpMode === null;
          const isTdmKill  = killer.fpMode === 'tdm' && target.fpMode === 'tdm';
          const reward = isTdmKill ? CREDIT_REWARD.tdm : isShipKill ? CREDIT_REWARD.ship : CREDIT_REWARD.fp;
          killer.credits += reward;
          io.to(socket.id).emit('credits_update', { credits: killer.credits, reward, reason: 'kill', kind: isShipKill ? 'ship' : isTdmKill ? 'tdm' : 'fp' });
        }
      }
    } catch(e) {
      console.error('player_hit error:', e.message);
    }
  });

  // Environmental damage (e.g. freezing to death while ejected in open space) — same
  // damage/death flow as player_hit, but always targets yourself, so it skips that
  // handler's no-self-damage check instead of trying to route around it.
  socket.on('environmental_damage', (data) => {
    try {
      const player = players[socket.id];
      if (!player) return;
      const damage = typeof data.damage === 'number' && isFinite(data.damage)
        ? Math.max(0, Math.min(100, data.damage)) : 5;
      player.health = Math.max(0, player.health - damage);
      io.to(socket.id).emit('took_damage', { health: player.health, damage });
      if (player.health <= 0) {
        player.health = 100; // respawn full health
        io.to(socket.id).emit('you_died', {});
      }
    } catch(e) {
      console.error('environmental_damage error:', e.message);
    }
  });

  // Ship combat damage against the cargo ship — same idea as player_hit but the target
  // isn't a player, so it's a separate event with its own (simpler) state.
  socket.on('hit_cargo_ship', (data) => {
    try {
      if (!_cargoShip || !data || data.id !== _cargoShip.id) return;
      const damage = typeof data.damage === 'number' && isFinite(data.damage)
        ? Math.max(0, Math.min(100, data.damage)) : 10;
      _cargoShip.hp = Math.max(0, _cargoShip.hp - damage);
      io.emit('cargo_ship_damaged', { id: _cargoShip.id, hp: _cargoShip.hp });
      if (_cargoShip.hp <= 0) {
        _floatingCrate = { position: _cargoShip.position };
        io.emit('cargo_ship_destroyed', { id: _cargoShip.id, position: _cargoShip.position, killerId: socket.id });
        io.emit('chat', { name: '📦 SERVER', text: `The supply ship was shot down! Its crate is floating at the wreck site.` });
        _cargoShip = null;
        _nextCargoShipAt = Date.now() + CARGO_SHIP_SPAWN_MIN_MS + Math.random() * (CARGO_SHIP_SPAWN_MAX_MS - CARGO_SHIP_SPAWN_MIN_MS);
      }
    } catch(e) {
      console.error('hit_cargo_ship error:', e.message);
    }
  });

  // Collecting the floating crate — trusts the position the client says it's at (same
  // trust level as every other position in this game, there's no server-side movement
  // simulation to check against), but still requires actually being within range of the
  // real server-tracked crate position, so you can't collect one from across the map.
  socket.on('collect_crate', (data) => {
    try {
      if (!_floatingCrate || !data || !isValidVec(data.position)) return;
      const dx = data.position.x - _floatingCrate.position.x;
      const dy = data.position.y - _floatingCrate.position.y;
      const dz = data.position.z - _floatingCrate.position.z;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) > CRATE_COLLECT_RADIUS) return;
      const player = players[socket.id];
      if (!player) return;
      player.credits += CREDIT_REWARD.crate;
      io.to(socket.id).emit('credits_update', { credits: player.credits, reward: CREDIT_REWARD.crate, reason: 'crate' });
      io.emit('crate_collected', { by: player.name });
      io.emit('chat', { name: '📦 SERVER', text: `${player.name} collected the crate!` });
      _floatingCrate = null;
    } catch(e) {
      console.error('collect_crate error:', e.message);
    }
  });

  // Bounty completion is tracked and decided client-side (session-only progress, same
  // trust level as the shop below) — this just mirrors the reward into the server-held
  // balance, capped well above any real bounty reward so a tampered client can't just
  // claim arbitrary amounts.
  socket.on('claim_bounty', (data) => {
    try {
      const player = players[socket.id];
      if (!player || typeof data.amount !== 'number' || !isFinite(data.amount) || data.amount <= 0) return;
      player.credits += Math.min(500, data.amount);
    } catch(e) {
      console.error('claim_bounty error:', e.message);
    }
  });

  // Shop purchases are decided client-side (no server-side item catalog to validate
  // against yet), but the spend still has to be mirrored into the server-held balance —
  // otherwise the next kill/crate reward would add onto a stale pre-purchase number and
  // the player's credits would silently jump back up.
  socket.on('spend_credits', (data) => {
    try {
      const player = players[socket.id];
      if (!player || typeof data.amount !== 'number' || !isFinite(data.amount) || data.amount < 0) return;
      player.credits = Math.max(0, player.credits - data.amount);
    } catch(e) {
      console.error('spend_credits error:', e.message);
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

// Cargo ship spawn timer — checked every 5s, only spawns a new one if there isn't one
// already alive and no uncollected crate is currently floating from the last one.
setInterval(() => {
  if (_cargoShip || _floatingCrate) return;
  if (Date.now() >= _nextCargoShipAt) spawnCargoShip();
}, 5000);

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
