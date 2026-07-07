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

// ── Event crate ───────────────────────────────────────────────────────────────
// A valuable crate periodically lands on a random planet — server-owned state (not tied
// to any one player's connection) so every client agrees on where it is and who has it.
// Flow: lands on a planet's surface (status 'planet') → someone walks up and picks it up
// (status 'carried') → they have to physically get it back to the safe zone to actually
// bank the reward → if they die anywhere while carrying it (especially getting shot down
// while flying it out), it drops right there (status 'floating') for anyone else to grab.
//
// PLANET_COUNT must match the length of the client's `planets` array (2 hand-placed +
// however many are in the procedural defs list) — the server only ever deals in an index
// into that array, never planet data itself, since planet definitions live entirely
// client-side. If planets are ever added/removed there, update this to match.
const EVENT_CRATE_PLANET_COUNT = 38;
const EVENT_CRATE_SPAWN_MIN_MS = 3 * 60 * 1000;
const EVENT_CRATE_SPAWN_MAX_MS = 6 * 60 * 1000;
const CRATE_COLLECT_RADIUS = 80;
let _eventCrate = null; // { status: 'planet'|'carried'|'floating', ...fields for that status }
let _nextEventCrateAt = Date.now() + 20000; // first one appears reasonably soon after boot

function spawnEventCrate() {
  const planetIndex = Math.floor(Math.random() * EVENT_CRATE_PLANET_COUNT);
  // Angular placement on the planet's surface — client resolves this to an actual world
  // position using its own copy of that planet's real position/radius (same approach
  // already used for the decorative crates every planet has).
  const ang = Math.random() * Math.PI * 2;
  const elev = 0.3 + Math.random() * 0.5;
  _eventCrate = { status: 'planet', planetIndex, ang, elev };
  io.emit('event_crate_spawned', _eventCrate);
}

function _dropEventCrate(holderId, position) {
  if (!_eventCrate || _eventCrate.status !== 'carried' || _eventCrate.holderId !== holderId) return;
  _eventCrate = { status: 'floating', position };
  io.emit('event_crate_dropped', { position });
  io.emit('chat', { name: '📦 SERVER', text: `The crate was dropped! It's floating in space, up for grabs.` });
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
    eventCrate: _eventCrate,
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

      // Auto-deliver: getting the crate back into the safe zone (under your own power,
      // however you manage it) banks the reward automatically — no separate "turn in"
      // action needed, matching "escape with the loot" as literally as possible.
      if (_eventCrate && _eventCrate.status === 'carried' && _eventCrate.holderId === socket.id && player.inSafeZone) {
        player.credits += CREDIT_REWARD.crate;
        io.to(socket.id).emit('credits_update', { credits: player.credits, reward: CREDIT_REWARD.crate, reason: 'crate' });
        io.emit('event_crate_delivered', { by: player.name });
        io.emit('chat', { name: '📦 SERVER', text: `${player.name} delivered the crate to safety!` });
        _eventCrate = null;
        _nextEventCrateAt = Date.now() + EVENT_CRATE_SPAWN_MIN_MS + Math.random() * (EVENT_CRATE_SPAWN_MAX_MS - EVENT_CRATE_SPAWN_MIN_MS);
      }
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
        // Dying while carrying the event crate drops it right where you died — most
        // dramatically, getting shot down while flying it back leaves it floating in
        // space at the wreck, exactly like the cargo ship used to work.
        _dropEventCrate(data.targetId, target.position);
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
        _dropEventCrate(socket.id, player.position);
      }
    } catch(e) {
      console.error('environmental_damage error:', e.message);
    }
  });

  // Picking up the crate — either off a planet's surface (status 'planet', where the
  // server only knows angular coordinates, not a real world position, so that case is
  // trusted outright — same trust level this game already gives fpPos in general) or out
  // of open space (status 'floating', where the server DOES have a real tracked position
  // and can sanity-check the client is actually within range of it).
  socket.on('collect_crate', (data) => {
    try {
      if (!_eventCrate || _eventCrate.status === 'carried' || !data) return;
      if (_eventCrate.status === 'floating') {
        if (!isValidVec(data.position)) return;
        const dx = data.position.x - _eventCrate.position.x;
        const dy = data.position.y - _eventCrate.position.y;
        const dz = data.position.z - _eventCrate.position.z;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) > CRATE_COLLECT_RADIUS) return;
      }
      const player = players[socket.id];
      if (!player) return;
      _eventCrate = { status: 'carried', holderId: socket.id, holderName: player.name };
      io.emit('event_crate_picked_up', { holderId: socket.id, holderName: player.name });
      io.emit('chat', { name: '📦 SERVER', text: `${player.name} picked up the crate! Get it back to the safe zone to bank it.` });
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
    // Don't let the crate vanish into a disconnected player's pocket forever — drop it
    // right where they were, same as if they'd died carrying it.
    if (players[socket.id]) _dropEventCrate(socket.id, players[socket.id].position);
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

// Event crate spawn timer — checked every 5s, only spawns a new one once the last one is
// fully resolved (delivered — _eventCrate goes back to null only on delivery).
setInterval(() => {
  if (_eventCrate) return;
  if (Date.now() >= _nextEventCrateAt) spawnEventCrate();
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
