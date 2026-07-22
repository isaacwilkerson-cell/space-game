// ── Game.js ─────────────────────────────────────────────────────────────────
console.log('%c GAME.JS v209 LOADED', 'color:lime;font-size:18px;font-weight:bold');
document.title = 'Space Game v209';

// Socket is optional — game runs offline if server isn't up
let socket = null;
try {
  const _serverURL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? '' : 'https://space-game-production-1d20.up.railway.app';
  // Just a plain display name, no account/password — whatever was last typed on the title
  // screen (or a blank string, meaning "let the server make up a Pilot-XXXX name").
  const _savedUsername = localStorage.getItem('sn_username') || '';
  socket = io(_serverURL, { timeout: 3000, reconnectionAttempts: 3, auth: { username: _savedUsername } });
  socket.on('connect_error', () => { socket = null; });
} catch(e) { socket = null; }

// ── Asset config — drop files in client/assets/ and set names here ───────────
const ASSETS = {
  skybox:      'assets/deep_space_skybox.glb',
  playerShip:  'assets/ships/cargo_ship.glb',
  enemyShip:   'assets/ships/cargo_ship.glb',
  planets: [
    'assets/planets/planet_of_phoenix.glb',
    'assets/planets/planet_of_phoenix.glb',
    'assets/planets/planet_of_phoenix.glb',
    'assets/planets/planet_of_phoenix.glb',
    'assets/planets/planet_of_phoenix.glb',
  ],
  station: 'assets/space_station.glb',
};

// Selectable player ships — picked in the hangar's SHIP tab. All of them go through the
// exact same loadModel() auto-scale/flight/collision pipeline, so any entry here behaves
// identically to the others; only the visual model differs. Persisted so the choice
// survives a reload — index.html's own ship preload script reads the same localStorage
// key before game.js even starts loading. Falcon (the original spaceship) is the default.
const SHIP_DEFS = {
  spaceship: { name: 'Falcon',     asset: 'assets/ships/spaceship.glb' },
  // The flight camera is a fixed rig behind the ship looking down local -Z (see the
  // "Camera follows behind ship" setup near selfMesh) — every model is expected to have
  // its nose-to-tail length run along that axis, nose pointing -Z (away from the camera,
  // into the screen). cargo_ship.glb's actual geometry (checked via its bounding box with
  // the baked-in star decoration stripped out) is over 2x longer on X than on Z, i.e. it's
  // built lying on its side relative to that convention — a 90° yaw corrects the axis, and
  // the sign (-90° rather than +90°) points the nose away from the camera instead of at it.
  // sizeMul scales it up relative to the other ships' normal target size.
  cargo:     { name: 'Cargo Ship', asset: 'assets/ships/cargo_ship.glb', yawOffset: -Math.PI / 2, sizeMul: 2 },
  // X being the longest raw-bbox dimension turned out to be a wide wingspan, not a
  // sideways-built model like cargo_ship — -90°/+90° pointed it left/right, and 0° (its
  // native orientation) had it facing straight at the camera instead of away from it, so a
  // plain 180° flip was the actual fix. sizeMul bumped up — it read noticeably small next
  // to the others.
  // interiorNode: unlike the Falcon (a separate falcon_cockpit.glb asset), the Star Wing
  // model already has its own cockpit interior baked in as a "Cockpit" node group among its
  // top-level parts (alongside MainHull, wings, landing gear, etc.) — walkableInterior
  // walks around inside just that node's own geometry (small — it's a one-seat cockpit
  // bubble, so "walking around" is necessarily cramped) instead of swapping in another
  // model or hiding siblings for a static view. interiorSpawn was picked from that node's
  // own measured bounding-box center (in the ship's final post-normalize local space),
  // nudged up a bit for eye height — may need further tuning once actually seen in place.
  starwing:  { name: 'Star Wing',  asset: 'assets/ships/star_wing.glb', yawOffset: Math.PI, sizeMul: 1.7, walkableInterior: true, interiorNode: 'Cockpit', interiorSpawn: new THREE.Vector3(0, -0.3, -2.6) },
  // Z is already the longest raw-bbox dimension (unlike cargo_ship/star_wing), matching the
  // -Z forward convention by default — no yaw correction applied yet. Report back if it
  // turns out sideways or backwards once actually flown, same as the other two needed.
  // No interiorNode — unlike Star Wing's separate cockpit bubble, this model doesn't split
  // exterior/interior into different top-level parts, so the whole thing serves as the
  // walkable room (matches the real Lethal Company ship it's from, which is a single
  // walk-in interior).
  shuttle:   { name: 'Shuttle',    asset: 'assets/ships/shuttle.glb', walkableInterior: true, interiorSpawn: new THREE.Vector3(0, 0, 0) },
};
const SHIP_STORAGE_KEY = 'sn_selected_ship';
let _selectedShipId = (localStorage.getItem(SHIP_STORAGE_KEY) in SHIP_DEFS) ? localStorage.getItem(SHIP_STORAGE_KEY) : 'spaceship';
function _selectedShipAsset() { return SHIP_DEFS[_selectedShipId].asset; }
function _selectedShipYawOffset() { return SHIP_DEFS[_selectedShipId].yawOffset || 0; }
function _selectedShipSizeMul() { return SHIP_DEFS[_selectedShipId].sizeMul || 1; }
// The star decoration (stripped below) turned out to span a much bigger volume than the
// actual ship body — loadModel() had already scaled+centered the model around that bigger
// combined bounding box before this ever runs, so simply removing the stars left the real
// ship geometry sitting off-center (this is the "ship appears at the bottom-left" bug).
// Reset the transform and redo the scale/center step from scratch using only what's left.
function _normalizeShipModel(model, targetSize, yawOffset) {
  _stripShipStars(model);
  model.position.set(0, 0, 0);
  model.scale.set(1, 1, 1);
  // Rotate BEFORE measuring/centering — position centers the model's local origin (its
  // pivot, not necessarily the geometry's centroid) around wherever the bounding box
  // happens to be. Rotating after that offset was already set would swing the geometry's
  // actual centroid away from world origin as the pivot spins around it (this was the
  // ship-appears-off-to-one-side bug), so the box has to reflect the final orientation
  // before we compute where to put it.
  model.rotation.set(0, yawOffset || 0, 0);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 0) {
    const s = targetSize / maxDim;
    model.scale.setScalar(s);
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x * s, -center.y * s, -center.z * s);
  }
  return model;
}
// cargo_ship.glb has a baked-in starfield/particle decoration (node "Particle_169", sized to
// span the whole model) meant for its own standalone viewer scene — strip it here so it
// doesn't ride along as part of the actual playable ship model. No-op for ships that don't
// have that node (e.g. the original spaceship).
function _stripShipStars(model) {
  const toRemove = [];
  model.traverse(c => { if (c.name === 'Particle_169') toRemove.push(c); });
  toRemove.forEach(c => { if (c.parent) c.parent.remove(c); });
  return model;
}


// ── Global asset load tracking (drives the loading-screen progress bar) ────────
// pending = number of loadModel() calls currently in flight, right now — not a running
// total, so it correctly reflects "how much is left" no matter when each load started.
const _loadStats = { pending: 0 };

// Large assets (some weapons are 40-60MB, the shooting range is ~42MB) can hit a transient
// network blip or timeout on any single attempt — this used to give up immediately and
// permanently, silently leaving that weapon un-firable or the range's collision empty for
// the rest of the session with no way to recover short of a page reload. Retry a few times
// with a short backoff before actually giving up.
const LOAD_MODEL_MAX_RETRIES = 3;
function loadModel(path, targetSize, onLoaded, onProgress, _attempt) {
  _attempt = _attempt || 0;
  if (_attempt === 0) _loadStats.pending++;
  const _done = () => { _loadStats.pending = Math.max(0, _loadStats.pending - 1); };
  const _retryOrGiveUp = () => {
    if (_attempt < LOAD_MODEL_MAX_RETRIES) {
      console.warn(`[loadModel] retrying ${path} (attempt ${_attempt + 2}/${LOAD_MODEL_MAX_RETRIES + 1})`);
      setTimeout(() => loadModel(path, targetSize, onLoaded, onProgress, _attempt + 1), 800 * (_attempt + 1));
    } else {
      console.warn(`[loadModel] giving up on ${path} after ${LOAD_MODEL_MAX_RETRIES + 1} attempts`);
      _done();
      onLoaded(null);
    }
  };
  fetch(path)
    .then(r => {
      if (!r.ok) { _retryOrGiveUp(); return null; }
      if (!onProgress || !r.body) return r.blob();
      // Manually read the stream so we can report bytes-downloaded progress for large
      // assets instead of just an indeterminate wait.
      const total = Number(r.headers.get('Content-Length')) || 0;
      const reader = r.body.getReader();
      const chunks = [];
      let received = 0;
      return (function pump() {
        return reader.read().then(({ done, value }) => {
          if (done) return new Blob(chunks);
          chunks.push(value);
          received += value.length;
          onProgress(received, total);
          return pump();
        });
      })();
    })
    .then(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      new THREE.GLTFLoader().load(url, gltf => {
        URL.revokeObjectURL(url);
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim > 0) {
          const s = targetSize / maxDim;
          model.scale.setScalar(s);
          const center = box.getCenter(new THREE.Vector3());
          model.position.set(-center.x * s, -center.y * s, -center.z * s);
        }
        _done();
        onLoaded(model);
      }, undefined, () => { URL.revokeObjectURL(url); _retryOrGiveUp(); });
    })
    .catch(() => { _retryOrGiveUp(); });
}

// ── Loading screen (progress bar fills as pending assets finish loading) ───────
const _loadingScreenEl = document.createElement('div');
_loadingScreenEl.style.cssText = `
  position:fixed; inset:0; z-index:500; display:none;
  background:#000; flex-direction:column; align-items:center; justify-content:center;
  font-family:'Courier New',monospace; color:#0ff;
`;
_loadingScreenEl.innerHTML = `
  <div id="loading-label" style="font-size:15px;letter-spacing:4px;margin-bottom:18px;text-shadow:0 0 10px #0af;">LOADING</div>
  <div style="width:340px;height:10px;border:1px solid #0af;border-radius:5px;overflow:hidden;background:rgba(0,255,255,0.08);">
    <div id="loading-bar-fill" style="width:0%;height:100%;background:#0ff;box-shadow:0 0 10px #0ff;transition:width 0.15s;"></div>
  </div>
`;
document.body.appendChild(_loadingScreenEl);
const _loadingLabelEl = _loadingScreenEl.querySelector('#loading-label');
const _loadingBarEl   = _loadingScreenEl.querySelector('#loading-bar-fill');

let _loadingScreenActive = false;
let _loadingScreenDoneCheck = null;
function _showLoadingScreen(label, isDoneFn, opts) {
  _loadingScreenActive = true;
  _loadingScreenDoneCheck = isDoneFn;
  _loadingLabelEl.textContent = label;
  _loadingBarEl.style.width = '0%';
  _loadingScreenEl.style.display = 'flex';
  // Snapshot how many loads are in flight right now — the bar tracks THOSE finishing,
  // regardless of when they originally started (fixes the bar jumping straight to 100%
  // for assets that began loading long before this screen was shown).
  const startPending = _loadStats.pending;
  const timeoutMs = (opts && opts.timeoutMs) || 8000;
  const minShowMs = (opts && opts.minShowMs != null) ? opts.minShowMs : 300; // never just flash
  const startTime = Date.now();
  (function poll() {
    if (!_loadingScreenActive) return;
    const finishedSinceShown = Math.max(startPending - _loadStats.pending, 0);
    const pct = startPending > 0
      ? Math.min(99, Math.round((finishedSinceShown / startPending) * 100))
      : 99;
    _loadingBarEl.style.width = pct + '%';
    const elapsed = Date.now() - startTime;
    const timedOut = elapsed > timeoutMs;
    const contentReady = _loadingScreenDoneCheck && _loadingScreenDoneCheck();
    if ((elapsed >= minShowMs) && (timedOut || contentReady)) {
      _loadingBarEl.style.width = '100%';
      setTimeout(() => { _loadingScreenActive = false; _loadingScreenEl.style.display = 'none'; }, 150);
      return;
    }
    requestAnimationFrame(poll);
  })();
}

// ── Scene setup ──────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
// Cap pixel ratio — on high-DPI displays devicePixelRatio can be 2-3x, which quadruples
// fragment shading cost for little visible gain, especially on heavier planet terrain.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.domElement.setAttribute('tabindex', '0');
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.getElementById('canvas-container').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x000010, 0.0);

// Skybox — loaded once, follows camera every frame
// Skybox via scene.background — no mesh, no edge artifacts, no draw-call conflicts
let skyboxMesh = null; // kept as flag for show/hide logic
let _skyboxTex  = null;
loadModel('assets/deep_space_skybox.glb', 18000, model => {
  if (!model) return;
  let tex = null;
  model.traverse(c => {
    if (tex) return;
    if (c.isMesh && c.material) {
      const m = Array.isArray(c.material) ? c.material[0] : c.material;
      if (m.map) tex = m.map;
    }
  });
  if (!tex) return;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  _skyboxTex  = tex;
  skyboxMesh  = {}; // truthy sentinel so existing show/hide checks still work
  scene.background = tex;
});

// Stars — actual 3D objects at fixed world positions you can fly to and past
(function createStars() {
  // Glow texture shared by all stars
  const gc = document.createElement('canvas'); gc.width = gc.height = 64;
  const gx = gc.getContext('2d');
  const gg = gx.createRadialGradient(32,32,0, 32,32,32);
  gg.addColorStop(0,   'rgba(255,255,255,1)');
  gg.addColorStop(0.15,'rgba(255,255,255,0.9)');
  gg.addColorStop(0.5, 'rgba(255,255,255,0.3)');
  gg.addColorStop(1,   'rgba(255,255,255,0)');
  gx.fillStyle = gg; gx.fillRect(0,0,64,64);
  const glowTex = new THREE.CanvasTexture(gc);

  const COLORS  = [0xaaddff, 0xffffff, 0xfffde0, 0xffcc88, 0xff9966];
  const COUNT   = 3000;
  const SPAWN_R = 5000;
  const CULL_R2 = SPAWN_R * SPAWN_R * 1.3;

  // Spawn a star ahead of the player rather than randomly behind
  const _fwd = new THREE.Vector3();
  const _rgt = new THREE.Vector3();
  const _up2 = new THREE.Vector3(0,1,0);
  function spawnAhead(px, py, pz, camQ, out) {
    _fwd.set(0,0,-1).applyQuaternion(camQ);
    _rgt.crossVectors(_fwd, _up2).normalize();
    // Random angle in front hemisphere (±90°), bias toward fwd
    const yaw   = (Math.random() - 0.5) * Math.PI;       // ±90° sideways
    const pitch = (Math.random() - 0.5) * Math.PI * 0.4; // ±36° up/down
    const dist  = SPAWN_R * (0.5 + Math.random() * 0.5); // 50–100% of range
    out.set(px, py, pz)
      .addScaledVector(_fwd, Math.cos(yaw) * Math.cos(pitch) * dist)
      .addScaledVector(_rgt, Math.sin(yaw) * dist * 0.6)
      .addScaledVector(_up2, Math.sin(pitch) * dist * 0.3);
  }

  const stars = [];
  for (let i = 0; i < COUNT; i++) {
    const col = COLORS[Math.floor(Math.random() * COLORS.length)];
    const mat = new THREE.SpriteMaterial({
      map: glowTex, color: col,
      blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false,
    });
    const s = new THREE.Sprite(mat);
    s.scale.setScalar(3 + Math.random() * 18); // much smaller
    // Initial spread around origin in all directions
    const th = Math.random()*Math.PI*2, ph = Math.acos(2*Math.random()-1);
    const r  = SPAWN_R * Math.cbrt(Math.random()); // cube root for uniform sphere
    s.position.set(r*Math.sin(ph)*Math.cos(th), r*Math.sin(ph)*Math.sin(th)*0.4, r*Math.cos(ph));
    s.frustumCulled = false;
    scene.add(s);
    stars.push(s);
  }

  window._updateStars = function(px, py, pz, camQ) {
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const dx = s.position.x-px, dy = s.position.y-py, dz = s.position.z-pz;
      if (dx*dx + dy*dy + dz*dz > CULL_R2) spawnAhead(px, py, pz, camQ, s.position);
    }
  };

  window._stars    = { _sprites: stars };
  window._starsDim = null;
  window._setStarsVisible = v => stars.forEach(s => { s.visible = v; });
  window._setStarsVisible(true);
})();

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 150000);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Lighting ──────────────────────────────────────────────────────────────────
const _sceneAmbient = new THREE.AmbientLight(0x334466, 2.5);
scene.add(_sceneAmbient);
const _dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
_dirLight.position.set(1, 1, -1).normalize();
scene.add(_dirLight);



// ── Ship geometry factory ─────────────────────────────────────────────────────
function createShipMesh(color = 0x00ccff) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.ConeGeometry(4, 16, 6),
    new THREE.MeshPhongMaterial({ color, shininess: 80 })
  );
  body.rotation.x = Math.PI / 2;
  group.add(body);

  const wings = new THREE.Mesh(
    new THREE.BoxGeometry(18, 1, 6),
    new THREE.MeshPhongMaterial({ color: 0x005577, shininess: 60 })
  );
  wings.position.z = 3;
  group.add(wings);

  // Point light behind ship — illuminates hull and surroundings when engine fires
  const engineLight = new THREE.PointLight(0xff5500, 0, 600);
  engineLight.position.z = 15;
  group.add(engineLight);
  group.userData.engineLight = engineLight;
  group.userData.glowMesh = null;

  return group;
}

// ── Space Station ─────────────────────────────────────────────────────────────
function createStation() {
  const group = new THREE.Group();
  const mat = new THREE.MeshPhongMaterial({ color: 0x888899, shininess: 100 });

  group.add(new THREE.Mesh(new THREE.CylinderGeometry(20, 20, 40, 16), mat));

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(50, 6, 8, 32),
    new THREE.MeshPhongMaterial({ color: 0x445566 })
  );
  ring.rotation.x = Math.PI / 2;
  group.add(ring);

  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 50), mat);
    const angle = (i / 4) * Math.PI * 2;
    arm.position.set(Math.sin(angle) * 25, 0, Math.cos(angle) * 25);
    arm.rotation.y = angle;
    group.add(arm);
  }

  // Lights to illuminate the station from multiple angles
  const lightDefs = [
    [0x4488ff, 4, 2000, [0, 200, 0]],
    [0xffffff, 3, 1500, [400, 100, 0]],
    [0xffffff, 3, 1500, [-400, 100, 0]],
    [0xffa040, 2, 1200, [0, -200, 400]],
  ];
  lightDefs.forEach(([color, intensity, dist, pos]) => {
    const l = new THREE.PointLight(color, intensity, dist);
    l.position.set(...pos);
    group.add(l);
  });
  scene.add(group);
  return group;
}
const station = createStation();
let stationOpacity = 1;
loadModel(ASSETS.station, 1200, model => {
  if (!model) return;
  station.children.slice().forEach(c => { if (!c.isLight) station.remove(c); });
  // Make all meshes transparent so we can fade them
  model.traverse(c => {
    if (c.isMesh) { c.material = c.material.clone(); c.material.transparent = true; }
  });
  station.add(model);
});

// ── Station Interior / Docking ────────────────────────────────────────────────
let gameMode = 'docked';
let fpYaw = 0, fpPitch = 0;
let _fpMouseDX = 0, _fpMouseDY = 0; // accumulated raw delta this frame
const fpPos = new THREE.Vector3(0, 2, 0);
const fpVel = new THREE.Vector3();
const FP_SPEED = 1.3, FP_ACCEL = 0.14, FP_FRICTION = 0.8;
const FP_SPRINT_MUL = 1.4;
const FP_JUMP_V  = 0.255;
const FP_GRAVITY = 0.018;
let _fpJumpVel = 0;       // vertical velocity for lobby jump
let _fpBaseY   = 0;       // floor height (set per-mode)
let _crouchAmount = 0;    // 0 = standing, 1 = fully crouched (eased)
const CROUCH_HEIGHT = 5;
const CROUCH_SPEED_MUL = 0.55;
// Slide: crouching while sprinting launches a burst of speed that decays back to crouch speed
let _slideTimer = 0;
let _prevCrouchKey = false;
const SLIDE_DURATION = 55;
const SLIDE_SPEED_MUL = 1.15; // relative to sprint speed at the start of the slide
const SLIDE_COOLDOWN = 45; // frames after a slide ends before another can be triggered — stops spam-sliding
let _slideCooldownTimer = 0;
let _slideJustTriggered = false;
let fpBobT = 0;
const _footstepAudio = new Audio('assets/sounds/footsteps.mp3');
_footstepAudio.loop = true;
_footstepAudio.volume = 0.28;
const _fpFwd = new THREE.Vector3(), _fpRight = new THREE.Vector3();
const _fpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _fpQuat  = new THREE.Quaternion();

const _viewmodelScene = new THREE.Scene();
const interiorScene = new THREE.Group();
scene.add(interiorScene);
interiorScene.visible = false;
const _iAmbient = new THREE.AmbientLight(0x334466, 2.5);
interiorScene.add(_iAmbient);
const _iDirLight = new THREE.DirectionalLight(0xffffff, 1.2);
_iDirLight.position.set(1, 1, -1).normalize();
interiorScene.add(_iDirLight);
const _iLight = new THREE.PointLight(0x6688aa, 2.0, 400);
_iLight.position.set(0, 40, 0);
interiorScene.add(_iLight);
const _iOverhead = new THREE.PointLight(0xffffff, 3.0, 300);
_iOverhead.position.set(0, 80, 0);
interiorScene.add(_iOverhead);

// Collision meshes collected after room loads
let _roomCollidables = [];
let _roomBBox = null;

// Trading station interior — collidables/bounds/floor filled in once the club house model
// loads, mirroring how the room's own _roomCollidables/_roomBBox work.
let _tradeStationCollidables = [];
let _tradeStationBBox = null;
let _tradeStationFloorY = 0;
let _tradeStationSpawn = new THREE.Vector3(0, 2, 40);
let _tradeStationShopPos = new THREE.Vector3(0, 2, 0);

// ── Lobby scene ───────────────────────────────────────────────────────────────
const lobbyScene = new THREE.Group();
scene.add(lobbyScene);
lobbyScene.visible = false;
const _lobbyAmbient = new THREE.AmbientLight(0xffffff, 0);
lobbyScene.add(_lobbyAmbient);
const _lobbyLight = new THREE.PointLight(0xffeedd, 0, 600);
_lobbyLight.position.set(0, 60, 0);
lobbyScene.add(_lobbyLight);

let _lobbyCollidables = [];
let _lobbyBBox = null;
let _lobbyExitPos = new THREE.Vector3(0, 0, 0); // updated after GLB loads

// Dynamic floor height at a given XZ — each scene's real floor geometry sits at a
// different height than the fpPos movement convention assumes, and isn't flat everywhere,
// so avatars positioned directly off fpPos.y could float or sink depending on where they
// stood. Raycast straight down against that scene's own collidables to find the real
// surface instead. Shared across every FP-avatar scene (lobby, room, range, TDM), not
// just the lobby — same bug, same fix, everywhere an avatar can stand.
const _groundRaycaster = new THREE.Raycaster();
function _groundHeightAt(collidables, x, z, fallbackY) {
  if (!collidables || collidables.length === 0) return fallbackY;
  // Cast from just above head height, not from way up near the ceiling — a high-up cast
  // can hit a roof/light fixture/overhang first and mistake it for the floor.
  _groundRaycaster.set(new THREE.Vector3(x, fallbackY + 8, z), new THREE.Vector3(0, -1, 0));
  const hits = _groundRaycaster.intersectObjects(collidables, false);
  return hits.length > 0 ? hits[0].point.y : fallbackY;
}
// Which collidables array backs "the ground" for a given FP mode — used to pick which
// scene's geometry an avatar's feet should be raycast against.
// TDM is deliberately excluded — its fpPos.y already bakes in a large eye-height offset
// (_TDM_EYE_OFFSET) rather than being a raw floor value, and has its own dedicated ground
// system (_tdmGroundHeightAt) already. Mixing conventions here would misplace it, not fix it.
function _avatarGroundCollidables(mode) {
  return mode === 'lobby' ? _lobbyCollidables
       : mode === 'docked' ? _roomCollidables
       : mode === 'range' ? _rangeCollidables
       : null;
}

loadModel('assets/free_fire_ob39_lobby_3d_model.glb', 400, model => {
  if (!model) { console.warn('Lobby GLB failed'); return; }
  model.traverse(c => {
    if (c.isMesh) {
      _lobbyCollidables.push(c);
      if (c.material) {
        if (Array.isArray(c.material)) {
          c.material.forEach(m => { m.side = THREE.FrontSide; });
        } else {
          c.material.side = THREE.FrontSide;
        }
      }
    }
  });
  lobbyScene.add(model);
  _lobbyBBox = new THREE.Box3().setFromObject(model);
  // Exit point = center of one wall edge (player will see a prompt here)
  _lobbyExitPos.set(
    (_lobbyBBox.min.x + _lobbyBBox.max.x) * 0.5,
    2,
    _lobbyBBox.max.z - 10
  );
  console.log('[lobby] loaded, bbox:', _lobbyBBox, 'exit:', _lobbyExitPos);
});

// Beta-testing thank-you screen — a flat quad mounted across four measured world-space
// corners (the wall it's mounted on isn't perfectly axis-aligned, so each corner gets its
// own position rather than assuming a flat rectangle).
(function _addBetaThankYouScreen() {
  // Measured directly off the room's own black monitor prop ("Object_10" in the lobby
  // GLB — a flat, near-black panel at x:[0.94, 50.94] y:[0.41, 22.54] z:-67.366), so the
  // thank-you text sits exactly over that existing screen instead of floating near it.
  const _left = 0.94, _right = 50.94, _bottom = 0.41, _top = 22.54, _z = -67.366;
  const corners = {
    topLeft:     new THREE.Vector3(_left, _top, _z),
    bottomLeft:  new THREE.Vector3(_left, _bottom, _z),
    topRight:    new THREE.Vector3(_right, _top, _z),
    bottomRight: new THREE.Vector3(_right, _bottom, _z),
  };
  // The measured corners sit almost exactly on the room's own wall surface, which
  // z-fights with the wall mesh underneath — nudge the whole plane out along its own
  // face normal so it renders cleanly in front instead of flickering/losing to the wall.
  const _edge1 = corners.bottomLeft.clone().sub(corners.topLeft);
  const _edge2 = corners.topRight.clone().sub(corners.topLeft);
  const _faceNormal = new THREE.Vector3().crossVectors(_edge1, _edge2).normalize();
  Object.values(corners).forEach(c => c.addScaledVector(_faceNormal, 0.3));
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#04121c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#00ffff';
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  ctx.font = 'bold 64px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#00ffff';
  ctx.fillText('THANK YOU FOR BEING', canvas.width / 2, canvas.height / 2 - 40);
  ctx.fillText('A PART OF BETA TESTING', canvas.width / 2, canvas.height / 2 + 40);

  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array([
    corners.topLeft.x, corners.topLeft.y, corners.topLeft.z,
    corners.bottomLeft.x, corners.bottomLeft.y, corners.bottomLeft.z,
    corners.topRight.x, corners.topRight.y, corners.topRight.z,
    corners.bottomRight.x, corners.bottomRight.y, corners.bottomRight.z,
  ]);
  const uvs = new Float32Array([0, 1,  0, 0,  1, 1,  1, 0]);
  const indices = [0, 1, 2,  1, 3, 2];
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const tex = new THREE.CanvasTexture(canvas);
  // transparent + depthTest:false + a high renderOrder forces this into the very end of the
  // transparent render queue, so it draws on top of the room's own glass/window panes
  // instead of getting tinted/hidden underneath them (this exact spot sits right behind one).
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, depthTest: false, transparent: true });
  const screen = new THREE.Mesh(geo, mat);
  screen.renderOrder = 999;
  screen.userData.isBetaScreen = true;
  lobbyScene.add(screen);
})();

// Player's private room: a "WELCOME <username>" screen, mounted the same way as the
// lobby's thank-you screen (flat quad across two measured diagonal corners, nudged
// forward along its own face normal, drawn with depthTest off + a high renderOrder so it
// doesn't z-fight with the room's own wall/window geometry behind it). Unlike the lobby
// screen, the text has to be re-drawn whenever the player's username changes, so the
// canvas/texture/context are kept around in _roomWelcomeScreen instead of being local to
// a one-shot IIFE.
let _roomWelcomeScreen = null;
function _addRoomWelcomeScreen() {
  if (_roomWelcomeScreen) return; // room model can't reload while the tab is open, but guard anyway
  // Measured directly off the room's own black monitor prop ("TV_Screen_0" in the
  // interior GLB — a thin flat panel facing +x at x≈-81.33, y:[-13.22, 26.42],
  // z:[-125.86, -72.99]), so the text sits exactly on that existing TV instead of
  // floating nearby at guessed coordinates. The room is entered facing roughly -x, so
  // "left" (the viewer's left) is the higher-z side of the panel.
  const _x = -81.33, _top = 26.42, _bottom = -13.22, _zLeft = -72.99, _zRight = -125.86;
  const corners = {
    topLeft:     new THREE.Vector3(_x, _top, _zLeft),
    bottomLeft:  new THREE.Vector3(_x, _bottom, _zLeft),
    topRight:    new THREE.Vector3(_x, _top, _zRight),
    bottomRight: new THREE.Vector3(_x, _bottom, _zRight),
  };
  const _edge1 = corners.bottomLeft.clone().sub(corners.topLeft);
  const _edge2 = corners.topRight.clone().sub(corners.topLeft);
  const _faceNormal = new THREE.Vector3().crossVectors(_edge1, _edge2).normalize();
  Object.values(corners).forEach(c => c.addScaledVector(_faceNormal, 0.3));

  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 512;
  const ctx = canvas.getContext('2d');

  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array([
    corners.topLeft.x, corners.topLeft.y, corners.topLeft.z,
    corners.bottomLeft.x, corners.bottomLeft.y, corners.bottomLeft.z,
    corners.topRight.x, corners.topRight.y, corners.topRight.z,
    corners.bottomRight.x, corners.bottomRight.y, corners.bottomRight.z,
  ]);
  const uvs = new Float32Array([0, 1,  0, 0,  1, 1,  1, 0]);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex([0, 1, 2,  1, 3, 2]);
  geo.computeVertexNormals();

  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, depthTest: false, transparent: true });
  const screen = new THREE.Mesh(geo, mat);
  screen.renderOrder = 999;
  screen.userData.isRoomWelcomeScreen = true;
  interiorScene.add(screen);

  _roomWelcomeScreen = { canvas, ctx, tex };
  _updateRoomWelcomeScreen(localStorage.getItem('sn_username') || '');
}
function _updateRoomWelcomeScreen(name) {
  if (!_roomWelcomeScreen) return;
  const { canvas, ctx, tex } = _roomWelcomeScreen;
  const displayName = (name || '').trim().slice(0, 20) || 'PILOT';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#04121c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#00ffff';
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#00ffff';
  ctx.font = 'bold 90px monospace';
  ctx.fillText('WELCOME', canvas.width / 2, canvas.height / 2 - 70);
  ctx.font = 'bold 70px monospace';
  ctx.fillText(displayName.toUpperCase(), canvas.width / 2, canvas.height / 2 + 70);
  tex.needsUpdate = true;
}

const _lobbyExitPrompt = document.createElement('div');
_lobbyExitPrompt.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);color:#adf;font-family:monospace;font-size:13px;letter-spacing:2px;pointer-events:none;display:none;';
_lobbyExitPrompt.textContent = '[ E ]  RETURN TO STATION';
document.body.appendChild(_lobbyExitPrompt);

const _hangarPrompt = document.createElement('div');
_hangarPrompt.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);color:#adf;font-family:monospace;font-size:13px;letter-spacing:2px;pointer-events:none;display:none;';
_hangarPrompt.textContent = '[ E ]  GO TO HANGAR';
document.body.appendChild(_hangarPrompt);

function _inHangarZone() {
  return gameMode === 'lobby' &&
    fpPos.x > 160 && fpPos.x < 214 &&
    fpPos.z > -24 && fpPos.z < 24;
}

const _lobbyRoomPrompt = document.createElement('div');
_lobbyRoomPrompt.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);color:#adf;font-family:monospace;font-size:13px;letter-spacing:2px;pointer-events:none;display:none;';
_lobbyRoomPrompt.textContent = '[ E ]  RETURN TO YOUR ROOM';

const _lobbyRangePrompt = document.createElement('div');
_lobbyRangePrompt.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);color:#adf;font-family:monospace;font-size:13px;letter-spacing:2px;pointer-events:none;display:none;';
_lobbyRangePrompt.textContent = '[ E ]  SHOOTING RANGE';
document.body.appendChild(_lobbyRangePrompt);
document.body.appendChild(_lobbyRoomPrompt);

function _inRoomZone() {
  return gameMode === 'lobby' &&
    fpPos.x > 19 && fpPos.x < 59 && fpPos.z > -73 && fpPos.z < -33;
}

function _inRangeZone() {
  return gameMode === 'lobby' &&
    fpPos.x > 20 && fpPos.x < 60 && fpPos.z > 30 && fpPos.z < 70;
}

// ── Team Deathmatch zone ────────────────────────────────────────────────────
const TDM_ZONE = { minX: -147, maxX: -82, minZ: -26, maxZ: 22 };
function _posInTDMZone(x, z) {
  return x > TDM_ZONE.minX && x < TDM_ZONE.maxX && z > TDM_ZONE.minZ && z < TDM_ZONE.maxZ;
}
function _inTDMZone() {
  return gameMode === 'lobby' && _posInTDMZone(fpPos.x, fpPos.z);
}
const _tdmEl = document.createElement('div');
_tdmEl.style.cssText = 'position:fixed;top:30%;left:50%;transform:translateX(-50%);color:#0ff;font-family:monospace;font-size:20px;letter-spacing:3px;text-align:center;text-shadow:0 0 8px #000;pointer-events:none;display:none;z-index:40;';
document.body.appendChild(_tdmEl);
// The countdown itself is decided by the server (see 'tdm_countdown_start'/'tdm_go' socket
// handlers below) — each client used to run its own independent local timer, so one
// player's clock could reach zero a moment before another's and only THEY would actually
// teleport. This function is now purely a display: it renders whatever the server most
// recently said, and shows/hides based on whether the local player is in the zone.
let _tdmServerEndsAt = null; // ms epoch from the server, or null if no countdown running
function _updateTDMZone() {
  const localInZone = _inTDMZone();
  if (!localInZone) {
    _tdmEl.style.display = 'none';
    return;
  }
  _tdmEl.style.display = 'block';
  if (_tdmServerEndsAt !== null) {
    const secsLeft = Math.max(0, Math.ceil((_tdmServerEndsAt - Date.now()) / 1000));
    _tdmEl.textContent = `TEAM DEATHMATCH STARTING IN ${secsLeft}...`;
  } else {
    _tdmEl.textContent = 'TEAM DEATHMATCH — AT LEAST 2 PLAYERS NEEDED TO START';
  }
}

// ── Team intro screen — plays between the lobby countdown and the actual teleport ──
// A camera orbit around the arena, gamertags split into two colored teams, and a 10s
// countdown before gameplay actually starts.
const _tdmTeamsEl = document.createElement('div');
_tdmTeamsEl.style.cssText = 'position:fixed;inset:0;z-index:550;display:none;flex-direction:column;align-items:center;padding-top:8vh;font-family:monospace;color:#fff;pointer-events:none;';
_tdmTeamsEl.innerHTML = `
  <div style="font-size:30px;letter-spacing:10px;text-shadow:0 0 14px #000;">TEAMS</div>
  <div id="tdm-teams-countdown" style="font-size:54px;color:#0ff;text-shadow:0 0 16px #000;margin:14px 0 30px;">10</div>
  <div style="display:flex;gap:140px;">
    <div style="text-align:center;">
      <div style="font-size:20px;color:#3f9;letter-spacing:5px;margin-bottom:12px;text-shadow:0 0 8px #000;">GOOD</div>
      <div id="tdm-good-list" style="font-size:16px;line-height:2;color:#3f9;text-shadow:0 0 6px #000;"></div>
    </div>
    <div style="text-align:center;">
      <div style="font-size:20px;color:#f44;letter-spacing:5px;margin-bottom:12px;text-shadow:0 0 8px #000;">EVIL</div>
      <div id="tdm-evil-list" style="font-size:16px;line-height:2;color:#f44;text-shadow:0 0 6px #000;"></div>
    </div>
  </div>
`;
document.body.appendChild(_tdmTeamsEl);
const _tdmGoodListEl = _tdmTeamsEl.querySelector('#tdm-good-list');
const _tdmEvilListEl = _tdmTeamsEl.querySelector('#tdm-evil-list');
const _tdmTeamsCountdownEl = _tdmTeamsEl.querySelector('#tdm-teams-countdown');

let _tdmIntroCountdown = 10;
let _tdmIntroLastTick = 0;
let _tdmIntroOrbitAngle = 0;
window._tdmTeams = { good: [], evil: [] }; // { id, name } per side — exposed on window for later teammate/enemy logic

function _startTDMIntro(participantIds) {
  if (gameMode === 'tdm_intro' || gameMode === 'tdm') return;
  gameMode = 'tdm_intro';
  _tdmEl.style.display = 'none';

  // participantIds comes from the server's 'tdm_go' broadcast — every client gets the
  // exact same list, so sorting it the same way everywhere gives an identical team split
  // without the server needing to assign teams itself.
  const players = participantIds.map(id => {
    if (id === self.id) return { id, name: self.name || 'You' };
    const rp = remotePlayers[id];
    return { id, name: (rp && rp.data && rp.data.name) || 'Pilot' };
  });
  players.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const half = Math.ceil(players.length / 2);
  window._tdmTeams = { good: players.slice(0, half), evil: players.slice(half) };
  window._tdmMyTeam = window._tdmTeams.good.some(p => p.id === self.id) ? 'good' : 'evil';

  _tdmGoodListEl.innerHTML = window._tdmTeams.good.map(p => `<div>${p.name}</div>`).join('') || '<div>—</div>';
  _tdmEvilListEl.innerHTML = window._tdmTeams.evil.map(p => `<div>${p.name}</div>`).join('') || '<div>—</div>';

  _tdmIntroCountdown = 10;
  _tdmIntroLastTick = Date.now();
  _tdmIntroOrbitAngle = 0;
  _tdmTeamsCountdownEl.textContent = String(_tdmIntroCountdown);
  _tdmTeamsEl.style.display = 'flex';
}

function _updateTDMIntro() {
  const center = _tdmArenaBBox ? _tdmArenaBBox.getCenter(new THREE.Vector3()) : new THREE.Vector3();
  const radius = _tdmArenaBBox ? Math.max(_tdmArenaBBox.max.x - _tdmArenaBBox.min.x, _tdmArenaBBox.max.z - _tdmArenaBBox.min.z) * 0.6 : 400;
  const height = _tdmArenaBBox ? _tdmArenaBBox.max.y + radius * 0.35 : 200;
  _tdmIntroOrbitAngle += 0.0035;
  camera.position.set(
    center.x + Math.cos(_tdmIntroOrbitAngle) * radius,
    center.y + height,
    center.z + Math.sin(_tdmIntroOrbitAngle) * radius
  );
  camera.lookAt(center.x, center.y, center.z);

  const now = Date.now();
  if (now - _tdmIntroLastTick >= 1000) {
    _tdmIntroCountdown = Math.max(0, _tdmIntroCountdown - Math.floor((now - _tdmIntroLastTick) / 1000));
    _tdmIntroLastTick = now;
    _tdmTeamsCountdownEl.textContent = String(_tdmIntroCountdown);
  }
  if (_tdmIntroCountdown <= 0) {
    _tdmTeamsEl.style.display = 'none';
    enterTDMArena();
  }
}

// ── Match-end stats screen ──────────────────────────────────────────────────
const _tdmEndEl = document.createElement('div');
_tdmEndEl.style.cssText = 'position:fixed;inset:0;z-index:560;display:none;flex-direction:column;align-items:center;justify-content:center;font-family:monospace;color:#fff;background:rgba(0,0,0,0.75);';
_tdmEndEl.innerHTML = `
  <div style="font-size:30px;letter-spacing:8px;text-shadow:0 0 14px #000;margin-bottom:6px;">MATCH OVER</div>
  <div id="tdm-end-winner" style="font-size:22px;letter-spacing:4px;margin-bottom:24px;text-shadow:0 0 10px #000;"></div>
  <div id="tdm-end-personal" style="font-size:17px;letter-spacing:2px;margin-bottom:10px;color:#0ff;text-shadow:0 0 6px #000;"></div>
  <div id="tdm-end-scoreboard" style="font-size:13px;line-height:1.7;margin-bottom:30px;text-align:center;color:#ccc;"></div>
  <div style="display:flex;gap:24px;">
    <button id="tdm-end-again" style="font-family:monospace;font-size:15px;letter-spacing:2px;padding:10px 22px;background:#0af;color:#000;border:none;border-radius:4px;cursor:pointer;">PLAY AGAIN</button>
    <button id="tdm-end-lobby" style="font-family:monospace;font-size:15px;letter-spacing:2px;padding:10px 22px;background:#333;color:#fff;border:1px solid #888;border-radius:4px;cursor:pointer;">BACK TO LOBBY</button>
  </div>
`;
document.body.appendChild(_tdmEndEl);
_tdmEndEl.querySelector('#tdm-end-again').addEventListener('click', () => {
  _tdmEndEl.style.display = 'none';
  exitTDMArena();
});
_tdmEndEl.querySelector('#tdm-end-lobby').addEventListener('click', () => {
  _tdmEndEl.style.display = 'none';
  exitTDMArena();
});

function _showTDMMatchEnd(stats) {
  if (gameMode !== 'tdm') return; // don't yank someone who already left back into a results screen
  document.exitPointerLock(); // release the mouse so the buttons below are actually clickable
  const list = Array.isArray(stats) ? stats : [];
  const goodIds = new Set((window._tdmTeams.good || []).map(p => p.id));
  const evilIds = new Set((window._tdmTeams.evil || []).map(p => p.id));
  let goodKills = 0, evilKills = 0;
  list.forEach(s => {
    if (goodIds.has(s.id)) goodKills += s.kills;
    else if (evilIds.has(s.id)) evilKills += s.kills;
  });
  const winnerEl = _tdmEndEl.querySelector('#tdm-end-winner');
  if (goodKills === evilKills) {
    winnerEl.textContent = 'DRAW';
    winnerEl.style.color = '#fff';
  } else if (goodKills > evilKills) {
    winnerEl.textContent = `GOOD TEAM WINS  ${goodKills} — ${evilKills}`;
    winnerEl.style.color = '#3f9';
  } else {
    winnerEl.textContent = `EVIL TEAM WINS  ${evilKills} — ${goodKills}`;
    winnerEl.style.color = '#f44';
  }

  const mine = list.find(s => s.id === self.id) || { kills: 0, deaths: 0 };
  const kd = mine.deaths > 0 ? (mine.kills / mine.deaths).toFixed(2) : mine.kills.toFixed(2);
  _tdmEndEl.querySelector('#tdm-end-personal').textContent = `YOUR KILLS: ${mine.kills}   DEATHS: ${mine.deaths}   K/D: ${kd}`;

  const sorted = list.slice().sort((a, b) => b.kills - a.kills);
  _tdmEndEl.querySelector('#tdm-end-scoreboard').innerHTML = sorted.map(s => {
    const team = goodIds.has(s.id) ? 'GOOD' : evilIds.has(s.id) ? 'EVIL' : '?';
    const color = team === 'GOOD' ? '#3f9' : team === 'EVIL' ? '#f44' : '#ccc';
    return `<div style="color:${color}">${s.name} [${team}] — ${s.kills}K / ${s.deaths}D</div>`;
  }).join('');

  _tdmEndEl.style.display = 'flex';
}

// ── TDM Arena — teleported into when the lobby countdown hits 0 ────────────────
const tdmScene = new THREE.Scene();
const _tdmAmbient = new THREE.AmbientLight(0xffffff, 1.0);
tdmScene.add(_tdmAmbient);
const _tdmDirLight = new THREE.DirectionalLight(0xffffff, 1.6);
_tdmDirLight.position.set(1, 2, 0.5).normalize();
tdmScene.add(_tdmDirLight);
const _tdmDirLight2 = new THREE.DirectionalLight(0xaaccff, 0.7);
_tdmDirLight2.position.set(-1, 1, -1).normalize();
tdmScene.add(_tdmDirLight2);

// Light-blue sky with a few soft procedural clouds — drawn once onto a canvas texture,
// no external asset needed, mapped onto the inside of a big dome around the whole map.
const _tdmSkyDome = (() => {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 512;
  const ctx = cv.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, cv.height);
  grad.addColorStop(0, '#3fa9f5');
  grad.addColorStop(1, '#bfe4ff');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  for (let i = 0; i < 22; i++) {
    const cx = Math.random() * cv.width, cy = Math.random() * cv.height * 0.55 + 20;
    const puffs = 5 + Math.floor(Math.random() * 5);
    for (let j = 0; j < puffs; j++) {
      const r = 18 + Math.random() * 26;
      ctx.beginPath();
      ctx.arc(cx + (Math.random() - 0.5) * 60, cy + (Math.random() - 0.5) * 18, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(4000, 24, 16),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false })
  );
  return dome;
})();
tdmScene.add(_tdmSkyDome);

let _tdmArenaCollidables = [];
let _tdmArenaBBox = null;
let _tdmFloorY = 2; // fallback value, real per-position height comes from _tdmGroundHeightAt()
// Good team spawns at the original spawn point; evil team spawns on the other side of
// the map. Both get clamped into the map's real footprint once it loads (see below).
let _tdmSpawnGoodX = 0, _tdmSpawnGoodZ = 0;
let _tdmSpawnEvilX = -35, _tdmSpawnEvilZ = -566;
// Ground reference = raycasted surface height + the apex height of a TDM jump
// (v^2 / 2g with FP_JUMP_V * 3.5 initial velocity, ~22 units) instead of a small
// fixed offset — puts "ground" at roughly where the top of a jump used to land you,
// since the map kept spawning you underneath it otherwise.
const _TDM_EYE_OFFSET = 16;
// Shared between the floor step-up logic and the horizontal wall-collision height
// sampling below — anything at or under this height should always be auto-climbable,
// which means the horizontal collision must never sample within this range, or it'll
// block you from ever walking into (and therefore auto-stepping onto) short objects.
const _TDM_MAX_STEP_UP = 7;
const _TDM_ASTRONAUT_SCALE = 2; // was 6 — way too big relative to other players
const TDM_DAMAGE_MUL = 0.35; // weapons hit significantly softer in TDM so a 3-minute match doesn't end in seconds
const TDM_MATCH_DURATION_MS = 3 * 60 * 1000;
let _tdmLastFloor = null; // last accepted ground height, used to clamp step-up size
let _tdmWasGrounded = true; // tracks previous frame's grounded state — step-up clamp only applies while walking, not landing from a jump
const _tdmGroundRaycaster = new THREE.Raycaster();
// Raw downward raycast at one XZ point — null if nothing is directly below (outside the
// map footprint), instead of silently falling through to the map's basement/underside.
function _tdmRaycastGroundY(x, z, fromY) {
  if (_tdmArenaCollidables.length === 0) return null;
  _tdmGroundRaycaster.set(new THREE.Vector3(x, fromY, z), new THREE.Vector3(0, -1, 0));
  const hits = _tdmGroundRaycaster.intersectObjects(_tdmArenaCollidables, false);
  return hits.length > 0 ? hits[0].point.y : null;
}
// Mesh the player is currently standing on top of — excluded from the horizontal wall
// collision check each frame, since a ray sampled near foot height can otherwise catch
// the top edge/lip of that very mesh when walking toward its border, locking the player
// in place until they jump clear of it.
let _tdmStandingMesh = null;
let _tdmLastFilteredStandingMesh = undefined;
let _tdmFilteredCollidables = _tdmArenaCollidables;
// Dynamic ground height at any XZ — lets the player stand on top of crates/platforms
// instead of always snapping back to one fixed arena-wide floor height. If the exact
// point has no geometry below it (e.g. a requested spawn point just outside the actual
// mesh footprint), spirals outward to find the nearest real ground instead of falling
// back to the whole map's absolute lowest point (which put spawns under the map).
function _tdmGroundHeightAt(x, z, fromY = 5000) {
  let y = _tdmRaycastGroundY(x, z, fromY);
  if (y === null) {
    for (let r = 10; r <= 200 && y === null; r += 10) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        y = _tdmRaycastGroundY(x + Math.cos(ang) * r, z + Math.sin(ang) * r, fromY);
        if (y !== null) break;
      }
    }
  }
  if (y === null) y = _tdmArenaBBox ? _tdmArenaBBox.max.y : 0; // last-resort: top of map, never the basement
  return y + _TDM_EYE_OFFSET;
}
let _tdmLoadFailed = false;
// On-screen debug readout — shows live download progress and, once loaded, the map's
// real size, so this is diagnosable from a screenshot without needing dev tools.
const _tdmDebugEl = document.createElement('div');
_tdmDebugEl.style.cssText = 'position:fixed;top:8px;left:8px;color:#0f0;font-family:monospace;font-size:11px;background:rgba(0,0,0,0.6);padding:4px 8px;pointer-events:none;display:none;z-index:600;max-width:90vw;';
_tdmDebugEl.textContent = 'TDM DEBUG — waiting for map to load...';
document.body.appendChild(_tdmDebugEl);
// This 32MB map used to load eagerly at page start, blocking the initial loading screen
// for every player even if they never touch TDM. Now it only starts downloading once the
// server's real 20s countdown begins (see 'tdm_countdown_start' below) — that gives it a
// full 20s+10s(intro) head start before anyone actually needs to walk on it, without
// costing everyone that download on page load.
let _tdmMapLoadStarted = false;
function _loadTDMMap() {
  if (_tdmMapLoadStarted) return;
  _tdmMapLoadStarted = true;
  loadModel('assets/lowpoly__map__asset__by_resoforge.glb', 1400, model => {
  if (!model) {
    console.warn('TDM arena map GLB failed');
    _tdmLoadFailed = true;
    _tdmDebugEl.textContent = 'TDM DEBUG — LOAD FAILED (fetch or parse error)';
    if (gameMode === 'tdm') {
      _tdmEl.style.display = 'block';
      _tdmEl.textContent = 'ARENA MAP FAILED TO LOAD — check your connection and press E to leave';
    }
    return;
  }
  model.traverse(c => {
    if (c.isMesh) {
      _tdmArenaCollidables.push(c);
      // Single-sided materials make the raycaster miss hits approached from the "back"
      // face — force double-sided so wall/collision rays register from any direction.
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach(m => { if (m) m.side = THREE.DoubleSide; });
    }
  });
  tdmScene.add(model);
  _tdmArenaBBox = new THREE.Box3().setFromObject(model);
  // The requested spawn points may sit entirely outside the model's real footprint (its
  // actual extent depends on the asset's own aspect ratio, which we don't know ahead of
  // time) — clamp them into the bbox so nobody ends up floating over empty space with
  // nothing but sky around them.
  const _PAD = 20;
  const _clampX = v => Math.max(_tdmArenaBBox.min.x + _PAD, Math.min(_tdmArenaBBox.max.x - _PAD, v));
  const _clampZ = v => Math.max(_tdmArenaBBox.min.z + _PAD, Math.min(_tdmArenaBBox.max.z - _PAD, v));
  _tdmSpawnGoodX = _clampX(_tdmSpawnGoodX); _tdmSpawnGoodZ = _clampZ(_tdmSpawnGoodZ);
  _tdmSpawnEvilX = _clampX(_tdmSpawnEvilX); _tdmSpawnEvilZ = _clampZ(_tdmSpawnEvilZ);
  _tdmFloorY = _tdmGroundHeightAt(_tdmSpawnGoodX, _tdmSpawnGoodZ);
  console.log('[TDM] map bbox:', _tdmArenaBBox.min, _tdmArenaBBox.max, 'good spawn:', _tdmSpawnGoodX, _tdmSpawnGoodZ, 'evil spawn:', _tdmSpawnEvilX, _tdmSpawnEvilZ, 'meshes:', _tdmArenaCollidables.length);
  _tdmDebugEl.textContent = `TDM DEBUG — meshes:${_tdmArenaCollidables.length} bbox min:(${_tdmArenaBBox.min.x.toFixed(0)},${_tdmArenaBBox.min.y.toFixed(0)},${_tdmArenaBBox.min.z.toFixed(0)}) max:(${_tdmArenaBBox.max.x.toFixed(0)},${_tdmArenaBBox.max.y.toFixed(0)},${_tdmArenaBBox.max.z.toFixed(0)}) good:(${_tdmSpawnGoodX.toFixed(0)},${_tdmSpawnGoodZ.toFixed(0)}) evil:(${_tdmSpawnEvilX.toFixed(0)},${_tdmSpawnEvilZ.toFixed(0)})`;
  if (gameMode === 'tdm') { fpPos.y = _tdmFloorY; camera.position.y = _tdmFloorY; }
  }, (received, total) => {
    const mb = (n) => (n / (1024 * 1024)).toFixed(1);
    _tdmDebugEl.textContent = total > 0
      ? `TDM DEBUG — downloading map: ${mb(received)}MB / ${mb(total)}MB (${Math.round(received / total * 100)}%)`
      : `TDM DEBUG — downloading map: ${mb(received)}MB (size unknown)`;
  });
}

const _tdmExitPrompt = document.createElement('div');
_tdmExitPrompt.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);color:#adf;font-family:monospace;font-size:13px;letter-spacing:2px;pointer-events:none;display:none;';
_tdmExitPrompt.textContent = '[ E ]  LEAVE ARENA';
document.body.appendChild(_tdmExitPrompt);

// Good team spawns at the original spawn point, evil team spawns on the other side of
// the map. Default to good if a team was never assigned (e.g. entering without going
// through the intro screen). Used both for the initial teleport and for respawning after
// a kill mid-match.
function _tdmRespawnAtTeamSpawn() {
  const _onEvil = window._tdmMyTeam === 'evil';
  const _spawnX = _onEvil ? _tdmSpawnEvilX : _tdmSpawnGoodX;
  const _spawnZ = _onEvil ? _tdmSpawnEvilZ : _tdmSpawnGoodZ;
  _tdmFloorY = _tdmGroundHeightAt(_spawnX, _spawnZ);
  _tdmLastFloor = _tdmFloorY; // reset step-up clamp for the new run
  _tdmWasGrounded = true;
  _tdmStandingMesh = null;
  fpPos.set(_spawnX, _tdmFloorY, _spawnZ);
  fpVel.set(0, 0, 0);
  camera.position.copy(fpPos);
}

function enterTDMArena() {
  if (gameMode === 'tdm') return; // already in
  _loadTDMMap(); // safety net in case the countdown-start trigger was somehow missed
  gameMode = 'tdm';
  _killAllExteriorLights();
  lobbyScene.visible = false;
  interiorScene.visible = false;
  _tdmRespawnAtTeamSpawn();
  fpYaw = 0; fpPitch = 0;
  renderer.toneMappingExposure = 1.0;
  _tdmEl.style.display = 'none';
  _tdmEndEl.style.display = 'none';
  // Real wait: stays up until the 32MB map has actually finished downloading/parsing
  // AND had a real chance to compile shaders + upload textures to the GPU (the warm-up
  // render pass). The old 15s timeoutMs was force-hiding this before a slow download
  // finished, dropping the player into an arena that wasn't actually ready yet — give it
  // a much longer safety cap instead so it only ever cuts off in a genuinely broken load.
  let _tdmWarmFrames = 0;
  const _tdmWarmTarget = 90;
  console.log('[TDM] entering arena — collidables so far:', _tdmArenaCollidables.length, 'load failed:', _tdmLoadFailed);
  _showLoadingScreen('LOADING ARENA', () => {
    if (_tdmLoadFailed) {
      _tdmEl.style.display = 'block';
      _tdmEl.textContent = 'ARENA MAP FAILED TO LOAD — check your connection and press E to leave';
      return true; // stop waiting, nothing more will arrive
    }
    if (_tdmArenaCollidables.length === 0) return false;
    if (_tdmWarmFrames < _tdmWarmTarget) {
      renderer.render(tdmScene, camera);
      _tdmWarmFrames++;
      return false;
    }
    return true;
  }, { timeoutMs: 120000, minShowMs: 150 });
}

function exitTDMArena() {
  gameMode = 'lobby';
  lobbyScene.visible = true;
  _tdmExitPrompt.style.display = 'none';
  _tdmDebugEl.style.display = 'none';
  fpPos.set(-115, -7.5, 40); // just outside the TDM zone bounds (was inside it, which — combined
  // with the temporary insta-teleport-at-1-player — bounced you right back in immediately)
  fpVel.set(0, 0, 0);
  camera.position.copy(fpPos);
  _restoreSceneLights();
  _lobbyAmbient.intensity = 1.2;
  _lobbyLight.intensity = 1.0;
  renderer.toneMappingExposure = 0.8;
}

function enterLobby() {
  gameMode = 'lobby';
  _killAllExteriorLights();
  interiorScene.visible = false;
  lobbyScene.visible = true;
  _lobbyAmbient.intensity = 1.2;
  _lobbyLight.intensity = 1.0;
  exitPrompt.style.display = 'none';
  fpPos.set(0, -7.5, 0);
  fpVel.set(0, 0, 0);
  _fpJumpVel = 0;
  fpYaw = 0; fpPitch = 0;
  _fpMouseDX = 0; _fpMouseDY = 0;
  camera.quaternion.identity();
  camera.position.copy(fpPos);
  renderer.toneMappingExposure = 0.8;
  if (_lobbyCollidables.length === 0) {
    _showLoadingScreen('LOADING LOBBY', () => _lobbyCollidables.length > 0, { timeoutMs: 10000 });
  }
}

function exitLobby() {
  gameMode = 'docked';
  _killAllExteriorLights();
  lobbyScene.visible = false;
  interiorScene.visible = true;
  _lobbyExitPrompt.style.display = 'none';
  _hangarPrompt.style.display = 'none';
  _hangarBackPrompt.style.display = 'none';
  _lobbyRoomPrompt.style.display = 'none';
  fpPos.set(-9.6, 2, 53);
  fpVel.set(0, 0, 0);
  fpYaw = Math.PI; fpPitch = 0;
  camera.position.copy(fpPos);
  _iAmbient.intensity = 2.5;
  _iLight.intensity = 2.0;
  renderer.toneMappingExposure = 0.18;
  // Flash lights off then on: clear cache first so it captures the correct
  // E*6 baseline, then dim, then restore using that same cached baseline.
  setTimeout(() => {
    _roomEmissiveCache.length = 0;
    setRoomLights(false);
    setTimeout(() => { setRoomLights(true); }, 350);
  }, 50);
}
// ── Shooting Range scene — standalone THREE.Scene so space station never shows ─
const shootingRangeScene = new THREE.Scene();
const _rangeAmbient = new THREE.AmbientLight(0xffffff, 0.6);
shootingRangeScene.add(_rangeAmbient);
const _rangeDirLight = new THREE.DirectionalLight(0xffffff, 1.8);
_rangeDirLight.position.set(1, 2, 0.5).normalize();
shootingRangeScene.add(_rangeDirLight);
const _rangeDirLight2 = new THREE.DirectionalLight(0xaaccff, 0.8);
_rangeDirLight2.position.set(-1, 1, -1).normalize();
shootingRangeScene.add(_rangeDirLight2);
const _rangeLight = new THREE.PointLight(0xffffff, 2.5, 800);
_rangeLight.position.set(55, 120, -120);
shootingRangeScene.add(_rangeLight);

let _rangeCollidables = [];
let _rangeBBox = null;

// Offscreen canvas for sampling target texture colors
const _rangeTexCanvas = document.createElement('canvas');
const _rangeTexCtx = _rangeTexCanvas.getContext('2d');
let _rangeTexReady = false;

loadModel('assets/shooting_range.glb', 400, model => {
  if (!model) { console.warn('Shooting range GLB failed'); return; }
  model.traverse(c => {
    if (c.isMesh) {
      _rangeCollidables.push(c);
      // Targets are thin flat objects — smallest dimension < 4 units, not huge overall
      const _b = new THREE.Box3().setFromObject(c);
      const _s = _b.getSize(new THREE.Vector3());
      const minDim = Math.min(_s.x, _s.y, _s.z);
      const maxDim = Math.max(_s.x, _s.y, _s.z);
      if (minDim < 4 && maxDim < 120) c.userData.isTarget = true;
    }
  });
  shootingRangeScene.add(model);
  _rangeBBox = new THREE.Box3().setFromObject(model);
  console.log('[range] collidables:', _rangeCollidables.length, 'texReady:', _rangeTexReady);
});

const _rangeExitPrompt = document.createElement('div');
_rangeExitPrompt.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);color:#adf;font-family:monospace;font-size:13px;letter-spacing:2px;pointer-events:none;display:none;';
_rangeExitPrompt.textContent = '[ E ]  EXIT SHOOTING RANGE';
document.body.appendChild(_rangeExitPrompt);

function enterShootingRange() {
  gameMode = 'range';
  _killAllExteriorLights();
  lobbyScene.visible = false;
  interiorScene.visible = false;
  fpPos.set(63, 2, -142);
  fpVel.set(0, 0, 0);
  fpYaw = Math.PI; fpPitch = 0;
  camera.position.copy(fpPos);
  renderer.toneMappingExposure = 1.0; // was 0.18 — rendered the whole range almost pitch black
  // Always show it (not just when we know assets are missing) — guards against any
  // race where the range briefly renders black for a frame before content is in.
  // Mesh being in the scene isn't the same as it being ready to draw — brand-new
  // materials/textures still need shader compilation + GPU texture upload on the first
  // real draw call, which was the extra few seconds of black AFTER the bar finished.
  // renderer.compile() alone doesn't force texture upload, so actually render the scene
  // (harmless — it's still hidden behind the opaque loading overlay) to pay that cost
  // while covered instead of on the first frame the player actually sees.
  // 3 frames (~50ms) wasn't nearly enough — large embedded textures decode/upload on a
  // background timeline that a couple of synchronous render() calls can't force to
  // finish. Keep warming up for a real ~1.5s so that work actually completes while
  // still hidden, instead of bleeding into the first frame the player sees.
  let _rangeWarmFrames = 0;
  const _rangeWarmTarget = 90;
  // 10s was fine before, but the page now has a lot more to load overall (the TDM system's
  // 32MB map among other things) — that 10s cap was force-hiding this screen before the
  // range genuinely finished loading, dropping the player into an unready range. Give it
  // the same much longer safety cap TDM's loading screen already got.
  _showLoadingScreen('LOADING SHOOTING RANGE', () => {
    if (_rangeCollidables.length === 0) return false;
    if (_rangeWarmFrames < _rangeWarmTarget) {
      renderer.render(shootingRangeScene, camera);
      _rangeWarmFrames++;
      return false;
    }
    return true;
  }, { timeoutMs: 120000, minShowMs: 150 });
}

function exitShootingRange() {
  gameMode = 'lobby';
  lobbyScene.visible = true;
  _rangeExitPrompt.style.display = 'none';
  fpPos.set(40, -7.5, 50);
  fpVel.set(0, 0, 0);
  fpYaw = Math.PI; fpPitch = 0;
  camera.position.copy(fpPos);
  _lobbyAmbient.intensity = 1.2;
  _lobbyLight.intensity = 1.0;
  renderer.toneMappingExposure = 0.8;
}

// ── Planet surface scene ───────────────────────────────────────────────────────
const _planetSurfScene = new THREE.Scene();
// no fog on planet surface

const _surfAmbient = new THREE.AmbientLight(0xffffff, 2.5);
_planetSurfScene.add(_surfAmbient);
const _surfDirLight = new THREE.DirectionalLight(0xfff4e0, 1.4);
_surfDirLight.position.set(1, 2, 0.5).normalize();
_planetSurfScene.add(_surfDirLight);
const _surfDirLight2 = new THREE.DirectionalLight(0x8899cc, 0.4);
_surfDirLight2.position.set(-1, 0.5, -1).normalize();
_planetSurfScene.add(_surfDirLight2);

// Flat ground plane — tinted per planet in _enterPlanetSurface
const _surfGroundMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.95, metalness: 0.0 });
const _surfGround = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000, 1, 1), _surfGroundMat);
_surfGround.rotation.x = -Math.PI / 2;
_planetSurfScene.add(_surfGround);

// Sky dome (inside of sphere so only visible from inside)
const _surfSkyDome = new THREE.Mesh(
  new THREE.SphereGeometry(18000, 16, 8),
  new THREE.MeshBasicMaterial({ color: 0x88bbff, side: THREE.BackSide })
);
_planetSurfScene.add(_surfSkyDome);

// Fog overlay element
const _planetFogEl = document.getElementById('planet-fog');
const _surfHudEl   = document.getElementById('planet-surface-hud');
let _surfFogTarget = 0; // 0=clear, 1=opaque

function _setPlanetFog(opacity, color) {
  if (!_planetFogEl) return;
  if (color) _planetFogEl.style.background = color;
  _planetFogEl.style.opacity = opacity;
}

// FP state for planet surface
const _surfPos = new THREE.Vector3(0, 1.8, 0);
const _surfVel = new THREE.Vector3();
let _surfYaw = 0, _surfPitch = 0;
let _surfVertVel = 0;
// Speeds brought in line with the room/lobby walk speed (FP_SPEED = 1.3) — these used to be
// ~6x slower than everywhere else in the game, which made every planet feel sluggish.
const SURF_EYE_H = 12, SURF_SPEED = 1.1, SURF_SPRINT = 1.7, SURF_ACCEL = 0.9, SURF_FRICTION = 0.82;
const SURF_JUMP_V = 0.5, SURF_GRAVITY = 0.012;

let _surfCurrentPlanet = null;
let _surfShipWorldPos = null;
const _surfRaycaster = new THREE.Raycaster();

// Landing animation state
let _surfLanding = false;
let _surfLandT = 0;
let _surfLandGroundY = null;
const SURF_LAND_DUR = 180;
let _surfLandShip = null;
let _surfLandShipBaseY = -38;
let _surfShipBox = null;      // XZ bounding box of parked ship
let _surfLeaving = false;     // takeoff animation active
let _surfLeaveT = 0;
const SURF_LEAVE_DUR = 150;

const _surfBoardPrompt = document.createElement('div');
_surfBoardPrompt.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
  'color:#0ff;font-family:monospace;font-size:16px;letter-spacing:2px;text-shadow:0 0 8px #000;' +
  'pointer-events:none;display:none;z-index:30;';
_surfBoardPrompt.textContent = '[ E ]  BOARD SHIP';
document.body.appendChild(_surfBoardPrompt);

let _surfTerrainMesh = null; // currently active terrain mesh for this landing, or null for flat ground
let _surfWalkMul = 1.0;    // per-terrain walk speed multiplier
let _surfSprintMul = 1.0;  // per-terrain sprint speed multiplier
let _surfJumpVelMul = 1.0; // per-terrain jump launch velocity multiplier
let _surfGravityMul = 1.0; // per-terrain gravity multiplier
let _surfClimbMul = 1.0;   // per-terrain obstacle-climb speed multiplier
let _surfTerrainReady = false;
let _surfTerrainHalfX = 1400, _surfTerrainHalfZ = 1400;

const HOT_VOLCANIC_NAMES = new Set([
  'Cinder Peak', 'Molten Eye', 'Inferno', 'Ember Drift',
  'Sulfur Moon', 'Acid Flats', 'Brimstone', 'Gilt Waste',
]);

const ICY_NAMES = new Set([
  'Frost Haven', 'Cryo Reach',
]);

const ICY2_NAMES = new Set([
  'Glacius', 'Tundra Shelf',
]);

const DESERT_NAMES = new Set([
  'Dust Bowl', 'Sand Veil', 'Mirage', 'Dune Scar',
  'Sunscorch', 'Amber Wastes', 'Drylands', 'Cracked Basin',
]);

const INDUSTRIAL_NAMES = new Set([
  'Obsidian', 'Slate Void', 'Charcoal Rim', 'Iron Dark',
  'Neon Abyss', 'Void Pulse', 'Azure Neon', 'Deep Circuit',
]);

const VALLEY_NAMES = new Set([
  'Greenvale', 'Highland Vale', 'Mossy Hollow', 'Sunken Valley',
  'Silverbrook', 'Fernvale', 'Windmere Vale', 'Emerald Valley',
]);

// Generic terrain registry — each entry holds its own loaded mesh + extents
const _surfTerrains = {
  mars:       { mesh: null, ready: false, halfX: 1400, halfZ: 1400, tint: 0xc1440e, dim: 1.0, walkMul: 1.0, sprintMul: 1.0, jumpVelMul: 1.0, gravityMul: 1.0, climbMul: 1.0 },
  volcano:    { mesh: null, ready: false, halfX: 1400, halfZ: 1400, tint: 0x661a0a, dim: 1.0, walkMul: 1.0, sprintMul: 1.0, jumpVelMul: 1.0, gravityMul: 1.0, climbMul: 1.0 },
  icy:        { mesh: null, ready: false, halfX: 1400, halfZ: 1400, tint: 0xddeeff, dim: 0.85, walkMul: 1.0, sprintMul: 1.0, jumpVelMul: 1.0, gravityMul: 1.0, climbMul: 1.0 },
  icy2:       { mesh: null, ready: false, halfX: 1400, halfZ: 1400, tint: 0xddeeff, dim: 0.85, walkMul: 1.0, sprintMul: 1.0, jumpVelMul: 1.0, gravityMul: 1.0, climbMul: 1.0 },
  desert:     { mesh: null, ready: false, halfX: 1400, halfZ: 1400, tint: 0xddbb77, dim: 0.75, walkMul: 1.0, sprintMul: 1.0, jumpVelMul: 1.0, gravityMul: 1.0, climbMul: 1.0, shiny: true, roughness: 0.4, metalness: 0.25 },
  industrial: { mesh: null, ready: false, halfX: 1400, halfZ: 1400, tint: 0x555566, dim: 1.0, walkMul: 0.8, sprintMul: 0.8, jumpVelMul: 1.0, gravityMul: 1.0, climbMul: 1.0 },
  valley:     { mesh: null, ready: false, halfX: 1400, halfZ: 1400, tint: 0x336633, dim: 1.0, walkMul: 1.0, sprintMul: 1.0, jumpVelMul: 1.0, gravityMul: 1.0, climbMul: 1.0 },
};

function _terrainKeyForPlanet(planet) {
  const name = planet.userData.mapName;
  if (name === 'Phoenix') return 'mars';
  if (HOT_VOLCANIC_NAMES.has(name)) return 'volcano';
  if (ICY_NAMES.has(name)) return 'icy';
  if (ICY2_NAMES.has(name)) return 'icy2';
  if (DESERT_NAMES.has(name)) return 'desert';
  if (INDUSTRIAL_NAMES.has(name)) return 'industrial';
  if (VALLEY_NAMES.has(name)) return 'valley';
  return null;
}

function _loadSurfTerrain(key, assetPath) {
  loadModel(assetPath, 3000, model => {
    if (!model) return;
    const entry = _surfTerrains[key];
    model.traverse(c => {
      if (!c.isMesh || !c.material) return;
      c.castShadow = false;
      c.receiveShadow = false;
      // Some exported terrain assets ship with degenerate UVs (every coordinate collapsed to
      // the same point), which samples one single texel across the whole surface and looks
      // like a flat, untextured color. Detect that and rebuild UVs via planar XZ projection.
      const _uvAttr = c.geometry.attributes.uv;
      if (_uvAttr) {
        let _uMin = Infinity, _uMax = -Infinity, _vMin = Infinity, _vMax = -Infinity;
        for (let i = 0; i < _uvAttr.count; i++) {
          const u = _uvAttr.getX(i), v = _uvAttr.getY(i);
          if (u < _uMin) _uMin = u; if (u > _uMax) _uMax = u;
          if (v < _vMin) _vMin = v; if (v > _vMax) _vMax = v;
        }
        if (_uMax - _uMin < 1e-5 && _vMax - _vMin < 1e-5) {
          const pos = c.geometry.attributes.position;
          c.geometry.computeBoundingBox();
          const bb = c.geometry.boundingBox;
          const sizeX = Math.max(bb.max.x - bb.min.x, 1e-5);
          const sizeZ = Math.max(bb.max.z - bb.min.z, 1e-5);
          const TILE = 8; // repeat count across this mesh's span
          const newUv = new Float32Array(pos.count * 2);
          for (let i = 0; i < pos.count; i++) {
            newUv[i * 2]     = (pos.getX(i) - bb.min.x) / sizeX * TILE;
            newUv[i * 2 + 1] = (pos.getZ(i) - bb.min.z) / sizeZ * TILE;
          }
          c.geometry.setAttribute('uv', new THREE.BufferAttribute(newUv, 2));
        }
      }
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach(m => {
        // Only fall back to a flat tint when the material genuinely has no texture at all —
        // never override a real base color texture (was incorrectly painting over textured
        // sand/snow assets that have a texture but happened to have a white color factor).
        if (!m.map && !m.aoMap && !m.roughnessMap && !m.metalnessMap) {
          const col = m.color;
          const isWhite = col && col.r > 0.95 && col.g > 0.95 && col.b > 0.95;
          if (isWhite) m.color.set(entry.tint);
        }
        if (entry.dim !== 1.0) m.color.multiplyScalar(entry.dim);
        // A baked AO map without a matching uv2 channel darkens/discolors the whole
        // surface incorrectly — drop it so the base color texture shows through as intended.
        if (m.aoMap && !c.geometry.attributes.uv2) m.aoMap = null;
        // Avoid rendering both faces of every triangle — halves fill cost on heavy terrain
        m.side = THREE.FrontSide;
        if (entry.shiny && m.isMeshStandardMaterial) {
          m.roughness = entry.roughness != null ? entry.roughness : 0.25;
          m.metalness = entry.metalness != null ? entry.metalness : 0.35;
          m.envMapIntensity = 1.5;
        }
        m.needsUpdate = true;
      });
    });
    entry.mesh = model;
    const box = new THREE.Box3().setFromObject(model);
    model.position.y -= box.max.y;
    entry.halfX = (box.max.x - box.min.x) / 2 * 0.92;
    entry.halfZ = (box.max.z - box.min.z) / 2 * 0.92;
    entry.ready = true;
  });
}

// Preload terrains at startup so they're ready when landing
_loadSurfTerrain('mars', 'assets/maadim_valles_outflow_mars.glb');
_loadSurfTerrain('volcano', 'assets/volcano_v1.glb');
_loadSurfTerrain('icy', 'assets/snow_terrain_low_poly.glb');
_loadSurfTerrain('icy2', 'assets/icy_terrain_export.glb');
_loadSurfTerrain('desert', 'assets/dune_-_arrakis_wip.glb');
_loadSurfTerrain('industrial', 'assets/futuristic_cube-shaped_cityscape.glb');
_loadSurfTerrain('valley', 'assets/grassy_mountains_geo.glb');

// Bright day-sky skybox, shown on every planet surface EXCEPT the fiery (mars/volcano)
// and dark/neon (industrial) terrain types, which keep their own dramatic tinted dome —
// a cheerful blue-sky-and-clouds backdrop would look wrong over lava or a cyberpunk city.
let _surfDaySky = null;
const _SURF_DAY_SKY_EXCLUDED_TERRAINS = new Set(['mars', 'volcano', 'industrial']);
loadModel('assets/skybox_skydays_3.glb', 16000, model => {
  if (!model) return;
  // The source asset's own single-material box UVs don't line up with its texture (came
  // out fully black no matter which way you looked) — the texture itself is a standard
  // cross-layout cube atlas (verified by sampling a coarse brightness grid: a plus-shaped
  // pattern at columns 1 of 4 / rows 1 of 3, i.e. top/bottom arms plus a left-front-right-
  // back middle band). Rebuilding as a fresh box with 6 explicit face materials, each
  // cropped to its correct cell via texture repeat/offset, instead of trusting the
  // imported mesh's UVs.
  let srcTex = null;
  model.traverse(c => {
    if (c.isMesh && c.material && !srcTex) {
      const m = Array.isArray(c.material) ? c.material[0] : c.material;
      srcTex = m.emissiveMap || m.map;
    }
  });
  if (!srcTex) return;
  const cellW = 0.25, cellH = 1 / 3;
  function faceMat(cx, cy) {
    const t = srcTex.clone();
    t.flipY = false;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.repeat.set(cellW, cellH);
    t.offset.set(cx * cellW, cy * cellH);
    t.needsUpdate = true;
    return new THREE.MeshBasicMaterial({ map: t, side: THREE.BackSide, fog: false, depthWrite: false });
  }
  const mats = [
    faceMat(2, 1), // +x right
    faceMat(0, 1), // -x left
    faceMat(1, 0), // +y top
    faceMat(1, 2), // -y bottom
    faceMat(1, 1), // +z front
    faceMat(3, 1), // -z back
  ];
  _surfDaySky = new THREE.Mesh(new THREE.BoxGeometry(16000, 16000, 16000), mats);
});

function _enterPlanetSurface(planet) {
  _surfCurrentPlanet = planet;
  const atm = planet.userData.atmosphere;

  // Remove any previously-shown terrain mesh from the scene
  Object.values(_surfTerrains).forEach(entry => {
    if (entry.mesh) _planetSurfScene.remove(entry.mesh);
  });

  const terrainKey = _terrainKeyForPlanet(planet);
  const terrainEntry = terrainKey ? _surfTerrains[terrainKey] : null;
  const hasTerrain = !!(terrainEntry && terrainEntry.ready);

  if (hasTerrain) {
    _planetSurfScene.add(terrainEntry.mesh);
    _planetSurfScene.remove(_surfGround);
    _surfTerrainMesh = terrainEntry.mesh;
    _surfTerrainHalfX = terrainEntry.halfX;
    _surfTerrainHalfZ = terrainEntry.halfZ;
    _surfWalkMul = terrainEntry.walkMul || 1.0;
    _surfSprintMul = terrainEntry.sprintMul || 1.0;
    _surfJumpVelMul = terrainEntry.jumpVelMul || 1.0;
    _surfGravityMul = terrainEntry.gravityMul || 1.0;
    _surfClimbMul = terrainEntry.climbMul || 1.0;
  } else {
    if (_surfGround.parent !== _planetSurfScene) _planetSurfScene.add(_surfGround);
    _surfTerrainMesh = null;
    _surfWalkMul = 1.0;
    _surfSprintMul = 1.0;
    _surfJumpVelMul = 1.0;
    _surfGravityMul = 1.0;
    _surfClimbMul = 1.0;
  }

  if (atm) {
    _surfSkyDome.material.color.copy(atm.skyColor);
    if (!hasTerrain) {
      // Tint flat ground to match planet fog/surface color
      _surfGroundMat.color.copy(atm.fogColor || atm.skyColor);
      _surfGroundMat.needsUpdate = true;
    }
  }

  // Bright day-sky skybox on every planet except fiery (mars/volcano) and dark/neon
  // (industrial) terrain types — those keep the plain tinted dome instead.
  const _useDaySky = !!_surfDaySky && !_SURF_DAY_SKY_EXCLUDED_TERRAINS.has(terrainKey);
  _surfSkyDome.visible = !_useDaySky;
  if (_surfDaySky) {
    if (_useDaySky) {
      if (_surfDaySky.parent !== _planetSurfScene) _planetSurfScene.add(_surfDaySky);
    } else if (_surfDaySky.parent === _planetSurfScene) {
      _planetSurfScene.remove(_surfDaySky);
    }
  }

  _surfGround.visible = !hasTerrain;
  // For flat ground planets use a large open border; terrain planets use computed extents
  if (!hasTerrain) { _surfTerrainHalfX = 18000; _surfTerrainHalfZ = 18000; }

  _surfShipWorldPos = new THREE.Vector3(0, 0, 0);
  _surfVel.set(0, 0, 0);
  _surfVertVel = 0;
  _surfYaw = Math.PI; // face forward
  _surfPitch = -0.18;

  renderer.setClearColor(0x000000, 0);
  renderer.toneMappingExposure = 1.0;

  selfMesh.visible = false;
  if (_landedMenu) _landedMenu.style.display = 'none';
  elHud.style.display = 'none';

  gameMode = 'planet_surface';
  if (_surfHudEl) _surfHudEl.style.display = 'none'; // hidden during landing
  // Whatever planet the crate is actually on, this is the moment to find out — show/hide/
  // reposition its ground mesh for whichever planet was just landed on (function itself
  // checks whether this is even the right one).
  if (typeof _syncEventCratePlanetMesh === 'function') _syncEventCratePlanetMesh();

  // Start landing animation — clone ship into surface scene
  _surfLanding = true;
  _surfLandT = 0;
  _surfLandGroundY = null;
  if (_surfLandShip) { _planetSurfScene.remove(_surfLandShip); _surfLandShip = null; }
  loadModel(_selectedShipAsset(), 60, m => {
    if (!m) return;
    _normalizeShipModel(m, 60 * _selectedShipSizeMul(), _selectedShipYawOffset());
    // Wrap in a group — normalize's own centering position would otherwise get clobbered
    // by placing the ship in the world below (same issue as the hangar display ship).
    const holder = new THREE.Group();
    holder.add(m);
    holder.position.set(0, 800, 0);
    _surfLandShip = holder;
    _planetSurfScene.add(_surfLandShip);
    // Compute XZ bounding box for collision (in local space, before position offset)
    const _sBox = new THREE.Box3().setFromObject(m);
    _surfShipBox = {
      minX: _sBox.min.x, maxX: _sBox.max.x,
      minZ: _sBox.min.z, maxZ: _sBox.max.z,
    };
  });
}

function _exitPlanetSurface() {
  if (_surfHudEl) _surfHudEl.style.display = 'none';
  _surfBoardPrompt.style.display = 'none';
  selfMesh.visible = true;
  gameMode = 'landed_ship';
  _landedMenu.style.display = 'flex';
}

function _updatePlanetSurface() {
  // ── Landing animation ──────────────────────────────────
  if (_surfLanding) {
    if (_surfLandShip) {
      _surfLandT = Math.min(1, _surfLandT + 1 / SURF_LAND_DUR);
      const ease = 1 - Math.pow(1 - _surfLandT, 3); // ease-out cubic
      const shipY = 800 * (1 - ease) - 38;
      _surfLandShip.position.set(0, shipY, 0);

      // Camera follows from behind/above the ship
      const camDist = 160, camHeight = 60;
      camera.position.set(0, shipY + camHeight, camDist);
      camera.lookAt(0, shipY, 0);

      if (_surfLandT >= 1) {
        // Ship stays on terrain — just hand control to player standing next to it
        _surfLanding = false;
        _surfLandT = 0;
        // Spawn player just to the side of the ship
        _surfPos.set(60, 50, 0);
        _surfVel.set(0, 0, 0);
        _surfVertVel = 0;
        _surfYaw = Math.PI / 2; // facing away from ship
        _surfPitch = 0;
        if (_surfHudEl) _surfHudEl.style.display = 'block';
      }
    }
    _pwMouseDX = 0; _pwMouseDY = 0;
    return; // no player controls during landing
  }

  // Mouse look
  _surfYaw   -= (_pwMouseDX || 0) * 0.0028;
  _surfPitch -= (_pwMouseDY || 0) * 0.0028;
  _surfPitch  = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, _surfPitch));
  _pwMouseDX = 0; _pwMouseDY = 0;

  const forward = new THREE.Vector3(-Math.sin(_surfYaw), 0, -Math.cos(_surfYaw));
  const right   = new THREE.Vector3(-Math.cos(_surfYaw), 0, Math.sin(_surfYaw));

  // C or Alt to crouch — crouching while sprinting triggers a slide. Once triggered it
  // plays out fully; you don't need to keep holding the key.
  const _surfCrouchKeyDown = keys['c'] || keys['alt'];
  const _wasSprintingSurf = keys['shift'] && _surfVel.lengthSq() > 0.3;
  if (_surfCrouchKeyDown && !_prevCrouchKey && _wasSprintingSurf) {
    _slideTimer = SLIDE_DURATION;
    _surfVel.setLength(SURF_SPRINT * SLIDE_SPEED_MUL); // launch the slide
  }
  _prevCrouchKey = _surfCrouchKeyDown;
  const _surfCrouching = _surfCrouchKeyDown || _slideTimer > 0; // stay low for the whole slide
  _crouchAmount += ((_surfCrouching ? 1 : 0) - _crouchAmount) * 0.2;
  const _surfCrouchSpeedMul = 1 - CROUCH_SPEED_MUL * _crouchAmount;

  const _surfMoveMul = (keys['shift'] && !_surfCrouching ? _surfSprintMul : _surfWalkMul) * _surfCrouchSpeedMul;
  const _accelAmt = (keys['shift'] && !_surfCrouching ? SURF_ACCEL * 4 : SURF_ACCEL) * _surfMoveMul;
  const accel = new THREE.Vector3();
  if (keys['w'] || keys['arrowup'])    accel.addScaledVector(forward,  _accelAmt);
  if (keys['s'] || keys['arrowdown'])  accel.addScaledVector(forward, -_accelAmt);
  if (keys['a'] || keys['arrowleft'])  accel.addScaledVector(right,    _accelAmt);
  if (keys['d'] || keys['arrowright']) accel.addScaledVector(right,   -_accelAmt);

  _surfVel.add(accel);
  _surfVel.y = 0;
  _surfVel.multiplyScalar(_slideTimer > 0 ? 0.97 : SURF_FRICTION); // slide loses speed more gently
  let _surfSpeedCap = (keys['shift'] ? SURF_SPRINT : SURF_SPEED) * _surfMoveMul;
  if (_slideTimer > 0) {
    _surfSpeedCap = Math.max(_surfSpeedCap, SURF_SPRINT * SLIDE_SPEED_MUL * (_slideTimer / SLIDE_DURATION));
    _slideTimer--;
  }
  if (_surfVel.length() > _surfSpeedCap) _surfVel.setLength(_surfSpeedCap);

  // Raycast to find ground height beneath player
  const _groundMesh = _surfTerrainMesh || _surfGround;
  _surfRaycaster.set(new THREE.Vector3(_surfPos.x, _surfPos.y + 10, _surfPos.z), new THREE.Vector3(0, -1, 0));
  const _gHits = _surfRaycaster.intersectObject(_groundMesh, true);
  const _groundY = _gHits.length > 0 ? _gHits[0].point.y + SURF_EYE_H : SURF_EYE_H;

  const onGround = _surfPos.y <= _groundY + 0.1;
  if (keys[' '] && onGround && _surfVertVel <= 0) _surfVertVel = SURF_JUMP_V * _surfJumpVelMul;

  const CLIMB_STEP = 6;
  const CLIMB_SPEED = 5 * _surfClimbMul;

  // Look ahead at where we're about to move BEFORE moving there. A tall obstacle (e.g.
  // a building wall) shows up as a big height jump — hold horizontal position there and
  // climb straight up instead of stepping into the wall and reacting afterward (which
  // used to flip-flop between "moved in" and "pushed back out" every other frame).
  let _blockHorizontal = false;
  let _climbTargetY = _groundY;
  if (_surfVel.lengthSq() > 0.0001) {
    _surfRaycaster.set(new THREE.Vector3(_surfPos.x + _surfVel.x, _surfPos.y + 10, _surfPos.z + _surfVel.z), new THREE.Vector3(0, -1, 0));
    const _aHits = _surfRaycaster.intersectObject(_groundMesh, true);
    const _attemptGroundY = _aHits.length > 0 ? _aHits[0].point.y + SURF_EYE_H : SURF_EYE_H;
    if (_attemptGroundY - _surfPos.y > CLIMB_STEP) { _blockHorizontal = true; _climbTargetY = _attemptGroundY; }
  }

  _surfVertVel -= SURF_GRAVITY * _surfGravityMul;
  if (!_blockHorizontal) _surfPos.add(_surfVel);
  _surfPos.y += _surfVertVel;
  if (_blockHorizontal) {
    _surfPos.y = Math.min(_surfPos.y + CLIMB_SPEED, _climbTargetY);
    _surfVertVel = 0;
  } else if (_surfPos.y < _groundY) {
    // Small terrain bumps get smoothed instead of hard-snapped so fast movement
    // over uneven ground doesn't jitter the camera. Real falls still snap immediately.
    const _groundGap = _groundY - _surfPos.y;
    _surfPos.y += _groundGap < CLIMB_STEP ? _groundGap * 0.4 : _groundGap;
    _surfVertVel = 0;
  }

  // World border — clamp to terrain edges
  if (_surfPos.x >  _surfTerrainHalfX) { _surfPos.x =  _surfTerrainHalfX; _surfVel.x = 0; }
  if (_surfPos.x < -_surfTerrainHalfX) { _surfPos.x = -_surfTerrainHalfX; _surfVel.x = 0; }
  if (_surfPos.z >  _surfTerrainHalfZ) { _surfPos.z =  _surfTerrainHalfZ; _surfVel.z = 0; }
  if (_surfPos.z < -_surfTerrainHalfZ) { _surfPos.z = -_surfTerrainHalfZ; _surfVel.z = 0; }

  // Camera
  const pitchQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), _surfPitch);
  const yawQ   = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), _surfYaw);
  camera.quaternion.multiplyQuaternions(yawQ, pitchQ);
  camera.position.copy(_surfPos);
  camera.position.y -= CROUCH_HEIGHT * _crouchAmount;

  // Ship bobbing + collision
  if (_surfLandShip) {
    const bobY = _surfLandShipBaseY + Math.sin(Date.now() * 0.001) * 4;
    _surfLandShip.position.y = bobY;

    // Collision — AABB in XZ using actual ship bounding box
    const sdx = _surfPos.x - _surfLandShip.position.x;
    const sdz = _surfPos.z - _surfLandShip.position.z;
    const sDist = Math.sqrt(sdx * sdx + sdz * sdz);
    if (_surfShipBox) {
      const PAD = 4;
      const inX = sdx > _surfShipBox.minX - PAD && sdx < _surfShipBox.maxX + PAD;
      const inZ = sdz > _surfShipBox.minZ - PAD && sdz < _surfShipBox.maxZ + PAD;
      if (inX && inZ) {
        // Push out on the axis with least overlap
        const ox1 = sdx - (_surfShipBox.minX - PAD);
        const ox2 = (_surfShipBox.maxX + PAD) - sdx;
        const oz1 = sdz - (_surfShipBox.minZ - PAD);
        const oz2 = (_surfShipBox.maxZ + PAD) - sdz;
        const minO = Math.min(ox1, ox2, oz1, oz2);
        if (minO === ox1) { _surfPos.x = _surfLandShip.position.x + _surfShipBox.minX - PAD; _surfVel.x = 0; }
        else if (minO === ox2) { _surfPos.x = _surfLandShip.position.x + _surfShipBox.maxX + PAD; _surfVel.x = 0; }
        else if (minO === oz1) { _surfPos.z = _surfLandShip.position.z + _surfShipBox.minZ - PAD; _surfVel.z = 0; }
        else { _surfPos.z = _surfLandShip.position.z + _surfShipBox.maxZ + PAD; _surfVel.z = 0; }
      }
    }

    // Leave planet prompt
    const nearShip = sDist < 120;
    _surfBoardPrompt.textContent = '[ E ]  LEAVE PLANET';
    _surfBoardPrompt.style.display = nearShip ? 'block' : 'none';
  } else {
    _surfBoardPrompt.style.display = 'none';
  }
}

function _startLeavePlanet() {
  if (_surfLeaving || !_surfLandShip) return;
  _surfLeaving = true;
  _surfLeaveT = 0;
  if (_surfHudEl) _surfHudEl.style.display = 'none';
  _surfBoardPrompt.style.display = 'none';
}

function _updateLeavePlanet() {
  _surfLeaveT = Math.min(1, _surfLeaveT + 1 / SURF_LEAVE_DUR);
  const ease = _surfLeaveT * _surfLeaveT; // ease-in
  const shipY = _surfLandShipBaseY + ease * 1200;
  if (_surfLandShip) _surfLandShip.position.y = shipY;

  // Camera follows ship up
  const camDist = 160;
  camera.position.set(0, shipY + 60, camDist);
  camera.lookAt(0, shipY, 0);
  _pwMouseDX = 0; _pwMouseDY = 0;

  if (_surfLeaveT >= 1) {
    _surfLeaving = false;
    if (_surfLandShip) { _planetSurfScene.remove(_surfLandShip); _surfLandShip = null; }
    if (_surfHudEl) _surfHudEl.style.display = 'none';
    // Place selfMesh near the planet and launch into flight mode
    if (_landedPlanet) {
      const r = _landedPlanet.userData.collisionRadius || 700;
      const away = _landedPlanet.position.clone().normalize();
      selfMesh.position.copy(_landedPlanet.position).addScaledVector(away, r * 2.2);
      selfMesh.quaternion.identity();
      self.velocity.copy(away).multiplyScalar(8);
    }
    _landedPlanet = null;
    selfMesh.visible = true;
    gameMode = 'flight';
    elHud.style.display = 'block';
    renderer.setClearColor(0x000000, 0);
    if (skyboxMesh) scene.background = _skyboxTex;
  }
}

// ── Hangar scene ──────────────────────────────────────────────────────────────
const hangarScene = new THREE.Group();
scene.add(hangarScene);
hangarScene.visible = false;
const _hangarAmbient = new THREE.AmbientLight(0xffffff, 0);
hangarScene.add(_hangarAmbient);
const _hangarLight = new THREE.PointLight(0xddeeff, 0, 800);
_hangarLight.position.set(0, 80, 0);
hangarScene.add(_hangarLight);

let _hangarCollidables = [];
let _hangarBBox = null;

loadModel('assets/sci_fi_hangar.glb', 500, model => {
  if (!model) { console.warn('Hangar GLB failed'); return; }
  model.traverse(c => {
    if (c.isMesh) {
      _hangarCollidables.push(c);
      if (c.material) {
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        mats.forEach(m => {
          m.side = THREE.FrontSide;
          if (m.emissive && (m.emissive.r > 0 || m.emissive.g > 0 || m.emissive.b > 0)) {
            m.emissiveIntensity = (m.emissiveIntensity || 1) * 2;
          }
        });
      }
    }
  });
  hangarScene.add(model);
  _hangarBBox = new THREE.Box3().setFromObject(model);
  console.log('[hangar] loaded, bbox:', _hangarBBox);
});

// ── Hangar customization UI ───────────────────────────────────────────────────
const _hangarUI = document.createElement('div');
_hangarUI.id = 'hangar-ui';
_hangarUI.style.cssText = `
  position:fixed; top:0; left:0; width:280px; height:100vh;
  background:rgba(0,5,15,0.88); border-right:1px solid #0af4;
  display:none; flex-direction:column; z-index:60;
  font-family:'Courier New',monospace; color:#0af;
`;
_hangarUI.innerHTML = `
  <div style="padding:18px 20px 10px; font-size:16px; letter-spacing:3px; border-bottom:1px solid #0af3;">SHIP CUSTOMIZATION</div>
  <div id="hangar-tabs" style="display:flex; border-bottom:1px solid #0af3;">
    <button class="h-tab" data-tab="ship">SHIP</button>
    <button class="h-tab h-tab-active" data-tab="color">COLOR</button>
    <button class="h-tab" data-tab="decals">DECALS</button>
    <button class="h-tab" data-tab="engine">ENGINE</button>
  </div>
  <div id="hangar-panels" style="flex:1; overflow-y:auto; padding:16px;">
    <div id="htab-ship" style="display:none;">
      <div style="font-size:11px;color:#0af8;margin-bottom:14px;letter-spacing:1px;">FIGHTER MODEL</div>
      <div style="display:flex;align-items:center;justify-content:center;gap:14px;">
        <button id="hangar-ship-prev" style="background:rgba(0,170,255,0.12);border:1px solid #0af8;color:#0af;font-size:20px;width:38px;height:38px;border-radius:4px;cursor:pointer;line-height:1;">◀</button>
        <div id="hangar-ship-name" style="min-width:120px;text-align:center;font-size:14px;letter-spacing:1px;color:#fff;"></div>
        <button id="hangar-ship-next" style="background:rgba(0,170,255,0.12);border:1px solid #0af8;color:#0af;font-size:20px;width:38px;height:38px;border-radius:4px;cursor:pointer;line-height:1;">▶</button>
      </div>
    </div>
    <div id="htab-color">
      <div style="font-size:11px;color:#0af8;margin-bottom:10px;letter-spacing:1px;">HULL COLOR</div>
      <div id="hangar-color-swatches" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px;"></div>
      <div style="font-size:11px;color:#0af8;margin-bottom:8px;letter-spacing:1px;">CUSTOM HEX</div>
      <div style="display:flex;gap:8px;align-items:center;">
        <input id="hangar-hex" type="text" maxlength="7" value="#00ccff"
          style="flex:1;background:#001020;border:1px solid #0af5;color:#0af;font-family:'Courier New',monospace;font-size:13px;padding:5px 8px;border-radius:3px;" />
        <button id="hangar-hex-apply" style="background:#0af2;border:1px solid #0af8;color:#0af;font-family:'Courier New',monospace;font-size:11px;padding:5px 10px;cursor:pointer;border-radius:3px;">APPLY</button>
      </div>
    </div>
    <div id="htab-decals" style="display:none;">
      <div style="font-size:11px;color:#0af8;margin-bottom:10px;letter-spacing:1px;">MARKINGS</div>
      <div id="hangar-decal-list" style="display:flex;flex-direction:column;gap:8px;"></div>
    </div>
    <div id="htab-engine" style="display:none;">
      <div style="font-size:11px;color:#0af8;margin-bottom:10px;letter-spacing:1px;">ENGINE TRAIL</div>
      <div id="hangar-engine-list" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
    </div>
  </div>
  <div style="padding:0 16px 8px;display:flex;flex-direction:column;gap:8px;">
    <button id="hangar-launch-btn" style="padding:12px;background:rgba(0,255,100,0.12);border:1px solid #0f6;color:#0f6;font-family:'Courier New',monospace;font-size:14px;letter-spacing:3px;cursor:pointer;">▶  LAUNCH</button>
    <button id="hangar-back-btn" style="padding:10px;background:transparent;border:1px solid #0af6;color:#0af;font-family:'Courier New',monospace;font-size:13px;letter-spacing:2px;cursor:pointer;">[ BACK TO LOBBY ]</button>
  </div>
`;
document.body.appendChild(_hangarUI);

// Tab styles
const _hangarTabStyle = document.createElement('style');
_hangarTabStyle.textContent = `
  .h-tab { flex:1; background:transparent; border:none; border-right:1px solid #0af3;
    color:#0af6; font-family:'Courier New',monospace; font-size:11px; letter-spacing:1px;
    padding:9px 4px; cursor:pointer; transition:background 0.15s; }
  .h-tab:last-child { border-right:none; }
  .h-tab:hover { background:rgba(0,170,255,0.1); }
  .h-tab.h-tab-active { background:rgba(0,170,255,0.18); color:#0ff; }
  #hangar-panels::-webkit-scrollbar { width:4px; }
  #hangar-panels::-webkit-scrollbar-thumb { background:#0af4; border-radius:2px; }
`;
document.head.appendChild(_hangarTabStyle);

// ── Inventory bar ─────────────────────────────────────────────────────────────
let _hasSniper = false;
let _sniperMesh = null;      // currently-equipped weapon's viewmodel mesh
let _equippedWeaponId = null;
const _weaponMeshes = {};    // weapon id -> loaded viewmodel mesh (all preloaded, hidden)
const _weaponAmmo = {};      // weapon id -> current rounds loaded (initialized to magSize on first equip)
let _gunReloading = false;
let _reloadTimer = 0;
let _reloadDuration = 1;

// ── Inventory system ──────────────────────────────────────────────────────────
const INVENTORY_SIZE = 2;
const _inventory = Array(INVENTORY_SIZE).fill(null); // null = empty
let _activeSlot = 0;
// Backing storage for the full inventory panel (press I) — the 2-slot hotbar above is what's
// actually equippable/fireable; this is overflow storage for everything else you own.
const EXTRA_INVENTORY_SIZE = 20;
const _extraInventory = Array(EXTRA_INVENTORY_SIZE).fill(null);

const _inventoryBar = document.createElement('div');
_inventoryBar.id = 'inventory-bar';
_inventoryBar.style.cssText = `
  position:fixed; bottom:12px; left:50%; transform:translateX(-50%);
  display:flex; gap:6px; pointer-events:none; z-index:100;
`;

const _invSlotEls = [];
for (let i = 0; i < INVENTORY_SIZE; i++) {
  const slot = document.createElement('div');
  slot.style.cssText = `
    width:52px; height:52px;
    background:rgba(0,0,0,0.6);
    border:2px solid rgba(0,255,255,0.25);
    box-shadow:0 0 6px rgba(0,255,255,0.1) inset;
    border-radius:3px;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    position:relative; transition:border-color 0.1s;
  `;
  const num = document.createElement('span');
  num.style.cssText = 'position:absolute;bottom:2px;right:4px;color:rgba(0,255,255,0.3);font-family:"Courier New",monospace;font-size:9px;';
  num.textContent = i + 1;
  const icon = document.createElement('div');
  icon.style.cssText = 'font-size:22px;line-height:1;';
  const label = document.createElement('div');
  label.style.cssText = `
    position:absolute; bottom:-14px; left:50%; transform:translateX(-50%);
    color:#0ff; font-family:'Courier New',monospace; font-size:9px; letter-spacing:0.5px;
    white-space:nowrap; text-shadow:0 0 4px #000; display:none;
  `;
  slot.appendChild(icon);
  slot.appendChild(num);
  slot.appendChild(label);
  _inventoryBar.appendChild(slot);
  _invSlotEls.push({ el: slot, icon, label });
}

// Dedicated 3rd slot for grenades — separate from the weapon inventory above (its own
// throw-on-click behavior instead of the aim-and-shoot weapon flow). Not pre-filled —
// both counts start at 0 and have to be bought in the shop. Styled as a circle in orange
// instead of a square in cyan so it reads as a different kind of slot at a glance, not
// just a third gun slot.
const GRENADE_TYPES = {
  frag:  { name: 'Frag Grenade',  icon: '💣', price: 40 },
  smoke: { name: 'Smoke Grenade', icon: '💨', price: 25 },
};
let _grenadeCount = 0;       // frag count
let _smokeGrenadeCount = 0;
let _grenadeType = 'frag';   // which type is currently loaded in the slot
let _grenadeSelected = false;
const _grenadeSlotEl = document.createElement('div');
_grenadeSlotEl.style.cssText = `
  width:52px; height:52px;
  background:rgba(20,10,0,0.6);
  border:2px solid rgba(255,140,0,0.35);
  box-shadow:0 0 6px rgba(255,140,0,0.15) inset;
  border-radius:50%;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  position:relative; transition:border-color 0.1s;
`;
const _grenadeNum = document.createElement('span');
_grenadeNum.style.cssText = 'position:absolute;bottom:2px;right:6px;color:rgba(255,140,0,0.4);font-family:"Courier New",monospace;font-size:9px;';
_grenadeNum.textContent = String(INVENTORY_SIZE + 1);
const _grenadeIcon = document.createElement('div');
_grenadeIcon.style.cssText = 'font-size:22px;line-height:1;';
const _grenadeCountEl = document.createElement('span');
_grenadeCountEl.style.cssText = 'position:absolute;bottom:2px;left:6px;color:#fa0;font-family:"Courier New",monospace;font-size:10px;font-weight:bold;';
const _grenadeLabel = document.createElement('div');
_grenadeLabel.style.cssText = `
  position:absolute; bottom:-14px; left:50%; transform:translateX(-50%);
  color:#fa0; font-family:'Courier New',monospace; font-size:9px; letter-spacing:0.5px;
  white-space:nowrap; text-shadow:0 0 4px #000;
`;
_grenadeSlotEl.appendChild(_grenadeIcon);
_grenadeSlotEl.appendChild(_grenadeNum);
_grenadeSlotEl.appendChild(_grenadeCountEl);
_grenadeSlotEl.appendChild(_grenadeLabel);
_inventoryBar.appendChild(_grenadeSlotEl);
function _grenadeCountFor(type) { return type === 'smoke' ? _smokeGrenadeCount : _grenadeCount; }
function _updateGrenadeSlotUI() {
  const def = GRENADE_TYPES[_grenadeType];
  _grenadeIcon.textContent = def.icon;
  _grenadeIcon.style.opacity = _grenadeCountFor(_grenadeType) > 0 ? '1' : '0.3';
  _grenadeCountEl.textContent = String(_grenadeCountFor(_grenadeType));
  _grenadeLabel.textContent = def.name.toUpperCase();
  _grenadeSlotEl.style.borderColor = _grenadeSelected ? '#ffaa00' : 'rgba(255,140,0,0.35)';
  _grenadeSlotEl.style.boxShadow   = _grenadeSelected
    ? '0 0 12px rgba(255,170,0,0.6) inset, 0 0 8px rgba(255,170,0,0.5)'
    : '0 0 6px rgba(255,140,0,0.15) inset';
  _grenadeSlotEl.style.transform  = _grenadeSelected ? 'translateY(-4px)' : 'none';
}
_updateGrenadeSlotUI();

document.body.appendChild(_inventoryBar);

// Weapon definitions — all weapons share identical fire/scope/recoil mechanics (see
// _fireSniper / _updateSniperShots), only the viewmodel mesh + shop copy differ.
// viewSize: loadModel's targetSize (bigger guns need a bigger normalized scale so they
// don't look tiny). viewFwd: how far out in front of the camera the gun sits — smaller
// guns need a bigger forward offset relative to their size or they end up too close.
const WEAPON_DEFS = {
  // cooldown: frames between shots. auto: holding the trigger keeps firing. spread: random
  // aim deviation per shot (radians). pellets: number of projectiles fired per trigger pull.
  // magSize: rounds per magazine. reloadTime: frames the reload shake takes. damage: HP per
  // projectile that lands on a player (shotgun pellets each do their own smaller damage).
  sniper:    { name: 'Sniper Rifle', desc: 'Long-range precision weapon<br>RMB to zoom scope', asset: 'assets/sniper_c.glb', viewSize: 40, viewFwd: 14, cooldown: 60, pellets: 1, spread: 0, magSize: 1, reloadTime: 150, icon: '🎯', damage: 100, price: 400, sound: 'assets/sounds/sniper_shot.mp3', soundVolume: 0.45 },
  pistol:    { name: 'Pistol',       desc: 'Sidearm — fast to draw',                            asset: 'assets/pistol_c.glb', viewSize: 18, viewFwd: 22, viewRight: 10, viewUp: -9, cooldown: 18, pellets: 1, spread: 0.008, magSize: 12, reloadTime: 100, icon: '🔫', damage: 30, price: 100, sound: 'assets/sounds/pistol_shot.mp3', soundVolume: 0.35 },
  pistol9mm: { name: '9mm Pistol',   desc: 'Standard-issue 9mm sidearm',                        asset: 'assets/9mm_pistol_c.glb', viewSize: 18, viewFwd: 22, viewYaw: Math.PI / 2, viewRight: 10, viewUp: -9, cooldown: 18, pellets: 1, spread: 0.008, magSize: 12, reloadTime: 100, icon: '🔫', damage: 30, price: 100, sound: 'assets/sounds/pistol_shot.mp3', soundVolume: 0.35 },
  ak105:     { name: 'AK-105',       desc: 'Compact automatic rifle',                           asset: 'assets/ak-105_c.glb', viewSize: 40, viewFwd: 14, viewYaw: Math.PI, cooldown: 18, pellets: 1, spread: 0.025, auto: true, magSize: 30, reloadTime: 140, recoil: 22, recoilMag: 0.5, icon: '🔥', damage: 26, price: 350, sound: 'assets/sounds/machine_gun.mp3', soundVolume: 0.3 },
  ak47:      { name: 'AK-47',        desc: 'Classic automatic rifle',                           asset: 'assets/ak-47_kalashnikov_c.glb', viewSize: 40, viewFwd: 14, viewYaw: Math.PI, cooldown: 20, pellets: 1, spread: 0.03, auto: true, magSize: 30, reloadTime: 140, recoil: 22, recoilMag: 0.5, icon: '💥', damage: 28, price: 350, sound: 'assets/sounds/machine_gun.mp3', soundVolume: 0.3 },
  shotgun:   { name: 'Shotgun',      desc: 'Close-range heavy hitter',                          asset: 'assets/shotgun_c.glb', viewSize: 34, viewFwd: 16, viewYaw: Math.PI / 2, viewUp: -9, cooldown: 50, pellets: 10, spread: 0.09, magSize: 6, reloadTime: 170, icon: '💢', damage: 17, price: 300, sound: 'assets/sounds/shotgun_blast.mp3', soundVolume: 0.4 },
};
// SFX helper — Web Audio buffers instead of plain `new Audio(url)`. A fresh HTMLAudioElement
// has to spin up its whole media pipeline (fetch/parse/decode) before playback actually
// starts, which is exactly the "click... *pause*... bang" delay on gunfire — noticeable even
// once cached, since decode still happens per element. Decoding each sound into an
// AudioBuffer once up front and firing it through a new BufferSourceNode per play gets
// sample-accurate, zero-setup-latency playback (the browser's autoplay policy still means
// the context won't actually produce sound until after the first user gesture, same as
// everything else audio-related here).
// latencyHint 'interactive' asks the browser to favor lower output latency over power
// savings/glitch-safety — the default hint can add tens of ms of buffering that's fine for
// music but is exactly the kind of "slightly delayed" gap you'd notice on a gunshot.
const _sfxCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
const _sfxBuffers = {}; // url -> Promise<AudioBuffer>
function _preloadSfx(url) {
  if (_sfxBuffers[url]) return _sfxBuffers[url];
  _sfxBuffers[url] = fetch(url)
    .then(r => r.arrayBuffer())
    .then(buf => _sfxCtx.decodeAudioData(buf))
    .catch(() => null);
  return _sfxBuffers[url];
}
function _playSfx(url, volume) {
  // resume() is async — if a shot fires while the context is still suspended (e.g. right
  // after page load, before it's had a chance to resume from the startup click), scheduling
  // the source without waiting for resume() to actually finish let the browser queue it
  // until resume completed, which is exactly an extra, inconsistent delay on top of decode.
  const ctxReady = _sfxCtx.state === 'suspended' ? _sfxCtx.resume() : Promise.resolve();
  Promise.all([_preloadSfx(url), ctxReady]).then(([buffer]) => {
    if (!buffer) return;
    const src = _sfxCtx.createBufferSource();
    src.buffer = buffer;
    const gain = _sfxCtx.createGain();
    gain.gain.value = volume != null ? volume : 0.4;
    src.connect(gain).connect(_sfxCtx.destination);
    src.start(0);
  });
}
[
  'assets/sounds/pistol_shot.mp3', 'assets/sounds/machine_gun.mp3', 'assets/sounds/shotgun_blast.mp3',
  'assets/sounds/sniper_shot.mp3', 'assets/sounds/grenade_explosion.mp3', 'assets/sounds/reload.mp3',
  'assets/sounds/slide.mp3',
].forEach(_preloadSfx);
const WEAPON_IDS = Object.keys(WEAPON_DEFS);

// Item definitions
const _itemDefs = {
  sniper: { name: 'Sniper Rifle' },
};

function _invSetActive(idx) {
  _activeSlot = (idx + INVENTORY_SIZE) % INVENTORY_SIZE;
  _grenadeSelected = false; // picking a weapon slot always drops out of grenade mode
  _updateGrenadeSlotUI();
  _invSlotEls.forEach((s, i) => {
    s.el.style.borderColor = i === _activeSlot ? '#0ff' : 'rgba(0,255,255,0.25)';
    s.el.style.boxShadow   = i === _activeSlot
      ? '0 0 12px rgba(0,255,255,0.5) inset, 0 0 8px rgba(0,255,255,0.4)'
      : '0 0 6px rgba(0,255,255,0.1) inset';
    s.el.style.transform   = i === _activeSlot ? 'translateY(-4px)' : 'none';
  });
  // Show the weapon viewmodel only if the active slot holds a weapon
  _equippedWeaponId = WEAPON_IDS.includes(_inventory[_activeSlot]) ? _inventory[_activeSlot] : null;
  _ensureWeaponModelLoaded(_equippedWeaponId); // kicks off the download the first time this weapon is ever equipped
  _hasSniper = !!_equippedWeaponId;
  Object.entries(_weaponMeshes).forEach(([wid, m]) => { if (m) m.visible = false; });
  _sniperMesh = _equippedWeaponId ? (_weaponMeshes[_equippedWeaponId] || null) : null;
  _gunReloading = false; // switching weapons cancels any in-progress reload
  if (_equippedWeaponId && _weaponAmmo[_equippedWeaponId] === undefined) {
    const def = WEAPON_DEFS[_equippedWeaponId];
    _weaponAmmo[_equippedWeaponId] = def ? def.magSize : 0;
  }
}

function _invAddItem(itemId) {
  // Put in first empty hotbar slot; if the 2-slot hotbar is full, overflow into the
  // 20-slot storage inventory instead of just failing.
  const emptyIdx = _inventory.indexOf(null);
  if (emptyIdx === -1) { _extraInvAddItem(itemId); return; }
  _inventory[emptyIdx] = itemId;
  const def = _itemDefs[itemId];
  const wdef = WEAPON_DEFS[itemId];
  // 3D render-to-icon can silently fail (texture not decoded yet, etc.) — always set a
  // reliable emoji icon first so the slot never ends up blank.
  _invSlotEls[emptyIdx].icon.textContent = wdef ? wdef.icon : (def ? def.icon : '?');
  if (wdef) {
    _invSlotEls[emptyIdx].label.textContent = wdef.name;
    _invSlotEls[emptyIdx].label.style.display = 'block';
  }
  _invSetActive(emptyIdx); // auto-select the new item
}

function _extraInvAddItem(itemId) {
  const emptyIdx = _extraInventory.indexOf(null);
  if (emptyIdx === -1) return; // hotbar AND storage both full — nowhere left to put it
  _extraInventory[emptyIdx] = itemId;
  if (typeof _renderInventoryPanel === 'function' && inventoryOpen) _renderInventoryPanel();
}

// Selecting the grenade slot hides whatever weapon viewmodel was up (grenades are thrown
// by hand, not aimed-and-fired like a gun) but otherwise leaves the weapon in its slot
// untouched so switching back to it resumes with the same ammo/reload state.
function _selectGrenadeSlot() {
  _grenadeSelected = true;
  _equippedWeaponId = null;
  _hasSniper = false;
  Object.entries(_weaponMeshes).forEach(([wid, m]) => { if (m) m.visible = false; });
  _sniperMesh = null;
  _invSlotEls.forEach(s => {
    s.el.style.borderColor = 'rgba(0,255,255,0.25)';
    s.el.style.boxShadow   = '0 0 6px rgba(0,255,255,0.1) inset';
    s.el.style.transform   = 'none';
  });
  // If you don't actually own whatever type was last loaded (e.g. you've only ever
  // bought smoke grenades), switch to whichever type you do own instead of showing an
  // empty frag slot by default.
  if (_grenadeCountFor(_grenadeType) === 0) {
    const other = _grenadeType === 'frag' ? 'smoke' : 'frag';
    if (_grenadeCountFor(other) > 0) _grenadeType = other;
  }
  _updateGrenadeSlotUI();
}

// Pressing 3 again while the grenade slot is already active cycles between grenade types
// — but only if you actually own both, otherwise there's nothing to switch to.
function _cycleGrenadeType() {
  if (_grenadeCount <= 0 || _smokeGrenadeCount <= 0) return;
  _grenadeType = _grenadeType === 'frag' ? 'smoke' : 'frag';
  _updateGrenadeSlotUI();
}

// Switch slots with number keys — 1/2 for the weapon inventory, 3 for grenades
window.addEventListener('keydown', e => {
  const n = parseInt(e.key);
  if (n >= 1 && n <= INVENTORY_SIZE) { _invSetActive(n - 1); }
  else if (n === INVENTORY_SIZE + 1) {
    if (_grenadeSelected) _cycleGrenadeType();
    else _selectGrenadeSlot();
  }
});

// Switch slots with scroll wheel
window.addEventListener('wheel', e => {
  if (document.pointerLockElement) {
    _invSetActive(_activeSlot + (e.deltaY > 0 ? 1 : -1));
  }
}, { passive: true });

// Init — highlight slot 1
_invSetActive(0);

// Tab switching
_hangarUI.querySelectorAll('.h-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    _hangarUI.querySelectorAll('.h-tab').forEach(b => b.classList.remove('h-tab-active'));
    btn.classList.add('h-tab-active');
    ['ship','color','decals','engine'].forEach(t => {
      document.getElementById('htab-' + t).style.display = t === btn.dataset.tab ? 'block' : 'none';
    });
  });
});

// Ship picker — left/right arrows cycle through SHIP_DEFS, swapping the actual flyable
// model (selfMesh) and the hangar display ship live, and persisting the choice for next
// time (index.html's preload reads it too).
const _shipNameEl = document.getElementById('hangar-ship-name');
const SHIP_IDS = Object.keys(SHIP_DEFS);
function _renderShipList() {
  _shipNameEl.textContent = SHIP_DEFS[_selectedShipId].name;
}
function _selectShip(id) {
  if (id === _selectedShipId || !SHIP_DEFS[id]) return;
  _selectedShipId = id;
  localStorage.setItem(SHIP_STORAGE_KEY, id);
  _renderShipList();
  _loadHangarDisplayShip();
  _loadSelfShipModel();
}
function _cycleShip(dir) {
  const idx = SHIP_IDS.indexOf(_selectedShipId);
  const nextIdx = (idx + dir + SHIP_IDS.length) % SHIP_IDS.length;
  _selectShip(SHIP_IDS[nextIdx]);
}
document.getElementById('hangar-ship-prev').addEventListener('click', () => _cycleShip(-1));
document.getElementById('hangar-ship-next').addEventListener('click', () => _cycleShip(1));
// Swaps the model attached to the player's actual flyable ship — mirrors the same
// "strip everything except camera/glow/light, then attach the new model" logic the
// initial waitForShip() preload swap uses, so switching mid-session behaves identically
// to picking a ship before ever launching.
let _userPickedShipColor = false; // only re-tint on ship switch if the player actually chose a color
function _loadSelfShipModel() {
  loadModel(_selectedShipAsset(), 20, model => {
    if (!model) return;
    _normalizeShipModel(model, 20 * _selectedShipSizeMul(), _selectedShipYawOffset());
    const keepGlow  = selfMesh.userData.glowMesh;
    const keepLight = selfMesh.userData.engineLight;
    selfMesh.children.slice().forEach(c => { if (c !== camera && c !== keepGlow && c !== keepLight) selfMesh.remove(c); });
    selfMesh.add(model);
    // A ship's own materials carry its real, often multi-color paint scheme (checked: the
    // Star Wing alone has grey/black/red/yellow-green/white/blue parts) — auto-applying
    // the hull-color tint on every switch flattened all of that into one solid color even
    // when the player never touched the color picker. Only reapply it if they actually did.
    if (_userPickedShipColor) _applyShipColor(document.getElementById('hangar-hex').value);
  });
}
_renderShipList();

// Color swatches
const _shipColors = ['#00ccff','#ff4400','#00ff88','#ffdd00','#ff00aa','#8844ff','#ffffff','#444444'];
const _swatchEl = document.getElementById('hangar-color-swatches');
_shipColors.forEach(hex => {
  const s = document.createElement('div');
  s.style.cssText = `width:36px;height:36px;border-radius:4px;background:${hex};cursor:pointer;border:2px solid transparent;transition:border-color 0.15s;`;
  s.title = hex;
  s.addEventListener('click', () => { _userPickedShipColor = true; _applyShipColor(hex); document.getElementById('hangar-hex').value = hex; });
  s.addEventListener('mouseenter', () => { s.style.borderColor = '#fff'; });
  s.addEventListener('mouseleave', () => { s.style.borderColor = 'transparent'; });
  _swatchEl.appendChild(s);
});
document.getElementById('hangar-hex-apply').addEventListener('click', () => {
  _userPickedShipColor = true;
  _applyShipColor(document.getElementById('hangar-hex').value);
});

// Decals
const _decals = ['NONE','STAR','SKULL','LIGHTNING','FLAME','ACE'];
const _decalList = document.getElementById('hangar-decal-list');
_decals.forEach(d => {
  const btn = document.createElement('button');
  btn.textContent = d;
  btn.style.cssText = 'background:transparent;border:1px solid #0af4;color:#0af;font-family:\'Courier New\',monospace;font-size:12px;padding:7px 12px;cursor:pointer;letter-spacing:1px;text-align:left;';
  btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(0,170,255,0.12)');
  btn.addEventListener('mouseleave', () => btn.style.background = 'transparent');
  _decalList.appendChild(btn);
});

// Engine colors
const _engineColors = ['#00ccff','#ff6600','#00ff44','#ff00ff','#ffff00','#ff2200'];
const _engineList = document.getElementById('hangar-engine-list');
_engineColors.forEach(hex => {
  const s = document.createElement('div');
  s.style.cssText = `width:36px;height:36px;border-radius:50%;background:${hex};cursor:pointer;border:2px solid transparent;box-shadow:0 0 8px ${hex};transition:border-color 0.15s;`;
  s.addEventListener('click', () => { /* future: change engine glow color */ });
  s.addEventListener('mouseenter', () => { s.style.borderColor = '#fff'; });
  s.addEventListener('mouseleave', () => { s.style.borderColor = 'transparent'; });
  _engineList.appendChild(s);
});

document.getElementById('hangar-back-btn').addEventListener('click', exitHangar);
document.getElementById('hangar-launch-btn').addEventListener('click', () => {
  _hangarUI.style.display = 'none';
  document.body.style.cursor = 'none';
  hangarScene.visible = false;
  _hangarAmbient.intensity = 0;
  _hangarLight.intensity = 0;
  exitStation();
  renderer.domElement.requestPointerLock();
});

function _applyShipColor(hex) {
  const col = new THREE.Color(hex);
  // material.color multiplies straight into any texture map it has (that's how Three.js
  // combines a base color with a diffuse texture) — force-tinting textured materials here
  // was washing out real ship textures with whatever hull color happened to be selected
  // (including the default, on every single ship switch, not just an explicit color pick).
  // Only tint flat/untextured materials; leave anything with its own texture alone.
  if (_hangarShip) _hangarShip.traverse(c => {
    if (c.isMesh && c.material) {
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach(m => { if (m.color && !m.map) m.color.set(col); });
    }
  });
  // Also tint the player's actual ship
  selfMesh.traverse(c => {
    if (c.isMesh && c.material) {
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach(m => { if (m.color && !m.map) m.color.set(col); });
    }
  });
}

// Fixed hangar camera target (looks at ship hover position)
const _hangarCamPos = new THREE.Vector3(0, 30, -60);
const _hangarCamTarget = new THREE.Vector3(0, 22, 78);

function enterHangarFromFlight() {
  _restoreSceneLights(); // reset from flight first, then kill
  gameMode = 'hangar';
  _killAllExteriorLights();
  _iAmbient.intensity = 0;
  _iLight.intensity = 0;
  interiorScene.visible = false;
  lobbyScene.visible = false;
  hangarScene.visible = true;
  _hangarAmbient.intensity = 1.0;
  _hangarLight.intensity = 1.2;
  _hangarUI.style.display = 'flex';
  dockPrompt.style.display = 'none';
  exitPrompt.style.display = 'none';
  document.exitPointerLock();
  document.body.style.cursor = 'default';
  camera.position.set(0, 32, 20);
  camera.lookAt(_hangarCamTarget);
  renderer.toneMappingExposure = 0.6;
  if (_hangarCollidables.length === 0) {
    _showLoadingScreen('LOADING HANGAR', () => _hangarCollidables.length > 0, { timeoutMs: 10000 });
  }
}

function enterHangar() {
  gameMode = 'hangar';
  _killAllExteriorLights();
  _iAmbient.intensity = 0;
  _iLight.intensity = 0;
  lobbyScene.visible = false;
  hangarScene.visible = true;
  _hangarAmbient.intensity = 1.0;
  _hangarLight.intensity = 1.2;
  _hangarPrompt.style.display = 'none';
  _hangarUI.style.display = 'flex';
  document.exitPointerLock();
  document.body.style.cursor = 'default';
  camera.position.set(0, 32, 20);
  camera.lookAt(_hangarCamTarget);
  renderer.toneMappingExposure = 0.6;
  if (_hangarCollidables.length === 0) {
    _showLoadingScreen('LOADING HANGAR', () => _hangarCollidables.length > 0, { timeoutMs: 10000 });
  }
}

function exitHangar() {
  gameMode = 'lobby';
  _killAllExteriorLights();
  _iAmbient.intensity = 0;
  _iLight.intensity = 0;
  hangarScene.visible = false;
  lobbyScene.visible = true;
  _lobbyAmbient.intensity = 1.2;
  _lobbyLight.intensity = 1.0;
  _hangarUI.style.display = 'none';
  document.body.style.cursor = 'none';
  fpPos.set(0, -7.5, 0);
  fpVel.set(0, 0, 0);
  _fpJumpVel = 0;
  fpYaw = 0; fpPitch = 0;
  camera.position.copy(fpPos);
  renderer.toneMappingExposure = 0.8;
  renderer.domElement.requestPointerLock();
}

// ── Hangar display ship ────────────────────────────────────────────────────────
let _hangarShip = null;
function _loadHangarDisplayShip() {
  if (_hangarShip) { hangarScene.remove(_hangarShip); _hangarShip = null; }
  loadModel(_selectedShipAsset(), 60, model => {
    if (!model) return;
    // _normalizeShipModel sets the model's own position to center it around its local
    // origin — wrap it in a group so that centering isn't clobbered by placing the display
    // spot in the hangar scene below (both would otherwise fight over the same position).
    _normalizeShipModel(model, 60 * _selectedShipSizeMul(), _selectedShipYawOffset());
    model.traverse(c => {
      if (c.isMesh && c.material) {
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        mats.forEach(m => {
          const basic = new THREE.MeshBasicMaterial({ map: m.map || null, color: m.color ? m.color.clone() : 0x00ccff });
          Object.assign(c, { material: basic });
        });
      }
    });
    const holder = new THREE.Group();
    holder.add(model);
    holder.position.set(0, 22, 78);
    _hangarShip = holder;
    hangarScene.add(_hangarShip);
  });
}
_loadHangarDisplayShip();

const _fpRaycaster = new THREE.Raycaster();
const _fpRayDir = new THREE.Vector3();
let _doorPos = null; // world position of the C-1 Capsule exit door

const _roomMatSnapshot = []; // { mat, emissiveIntensity, color }

loadModel('assets/sci-fi_interior_room.glb', 300, model => {
  if (!model) { console.warn('Interior GLB failed'); return; }
  model.traverse(c => {
    if (c.isMesh) {
      _roomCollidables.push(c);
      const mats = c.material ? (Array.isArray(c.material) ? c.material : [c.material]) : [];
      mats.forEach(m => {
        if (m.emissive && m.emissiveIntensity !== undefined) {
          m.emissiveIntensity = (m.emissiveIntensity || 1) * 6;
        }
        // Snapshot the post-load state so we can restore it exactly
        _roomMatSnapshot.push({
          mat: m,
          emissiveIntensity: m.emissiveIntensity,
          color: m.color ? m.color.clone() : null,
        });
      });
      // Find the door by name — log all mesh names so we can identify it
      console.log('[room mesh]', c.name);
    }
  });
  interiorScene.add(model);
  // Compute room bounds AFTER adding to scene so world matrix is correct
  _roomBBox = new THREE.Box3().setFromObject(model);
  _addRoomWelcomeScreen();

  // Find door mesh — look for "capsule", "door", "exit", or "C1" in name (case-insensitive)
  const doorKeywords = /capsule|door|exit|c.?1|hatch|airlock/i;
  let bestDoor = null;
  model.traverse(c => {
    if ((c.isMesh || c.isObject3D) && doorKeywords.test(c.name) && !bestDoor) {
      bestDoor = c;
    }
  });
  if (bestDoor) {
    _doorPos = new THREE.Vector3();
    bestDoor.getWorldPosition(_doorPos);
    console.log('[door found]', bestDoor.name, _doorPos);
  } else {
    _doorPos = new THREE.Vector3(-64, 2, 95);
  }

  // Add visible walls on the two open sides
  const bx = _roomBBox;
  const roomW = bx.max.x - bx.min.x;
  const roomH = bx.max.y - bx.min.y;
  const roomD = bx.max.z - bx.min.z;
  const cx = (bx.min.x + bx.max.x) / 2;
  const cy = (bx.min.y + bx.max.y) / 2;
  const cz = (bx.min.z + bx.max.z) / 2;

  // Panel grid texture baked via canvas
  const wallCanvas = document.createElement('canvas');
  wallCanvas.width = wallCanvas.height = 512;
  const wctx = wallCanvas.getContext('2d');
  wctx.fillStyle = '#b0b4b8';
  wctx.fillRect(0, 0, 512, 512);
  // Large panels
  wctx.strokeStyle = '#7a7e82';
  wctx.lineWidth = 3;
  for (let i = 0; i <= 512; i += 128) { wctx.beginPath(); wctx.moveTo(i,0); wctx.lineTo(i,512); wctx.stroke(); }
  for (let j = 0; j <= 512; j += 128) { wctx.beginPath(); wctx.moveTo(0,j); wctx.lineTo(512,j); wctx.stroke(); }
  // Inner panel bevel lines
  wctx.strokeStyle = '#c8ccce';
  wctx.lineWidth = 1;
  for (let i = 0; i < 512; i += 128) for (let j = 0; j < 512; j += 128) {
    wctx.strokeRect(i+6, j+6, 116, 116);
  }
  // Corner bolts
  for (let i = 64; i < 512; i += 128) for (let j = 64; j < 512; j += 128) {
    wctx.fillStyle = '#7a7e82'; wctx.beginPath(); wctx.arc(i, j, 5, 0, Math.PI*2); wctx.fill();
    wctx.fillStyle = '#d0d4d8'; wctx.beginPath(); wctx.arc(i, j, 2, 0, Math.PI*2); wctx.fill();
  }
  const wallTex = new THREE.CanvasTexture(wallCanvas);
  wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;

  // Emissive texture — just the glow strips
  const emCanvas = document.createElement('canvas');
  emCanvas.width = emCanvas.height = 512;
  const ectx = emCanvas.getContext('2d');
  ectx.fillStyle = '#c0c4c8';
  ectx.fillRect(0, 0, 512, 512);
  const emTex = new THREE.CanvasTexture(emCanvas);
  emTex.wrapS = emTex.wrapT = THREE.RepeatWrapping;

  function makeWall(w, h, rx, ry, rz, px, py, pz) {
    const geo = new THREE.PlaneGeometry(w, h);
    const repW = Math.max(1, Math.round(w / 100));
    const repH = Math.max(1, Math.round(h / 100));
    const tex = wallTex.clone(); tex.needsUpdate = true;
    tex.repeat.set(repW, repH);
    const em  = emTex.clone();  em.needsUpdate = true;
    em.repeat.set(repW, repH);
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      emissiveMap: em,
      emissive: new THREE.Color(0xc0c4c8),
      emissiveIntensity: 1.2,
      roughness: 0.7,
      metalness: 0.5,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.set(rx, ry, rz);
    mesh.position.set(px, py, pz);
    _roomCollidables.push(mesh);
    interiorScene.add(mesh);
  }

  // All four sides — two may already have room geometry, the open ones will be filled
  makeWall(roomW, roomH, 0, Math.PI,      0,  cx, cy, bx.max.z); // +Z
  makeWall(roomW, roomH, 0, 0,            0,  cx, cy, bx.min.z); // -Z
  makeWall(roomD, roomH, 0, Math.PI/2,    0,  bx.max.x, cy, cz); // +X
  makeWall(roomD, roomH, 0, -Math.PI/2,   0,  bx.min.x, cy, cz); // -X
});

const dockPrompt = document.createElement('div');
dockPrompt.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);color:#0ff;font-family:monospace;font-size:15px;letter-spacing:3px;text-shadow:0 0 10px #0ff;pointer-events:none;display:none;';
dockPrompt.textContent = '[ E ]  DOCK AT STATION';
document.body.appendChild(dockPrompt);

const landPrompt = document.createElement('div');
landPrompt.style.cssText = 'position:fixed;bottom:120px;left:50%;transform:translateX(-50%);color:#f80;font-family:monospace;font-size:15px;letter-spacing:3px;text-shadow:0 0 12px #f80;pointer-events:none;display:none;text-align:center;';
landPrompt.innerHTML = '[ E ]  LAND ON PLANET<br><span style="font-size:11px;color:#aaa;letter-spacing:1px;">GRAVITY FIELD DETECTED — ENGINES DAMPENED</span>';
document.body.appendChild(landPrompt);

let _nearPlanet = null; // planet currently in landing range

const exitPrompt = document.createElement('div');
exitPrompt.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);color:#adf;font-family:monospace;font-size:13px;letter-spacing:2px;pointer-events:none;display:none;';
exitPrompt.textContent = '[ E ]  EXIT STATION';
document.body.appendChild(exitPrompt);

// Weapons locked notice
const _weaponsLockedEl = document.createElement('div');
_weaponsLockedEl.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#f00;font-family:monospace;font-size:15px;letter-spacing:3px;text-shadow:0 0 12px #f00;pointer-events:none;display:none;text-align:center;';
_weaponsLockedEl.innerHTML = '🔒 WEAPONS LOCKED<br><span style="font-size:11px;color:#f88;letter-spacing:2px;">SAFE ZONE — EXIT TO ENGAGE</span>';
document.body.appendChild(_weaponsLockedEl);
let _weaponsLockedTimer = 0;
function showWeaponsLocked() {
  _weaponsLockedEl.style.display = 'block';
  _weaponsLockedTimer = 90;
}

// Heat bar
const _heatBarWrap = document.createElement('div');
_heatBarWrap.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);width:160px;pointer-events:none;display:none;';
_heatBarWrap.innerHTML = `
  <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#f84;text-align:center;margin-bottom:3px;" id="heat-label">HEAT</div>
  <div style="background:rgba(0,0,0,0.5);border:1px solid #555;border-radius:3px;height:6px;overflow:hidden;">
    <div id="heat-fill" style="height:100%;width:0%;background:#f84;border-radius:3px;transition:background 0.1s;"></div>
  </div>`;
document.body.appendChild(_heatBarWrap);
const _heatFill  = _heatBarWrap.querySelector('#heat-fill');
const _heatLabel = _heatBarWrap.querySelector('#heat-label');

function updateHeatBar() {
  if (gameMode !== 'flight') { _heatBarWrap.style.display = 'none'; return; }
  _heatBarWrap.style.display = _laserHeat > 0 || _laserOverheated ? 'block' : 'none';
  const pct = (_laserHeat / LASER_OVERHEAT * 100).toFixed(1);
  _heatFill.style.width = pct + '%';
  if (_laserOverheated) {
    _heatFill.style.background = '#f00';
    _heatLabel.textContent = 'OVERHEATED';
    _heatLabel.style.color = '#f00';
  } else {
    const hot = _laserHeat / LASER_OVERHEAT;
    _heatFill.style.background = `rgb(${Math.round(255)},${Math.round((1-hot)*140)},0)`;
    _heatLabel.textContent = 'HEAT';
    _heatLabel.style.color = '#f84';
  }
}

// Objects to hide when entering the interior dimension
const _spaceObjects = () => [selfMesh, station, ...(skyboxMesh ? [skyboxMesh] : [])];

// ── Room Hub menu ─────────────────────────────────────────────────────────────
const _HUB_Z_MIN = -131, _HUB_Z_MAX = -45, _HUB_X_MIN = -79, _HUB_X_MAX = 92;

const roomHubEl = document.createElement('div');
roomHubEl.style.cssText = `
  position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
  background:rgba(0,5,15,0.92); border:1px solid #0ff;
  border-radius:10px; padding:28px 40px; min-width:260px;
  font-family:'Courier New',monospace; color:#0ff;
  text-align:center; pointer-events:none; display:none;
  box-shadow:0 0 30px rgba(0,255,255,0.15);
`;
roomHubEl.innerHTML = `
  <div style="font-size:18px;letter-spacing:4px;margin-bottom:20px;text-shadow:0 0 10px #0ff;">ROOM HUB</div>
  <div style="display:flex;flex-direction:column;gap:12px;">
    <div class="hub-opt" data-opt="shop"  style="border:1px solid #0ff;border-radius:5px;padding:10px 0;font-size:14px;letter-spacing:3px;cursor:pointer;transition:background 0.2s;">SHOP</div>
    <div class="hub-opt" data-opt="bounties" style="border:1px solid #0ff;border-radius:5px;padding:10px 0;font-size:14px;letter-spacing:3px;cursor:pointer;">BOUNTIES</div>
    <div class="hub-opt" data-opt="room"  style="border:1px solid #0ff;border-radius:5px;padding:10px 0;font-size:14px;letter-spacing:3px;cursor:pointer;">ROOM</div>
    <div class="hub-opt" data-opt="ship"  style="border:1px solid #0ff;border-radius:5px;padding:10px 0;font-size:14px;letter-spacing:3px;cursor:pointer;">SHIP</div>
  </div>
  <div style="margin-top:16px;font-size:11px;color:#555;letter-spacing:2px;">[ ESC ]  CLOSE</div>
`;
document.body.appendChild(roomHubEl);

const hubApproachPrompt = document.createElement('div');
hubApproachPrompt.style.cssText = 'position:fixed;bottom:150px;left:50%;transform:translateX(-50%);color:#0ff;font-family:monospace;font-size:15px;letter-spacing:3px;text-shadow:0 0 10px #0ff;pointer-events:none;display:none;';
hubApproachPrompt.textContent = '[ E ]  ROOM HUB';
document.body.appendChild(hubApproachPrompt);

let hubOpen = false;
let hubSelected = 0;
const hubOptions = ['SHOP', 'BOUNTIES', 'ROOM', 'SHIP'];

function hubSelect(idx) {
  hubOpen = false;
  roomHubEl.style.display = 'none';
  const opt = hubOptions[idx].toLowerCase();
  if (opt === 'shop') { openShop(); return; }
  if (opt === 'bounties') { openBounties(); return; }
  if (opt === 'room') { openRoomCustom(); return; }
  if (opt === 'ship') { openShipUpgrades(); return; }
}

function openHub() {
  hubOpen = true;
  hubSelected = 0;
  renderHub();
  roomHubEl.style.pointerEvents = 'auto';
  roomHubEl.style.display = 'block';
  document.exitPointerLock();
  // exitPointerLock() only fires 'pointerlockchange' (which restores the cursor) if the
  // pointer was actually locked — if it wasn't, the cursor stayed invisible (cursor:none
  // on body) even though the hub is open and clickable. Set it directly instead of relying
  // on that event.
  document.body.style.cursor = 'auto';
}
function closeHub() {
  hubOpen = false;
  roomHubEl.style.display = 'none';
  hubApproachPrompt.style.display = 'none';
  document.body.style.cursor = 'none';
  // do NOT re-lock — let the click-to-play overlay handle it
}
function renderHub() {
  roomHubEl.querySelectorAll('.hub-opt').forEach((el, i) => {
    el.style.background = i === hubSelected ? 'rgba(0,255,255,0.12)' : 'transparent';
    el.style.color = i === hubSelected ? '#fff' : '#0ff';
    el.style.boxShadow = i === hubSelected ? '0 0 8px rgba(0,255,255,0.3)' : 'none';
  });
}

// Hover + click on hub options
roomHubEl.querySelectorAll('.hub-opt').forEach((el, i) => {
  el.addEventListener('mouseenter', () => { hubSelected = i; renderHub(); });
  el.addEventListener('click', () => hubSelect(i));
});

document.addEventListener('keydown', e => {
  if (!hubOpen) return;
  if (e.key === 'Escape') { closeHub(); e.stopPropagation(); return; }
  if (e.key === 'ArrowUp')   { hubSelected = (hubSelected - 1 + hubOptions.length) % hubOptions.length; renderHub(); e.preventDefault(); }
  if (e.key === 'ArrowDown') { hubSelected = (hubSelected + 1) % hubOptions.length; renderHub(); e.preventDefault(); }
  if (e.key === 'Enter') { hubSelect(hubSelected); e.preventDefault(); }
});

// ── Shared panel factory ──────────────────────────────────────────────────────
function makePanel(title, color, id) {
  const el = document.createElement('div');
  el.style.cssText = `
    position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
    background:rgba(0,5,15,0.95); border:1px solid ${color};
    border-radius:10px; padding:28px 40px; min-width:320px;
    font-family:'Courier New',monospace; color:${color};
    text-align:center; pointer-events:auto; display:none;
    box-shadow:0 0 30px ${color}26;
  `;
  el.innerHTML = `
    <div style="font-size:18px;letter-spacing:4px;margin-bottom:20px;text-shadow:0 0 10px ${color};">${title}</div>
    <div style="color:#555;font-size:13px;letter-spacing:2px;margin-bottom:24px;">COMING SOON</div>
    <div style="border:1px solid ${color};border-radius:5px;padding:10px 0;font-size:13px;letter-spacing:3px;cursor:pointer;" id="${id}-close">[ BACK ]</div>
  `;
  document.body.appendChild(el);
  return el;
}

// ── Inventory panel (I to open) ─────────────────────────────────────────────────
// The bottom hotbar (_inventory, INVENTORY_SIZE=2) stays the only equippable/fireable
// slots — this panel is just a way to see + rearrange the hotbar plus the 20-slot
// overflow storage (_extraInventory) it feeds into. Click a slot to pick it up, click
// another to swap — works between hotbar<->hotbar, hotbar<->storage, storage<->storage.
let inventoryOpen = false;
let _invSelected = null; // { type: 'hotbar'|'extra', idx } or null
const _invPanelEl = makePanel('INVENTORY', '#0ff', 'inv');
function _invSlotHtml(type, idx, itemId, isActive) {
  const wdef = itemId ? WEAPON_DEFS[itemId] : null;
  const selected = _invSelected && _invSelected.type === type && _invSelected.idx === idx;
  const borderColor = selected ? '#ff0' : (isActive ? '#0ff' : 'rgba(0,255,255,0.25)');
  const boxShadow = selected
    ? '0 0 12px rgba(255,255,0,0.6) inset, 0 0 8px rgba(255,255,0,0.5)'
    : (isActive ? '0 0 12px rgba(0,255,255,0.5) inset, 0 0 8px rgba(0,255,255,0.4)' : '0 0 6px rgba(0,255,255,0.1) inset');
  return `<div data-inv-slot data-inv-type="${type}" data-inv-idx="${idx}" title="${wdef ? wdef.name : 'Empty'}"
    style="width:52px;height:52px;background:rgba(0,0,0,0.6);border:2px solid ${borderColor};box-shadow:${boxShadow};
    border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:22px;cursor:pointer;">${wdef ? wdef.icon : ''}</div>`;
}
function _renderInventoryPanel() {
  const hotbarHtml = _inventory.map((id, i) => _invSlotHtml('hotbar', i, id, i === _activeSlot)).join('');
  const extraHtml = _extraInventory.map((id, i) => _invSlotHtml('extra', i, id, false)).join('');
  _invPanelEl.innerHTML = `
    <div style="font-size:18px;letter-spacing:4px;margin-bottom:16px;text-shadow:0 0 10px #0ff;">INVENTORY</div>
    <div style="color:#0ff8;font-size:11px;letter-spacing:2px;margin-bottom:10px;">HOTBAR</div>
    <div style="display:flex;gap:8px;justify-content:center;margin-bottom:20px;">${hotbarHtml}</div>
    <div style="color:#0ff8;font-size:11px;letter-spacing:2px;margin-bottom:10px;">STORAGE (${EXTRA_INVENTORY_SIZE} slots)</div>
    <div style="display:grid;grid-template-columns:repeat(5,56px);gap:8px;justify-content:center;margin-bottom:20px;max-height:40vh;overflow-y:auto;">${extraHtml}</div>
    <div style="color:#556;font-size:10px;letter-spacing:1px;margin-bottom:16px;">Click a slot, then click another to move/swap it</div>
    <div style="border:1px solid #0ff;border-radius:5px;padding:10px 0;font-size:13px;letter-spacing:3px;cursor:pointer;" id="inv-close">[ BACK ]</div>
  `;
  _invPanelEl.querySelectorAll('[data-inv-slot]').forEach(el => {
    el.addEventListener('click', () => _onInvSlotClick(el.getAttribute('data-inv-type'), parseInt(el.getAttribute('data-inv-idx'), 10)));
  });
  _invPanelEl.querySelector('#inv-close').addEventListener('click', closeInventory);
}
// Re-syncs the always-visible bottom hotbar UI (icons/labels/equip state) after the panel
// changes what's actually sitting in a hotbar slot — mirrors what _invAddItem already does
// for a single slot, but for all of them, plus re-running the equip logic in case the
// active slot's contents changed out from under it.
function _invRefreshHotbarUI() {
  _inventory.forEach((id, i) => {
    const wdef = id ? WEAPON_DEFS[id] : null;
    _invSlotEls[i].icon.textContent = wdef ? wdef.icon : '';
    _invSlotEls[i].label.textContent = wdef ? wdef.name : '';
    _invSlotEls[i].label.style.display = wdef ? 'block' : 'none';
  });
  _invSetActive(_activeSlot);
}
function _onInvSlotClick(type, idx) {
  const arr = type === 'hotbar' ? _inventory : _extraInventory;
  if (!_invSelected) {
    if (!arr[idx]) return; // nothing to pick up from an empty slot
    _invSelected = { type, idx };
    _renderInventoryPanel();
    return;
  }
  if (_invSelected.type === type && _invSelected.idx === idx) {
    _invSelected = null; // clicked the same slot again — deselect
    _renderInventoryPanel();
    return;
  }
  const srcArr = _invSelected.type === 'hotbar' ? _inventory : _extraInventory;
  const dstArr = arr;
  const tmp = dstArr[idx];
  dstArr[idx] = srcArr[_invSelected.idx];
  srcArr[_invSelected.idx] = tmp;
  _invSelected = null;
  _invRefreshHotbarUI(); // cheap enough to always run — covers hotbar<->hotbar and hotbar<->storage swaps
  _renderInventoryPanel();
}
function openInventory() {
  inventoryOpen = true;
  _invSelected = null;
  _renderInventoryPanel();
  _invPanelEl.style.display = 'block';
  document.exitPointerLock();
  document.body.style.cursor = 'auto';
}
function closeInventory() {
  inventoryOpen = false;
  _invPanelEl.style.display = 'none';
  document.body.style.cursor = 'none';
  // do NOT re-lock — let the click-to-play overlay handle it, same as closing the hub
}
document.addEventListener('keydown', e => {
  if ((e.key === 'i' || e.key === 'I') && !(window._chatOpen && window._chatOpen())) {
    const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
    if (typing) return;
    if (inventoryOpen) { closeInventory(); return; }
    if (hubOpen || shopOpen || bountiesOpen || roomCustomOpen || shipUpgradeOpen || gameMode === 'hangar') return;
    openInventory();
  }
  if (inventoryOpen && e.key === 'Escape') { closeInventory(); e.stopPropagation(); }
});

// ── Shop ──────────────────────────────────────────────────────────────────────
const CREDIT_REWARD_CRATE = 150; // must match server's CREDIT_REWARD.crate
const shopEl = makePanel('SHOP', '#0af', 'shop');
// Replace default "COMING SOON" content with actual shop items
const _weaponShopRows = Object.entries(WEAPON_DEFS).map(([id, def]) => `
  <div style="border:1px solid #0af4;border-radius:6px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:14px;">
    <div style="text-align:left;">
      <div style="font-size:14px;letter-spacing:2px;color:#fff;">${def.name.toUpperCase()}</div>
      <div style="font-size:11px;color:#667;margin-top:5px;line-height:1.6;">${def.desc}</div>
      <div style="font-size:11px;color:#ffd24d;margin-top:4px;">⬙ ${def.price} CR</div>
    </div>
    <button id="shop-${id}-btn" style="background:#0af2;border:1px solid #0af;border-radius:4px;color:#0af;font-family:'Courier New',monospace;font-size:12px;letter-spacing:1px;padding:8px 16px;cursor:pointer;white-space:nowrap;">EQUIP</button>
  </div>`).join('');
const _grenadeShopDescs = {
  frag:  'Explosive — falloff blast damage, scorches the ground',
  smoke: 'No damage — leaves a lingering smoke cloud',
};
const _grenadeShopRows = Object.entries(GRENADE_TYPES).map(([id, def]) => `
  <div style="border:1px solid #fa04;border-radius:6px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:14px;">
    <div style="text-align:left;">
      <div style="font-size:14px;letter-spacing:2px;color:#fff;">${def.name.toUpperCase()}</div>
      <div style="font-size:11px;color:#667;margin-top:5px;line-height:1.6;">${_grenadeShopDescs[id]}</div>
      <div style="font-size:11px;color:#ffd24d;margin-top:4px;">⬙ ${def.price} CR each</div>
    </div>
    <button id="shop-grenade-${id}-btn" style="background:#fa02;border:1px solid #fa0;border-radius:4px;color:#fa0;font-family:'Courier New',monospace;font-size:12px;letter-spacing:1px;padding:8px 16px;cursor:pointer;white-space:nowrap;">BUY (<span id="shop-grenade-${id}-count">0</span> owned)</button>
  </div>`).join('');
shopEl.innerHTML = `
  <div style="font-size:18px;letter-spacing:4px;margin-bottom:20px;text-shadow:0 0 10px #0af;">SHOP</div>
  <div style="color:#ffd24d;font-size:13px;letter-spacing:2px;margin-bottom:14px;">⬙ <span id="shop-credits-display">0</span> CR</div>
  <div id="shop-sell-crate-row" style="display:none;border:1px solid #f804;border-radius:6px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:18px;background:rgba(255,80,80,0.06);">
    <div style="text-align:left;">
      <div style="font-size:14px;letter-spacing:2px;color:#fff;">📦 SELL THE CRATE</div>
      <div style="font-size:11px;color:#667;margin-top:5px;line-height:1.6;">No questions asked — fence it here instead of hauling it all the way home.</div>
      <div style="font-size:11px;color:#ffd24d;margin-top:4px;">⬙ ${CREDIT_REWARD_CRATE} CR</div>
    </div>
    <button id="shop-sell-crate-btn" style="background:#f802;border:1px solid #f80;border-radius:4px;color:#f80;font-family:'Courier New',monospace;font-size:12px;letter-spacing:1px;padding:8px 16px;cursor:pointer;white-space:nowrap;">SELL</button>
  </div>
  <div style="color:#0af8;font-size:11px;letter-spacing:2px;margin-bottom:18px;">WEAPONS</div>
  <div style="max-height:34vh;overflow-y:auto;margin-bottom:10px;">${_weaponShopRows}</div>
  <div style="color:#fa08;font-size:11px;letter-spacing:2px;margin-bottom:18px;">GRENADES</div>
  <div style="max-height:20vh;overflow-y:auto;margin-bottom:10px;">${_grenadeShopRows}</div>
  <div style="border:1px solid #0af;border-radius:5px;padding:10px 0;font-size:13px;letter-spacing:3px;cursor:pointer;" id="shop-close">[ BACK ]</div>`;
shopEl.querySelector('#shop-sell-crate-btn').addEventListener('click', () => {
  if (!_iAmCarryingCrate) return;
  if (socket) socket.emit('sell_crate_at_station');
});
let shopOpen = false;
function openShop() {
  shopOpen = true;
  shopEl.style.display = 'block';
  document.exitPointerLock();
  _updateShopAffordability();
  // Selling the crate only makes sense at a trading station (not the home hangar's shop
  // tab), and obviously only while actually carrying it.
  const sellRow = shopEl.querySelector('#shop-sell-crate-row');
  if (sellRow) sellRow.style.display = (_shopOpenedFromTradeStation && _iAmCarryingCrate) ? 'flex' : 'none';
}
function closeShop() {
  shopOpen = false;
  shopEl.style.display = 'none';
  // The trading station is a real walkable space now — closing the shop panel just drops
  // you back into walking around it (re-locking the pointer), same as backing out of the
  // shop tab at the home station doesn't kick you out of your own room. Actually leaving
  // is its own explicit action (walk to the entrance, press E) handled elsewhere.
  if (typeof gameMode !== 'undefined' && gameMode === 'trade_station') {
    document.body.style.cursor = 'none';
    renderer.domElement.requestPointerLock();
  }
}
shopEl.querySelector('#shop-close').addEventListener('click', closeShop);
document.addEventListener('keydown', e => { if (shopOpen  && e.key === 'Escape') { closeShop(); e.stopPropagation(); } });

// Grenades can be bought any number of times (stacking count), unlike weapons which are a
// one-time equip — each click just adds one more to the relevant count, deducting credits.
function _buyGrenade(type) {
  const def = GRENADE_TYPES[type];
  if (self.credits < def.price) return;
  self.credits -= def.price;
  _updateCreditsHUD();
  if (socket) socket.emit('spend_credits', { amount: def.price });
  if (type === 'smoke') _smokeGrenadeCount++; else _grenadeCount++;
  const countEl = shopEl.querySelector(`#shop-grenade-${type}-count`);
  if (countEl) countEl.textContent = String(_grenadeCountFor(type));
  _updateGrenadeSlotUI();
  _updateShopAffordability();
}
Object.keys(GRENADE_TYPES).forEach(type => {
  const btn = shopEl.querySelector(`#shop-grenade-${type}-btn`);
  if (btn) btn.addEventListener('click', () => _buyGrenade(type));
});

// Greys out (and disables) anything the player can't currently afford — called whenever
// credits change and whenever the shop opens, so the state is never stale.
function _updateShopAffordability() {
  const creditsDisplay = shopEl.querySelector('#shop-credits-display');
  if (creditsDisplay) creditsDisplay.textContent = String(self.credits);
  Object.entries(WEAPON_DEFS).forEach(([id, def]) => {
    const btn = shopEl.querySelector(`#shop-${id}-btn`);
    if (!btn || btn.textContent === 'EQUIPPED') return;
    const affordable = window._freeWeapons || self.credits >= def.price;
    btn.disabled = !affordable;
    btn.style.opacity = affordable ? '1' : '0.4';
    btn.style.cursor = affordable ? 'pointer' : 'not-allowed';
  });
  Object.entries(GRENADE_TYPES).forEach(([id, def]) => {
    const btn = shopEl.querySelector(`#shop-grenade-${id}-btn`);
    if (!btn) return;
    const affordable = self.credits >= def.price;
    btn.disabled = !affordable;
    btn.style.opacity = affordable ? '1' : '0.4';
    btn.style.cursor = affordable ? 'pointer' : 'not-allowed';
  });
}

// ── Bounty board ─────────────────────────────────────────────────────────────
// Lightweight repeatable objectives on top of the base per-kill/per-crate credit rewards
// — tracked client-side per session (this game has no persistent accounts to save
// progress against anyway; every other stat like tdmKills resets per-session too).
// Claiming completed bounties re-arms them instead of being strictly one-time, so there's
// always something to work toward during a long session.
const BOUNTY_DEFS = [
  { id: 'kills5',   label: 'Get 5 kills (any mode)',        target: 5, reward: 100, track: 'kills' },
  { id: 'ships3',   label: 'Destroy 3 ships in combat',     target: 3, reward: 150, track: 'shipKills' },
  { id: 'crate1',   label: 'Collect a supply crate',        target: 1, reward: 120, track: 'crates' },
];
const _bountyProgress = { kills: 0, shipKills: 0, crates: 0 };
const _bountyClaimed = {}; // id -> progress value at last claim, so it can re-arm past that point

const bountiesEl = makePanel('BOUNTIES', '#0ff', 'bounties');
function _renderBounties() {
  const rows = BOUNTY_DEFS.map(b => {
    const have = _bountyProgress[b.track] - (_bountyClaimed[b.id] || 0);
    const done = have >= b.target;
    return `
    <div style="border:1px solid #0ff4;border-radius:6px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:14px;">
      <div style="text-align:left;">
        <div style="font-size:13px;letter-spacing:1px;color:#fff;">${b.label}</div>
        <div style="font-size:11px;color:#667;margin-top:5px;">${Math.min(have, b.target)} / ${b.target} — ⬙ ${b.reward} CR</div>
      </div>
      <button data-bounty="${b.id}" ${done ? '' : 'disabled'} style="background:${done ? '#0f42' : '#0af1'};border:1px solid ${done ? '#0f4' : '#0af6'};border-radius:4px;color:${done ? '#0f4' : '#0af8'};font-family:'Courier New',monospace;font-size:12px;letter-spacing:1px;padding:8px 16px;cursor:${done ? 'pointer' : 'not-allowed'};white-space:nowrap;">${done ? 'CLAIM' : 'IN PROGRESS'}</button>
    </div>`;
  }).join('');
  bountiesEl.innerHTML = `
    <div style="font-size:18px;letter-spacing:4px;margin-bottom:20px;text-shadow:0 0 10px #0ff;">BOUNTIES</div>
    <div style="max-height:50vh;overflow-y:auto;margin-bottom:10px;">${rows}</div>
    <div style="border:1px solid #0ff;border-radius:5px;padding:10px 0;font-size:13px;letter-spacing:3px;cursor:pointer;" id="bounties-close">[ BACK ]</div>`;
  bountiesEl.querySelectorAll('[data-bounty]').forEach(btn => {
    btn.addEventListener('click', () => _claimBounty(btn.getAttribute('data-bounty')));
  });
  bountiesEl.querySelector('#bounties-close').addEventListener('click', closeBounties);
}
function _claimBounty(id) {
  const b = BOUNTY_DEFS.find(x => x.id === id);
  if (!b) return;
  const have = _bountyProgress[b.track] - (_bountyClaimed[id] || 0);
  if (have < b.target) return;
  _bountyClaimed[id] = _bountyProgress[b.track]; // re-arms from this point forward
  self.credits += b.reward;
  _updateCreditsHUD();
  _popCreditsReward(b.reward, 'bounty');
  if (socket) socket.emit('claim_bounty', { amount: b.reward });
  _renderBounties();
  _updateShopAffordability();
}
let bountiesOpen = false;
function openBounties()  { bountiesOpen = true;  _renderBounties(); bountiesEl.style.display = 'block'; document.exitPointerLock(); }
function closeBounties() { bountiesOpen = false; bountiesEl.style.display = 'none'; }
document.addEventListener('keydown', e => { if (bountiesOpen && e.key === 'Escape') { closeBounties(); e.stopPropagation(); } });

// ── Weapon System (all weapons share this exact fire/scope/recoil behavior) ────
// _hasSniper, _sniperMesh, _weaponMeshes declared earlier near inventory system
let _sniperScoped   = false;
let _sniperCooldown = 0;
const SNIPER_COOLDOWN  = 60;  // frames between shots (~1s at 60fps)
const SNIPER_SPEED     = 180;
const SNIPER_LIFETIME  = 180; // frames
const _sniperShots     = [];
const _sniperGeo = new THREE.CylinderGeometry(0.15, 0.15, 40, 4);
_sniperGeo.rotateX(Math.PI / 2);
const _sniperMat = new THREE.MeshBasicMaterial({ color: 0xaaffcc });

// Scope overlay element
const _scopeEl = (() => {
  const el = document.createElement('div');
  el.style.cssText = `
    position:fixed;inset:0;z-index:80;pointer-events:none;display:none;
    background:radial-gradient(circle at 50% 50%, transparent 28%, rgba(0,0,0,0.97) 29%);
  `;
  // crosshair lines
  el.innerHTML = `
    <svg width="100%" height="100%" style="position:absolute;inset:0;">
      <line x1="50%" y1="0" x2="50%" y2="100%" stroke="#0f08" stroke-width="1"/>
      <line x1="0" y1="50%" x2="100%" y2="50%" stroke="#0f08" stroke-width="1"/>
      <circle cx="50%" cy="50%" r="55" stroke="#0f08" stroke-width="1" fill="none"/>
      <circle cx="50%" cy="50%" r="3" stroke="#0f0" stroke-width="1.5" fill="none"/>
    </svg>`;
  document.body.appendChild(el);
  return el;
})();

// Small aim reticle for non-sniper weapons — just a crosshair dot, no scope overlay
const _aimReticleEl = (() => {
  const el = document.createElement('div');
  el.style.cssText = `
    position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
    z-index:80;pointer-events:none;display:none;
  `;
  el.innerHTML = `
    <svg width="28" height="28" viewBox="0 0 28 28">
      <line x1="14" y1="2" x2="14" y2="10" stroke="#0f0" stroke-width="2"/>
      <line x1="14" y1="18" x2="14" y2="26" stroke="#0f0" stroke-width="2"/>
      <line x1="2" y1="14" x2="10" y2="14" stroke="#0f0" stroke-width="2"/>
      <line x1="18" y1="14" x2="26" y2="14" stroke="#0f0" stroke-width="2"/>
    </svg>`;
  document.body.appendChild(el);
  return el;
})();

// Small offscreen renderer for inventory icons
const _iconRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
_iconRenderer.setSize(48, 48);
_iconRenderer.setClearColor(0x000000, 0);
const _iconScene  = new THREE.Scene();
const _iconCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
_iconCamera.position.set(0, 10, 40);
_iconCamera.lookAt(0, 0, 0);
_iconScene.add(new THREE.AmbientLight(0xffffff, 1.5));
const _iconDirLight = new THREE.DirectionalLight(0xffffff, 1.0);
_iconDirLight.position.set(1, 2, 2);
_iconScene.add(_iconDirLight);

function _renderIconToSlot(model, slotIdx) {
  // Clone model into icon scene
  const clone = model.clone(true);
  // Center it
  const box = new THREE.Box3().setFromObject(clone);
  const center = box.getCenter(new THREE.Vector3());
  clone.position.sub(center);
  clone.rotation.set(0.2, -0.5, 0);
  _iconScene.add(clone);
  _iconRenderer.render(_iconScene, _iconCamera);
  _iconScene.remove(clone);

  const dataURL = _iconRenderer.domElement.toDataURL();
  const img = document.createElement('img');
  img.src = dataURL;
  img.style.cssText = 'width:44px;height:44px;object-fit:contain;';
  _invSlotEls[slotIdx].icon.textContent = '';
  _invSlotEls[slotIdx].icon.appendChild(img);
}

// Load weapon models lazily — on first equip — instead of all six up front. The two AK
// rifles alone are ~60MB each and the shotgun is ~43MB; loading every weapon regardless of
// whether the player owns or ever uses it was most of the game's initial load time.
// _fireSniper() already guards on "if (!_weaponMeshes[_equippedWeaponId]) return" (model
// still downloading), so firing just silently waits until the model is ready — no crash,
// just a brief pause the first time a given weapon is equipped this session.
window._weaponModelRefs = {};
const _weaponLoadStarted = {};
function _ensureWeaponModelLoaded(id) {
  if (!id || _weaponLoadStarted[id]) return;
  const def = WEAPON_DEFS[id];
  if (!def) return;
  _weaponLoadStarted[id] = true;
  loadModel(def.asset, def.viewSize || 40, model => {
    if (!model) return;
    model.traverse(c => {
      if (!c.isMesh || !c.material) return;
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach(m => {
        m.emissive = new THREE.Color(0x303030);
        m.emissiveIntensity = 1;
        if (m.metalness !== undefined) m.metalness = Math.min(m.metalness, 0.4);
        if (m.roughness !== undefined) m.roughness = Math.max(m.roughness, 0.6);
      });
    });
    model.visible = false;
    _viewmodelScene.add(model);
    _weaponMeshes[id] = model;
    window._weaponModelRefs[id] = model;
    // If this weapon happens to already be the equipped one (e.g. loaded after equip), show it
    if (_inventory[_activeSlot] === id) _sniperMesh = model;
  });
}

// Shared side light — lives in viewmodel scene so it only ever lights the gun
let _sniperLight = new THREE.PointLight(0xffffff, 9, 150);
_viewmodelScene.add(_sniperLight);

// Shop equip buttons — identical behavior for every weapon
function _equipWeapon(id, btn) {
  if (_inventory.includes(id) || _extraInventory.includes(id)) return; // already own it
  if (_inventory.indexOf(null) === -1 && _extraInventory.indexOf(null) === -1) return; // hotbar AND storage both full
  const def = WEAPON_DEFS[id];
  if (!window._freeWeapons) {
    if (self.credits < def.price) return;
    self.credits -= def.price;
    _updateCreditsHUD();
    if (socket) socket.emit('spend_credits', { amount: def.price });
  }
  _invAddItem(id); // sets the reliable emoji icon + name label — no 3D render needed
  btn.textContent = 'EQUIPPED';
  btn.style.background = '#0f42';
  btn.style.borderColor = '#0f4';
  btn.style.color = '#0f4';
  btn.disabled = false; // stays clickable-looking but _inventory.includes(id) guards re-buying
  btn.style.opacity = '1';
  btn.style.cursor = 'default';
  _updateShopAffordability();
}
Object.keys(WEAPON_DEFS).forEach(id => {
  const btn = shopEl.querySelector(`#shop-${id}-btn`);
  if (btn) btn.addEventListener('click', () => _equipWeapon(id, btn));
});

// Recoil state
let _sniperRecoil = 0;
let _reticleKick = 0; // pixels the aim reticle jumps up on fire, eases back to 0

// Muzzle flash light (reused)
const _muzzleFlash = new THREE.PointLight(0x88ffcc, 0, 120);
scene.add(_muzzleFlash);

// Hit marker state
let _hitMarker = null; // { color, life }
const HIT_MARKER_LIFE = 20; // frames

function _drawHitMarker() {
  if (!_hitMarker) return;
  _hitMarker.life--;
  if (_hitMarker.life <= 0) { _hitMarker = null; return; }
  const alpha = _hitMarker.life / HIT_MARKER_LIFE;
  const cx = reticleCanvas.width / 2, cy = reticleCanvas.height / 2;
  const color = _hitMarker.color === 'red' ? `rgba(255,40,40,${alpha})` : `rgba(255,255,255,${alpha})`;
  const size = 10, gap = 5;
  rCtx.strokeStyle = color;
  rCtx.lineWidth = 2.5;
  rCtx.lineCap = 'round';
  // Four lines forming an X cross hit marker
  rCtx.beginPath(); rCtx.moveTo(cx - gap, cy - gap); rCtx.lineTo(cx - gap - size, cy - gap - size); rCtx.stroke();
  rCtx.beginPath(); rCtx.moveTo(cx + gap, cy - gap); rCtx.lineTo(cx + gap + size, cy - gap - size); rCtx.stroke();
  rCtx.beginPath(); rCtx.moveTo(cx - gap, cy + gap); rCtx.lineTo(cx - gap - size, cy + gap + size); rCtx.stroke();
  rCtx.beginPath(); rCtx.moveTo(cx + gap, cy + gap); rCtx.lineTo(cx + gap + size, cy + gap + size); rCtx.stroke();
}

// Impact sparks pool
const _impacts = [];
const _impactGeo = new THREE.SphereGeometry(1.2, 4, 4);
const _impactMat = new THREE.MeshBasicMaterial({ color: 0xffdd44 });

// Bullet hole decal geo (flat circle)
const _holeGeo = new THREE.CircleGeometry(1.5, 8);
const _holeMat = new THREE.MeshBasicMaterial({ color: 0x111111, depthWrite: false, transparent: true, opacity: 1 });
const BULLET_HOLE_LIFE = 900; // ~15s at 60fps — was 1 minute, let decals clear much faster
const _bulletHoles = [];

function _sampleHitColor(hit) {
  // Y-position zones derived from admin coordinates on screen:
  // Cursor at Y=-0.6 = large body red circle; head bullseyes visually ~35 units higher
  const y = hit.point.y;
  if (y >= 30 && y <= 50) return 'red';  // head + shoulder bullseyes
  if (y >= -22 && y <= 8) return 'red';  // body X bullseye
  return 'black'; // black silhouette / gray background = white hit marker
}

function _spawnImpact(pos, normal, activeScene, hitColor) {
  const light = null;

  // Sparks — kept modest so rapid multi-pellet/full-auto fire doesn't pile up meshes
  const sparks = [];
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(_impactGeo, _impactMat);
    m.position.copy(pos);
    m.scale.setScalar(0.4 + Math.random() * 0.8);
    activeScene.add(m);
    sparks.push({
      mesh: m,
      vel: new THREE.Vector3(
        (Math.random() - 0.5) * 6,
        Math.random() * 7,
        (Math.random() - 0.5) * 6
      ),
      life: 60 + Math.random() * 60 // 1–2 seconds each
    });
  }
  _impacts.push({ sparks, life: 90, maxLife: 90, scene: activeScene });

  // Bullet hole decal — always dark
  const holeMat = _holeMat.clone();
  const hole = new THREE.Mesh(_holeGeo, holeMat);
  hole.position.copy(pos).addScaledVector(normal, 0.3);
  hole.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  hole.scale.setScalar(0.4); // bullet holes were too big
  if (gameMode === 'planet_surface') hole.scale.setScalar(0.1); // terrain decals were way too big
  activeScene.add(hole);
  _bulletHoles.push({ mesh: hole, life: BULLET_HOLE_LIFE, scene: activeScene });
  // Cap total decals so sustained auto-fire (shotgun pellets, AK bursts) can't pile up
  // meshes faster than they naturally expire.
  const MAX_BULLET_HOLES = 50;
  while (_bulletHoles.length > MAX_BULLET_HOLES) {
    const old = _bulletHoles.shift();
    old.scene.remove(old.mesh);
  }
}

function _updateImpacts() {
  // Update bullet holes
  for (let i = _bulletHoles.length - 1; i >= 0; i--) {
    const h = _bulletHoles[i];
    h.life--;
    // Fade out in last 5 seconds
    if (h.life < 300) h.mesh.material.opacity = h.life / 300;
    if (h.life <= 0) { h.scene.remove(h.mesh); _bulletHoles.splice(i, 1); }
  }

  for (let i = _impacts.length - 1; i >= 0; i--) {
    const imp = _impacts[i];
    imp.life--;

    for (let j = imp.sparks.length - 1; j >= 0; j--) {
      const s = imp.sparks[j];
      s.mesh.position.add(s.vel);
      s.vel.y -= 0.3;
      s.vel.multiplyScalar(0.96); // drag
      s.life--;
      if (s.life <= 0) { imp.scene.remove(s.mesh); imp.sparks.splice(j, 1); }
    }

    if (imp.life <= 0 && imp.sparks.length === 0) {
      _impacts.splice(i, 1);
    }
  }
}

// Fires one projectile in `dir` (already spread-adjusted). Shared by every weapon/pellet.
function _firePellet(dir, activeScene) {
  // Bullet tracer
  const mesh = new THREE.Mesh(_sniperGeo, _sniperMat);
  mesh.position.copy(camera.position).addScaledVector(dir, 8);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  activeScene.add(mesh);

  // Bullet tracers used to also spawn a real-time PointLight each — with a 10-pellet
  // shotgun blast or rapid AK fire that meant a dozen+ dynamic lights alive at once,
  // which is expensive to shade and was the main cause of the stutter on firing. The
  // tracer's own bright unlit material already reads as a glowing shot without one.

  // Track the tracer first — if hit-detection below ever throws, the bullet still
  // animates/expires normally instead of freezing in mid-air as an orphaned ray.
  _sniperShots.push({ mesh, vel: dir.clone().multiplyScalar(SNIPER_SPEED), life: SNIPER_LIFETIME, scene: activeScene });

  // Raycast for bullet impact. Static geometry (walls/targets) and player meshes are
  // raycast SEPARATELY and each wrapped on their own — a bad/edge-case remote player
  // mesh can no longer suppress normal wall/target hit detection (that's what was
  // silently breaking bullet holes whenever another player was in the range: one
  // shared try/catch meant a player-raycast failure skipped everything, including the
  // completely unrelated wall/target hit).
  const raycaster = new THREE.Raycaster(camera.position.clone(), dir.clone(), 0, 2000);
  let bestHit = null;
  let bestIsPlayer = false;

  try {
    const collidables = gameMode === 'lobby'          ? _lobbyCollidables
                      : gameMode === 'docked'         ? _roomCollidables
                      : gameMode === 'range'          ? _rangeCollidables
                      : gameMode === 'tdm'            ? _tdmArenaCollidables
                      : gameMode === 'planet_surface' ? [_surfTerrainMesh || _surfGround]
                      : [];
    const hits = raycaster.intersectObjects(collidables, true);
    if (hits.length > 0) bestHit = hits[0];
  } catch (err) {
    console.warn('[fire] static hit-detection error (bullet still fired fine):', err);
  }

  // Player hits: raycast directly against each player's ACTUAL current-pose mesh first —
  // the avatar's real geometry (torso/arms/legs/head) now decides whether a shot connects,
  // so aiming at a limb that's swung away from the rest-pose bounding sphere still counts.
  // A single bounding sphere used to be the gate here and only refined position afterward;
  // that made shots on anything outside the torso-centered sphere (an outstretched arm, a
  // raised leg while sliding, the head) silently miss even though the shot visibly connected.
  // The sphere is now only a fallback for the rare case the mesh isn't ready yet.
  let bestPlayerHit = null;
  try {
    const playerTargets = _getRemotePlayerHitTargets();
    playerTargets.forEach(m => {
      const other = m.children[0];
      let point = null;
      let normal = null;
      try {
        if (other) {
          other.updateMatrixWorld(true);
          const meshHits = raycaster.intersectObject(other, true);
          if (meshHits.length > 0) {
            point = meshHits[0].point;
            normal = meshHits[0].face
              ? meshHits[0].face.normal.clone().transformDirection(meshHits[0].object.matrixWorld).normalize()
              : dir.clone().negate();
          }
        }
      } catch (err) {
        // Mesh raycast failed — fall through to the sphere test below.
      }

      if (!point) {
        const radius = (other && other.userData.collisionRadius) || 6;
        // Center offset is in the model's own local space — rotate it by the wrapper's
        // current facing so the hitbox turns with the character instead of staying fixed.
        const localOffset = (other && other.userData.collisionCenterOffset) || new THREE.Vector3(0, 12, 0);
        const worldOffset = localOffset.clone().applyQuaternion(m.quaternion);
        const center = m.position.clone().add(worldOffset);
        const sphere = new THREE.Sphere(center, radius);
        const spherePoint = new THREE.Vector3();
        if (!raycaster.ray.intersectSphere(sphere, spherePoint)) return;
        point = spherePoint;
        normal = spherePoint.clone().sub(center).normalize();
      }

      const distance = camera.position.distanceTo(point);
      if (!bestPlayerHit || distance < bestPlayerHit.distance) {
        bestPlayerHit = { point: point.clone(), normal, distance, targetId: m.userData.playerId };
      }
    });
  } catch (err) {
    console.warn('[fire] player hit-detection error (bullet still fired fine):', err);
  }
  if (bestPlayerHit && (!bestHit || bestPlayerHit.distance < bestHit.distance)) {
    bestHit = bestPlayerHit;
    bestIsPlayer = true;
  }

  if (bestHit) {
    const normal = bestIsPlayer ? bestHit.normal
      : bestHit.face ? bestHit.face.normal.clone().transformDirection(bestHit.object.matrixWorld).normalize()
      : dir.clone().negate();
    const hitColor = bestIsPlayer ? 'red' : _sampleHitColor(bestHit);
    _spawnImpact(bestHit.point, normal, activeScene, hitColor);
    if (bestIsPlayer) {
      _hitMarker = { color: 'red', life: HIT_MARKER_LIFE };
      // Tell the server so it can apply damage authoritatively and notify the victim.
      if (socket && bestHit.targetId) {
        let dmg = (WEAPON_DEFS[_equippedWeaponId] && WEAPON_DEFS[_equippedWeaponId].damage) || 10;
        if (gameMode === 'tdm') dmg *= TDM_DAMAGE_MUL; // fights should last longer in a 3-minute match
        socket.emit('player_hit', { targetId: bestHit.targetId, damage: dmg });
      }
    } else if (gameMode === 'range') {
      // Only show hit marker if the hit surface faces roughly toward the player (Z-axis) = target face
      const faceNorm = bestHit.face ? bestHit.face.normal.clone().transformDirection(bestHit.object.matrixWorld) : null;
      if (faceNorm && Math.abs(faceNorm.z) > 0.6) {
        _hitMarker = { color: hitColor, life: HIT_MARKER_LIFE };
      }
    }
  }
}

// Other players' astronaut meshes currently visible in the active scene/mode.
function _getRemotePlayerHitTargets() {
  const meshKey = gameMode === 'lobby'   ? 'lobbyMesh'
                : gameMode === 'range'   ? 'rangeMesh'
                : gameMode === 'tdm'     ? 'tdmMesh'
                : gameMode === 'planet_walk' ? 'planetMesh'
                : gameMode === 'planet_surface' ? 'planetSurfMesh'
                : gameMode === 'ejected' ? 'ejectedMesh'
                : null;
  if (!meshKey) return [];
  const targets = [];
  Object.entries(remotePlayers).forEach(([id, rp]) => {
    const m = rp[meshKey];
    if (m && m.visible) { m.userData.playerId = id; targets.push(m); }
  });
  return targets;
}

// ── Grenades ──────────────────────────────────────────────────────────────────
// Thrown by hand (not aimed-and-fired like a gun) from the dedicated 3rd inventory slot —
// arcs under gravity, bounces once off the first thing it hits, then goes off on a timed
// fuse. Frag grenades deal falloff blast damage and scorch the ground; smoke grenades
// deal no damage and just leave a lingering smoke cloud instead.
const GRENADE_FUSE_FRAMES  = 90;   // ~1.5s at 60fps
const GRENADE_BLAST_RADIUS = 60;
const GRENADE_MAX_DAMAGE   = 80;
const GRENADE_GRAVITY      = 0.03;
const GRENADE_THROW_SPEED  = 3.2;
const GRENADE_THROW_COOLDOWN_FRAMES = 40;
const SCORCH_MARK_LIFETIME_MS = 6000;
const SMOKE_CLOUD_LIFETIME_MS = 9000;
const _grenadeGeo = new THREE.SphereGeometry(1.4, 8, 6);
const _grenadeMat = new THREE.MeshStandardMaterial({ color: 0x33552a, roughness: 0.6, metalness: 0.2 });
const _thrownGrenades = [];
let _grenadeThrowCooldown = 0;

// Real grenade models, preloaded once and cloned per throw — falls back to a plain sphere
// if a model hasn't finished downloading yet (or fails), same pattern as the procedural
// astronaut fallback elsewhere.
let _grenadeTemplate = null, _smokeGrenadeTemplate = null;
loadModel('assets/grenade.glb', 3, model => { if (model) _grenadeTemplate = model; });
loadModel('assets/m18_smoke_grenade.glb', 3, model => { if (model) _smokeGrenadeTemplate = model; });
function _makeGrenadeMesh(type) {
  const tmpl = type === 'smoke' ? _smokeGrenadeTemplate : _grenadeTemplate;
  return tmpl ? tmpl.clone() : new THREE.Mesh(_grenadeGeo, _grenadeMat);
}

function _spawnGrenadeBlast(pos, activeScene) {
  const light = new THREE.PointLight(0xff6600, 120, 150);
  light.position.copy(pos);
  activeScene.add(light);
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(1, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  ball.position.copy(pos);
  activeScene.add(ball);
  const start = performance.now();
  const DUR = 350;
  (function step() {
    const t = (performance.now() - start) / DUR;
    if (t >= 1) { activeScene.remove(light); activeScene.remove(ball); return; }
    ball.scale.setScalar(1 + t * 14);
    ball.material.opacity = Math.max(0, 1 - t);
    light.intensity = 120 * (1 - t);
    requestAnimationFrame(step);
  })();
}

// Flat scorch decal dropped where a frag grenade actually detonates, oriented to the last
// surface it bounced off (defaults to a flat floor-facing decal if it never touched
// anything before the fuse ran out, e.g. exploding mid-air). Uses a soft radial-gradient
// canvas texture instead of a solid-color disc — a hard-edged flat circle still reads as
// a floating 3D chip sitting on the surface; a soft faded edge reads as an actual burn
// mark painted onto it.
const _scorchTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0,   'rgba(0,0,0,0.85)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1,   'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
})();
const _scorchGeo = new THREE.CircleGeometry(8, 24);
function _spawnScorchMark(pos, normal, activeScene) {
  const mat = new THREE.MeshBasicMaterial({
    map: _scorchTex, color: 0x000000, transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide,
  });
  const decal = new THREE.Mesh(_scorchGeo, mat);
  decal.position.copy(pos).addScaledVector(normal, 0.15); // avoid z-fighting with the floor
  decal.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  activeScene.add(decal);
  const start = performance.now();
  (function fade() {
    const t = (performance.now() - start) / SCORCH_MARK_LIFETIME_MS;
    if (t >= 1) { activeScene.remove(decal); return; }
    // Holds fully opaque for most of its life, then fades out over the last third.
    mat.opacity = Math.min(1, (1 - t) / 0.33);
    requestAnimationFrame(fade);
  })();
}

// Lingering smoke cloud. Sparse billboarded spheres always have visible gaps between
// them, so no matter how you're standing in the cloud, you can see through those gaps —
// the actual "can't see" effect comes from a full-screen overlay that ramps up the closer
// the camera is to the cloud's center, on top of denser/bigger puffs for how it looks from
// outside the cloud.
const _smokeOverlayEl = document.createElement('div');
_smokeOverlayEl.style.cssText = 'position:fixed;inset:0;z-index:65;pointer-events:none;background:#ccccccdd;opacity:0;';
document.body.appendChild(_smokeOverlayEl);
const _activeSmokeClouds = []; // { pos, radius, endTime }
const SMOKE_CLOUD_RADIUS = 34;

function _spawnSmokeCloud(pos, activeScene) {
  const puffs = [];
  const PUFF_COUNT = 26;
  for (let i = 0; i < PUFF_COUNT; i++) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(5 + Math.random() * 4, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xbbbbbb, transparent: true, opacity: 0.7, depthWrite: false })
    );
    // Cluster puffs within the cloud's actual radius (not just a point) so it reads as one
    // continuous mass from the start instead of visibly growing from a single dot.
    const spread = new THREE.Vector3(
      (Math.random() - 0.5) * SMOKE_CLOUD_RADIUS * 0.7,
      Math.random() * SMOKE_CLOUD_RADIUS * 0.4,
      (Math.random() - 0.5) * SMOKE_CLOUD_RADIUS * 0.7
    );
    mesh.position.copy(pos).add(spread);
    activeScene.add(mesh);
    const dir = spread.clone().normalize();
    puffs.push({ mesh, vel: dir.multiplyScalar(0.05 + Math.random() * 0.08) });
  }
  const cloudEntry = { pos: pos.clone(), radius: SMOKE_CLOUD_RADIUS, endTime: performance.now() + SMOKE_CLOUD_LIFETIME_MS };
  _activeSmokeClouds.push(cloudEntry);

  const start = performance.now();
  (function step() {
    const t = (performance.now() - start) / SMOKE_CLOUD_LIFETIME_MS;
    if (t >= 1) {
      puffs.forEach(p => activeScene.remove(p.mesh));
      const idx = _activeSmokeClouds.indexOf(cloudEntry);
      if (idx !== -1) _activeSmokeClouds.splice(idx, 1);
      return;
    }
    puffs.forEach(p => {
      if (t < 0.3) p.mesh.position.add(p.vel); // puff outward briefly, then hang in place
      p.mesh.scale.setScalar(1 + t * 1.2);
      p.mesh.material.opacity = 0.7 * Math.min(1, (1 - t) / 0.4);
    });
    requestAnimationFrame(step);
  })();
}

// Checked every frame regardless of mode — ramps the full-screen grey overlay up as the
// camera gets closer to any active smoke cloud's center, so being inside one genuinely
// blocks vision instead of just being a visual prop you can see past the edges of.
function _updateSmokeVision() {
  if (_activeSmokeClouds.length === 0) { _smokeOverlayEl.style.opacity = '0'; return; }
  let maxOpacity = 0;
  const camPos = camera.position;
  _activeSmokeClouds.forEach(c => {
    const dist = camPos.distanceTo(c.pos);
    if (dist >= c.radius) return;
    // sqrt curve so it saturates fast on entry instead of only getting properly thick
    // right at dead-center — most of the cloud's interior should feel equally blinding.
    const proximity = Math.sqrt(1 - dist / c.radius); // 0 at edge, 1 at center
    const lifeLeft = Math.max(0, (c.endTime - performance.now()) / SMOKE_CLOUD_LIFETIME_MS);
    const fadeOut = Math.min(1, lifeLeft / 0.25);
    maxOpacity = Math.max(maxOpacity, proximity * 0.97 * fadeOut);
  });
  _smokeOverlayEl.style.opacity = String(maxOpacity);
}

function _throwGrenade() {
  if (!_grenadeSelected || _grenadeThrowCooldown > 0) return;
  const type = _grenadeType;
  if (_grenadeCountFor(type) <= 0) return;
  if (!pointerLocked || (gameMode !== 'lobby' && gameMode !== 'docked' && gameMode !== 'range' && gameMode !== 'tdm' && gameMode !== 'planet_surface' && gameMode !== 'planet_walk' && gameMode !== 'ejected')) return;
  if (type === 'smoke') _smokeGrenadeCount--; else _grenadeCount--;
  _grenadeThrowCooldown = GRENADE_THROW_COOLDOWN_FRAMES;
  _updateGrenadeSlotUI();

  const activeScene = gameMode === 'docked'        ? interiorScene
                    : gameMode === 'lobby'          ? lobbyScene
                    : gameMode === 'range'          ? shootingRangeScene
                    : gameMode === 'tdm'            ? tdmScene
                    : gameMode === 'planet_surface' ? _planetSurfScene
                    : scene;

  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const mesh = _makeGrenadeMesh(type);
  mesh.position.copy(camera.position).addScaledVector(dir, 6);
  activeScene.add(mesh);

  _thrownGrenades.push({
    mesh,
    scene: activeScene,
    type,
    vel: dir.clone().multiplyScalar(GRENADE_THROW_SPEED),
    fuse: GRENADE_FUSE_FRAMES,
    lastNormal: new THREE.Vector3(0, 1, 0),
  });
}

function _explodeGrenade(g) {
  if (g.type === 'smoke') {
    _spawnSmokeCloud(g.mesh.position.clone(), g.scene);
    return;
  }
  _spawnGrenadeBlast(g.mesh.position.clone(), g.scene);
  _spawnScorchMark(g.mesh.position.clone(), g.lastNormal, g.scene);
  _playSfx('assets/sounds/grenade_explosion.mp3', 0.5);
  _getRemotePlayerHitTargets().forEach(m => {
    const dist = g.mesh.position.distanceTo(m.position);
    if (dist > GRENADE_BLAST_RADIUS) return;
    const dmg = Math.round(GRENADE_MAX_DAMAGE * (1 - dist / GRENADE_BLAST_RADIUS));
    if (dmg > 0) socket.emit('player_hit', { targetId: m.userData.playerId, damage: dmg });
  });
}

function _updateGrenades() {
  if (_grenadeThrowCooldown > 0) _grenadeThrowCooldown--;
  for (let i = _thrownGrenades.length - 1; i >= 0; i--) {
    const g = _thrownGrenades[i];
    g.vel.y -= GRENADE_GRAVITY;
    const prevPos = g.mesh.position.clone();
    g.mesh.position.add(g.vel);
    g.fuse--;

    // One bounce off whatever's in the way — reflect velocity around the surface normal
    // and lose most of the energy, so it doesn't just phase through walls/floor.
    const collidables = gameMode === 'lobby'          ? _lobbyCollidables
                      : gameMode === 'docked'         ? _roomCollidables
                      : gameMode === 'range'          ? _rangeCollidables
                      : gameMode === 'tdm'            ? _tdmArenaCollidables
                      : gameMode === 'planet_surface' ? [_surfTerrainMesh || _surfGround]
                      : [];
    if (collidables.length > 0 && g.vel.lengthSq() > 1e-6) {
      const segLen = prevPos.distanceTo(g.mesh.position);
      const rc = new THREE.Raycaster(prevPos, g.vel.clone().normalize(), 0, segLen || 0.001);
      const hits = rc.intersectObjects(collidables, false);
      if (hits.length > 0) {
        const n = hits[0].face
          ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld).normalize()
          : new THREE.Vector3(0, 1, 0);
        g.mesh.position.copy(hits[0].point).addScaledVector(n, 0.5);
        g.vel.reflect(n).multiplyScalar(0.4);
        g.lastNormal.copy(n);
      }
    }

    if (g.fuse <= 0) {
      _explodeGrenade(g);
      g.scene.remove(g.mesh);
      _thrownGrenades.splice(i, 1);
    }
  }
}

document.addEventListener('mousedown', e => {
  if (e.button === 0 && _grenadeSelected) _throwGrenade();
});

// Starts the reload shake; refills ammo once _reloadDuration frames pass (see _updateSniperShots).
function _startReload() {
  if (!_hasSniper || !_equippedWeaponId || _gunReloading) return;
  const def = WEAPON_DEFS[_equippedWeaponId];
  if (!def) return;
  if ((_weaponAmmo[_equippedWeaponId] || 0) >= def.magSize) return; // already full
  _gunReloading = true;
  _reloadDuration = def.reloadTime || 60;
  // If the reload sound itself runs longer than the reload animation/cooldown, the clip
  // would get cut off mid-sound (or the gun would be usable again before it's done playing).
  // Stretch the reload to at least cover the sound, once we know how long it actually is.
  if (_reloadSoundFrames > _reloadDuration) _reloadDuration = _reloadSoundFrames;
  _reloadTimer = _reloadDuration;
  _playSfx('assets/sounds/reload.mp3', 0.4);
}
// Reload sound duration in frames (assuming ~60fps, matching how reloadTime/cooldown are
// already tuned elsewhere) — measured once the file's metadata loads, 0 (no stretch) until then.
let _reloadSoundFrames = 0;
(() => {
  const probe = new Audio('assets/sounds/reload.mp3');
  probe.addEventListener('loadedmetadata', () => { _reloadSoundFrames = Math.ceil(probe.duration * 60); });
})();

function _fireSniper() {
  if (!_hasSniper || (gameMode !== 'planet_walk' && gameMode !== 'planet_surface' && gameMode !== 'docked' && gameMode !== 'lobby' && gameMode !== 'ejected' && gameMode !== 'range' && gameMode !== 'tdm') || !pointerLocked || _surfLanding) return;
  if (!_weaponMeshes[_equippedWeaponId]) return; // model still downloading
  if (_sniperCooldown > 0 || _gunReloading) return;
  if ((_weaponAmmo[_equippedWeaponId] || 0) <= 0) { _startReload(); return; }
  _weaponAmmo[_equippedWeaponId]--;
  // Bolt-action-style weapons (magSize 1, like the sniper) reload automatically after
  // every single shot instead of waiting for the player to fire again into an empty gun.
  if (_weaponAmmo[_equippedWeaponId] <= 0 && WEAPON_DEFS[_equippedWeaponId] && WEAPON_DEFS[_equippedWeaponId].magSize === 1) {
    _startReload();
  }
  const _wdef = WEAPON_DEFS[_equippedWeaponId] || {};
  if (_wdef.sound) _playSfx(_wdef.sound, _wdef.soundVolume);
  _sniperCooldown = _wdef.cooldown != null ? _wdef.cooldown : SNIPER_COOLDOWN;
  _sniperRecoil = _wdef.recoil != null ? _wdef.recoil : 12; // frames of recoil
  // Kick the aim reticle up a bit (purely visual) AND the actual camera view up a bit.
  // This is a permanent kick to your aim (not an offset that eases back) — like older
  // shooters, you have to manually pull the mouse back down to recover.
  _reticleKick = Math.min(_reticleKick + 10 * (_wdef.recoilMag != null ? _wdef.recoilMag : 1), 22);
  const _kickAmt = 0.035 * (_wdef.recoilMag != null ? _wdef.recoilMag : 1);
  if (gameMode === 'planet_surface') {
    _surfPitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, _surfPitch + _kickAmt));
  } else {
    fpPitch = Math.max(-Math.PI / 2.5, Math.min(Math.PI / 2.5, fpPitch + _kickAmt));
  }

  const activeScene = gameMode === 'docked'         ? interiorScene
                    : gameMode === 'lobby'           ? lobbyScene
                    : gameMode === 'range'           ? shootingRangeScene
                    : gameMode === 'tdm'             ? tdmScene
                    : gameMode === 'planet_surface'  ? _planetSurfScene
                    : scene;

  const baseDir = new THREE.Vector3();
  camera.getWorldDirection(baseDir);

  // Muzzle flash — bright burst at gun tip (once per trigger pull, not per pellet)
  const muzzlePos = camera.position.clone()
    .addScaledVector(baseDir, 20)
    .addScaledVector(new THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion), 8)
    .addScaledVector(new THREE.Vector3(0,1,0).applyQuaternion(camera.quaternion), -6);
  if (_muzzleFlash.parent !== activeScene) {
    if (_muzzleFlash.parent) _muzzleFlash.parent.remove(_muzzleFlash);
    activeScene.add(_muzzleFlash);
  }
  _muzzleFlash.position.copy(muzzlePos);
  _muzzleFlash.intensity = 120;

  const pellets = _wdef.pellets || 1;
  const spread  = _wdef.spread  || 0;
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up    = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  for (let i = 0; i < pellets; i++) {
    let dir = baseDir;
    if (spread > 0) {
      dir = baseDir.clone()
        .addScaledVector(right, (Math.random() - 0.5) * 2 * spread)
        .addScaledVector(up,    (Math.random() - 0.5) * 2 * spread)
        .normalize();
    }
    _firePellet(dir, activeScene);
  }
}

function _updateSniperShots() {
  if (_sniperCooldown > 0) _sniperCooldown--;
  _muzzleFlash.intensity = 0; // instant off
  _updateImpacts();

  // Automatic weapons keep firing while the trigger is held down
  const _wdef = WEAPON_DEFS[_equippedWeaponId];
  if (_gunMouseHeld && _wdef && _wdef.auto) _fireSniper();

  // Reload countdown
  if (_gunReloading) {
    _reloadTimer--;
    if (_reloadTimer <= 0) {
      _gunReloading = false;
      if (_equippedWeaponId && _wdef) _weaponAmmo[_equippedWeaponId] = _wdef.magSize;
    }
  }

  // Ease the reticle kick back down toward center
  _reticleKick += (0 - _reticleKick) * 0.15;
  if (Math.abs(_reticleKick) < 0.05) _reticleKick = 0;
  _aimReticleEl.style.transform = `translate(-50%, calc(-50% - ${_reticleKick.toFixed(1)}px))`;

  // Ammo HUD — also covers the case where the equipped weapon's (often large) model
  // is still downloading, so it's obvious you're not actually empty-handed.
  if (_hasSniper && _equippedWeaponId && _wdef) {
    _ammoEl.style.display = 'block';
    _ammoEl.textContent = !_weaponMeshes[_equippedWeaponId] ? 'LOADING WEAPON…'
      : _gunReloading ? 'RELOADING…'
      : `${_weaponAmmo[_equippedWeaponId] || 0} / ${_wdef.magSize}`;
  } else {
    _ammoEl.style.display = 'none';
  }

  for (let i = _sniperShots.length - 1; i >= 0; i--) {
    const s = _sniperShots[i];
    s.mesh.position.add(s.vel);
    s.life--;
    if (s.life <= 0) {
      s.scene.remove(s.mesh);
      _sniperShots.splice(i, 1);
    }
  }

  // Position sniper model in lower-right of view when in planet_walk
  if (_sniperMesh) {
    const show = _hasSniper && (gameMode === 'planet_walk' || gameMode === 'planet_surface' || gameMode === 'docked' || gameMode === 'lobby' || gameMode === 'ejected' || gameMode === 'range' || gameMode === 'tdm') && pointerLocked && !_heldCrate && !_surfLanding;
    _sniperMesh.visible = show;
    if (show) {
      // Sniper always lives in _viewmodelScene — no reparenting needed
      const dir   = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const right = new THREE.Vector3(1, 0,  0).applyQuaternion(camera.quaternion);
      const up    = new THREE.Vector3(0, 1,  0).applyQuaternion(camera.quaternion);
      // Recoil — kick gun back and up, then recover. Duration comes from the weapon's own
      // recoil value (not a fixed 12), so a weapon can have a slower/longer kick without
      // necessarily being a bigger one — magnitude is scaled separately via recoilMag.
      const _wdef = WEAPON_DEFS[_equippedWeaponId] || {};
      const _recoilDuration = _wdef.recoil != null ? _wdef.recoil : 12;
      const _recoilMag = _wdef.recoilMag != null ? _wdef.recoilMag : 1;
      if (_sniperRecoil > 0) _sniperRecoil--;
      const recoilT = (_sniperRecoil / _recoilDuration) * _recoilMag;
      const recoilBack = recoilT * 5;
      const recoilUp   = recoilT * 2;
      const _viewFwd   = (_wdef.viewFwd)   || 14;
      const _viewRight = (_wdef.viewRight != null) ? _wdef.viewRight : 8;
      const _viewUp    = (_wdef.viewUp    != null) ? _wdef.viewUp    : -6;

      // Reload pose — instead of a shake, swing the gun to the side and down (like
      // pulling it in to swap the mag), holding partway through, then easing back to
      // the normal aim position as the reload finishes. reloadPose goes 0 -> 1 -> 0.
      let _reloadPose = 0;
      if (_gunReloading) {
        const _reloadProgress = 1 - (_reloadTimer / _reloadDuration); // 0 -> 1 over the reload
        _reloadPose = Math.sin(Math.PI * Math.min(_reloadProgress, 0.85) / 0.85);
      }
      const _poseRight = -6 * _reloadPose;   // pull in toward center
      const _poseDown   = -5 * _reloadPose;  // dip down
      const _poseFwd    = -2 * _reloadPose;  // pull back in a bit
      const _poseTiltZ  = 0.9 * _reloadPose; // roll the gun onto its side
      const _poseTiltX  = 0.3 * _reloadPose;

      _sniperMesh.position.copy(camera.position)
        .addScaledVector(dir,   _viewFwd - recoilBack + _poseFwd)
        .addScaledVector(right, _viewRight + _poseRight)
        .addScaledVector(up,    _viewUp + recoilUp + _poseDown);
      _sniperMesh.quaternion.copy(camera.quaternion);
      _sniperMesh.rotateY(Math.PI + ((_wdef.viewYaw) || 0));
      _sniperMesh.rotateX(-0.1 - recoilT * 0.3 - _poseTiltX);
      _sniperMesh.rotateZ(_poseTiltZ);

      if (_sniperLight) {
        _sniperLight.position.copy(camera.position)
          .addScaledVector(new THREE.Vector3(-1,0,0).applyQuaternion(camera.quaternion), 20)
          .addScaledVector(new THREE.Vector3(0,1,0).applyQuaternion(camera.quaternion), 10);
      }
    } else if (_sniperLight) {
      _sniperLight.intensity = 0;
    }
    if (_sniperLight) _sniperLight.intensity = show ? 9 : 0;
  }

  // Scope / aim zoom — sniper gets the full scope overlay + tight zoom; every other
  // weapon has iron sights on the model itself, so it just zooms in with no overlay.
  // FOV eases toward its target each frame instead of snapping instantly.
  let _targetFov = 75;
  if (_sniperScoped && _equippedWeaponId === 'sniper') {
    _targetFov = 15;
    _scopeEl.style.display = Math.abs(camera.fov - 15) < 2 ? 'block' : 'none';
    _aimReticleEl.style.display = 'none';
  } else if (_sniperScoped) {
    _targetFov = 55; // a bit of zoom, not a full scope
    _scopeEl.style.display = 'none';
    _aimReticleEl.style.display = 'block';
  } else {
    _targetFov = 75;
    _scopeEl.style.display = 'none';
    _aimReticleEl.style.display = 'none';
  }
  camera.fov += (_targetFov - camera.fov) * 0.15;
  if (Math.abs(_targetFov - camera.fov) < 0.05) camera.fov = _targetFov;
  camera.updateProjectionMatrix();
}

// Fire on left-click, scope on right-click — only in planet_walk with sniper
let _gunMouseHeld = false;
document.addEventListener('mousedown', e => {
  if (!_hasSniper || (gameMode !== 'planet_walk' && gameMode !== 'planet_surface' && gameMode !== 'docked' && gameMode !== 'ejected' && gameMode !== 'range' && gameMode !== 'tdm') || !pointerLocked) return;
  if (e.button === 0) { _gunMouseHeld = true; _fireSniper(); }
  if (e.button === 2) { e.preventDefault(); _sniperScoped = true; }
});
document.addEventListener('mouseup', e => {
  if (e.button === 0) _gunMouseHeld = false;
  if (e.button === 2) _sniperScoped = false;
});
document.addEventListener('contextmenu', e => { if (_hasSniper && (gameMode === 'planet_walk' || gameMode === 'planet_surface' || gameMode === 'docked' || gameMode === 'ejected' || gameMode === 'range' || gameMode === 'tdm')) e.preventDefault(); });

// R — manual reload
document.addEventListener('keydown', e => {
  if (e.key !== 'r' && e.key !== 'R') return;
  if (!_hasSniper || (gameMode !== 'planet_walk' && gameMode !== 'planet_surface' && gameMode !== 'docked' && gameMode !== 'lobby' && gameMode !== 'ejected' && gameMode !== 'range' && gameMode !== 'tdm') || !pointerLocked) return;
  _startReload();
});

// Ammo counter HUD
const _ammoEl = document.createElement('div');
_ammoEl.style.cssText = `
  position:fixed;bottom:80px;right:20px;z-index:30;display:none;
  font-family:'Courier New',monospace;font-size:22px;letter-spacing:2px;
  color:#0ff;text-shadow:0 0 8px #000;
`;
document.body.appendChild(_ammoEl);

// Drop scope if player leaves planet
// (handled naturally — _sniperScoped gets ignored outside planet_walk)

// ── Room Customization ────────────────────────────────────────────────────────
const roomCustomEl = makePanel('ROOM CUSTOMIZATION', '#0f8', 'roomcustom');
let roomCustomOpen = false;
function openRoomCustom()  { roomCustomOpen = true;  roomCustomEl.style.display = 'block'; document.exitPointerLock(); }
function closeRoomCustom() { roomCustomOpen = false; roomCustomEl.style.display = 'none'; }
roomCustomEl.querySelector('#roomcustom-close').addEventListener('click', closeRoomCustom);
document.addEventListener('keydown', e => { if (roomCustomOpen && e.key === 'Escape') { closeRoomCustom(); e.stopPropagation(); } });

// ── Ship Upgrades ─────────────────────────────────────────────────────────────
const shipUpgradeEl = makePanel('SHIP UPGRADES', '#f80', 'shipupgrade');
let shipUpgradeOpen = false;
function openShipUpgrades()  { shipUpgradeOpen = true;  shipUpgradeEl.style.display = 'block'; document.exitPointerLock(); }
function closeShipUpgrades() { shipUpgradeOpen = false; shipUpgradeEl.style.display = 'none'; }
shipUpgradeEl.querySelector('#shipupgrade-close').addEventListener('click', closeShipUpgrades);
document.addEventListener('keydown', e => { if (shipUpgradeOpen && e.key === 'Escape') { closeShipUpgrades(); e.stopPropagation(); } });

// ── Room lights toggle ────────────────────────────────────────────────────────
let roomLightsOn = true;
const _LIGHTS_POS = new THREE.Vector3(0, 2, 143);
const _roomEmissiveCache = []; // { mat, baseIntensity }

const lightsPrompt = document.createElement('div');
lightsPrompt.style.cssText = 'position:fixed;bottom:120px;left:50%;transform:translateX(-50%);color:#0ff;font-family:monospace;font-size:15px;letter-spacing:3px;text-shadow:0 0 10px #0ff;pointer-events:none;display:none;';
lightsPrompt.textContent = '[ E ]  TURN OFF LIGHTS';
document.body.appendChild(lightsPrompt);

function buildEmissiveCache() {
  if (_roomEmissiveCache.length > 0) return;
  interiorScene.traverse(c => {
    if (c.isMesh && c.material) {
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach(m => {
        if (m.emissiveIntensity !== undefined && m.emissiveIntensity > 0) {
          _roomEmissiveCache.push({ mat: m, baseIntensity: m.emissiveIntensity });
        }
      });
    }
  });
}

function setRoomLights(on) {
  buildEmissiveCache();
  roomLightsOn = on;
  lightsPrompt.textContent = on ? '[ E ]  TURN OFF LIGHTS' : '[ E ]  TURN ON LIGHTS';
  _roomEmissiveCache.forEach(({ mat, baseIntensity }) => {
    mat.emissiveIntensity = on ? baseIntensity : baseIntensity * 0.04;
  });
  _iLight.intensity = on ? 2.0 : 0.02;
  renderer.toneMappingExposure = on ? 0.18 : 0.04;
}

function _killAllExteriorLights() {
  _sceneAmbient.intensity = 0;
  _dirLight.intensity     = 0;
  _lobbyAmbient.intensity = 0;
  _lobbyLight.intensity   = 0;
  _hangarAmbient.intensity= 0;
  _hangarLight.intensity  = 0;
}
function _muteSceneLights()   { _sceneAmbient.intensity = 0; _dirLight.intensity = 0; }
function _restoreSceneLights(){ _sceneAmbient.intensity = 2.5; _dirLight.intensity = 1.2; }

// ── Health / damage ──────────────────────────────────────────────────────────
const _healthEl = document.getElementById('health');
const _healthBarOuter = document.createElement('div');
_healthBarOuter.style.cssText = 'position:fixed;bottom:30px;left:20px;width:160px;height:10px;border:1px solid rgba(255,255,255,0.6);border-radius:5px;overflow:hidden;background:rgba(0,0,0,0.4);z-index:45;';
const _healthBarFill = document.createElement('div');
_healthBarFill.style.cssText = 'width:100%;height:100%;background:#fff;box-shadow:0 0 6px #fff;transition:width 0.15s;';
_healthBarOuter.appendChild(_healthBarFill);
document.body.appendChild(_healthBarOuter);

// ── Credits HUD ────────────────────────────────────────────────────────────────
const _creditsEl = document.createElement('div');
_creditsEl.style.cssText = 'position:fixed;bottom:46px;left:20px;color:#ffd24d;font-family:"Courier New",monospace;font-size:14px;letter-spacing:1px;text-shadow:0 0 6px #000;z-index:45;';
document.body.appendChild(_creditsEl);
function _updateCreditsHUD() { _creditsEl.textContent = `⬙ ${self.credits} CR`; }
// NOTE: can't call _updateCreditsHUD() here yet — `self` (the player state object) isn't
// declared until much later in this file, and referencing a not-yet-initialized top-level
// const throws (silently killing the rest of the script's top-level execution, since nothing
// here catches it). Just set the initial text directly; the real value arrives via the
// 'init' socket handler once connected.
_creditsEl.textContent = '⬙ 0 CR';
// Small floating "+N CR" popup whenever a reward comes in, so a kill/crate actually feels
// like it paid off instead of the number just quietly changing in the corner.
function _popCreditsReward(amount, reason) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:70px;left:20px;color:#ffd24d;font-family:"Courier New",monospace;font-size:15px;font-weight:bold;text-shadow:0 0 8px #000;z-index:46;pointer-events:none;transition:transform 1.1s ease-out, opacity 1.1s ease-out;';
  el.textContent = `+${amount} CR${reason ? ' — ' + reason.toUpperCase() : ''}`;
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.style.transform = 'translateY(-30px)';
    el.style.opacity = '0';
  });
  setTimeout(() => el.remove(), 1200);
}

function _updateHealthHUD() {
  if (_healthEl) _healthEl.textContent = Math.round(self.health);
  _healthBarFill.style.width = Math.max(0, Math.min(100, self.health)) + '%';
}

// Full-screen red vignette that flashes when you take damage
const _damageVignetteEl = document.createElement('div');
_damageVignetteEl.style.cssText = `
  position:fixed; inset:0; z-index:60; pointer-events:none; opacity:0;
  background:radial-gradient(ellipse at center, transparent 55%, rgba(255,0,0,0.55) 100%);
  transition:opacity 0.1s;
`;
document.body.appendChild(_damageVignetteEl);
let _damageVignetteTimeout = null;
function _flashDamageVignette() {
  _damageVignetteEl.style.opacity = '1';
  clearTimeout(_damageVignetteTimeout);
  _damageVignetteTimeout = setTimeout(() => { _damageVignetteEl.style.opacity = '0'; }, 350);
  _lastDamageTime = Date.now(); // regen only kicks in a few seconds after the last hit
}

// Full-screen white vignette shown continuously while health is passively regenerating
// — same shape as the damage flash, just white and only visible during regen (not a
// one-shot flash).
const _regenVignetteEl = document.createElement('div');
_regenVignetteEl.style.cssText = `
  position:fixed; inset:0; z-index:59; pointer-events:none; opacity:0;
  background:radial-gradient(ellipse at center, transparent 55%, rgba(255,255,255,0.35) 100%);
  transition:opacity 0.3s;
`;
document.body.appendChild(_regenVignetteEl);

const HEALTH_REGEN_DELAY_MS = 3000; // time since last damage before regen starts
const HEALTH_REGEN_PER_SEC = 8;
let _lastDamageTime = 0;
function _updateHealthRegen() {
  if (self.health <= 0 || self.health >= 100) {
    _regenVignetteEl.style.opacity = '0';
    return;
  }
  const regenerating = Date.now() - _lastDamageTime >= HEALTH_REGEN_DELAY_MS;
  _regenVignetteEl.style.opacity = regenerating ? '1' : '0';
  if (regenerating) {
    self.health = Math.min(100, self.health + HEALTH_REGEN_PER_SEC / 60); // called once per frame (~60fps)
    _updateHealthHUD();
  }
}

// Die with any weapon equipped → wake up back in your room with nothing
function _respawnInRoom() {
  enterStation();
  lobbyScene.visible = false;
  // Freezing to death in eject mode is one path into this respawn, and its frost overlay
  // was never hidden/reset here — it kept covering the screen with icicles even after
  // landing back in the room. Also reset the timers so a future eject starts icing over
  // from a clean slate instead of picking up wherever the last one left off.
  frostCanvas.style.display = 'none';
  _ejectTime = 0;
  _ejectFreezeDamageTimer = 0;
  for (let i = 0; i < INVENTORY_SIZE; i++) {
    _inventory[i] = null;
    _invSlotEls[i].icon.textContent = '';
    _invSlotEls[i].label.style.display = 'none';
  }
  _equippedWeaponId = null;
  _hasSniper = false;
  if (_sniperMesh) _sniperMesh.visible = false;
  _sniperMesh = null;
  Object.keys(_weaponAmmo).forEach(k => delete _weaponAmmo[k]);
  _gunReloading = false;
  self.health = 100;
  _updateHealthHUD();
  _invSetActive(0);
}

function enterStation() {
  gameMode = 'docked';
  fpPos.set(0, 2, 0); fpYaw = 0; fpPitch = 0; _fpMouseDX = 0; _fpMouseDY = 0; fpVel.set(0,0,0);
  _killAllExteriorLights();
  // Fully reset camera to identity — no leftover flight rotation
  camera.quaternion.identity();
  camera.position.copy(fpPos);
  interiorScene.visible = true;
  renderer.toneMappingExposure = 0.18;
  dockPrompt.style.display = 'none';
  exitPrompt.style.display = 'none'; // shown only near the door
}
// ── Planet landing / surface walk ─────────────────────────────────────────────
let _landedPlanet = null;
// Ship's resting spot stored in planet-local space so it rotates with the planet
const _shipLocalPos  = new THREE.Vector3();
const _shipLocalQuat = new THREE.Quaternion();

// Landing / takeoff animation state
let _landAnimT = 0;
const LAND_FRAMES    = 90;
const TAKEOFF_FRAMES = 80;
const _landStartPos  = new THREE.Vector3();
const _landStartQuat = new THREE.Quaternion();
const _landTargetPos = new THREE.Vector3();
const _landTargetQuat= new THREE.Quaternion();

// Ship marker (shown when walking away from ship on planet)
let _shipMarker = null;
const SHIP_MARKER_SHOW_DIST = 50; // units from ship before marker appears

function _createShipMarker(planet) {
  _removeShipMarker();
  const grp = new THREE.Group();
  // Arrow shaft
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.4, 0.4, 6, 6),
    new THREE.MeshBasicMaterial({ color: 0x00ffff })
  );
  shaft.position.y = 3;
  grp.add(shaft);
  // Arrowhead cone
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(1.8, 4, 6),
    new THREE.MeshBasicMaterial({ color: 0x00ffff })
  );
  head.position.y = 8;
  grp.add(head);
  grp.userData.markerPulse = 0;
  planet.add(grp);
  _shipMarker = grp;
}

function _removeShipMarker() {
  if (_shipMarker) {
    if (_shipMarker.parent) _shipMarker.parent.remove(_shipMarker);
    _shipMarker = null;
  }
}

function _updateShipMarker(eyePos, shipPos, planet, surfNorm) {
  if (!_shipMarker) return;
  // Position above ship, floating 8 units up along surface normal
  const r = planet.userData.collisionRadius || 700;
  const shipNorm = shipPos.clone().sub(planet.position).normalize();
  const markerWorld = shipPos.clone().addScaledVector(shipNorm, 8);
  const markerLocal = planet.worldToLocal(markerWorld.clone());
  _shipMarker.position.copy(markerLocal);

  // Orient so arrow points away from planet surface (up relative to planet)
  const localUp = planet.worldToLocal(shipPos.clone().addScaledVector(shipNorm, 1)).sub(markerLocal).normalize();
  _shipMarker.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), localUp);

  // Pulse: bob up and down
  _shipMarker.userData.markerPulse += 0.04;
  const bob = Math.sin(_shipMarker.userData.markerPulse) * 1.5;
  _shipMarker.position.copy(planet.worldToLocal(shipPos.clone().addScaledVector(shipNorm, 10 + bob)));

  // 3D arrow hidden — replaced by 2D diamond on HUD
  _shipMarker.visible = false;
}

// Planet-walk state
const _pwLocalPos   = new THREE.Vector3();
const _pwLocalNorth = new THREE.Vector3();
const _pwVel        = new THREE.Vector3();
let   _pwYaw = 0, _pwPitch = 0;
let   _pwMouseDX = 0, _pwMouseDY = 0;
let   _pwBobT = 0;
const PW_SPEED      = 3.5;
const PW_SPRINT_MUL = 3.0;
const PW_ACCEL      = 0.15;
const PW_FRICTION   = 0.80;
const PW_EYE_H      = 0.9;
const PW_JUMP_V     = 0.55;
const PW_GRAVITY    = 0.032;
let   _pwVertVel    = 0;

const _pwSurfNorm = new THREE.Vector3();
const _pwLookM    = new THREE.Matrix4();
const _O3         = new THREE.Vector3();

// Landed-in-ship menu
const _landedMenu = document.createElement('div');
_landedMenu.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);display:none;flex-direction:column;gap:10px;align-items:center;font-family:monospace;pointer-events:none;';
_landedMenu.innerHTML = `
  <div style="color:#f80;font-size:18px;letter-spacing:4px;text-shadow:0 0 12px #f80;">LANDED</div>
  <div style="color:#0ff;font-size:13px;letter-spacing:2px;">[ E ]  EXIT SHIP &nbsp;&nbsp; [ F ]  TAKE OFF</div>`;
document.body.appendChild(_landedMenu);

const _liftoffHint = document.createElement('div');
_liftoffHint.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);color:#f80;font-family:monospace;font-size:13px;letter-spacing:2px;text-shadow:0 0 8px #f80;pointer-events:none;display:none;';
_liftoffHint.textContent = '[ F ]  LIFT OFF';
document.body.appendChild(_liftoffHint);

function _pwInitNorth(planet, away) {
  let ref = new THREE.Vector3(0, 1, 0);
  if (Math.abs(away.dot(ref)) > 0.98) ref.set(1, 0, 0);
  const east  = new THREE.Vector3().crossVectors(ref, away).normalize();
  const north = new THREE.Vector3().crossVectors(away, east).normalize();
  _pwLocalNorth.copy(north).applyQuaternion(planet.quaternion.clone().invert());
}

function landOnPlanet(planet) {
  _landedPlanet = planet;
  _nearPlanet   = null;
  landPrompt.style.display = 'none';
  self.velocity.set(0, 0, 0);
  // Skip landing animation — teleport straight to surface
  _shipLocalPos.copy(planet.worldToLocal(selfMesh.position.clone()));
  _shipLocalQuat.copy(selfMesh.quaternion).premultiply(planet.quaternion.clone().invert());
  elHud.style.display = 'none';
  if (!document.pointerLockElement) document.body.requestPointerLock();
  _enterPlanetSurface(planet);
  return;

  const r = planet.userData.collisionRadius || 700;
  const away = selfMesh.position.clone().sub(planet.position).normalize();

  // Animation start = current ship pos/rot
  _landStartPos.copy(selfMesh.position);
  _landStartQuat.copy(selfMesh.quaternion);

  // Animation target = belly-down on surface
  _landTargetPos.copy(planet.position).addScaledVector(away, r);
  _landTargetQuat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), away);

  _landAnimT = 0;
  gameMode = 'landing_anim';
  elHud.style.display = 'none';
  if (skyboxMesh) scene.background = null;
  const atm = planet.userData.atmosphere;
  if (atm) renderer.setClearColor(atm.skyColor, 1);
}

function updateLandingAnim() {
  _landAnimT += 1 / LAND_FRAMES;
  const t = Math.min(1, _landAnimT);
  // Smooth ease-out curve
  const ease = 1 - Math.pow(1 - t, 3);

  selfMesh.position.lerpVectors(_landStartPos, _landTargetPos, ease);
  selfMesh.quaternion.slerpQuaternions(_landStartQuat, _landTargetQuat, ease);
  selfMesh.visible = true;

  // Camera follows the ship descent from a fixed observer-ish angle
  const shipPos = selfMesh.position;
  const planet  = _landedPlanet;
  const away    = shipPos.clone().sub(planet.position).normalize();
  // Pull camera slightly behind & above the ship
  camera.position.copy(shipPos).addScaledVector(away, 40).addScaledVector(
    new THREE.Vector3().crossVectors(away, new THREE.Vector3(0,1,0)).normalize(), -10
  );
  camera.lookAt(shipPos);

  if (t >= 1) {
    selfMesh.position.copy(_landTargetPos);
    selfMesh.quaternion.copy(_landTargetQuat);
    _shipLocalPos.copy(_landedPlanet.worldToLocal(selfMesh.position.clone()));
    _shipLocalQuat.copy(selfMesh.quaternion).premultiply(_landedPlanet.quaternion.clone().invert());
    if (!document.pointerLockElement) document.body.requestPointerLock();
    _enterPlanetSurface(_landedPlanet);
  }
}

// Orbit camera state for landed_ship mode
let _landedCamYaw = 0, _landedCamPitch = 0.55; // pitch in radians (0=horizon, PI/2=top)
let _landedCamMouseDX = 0, _landedCamMouseDY = 0;
const LANDED_CAM_DIST = 80;

function updateLandedShip() {
  const planet = _landedPlanet;
  selfMesh.position.copy(planet.localToWorld(_shipLocalPos.clone()));
  selfMesh.quaternion.copy(planet.quaternion).multiply(_shipLocalQuat);

  if (gameMode !== 'landed_ship') return; // walk mode just needs ship pos/rot

  // Orbit camera: player can look around with mouse
  _landedCamYaw   -= _landedCamMouseDX * 0.004;
  _landedCamPitch += _landedCamMouseDY * 0.003;
  _landedCamPitch  = Math.max(0.08, Math.min(Math.PI / 2 - 0.05, _landedCamPitch));
  _landedCamMouseDX = _landedCamMouseDY = 0;

  const norm = selfMesh.position.clone().sub(planet.position).normalize();
  let camRef = new THREE.Vector3(0, 1, 0);
  if (Math.abs(norm.dot(camRef)) > 0.98) camRef.set(1, 0, 0);
  const east  = new THREE.Vector3().crossVectors(camRef, norm).normalize();
  const north = new THREE.Vector3().crossVectors(norm, east).normalize();

  // Yaw around surface normal, pitch tilts toward horizon
  const horizDir = north.clone().applyQuaternion(
    new THREE.Quaternion().setFromAxisAngle(norm, _landedCamYaw)
  );
  const camDir = horizDir.clone().multiplyScalar(Math.cos(_landedCamPitch))
    .addScaledVector(norm, Math.sin(_landedCamPitch))
    .normalize();

  camera.position.copy(selfMesh.position).addScaledVector(camDir, LANDED_CAM_DIST);
  camera.lookAt(selfMesh.position);
}

// Board-ship proximity prompt
const _boardPrompt = document.createElement('div');
_boardPrompt.style.cssText = 'position:fixed;bottom:50px;left:50%;transform:translateX(-50%);color:#0ff;font-family:monospace;font-size:14px;letter-spacing:3px;text-shadow:0 0 10px #0ff;pointer-events:none;display:none;';
_boardPrompt.textContent = '[ E ]  BOARD SHIP';
document.body.appendChild(_boardPrompt);
const BOARD_DIST = 22; // units from ship center

function boardShip() {
  _boardPrompt.style.display = 'none';
  _liftoffHint.style.display = 'none';
  _removeShipMarker();
  // Auto-store held crate when boarding
  if (_heldCrate) _storeCrate();
  gameMode = 'landed_ship';
  _landedMenu.style.display = 'flex';
  _landedCamYaw = 0; _landedCamPitch = 0.55;
}

function exitShipOnPlanet() {
  _landedMenu.style.display = 'none';
  _liftoffHint.style.display = 'none';

  const planet = _landedPlanet;
  const r = planet.userData.collisionRadius || 700;
  // Use the live (planet-rotation-correct) ship position
  updateLandedShip();
  const away = selfMesh.position.clone().sub(planet.position).normalize();

  // Spawn 60 units to the side of the ship so player is clear of the hull
  let sideRef = new THREE.Vector3(0, 1, 0);
  if (Math.abs(away.dot(sideRef)) > 0.98) sideRef.set(1, 0, 0);
  const spawnSide = new THREE.Vector3().crossVectors(away, sideRef).normalize();
  const worldEye = planet.position.clone()
    .addScaledVector(away, r + PW_EYE_H)
    .addScaledVector(spawnSide, 18);
  _pwLocalPos.copy(planet.worldToLocal(worldEye.clone()));
  _pwInitNorth(planet, away);
  _pwVel.set(0, 0, 0);
  _pwVertVel = 0;
  _pwPitch = 0; _pwMouseDX = 0; _pwMouseDY = 0; _pwBobT = 0;

  // Compute yaw so player faces the ship on spawn (ship is in -spawnSide direction)
  // worldNorth from _pwInitNorth projected onto tangent plane
  const worldNorth = _pwLocalNorth.clone().applyQuaternion(planet.quaternion);
  worldNorth.addScaledVector(away, -worldNorth.dot(away)).normalize();
  // Direction from player toward ship = -spawnSide
  const toShip = spawnSide.clone().negate();
  // Angle between worldNorth and toShip around the surface normal (away)
  const cosA = worldNorth.dot(toShip);
  const sinA = new THREE.Vector3().crossVectors(worldNorth, toShip).dot(away);
  _pwYaw = Math.atan2(sinA, cosA);

  _createShipMarker(planet);
  gameMode = 'planet_walk';
}

function startTakeoff() {
  _landedMenu.style.display = 'none';
  _liftoffHint.style.display = 'none';
  _boardPrompt.style.display = 'none';
  elHud.style.display = 'none';
  _removeShipMarker();

  const planet = _landedPlanet;
  const r = planet.userData.collisionRadius || 700;
  // If walking, snap ship back to where we're standing
  if (gameMode === 'landed_ship') {
    updateLandedShip(); // ensure ship is at its current planet-rotated position
  } else if (gameMode === 'planet_walk') {
    const worldPos = planet.localToWorld(_pwLocalPos.clone());
    const norm = worldPos.clone().sub(planet.position).normalize();
    selfMesh.position.copy(planet.position).addScaledVector(norm, r);
    selfMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), norm);
  }

  _landStartPos.copy(selfMesh.position);
  _landStartQuat.copy(selfMesh.quaternion);
  const away = selfMesh.position.clone().sub(planet.position).normalize();
  _landTargetPos.copy(planet.position).addScaledVector(away, r * 2.2); // rise to 2.2× radius
  _landTargetQuat.copy(selfMesh.quaternion); // keep same orientation while rising

  _landAnimT = 0;
  selfMesh.visible = true;
  gameMode = 'takeoff_anim';
}

function updateTakeoffAnim() {
  _landAnimT += 1 / TAKEOFF_FRAMES;
  const t = Math.min(1, _landAnimT);
  const ease = t * t * (3 - 2 * t); // smooth-step acceleration

  selfMesh.position.lerpVectors(_landStartPos, _landTargetPos, ease);
  selfMesh.quaternion.slerpQuaternions(_landStartQuat, _landTargetQuat, ease);

  // Camera watches from slightly behind
  const away = selfMesh.position.clone().sub(_landedPlanet.position).normalize();
  const sideRef = new THREE.Vector3().crossVectors(away, new THREE.Vector3(0,1,0)).normalize();
  camera.position.copy(selfMesh.position).addScaledVector(away, 50).addScaledVector(sideRef, -15);
  camera.lookAt(selfMesh.position);

  if (t >= 1) {
    const planet = _landedPlanet;
    const away2  = selfMesh.position.clone().sub(planet.position).normalize();
    self.velocity.copy(away2).multiplyScalar(5);
    _landedPlanet = null;
    gameMode = 'flight';
    elHud.style.display = 'block';
    renderer.setClearColor(0x000000, 0);
    if (skyboxMesh) scene.background = _skyboxTex;
    if (window._setStarsVisible) window._setStarsVisible(true);
  }
}

function updatePlanetWalk() {
  const planet = _landedPlanet;
  if (!planet) return;

  _pwYaw   -= _pwMouseDX * 0.0028;
  _pwPitch -= _pwMouseDY * 0.0028;
  _pwPitch  = Math.max(-Math.PI / 2.4, Math.min(Math.PI / 2.4, _pwPitch));
  _pwMouseDX = 0; _pwMouseDY = 0;

  const worldPos = planet.localToWorld(_pwLocalPos.clone());
  _pwSurfNorm.copy(worldPos).sub(planet.position).normalize();

  const worldNorth = _pwLocalNorth.clone().applyQuaternion(planet.quaternion);
  worldNorth.addScaledVector(_pwSurfNorm, -worldNorth.dot(_pwSurfNorm)).normalize();

  const yawQ   = new THREE.Quaternion().setFromAxisAngle(_pwSurfNorm, _pwYaw);
  const facing = worldNorth.clone().applyQuaternion(yawQ);
  const right  = new THREE.Vector3().crossVectors(facing, _pwSurfNorm).normalize();

  const sprinting = keys['shift'];
  const speedCap  = PW_SPEED * (sprinting ? PW_SPRINT_MUL : 1);
  const accelAmt  = PW_ACCEL * (sprinting ? PW_SPRINT_MUL : 1);

  const accel = new THREE.Vector3();
  if (keys['w'] || keys['arrowup'])    accel.addScaledVector(facing,  accelAmt);
  if (keys['s'] || keys['arrowdown'])  accel.addScaledVector(facing, -accelAmt);
  if (keys['a'] || keys['arrowleft'])  accel.addScaledVector(right,  -accelAmt);
  if (keys['d'] || keys['arrowright']) accel.addScaledVector(right,   accelAmt);
  _pwVel.add(accel);
  _pwVel.addScaledVector(_pwSurfNorm, -_pwVel.dot(_pwSurfNorm));
  _pwVel.multiplyScalar(PW_FRICTION);
  if (_pwVel.length() > speedCap) _pwVel.setLength(speedCap);

  // Move horizontally
  worldPos.add(_pwVel);

  const r = planet.userData.collisionRadius || 700;
  const currentDist = worldPos.distanceTo(planet.position);
  const grounded    = currentDist <= r + PW_EYE_H + 0.1;

  // Jump
  if (keys[' '] && grounded && _pwVertVel <= 0) _pwVertVel = PW_JUMP_V;

  // Gravity
  _pwVertVel -= PW_GRAVITY;

  // Apply vertical movement along surface normal
  const newNorm = worldPos.clone().sub(planet.position).normalize();
  worldPos.addScaledVector(newNorm, _pwVertVel);

  // Re-derive norm after vertical move, clamp to surface floor
  const newNorm2 = worldPos.clone().sub(planet.position).normalize();
  const newDist  = worldPos.distanceTo(planet.position);
  if (newDist < r + PW_EYE_H) {
    worldPos.copy(planet.position).addScaledVector(newNorm2, r + PW_EYE_H);
    _pwVertVel = 0;
  }

  // Ship collision
  const SHIP_R = 11, SHIP_TOP = 10; // horizontal radius, height above ship base
  const shipNorm  = selfMesh.position.clone().sub(planet.position).normalize();
  const toPlayer  = worldPos.clone().sub(selfMesh.position);
  const radial    = toPlayer.dot(shipNorm);           // positive = above ship
  const tangVec   = toPlayer.clone().addScaledVector(shipNorm, -radial);
  const tangDist  = tangVec.length();
  if (tangDist < SHIP_R && radial < SHIP_TOP && radial > -2) {
    if (_pwVertVel <= 0 && radial > SHIP_TOP - 1.5) {
      // land on top
      worldPos.copy(selfMesh.position).addScaledVector(shipNorm, SHIP_TOP + PW_EYE_H);
      _pwVertVel = 0;
    } else {
      // push out horizontally
      const pushDir = tangDist > 0.01 ? tangVec.clone().normalize() : facing.clone();
      worldPos.copy(selfMesh.position)
        .addScaledVector(shipNorm, radial)
        .addScaledVector(pushDir, SHIP_R + 0.5);
    }
  }

  _pwLocalPos.copy(planet.worldToLocal(worldPos.clone()));

  const moving = _pwVel.lengthSq() > 0.005;
  if (moving && grounded) _pwBobT += sprinting ? 0.15 : 0.09;
  const bob    = (moving && grounded) ? Math.sin(_pwBobT) * 0.1 : 0;
  const eyePos = planet.position.clone().addScaledVector(newNorm2, newDist + bob);

  const pitchQ = new THREE.Quaternion().setFromAxisAngle(right, _pwPitch);
  const camFwd = facing.clone().applyQuaternion(pitchQ);
  const camUp  = _pwSurfNorm.clone().applyQuaternion(pitchQ);

  _pwLookM.lookAt(_O3, camFwd, camUp);
  camera.quaternion.setFromRotationMatrix(_pwLookM);
  camera.position.copy(eyePos);

  

  // Board-ship proximity prompt
  const distToShip = eyePos.distanceTo(selfMesh.position);
  _boardPrompt.style.display = distToShip < BOARD_DIST ? 'block' : 'none';

  _updateShipMarker(eyePos, selfMesh.position, planet, _pwSurfNorm);
}

document.addEventListener('keydown', e => {
  if (e.key === 'e' || e.key === 'E') {
    if (gameMode === 'planet_surface' && _surfLandShip && !_surfLeaving) {
      const sdx = _surfPos.x - _surfLandShip.position.x;
      const sdz = _surfPos.z - _surfLandShip.position.z;
      if (Math.sqrt(sdx*sdx + sdz*sdz) < 120) { _startLeavePlanet(); return; }
    }
    if (gameMode === 'landed_ship') { exitShipOnPlanet(); return; }
    if (gameMode === 'planet_walk') {
      // Store crate in ship if holding one and near ship
      if (_heldCrate) {
        const shipPos = new THREE.Vector3();
        if (_shipMarker) _shipMarker.getWorldPosition(shipPos);
        else shipPos.copy(selfMesh.position);
        if (camera.position.distanceTo(shipPos) < 40) { _storeCrate(); return; }
      }
      // Grab nearest crate
      if (!_heldCrate) {
        let best = null, bestDist = 18;
        _crateObjects.forEach(c => {
          if (c.held || c.stored) return;
          const wp = new THREE.Vector3();
          c.mesh.getWorldPosition(wp);
          const d = camera.position.distanceTo(wp);
          if (d < bestDist) { bestDist = d; best = c; }
        });
        if (best) { _grabCrate(best); return; }
      }
      // Board ship (existing)
      if (_boardPrompt.style.display !== 'none') { boardShip(); return; }
    }
    if (gameMode === 'lobby') {
      if (_inHangarZone()) { enterHangar(); return; }
      if (_inRangeZone()) {
        _lobbyRangePrompt.style.display = 'none';
        enterShootingRange();
        return;
      }
      if (_inRoomZone()) {
        _lobbyRoomPrompt.style.display = 'none';
        exitLobby();
        fpPos.set(-9.6, 2, 53); camera.position.copy(fpPos);
        return;
      }
      if (fpPos.distanceTo(_lobbyExitPos) < 40) {
        exitLobby();
        fpPos.set(-9.6, 2, 53); camera.position.copy(fpPos);
        return;
      }
    }
    if (gameMode === 'hangar') { exitHangar(); return; }
    if (gameMode === 'range') { exitShootingRange(); return; }
    if (gameMode === 'tdm') { exitTDMArena(); return; }
  }
  if (e.key === 'f' || e.key === 'F') {
    if (gameMode === 'landed_ship') { startTakeoff(); return; }
  }
});

function exitStation() {
  gameMode = 'flight';
  _restoreSceneLights();
  interiorScene.visible = false;
  lobbyScene.visible = false;
  renderer.toneMappingExposure = 1.0;
  exitPrompt.style.display = 'none';
  _lobbyExitPrompt.style.display = 'none';
  selfMesh.position.set(0, 0, 400);
  self.velocity.set(0, 0, 2);
}
document.addEventListener('keydown', e => {
  if (e.key !== 'e' && e.key !== 'E') return;
  if (gameMode === 'flight' && _nearPlanet) { landOnPlanet(_nearPlanet); return; }
  if (gameMode === 'flight' && selfMesh.position.distanceTo(station.position) < 400) enterHangarFromFlight();
  else if (gameMode === 'docked') {
    if (hubOpen) return; // hub handles its own E via its own listener
    const nearHub = fpPos.z > _HUB_Z_MIN && fpPos.z < _HUB_Z_MAX &&
      fpPos.x > _HUB_X_MIN && fpPos.x < _HUB_X_MAX;
    if (nearHub) { openHub(); return; }
    if (fpPos.distanceTo(_LIGHTS_POS) < 40) { setRoomLights(!roomLightsOn); return; }
    if (_doorPos && fpPos.distanceTo(_doorPos) < 40) enterLobby();
  }
});

function updateFP() {
  // Apply accumulated mouse delta directly — no lerp, no lag
  fpYaw   -= _fpMouseDX * 0.0028;
  fpPitch -= _fpMouseDY * 0.0028;
  fpPitch  = Math.max(-Math.PI / 2.5, Math.min(Math.PI / 2.5, fpPitch));
  _fpMouseDX = 0;
  _fpMouseDY = 0;

  _fpEuler.set(fpPitch, fpYaw, 0, 'YXZ');
  _fpQuat.setFromEuler(_fpEuler);
  camera.quaternion.copy(_fpQuat);

  // Movement flat on floor, aligned to yaw
  const sinY = Math.sin(fpYaw), cosY = Math.cos(fpYaw);
  _fpFwd.set(-sinY, 0, -cosY);
  _fpRight.set(cosY, 0, -sinY);

  // C or Alt to crouch (Alt is already noclip-descend in admin mode, so skip it there)
  const _crouchKeyDown = !window._adminMode && (keys['c'] || keys['alt']);
  // Crouching while sprinting triggers a slide — a one-shot burst that decays back down.
  // Once triggered it plays out fully; you don't need to keep holding the key.
  const _wasSprintingFP = (gameMode === 'lobby' || gameMode === 'tdm' || gameMode === 'trade_station') && keys['shift'] && fpVel.lengthSq() > 0.3;
  if (_crouchKeyDown && !_prevCrouchKey && _wasSprintingFP && _slideCooldownTimer <= 0) {
    _slideTimer = SLIDE_DURATION;
    _slideCooldownTimer = SLIDE_DURATION + SLIDE_COOLDOWN;
    fpVel.setLength(FP_SPEED * FP_SPRINT_MUL * SLIDE_SPEED_MUL); // launch the slide
    _slideJustTriggered = true; // sound only plays below once we know whether we're grounded
  }
  if (_slideCooldownTimer > 0) _slideCooldownTimer--;
  _prevCrouchKey = _crouchKeyDown;
  const _crouching = _crouchKeyDown || _slideTimer > 0; // stay low for the whole slide
  _crouchAmount += ((_crouching ? 1 : 0) - _crouchAmount) * 0.2;

  const _fpSprinting = (gameMode === 'lobby' || gameMode === 'tdm' || gameMode === 'trade_station') && keys['shift'] && !_crouching;
  const _fpSpeedMul  = 1 - CROUCH_SPEED_MUL * _crouchAmount;
  let _fpSpeedCap  = FP_SPEED * (_fpSprinting ? FP_SPRINT_MUL : 1) * _fpSpeedMul;
  const _fpAccel     = FP_ACCEL * (_fpSprinting ? FP_SPRINT_MUL : 1) * _fpSpeedMul;
  if (_slideTimer > 0) {
    const _slideT = _slideTimer / SLIDE_DURATION; // 1 -> 0
    _fpSpeedCap = Math.max(_fpSpeedCap, FP_SPEED * FP_SPRINT_MUL * SLIDE_SPEED_MUL * _slideT);
    _slideTimer--;
  }
  if (window._adminMode) {
    if (keys[' '])   fpVel.y += _fpAccel;
    if (keys['alt']) fpVel.y -= _fpAccel;
    fpVel.y *= 0.85;
  }
  if (keys['w']) fpVel.addScaledVector(_fpFwd,    _fpAccel);
  if (keys['s']) fpVel.addScaledVector(_fpFwd,   -_fpAccel);
  if (keys['a']) fpVel.addScaledVector(_fpRight,  -_fpAccel);
  if (keys['d']) fpVel.addScaledVector(_fpRight,   _fpAccel);
  fpVel.y = 0;
  fpVel.multiplyScalar(_slideTimer > 0 ? 0.97 : FP_FRICTION); // slide loses speed more gently
  if (fpVel.length() > _fpSpeedCap) fpVel.setLength(_fpSpeedCap);

  // Precise mesh collision — slide along walls (skipped in admin/noclip mode)
  // (TDM's collidables-minus-standing-mesh array is only rebuilt when the standing mesh
  // actually changes, not every frame — rebuilding via .filter() on a big GLB's full mesh
  // list every frame was tanking performance.)
  if (gameMode === 'tdm' && _tdmStandingMesh !== _tdmLastFilteredStandingMesh) {
    _tdmLastFilteredStandingMesh = _tdmStandingMesh;
    _tdmFilteredCollidables = _tdmStandingMesh ? _tdmArenaCollidables.filter(m => m !== _tdmStandingMesh) : _tdmArenaCollidables;
  }
  const _activeCollidables = gameMode === 'lobby' ? _lobbyCollidables : gameMode === 'hangar' ? _hangarCollidables : gameMode === 'range' ? _rangeCollidables
    : gameMode === 'tdm' ? _tdmFilteredCollidables
    : gameMode === 'trade_station' ? _tradeStationCollidables
    : _roomCollidables;
  if (!window._adminMode && _activeCollidables.length > 0 && fpVel.lengthSq() > 0.0001) {
    const PLAYER_RADIUS = gameMode === 'tdm' ? 4 : 2.5; // was 10 — too wide to fit through building doorways
    // Cast from several heights so low obstacles (crates, ledges) and geometry
    // above chest height (arches, overhangs) both register — a single chest-height
    // ray missed most of the arena's map geometry. TDM's map asset is loaded at a much
    // larger scale (targetSize 1400 vs ~400 elsewhere) so walls/obstacles are physically
    // bigger — sample a taller range accordingly.
    // NOTE: in TDM, fpPos.y is EYE height, which sits _TDM_EYE_OFFSET (16) units above the
    // actual ground — offsets here must be measured from the ground, not from fpPos.y,
    // or every ray ends up sampling 15-24 units in the air, over doorways and short objects.
    const _tdmGroundRef = gameMode === 'tdm' ? fpPos.y - _TDM_EYE_OFFSET : fpPos.y;
    // Lowest sample must stay ABOVE _TDM_MAX_STEP_UP — anything shorter than that is meant
    // to be auto-climbed by the floor step-up logic, not blocked here. Sampling any lower
    // both (a) fights the step-up logic, since you can never walk into a climbable object
    // to begin with, and (b) can catch the top edge/lip of whatever you're currently
    // standing on when you try to walk off it.
    const _heightOffsets = gameMode === 'tdm' ? [_TDM_MAX_STEP_UP + 1, _TDM_MAX_STEP_UP + 3, _TDM_MAX_STEP_UP + 6, _TDM_MAX_STEP_UP + 10] : [1];

    // Try X and Z axes independently (slide)
    const axes = [
      new THREE.Vector3(fpVel.x, 0, 0),
      new THREE.Vector3(0, 0, fpVel.z),
    ];
    for (const axisVel of axes) {
      if (axisVel.lengthSq() < 0.00001) continue;
      _fpRayDir.copy(axisVel).normalize();
      for (const hOff of _heightOffsets) {
        const origin = fpPos.clone();
        origin.y = _tdmGroundRef + hOff;
        _fpRaycaster.set(origin, _fpRayDir);
        _fpRaycaster.far = PLAYER_RADIUS + axisVel.length();
        const hits = _fpRaycaster.intersectObjects(_activeCollidables, false); // already a flat leaf-mesh list
        if (hits.length > 0 && hits[0].distance < PLAYER_RADIUS) {
          // Zero out just this axis
          if (axisVel.x !== 0) fpVel.x = 0;
          if (axisVel.z !== 0) fpVel.z = 0;
          break;
        }
      }
    }
  }

  if (gameMode === 'docked') {
    // Show exit prompt only when near the door
    if (_doorPos) {
      exitPrompt.style.display = fpPos.distanceTo(_doorPos) < 40 ? 'block' : 'none';
    }
    // Show lights prompt when near the light switch
    lightsPrompt.style.display = (fpPos.distanceTo(_LIGHTS_POS) < 40 && !hubOpen) ? 'block' : 'none';
    // Room Hub trigger zone
    const nearHub = fpPos.z > _HUB_Z_MIN && fpPos.z < _HUB_Z_MAX &&
      fpPos.x > _HUB_X_MIN && fpPos.x < _HUB_X_MAX;
    hubApproachPrompt.style.display = (nearHub && !hubOpen) ? 'block' : 'none';
  } else if (gameMode === 'lobby') {
    _lobbyExitPrompt.style.display = fpPos.distanceTo(_lobbyExitPos) < 40 ? 'block' : 'none';
    _hangarPrompt.style.display = _inHangarZone() ? 'block' : 'none';
    _lobbyRoomPrompt.style.display = _inRoomZone() ? 'block' : 'none';
    _lobbyRangePrompt.style.display = _inRangeZone() ? 'block' : 'none';
    _rangeExitPrompt.style.display = 'none';
    _updateTDMZone();
  } else if (gameMode === 'range') {
    _rangeExitPrompt.style.display = 'block';
    _tdmEl.style.display = 'none';
  } else if (gameMode === 'tdm') {
    _tdmExitPrompt.style.display = 'block';
    _tdmEl.style.display = 'none';
  } else {
    _tdmEl.style.display = 'none';
  }

  fpPos.add(fpVel);

  // Player-vs-player collision — push back out of any other astronaut you'd otherwise
  // walk into. Uses a simple circle test against each player's precise measured radius
  // (see _cloneAstronaut) rather than a mesh raycast, so it's stable regardless of the
  // humanoid model's actual triangle layout.
  if (!window._adminMode) {
    const PLAYER_RADIUS = 2.5;
    _getRemotePlayerHitTargets().forEach(m => {
      const other = m.children[0]; // the actual astronaut clone (m is the wrapper group)
      if (!other || !other.userData.collisionRadius) return;
      const localOffset = other.userData.collisionCenterOffset || new THREE.Vector3();
      const worldOffset = localOffset.clone().applyQuaternion(m.quaternion);
      const cx = m.position.x + worldOffset.x, cz = m.position.z + worldOffset.z;
      const dx = fpPos.x - cx, dz = fpPos.z - cz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const minDist = PLAYER_RADIUS + other.userData.collisionRadius;
      if (dist > 0 && dist < minDist) {
        const push = (minDist - dist) / dist;
        fpPos.x += dx * push;
        fpPos.z += dz * push;
      }
    });
  }

  if (!window._adminMode) {
    // Clamp to active scene bounding box
    const _activeBBox = gameMode === 'lobby' ? _lobbyBBox : gameMode === 'hangar' ? _hangarBBox : gameMode === 'range' ? _rangeBBox : gameMode === 'tdm' ? _tdmArenaBBox : gameMode === 'trade_station' ? _tradeStationBBox : _roomBBox;
    if (_activeBBox) {
      const PAD = 2.5;
      fpPos.x = Math.max(_activeBBox.min.x + PAD, Math.min(_activeBBox.max.x - PAD, fpPos.x));
      fpPos.z = Math.max(_activeBBox.min.z + PAD, Math.min(_activeBBox.max.z - PAD, fpPos.z));
    }
    // Shooting range hard boundary
    if (gameMode === 'range') {
      if (fpPos.x > 192) fpPos.x = 192;
      if (fpPos.z > -88) fpPos.z = -88;
    }
  }
  const moving = fpVel.lengthSq() > 0.01;
  // TDM ground check now casts down from just above the player's own head instead of
  // from high in the sky — a cast from way up would hit the TOP of any platform/roof
  // overhead and snap the player onto it even while they're walking underneath it.
  // Also clamp how much the floor can jump UP in one frame: a small rise (stairs, a
  // curb) is accepted as a step, but a big rise directly ahead means it's the top edge
  // of an object/wall the player just walked into — treat that as a wall (blocked by
  // the horizontal collision above) instead of snapping the player up onto it.
  let _fpFloor;
  if (gameMode === 'lobby') _fpFloor = -7.5;
  else if (gameMode === 'range') _fpFloor = 0;
  else if (gameMode === 'tdm') {
    _tdmGroundRaycaster.set(new THREE.Vector3(fpPos.x, fpPos.y + 6, fpPos.z), new THREE.Vector3(0, -1, 0));
    const _groundHits = _tdmArenaCollidables.length > 0 ? _tdmGroundRaycaster.intersectObjects(_tdmArenaCollidables, false) : [];
    _tdmStandingMesh = _groundHits.length > 0 ? _groundHits[0].object : null;
    const _rawGround = _groundHits.length > 0 ? _groundHits[0].point.y + _TDM_EYE_OFFSET : _tdmGroundHeightAt(fpPos.x, fpPos.z, fpPos.y + 6);
    // Small rises (stairs, curbs) still auto-step. Bigger rises only get accepted while
    // airborne (landing on top of something you jumped onto) — while walking on the
    // ground, a big rise ahead is a wall/object edge and should block you, not carry you
    // up onto it.
    const MAX_STEP_UP = _TDM_MAX_STEP_UP;
    if (_tdmLastFloor === null || _rawGround <= _tdmLastFloor + MAX_STEP_UP || _rawGround < _tdmLastFloor || !_tdmWasGrounded) {
      _tdmLastFloor = _rawGround;
    }
    _fpFloor = _tdmLastFloor;
  } else if (gameMode === 'trade_station') _fpFloor = _tradeStationFloorY;
  else _fpFloor = 2;
  const _fpGrounded = fpPos.y <= _fpFloor + 0.1;
  if (gameMode === 'tdm') _tdmWasGrounded = _fpGrounded;
  if (_slideJustTriggered) {
    _slideJustTriggered = false;
    if (_fpGrounded) _playSfx('assets/sounds/slide.mp3', 0.4);
  }
  const _fpSprinting2 = (gameMode === 'lobby' || gameMode === 'tdm') && keys['shift'];
  // Bob: faster + bigger in lobby/tdm to feel like real footsteps
  const _bobbyMode = gameMode === 'lobby' || gameMode === 'tdm' || gameMode === 'trade_station';
  const bobSpeed = _bobbyMode ? (_fpSprinting2 ? 0.16 : 0.11) : 0.08;
  const bobAmp   = _bobbyMode ? 1.8 : 0.8;
  const _bobAdvancing = moving && (!_bobbyMode || _fpGrounded);
  if (_bobAdvancing) fpBobT += bobSpeed;
  else fpBobT += (Math.round(fpBobT / Math.PI) * Math.PI - fpBobT) * 0.12;
  const bob = Math.sin(fpBobT) * bobAmp * (moving ? 1 : Math.exp(-0.1));
  // Footsteps: footsteps.mp3 is actually a multi-second walking-loop sample (not one
  // single step), so retriggering a fresh Audio() per step played the whole several-second
  // clip every time and they piled up into a mess that kept going after you'd stopped.
  // Instead treat it as one continuous loop tied directly to movement: play() when you
  // start moving, pause() the instant you stop/slide/leave the ground, and speed up
  // (playbackRate) while sprinting so the cadence actually matches your speed.
  const _canFootstep = moving && _fpGrounded && !(_slideTimer > 0);
  if (_canFootstep) {
    _footstepAudio.playbackRate = _fpSprinting2 ? 1.5 : 1.0;
    _footstepAudio.volume = _fpSprinting2 ? 0.4 : 0.28;
    if (_footstepAudio.paused) _footstepAudio.play().catch(() => {});
  } else if (!_footstepAudio.paused) {
    _footstepAudio.pause();
  }
  if (window._adminMode) {
    camera.position.copy(fpPos);
  } else if (_bobbyMode) {
    // Jump + gravity
    if (keys[' '] && _fpGrounded && _fpJumpVel <= 0) _fpJumpVel = FP_JUMP_V * (gameMode === 'tdm' ? 2.8 : gameMode === 'lobby' ? 1.8 : 1);
    _fpJumpVel -= FP_GRAVITY;
    // Ceiling check — stop the ascent instead of letting the camera clip up into
    // whatever geometry (platform underside, arch, roof) is directly overhead.
    if (gameMode === 'tdm' && _fpJumpVel > 0 && _tdmArenaCollidables.length > 0) {
      _tdmGroundRaycaster.set(new THREE.Vector3(fpPos.x, fpPos.y + 2, fpPos.z), new THREE.Vector3(0, 1, 0));
      const _ceilHits = _tdmGroundRaycaster.intersectObjects(_tdmArenaCollidables, false);
      if (_ceilHits.length > 0 && _ceilHits[0].distance < _fpJumpVel + 2) {
        _fpJumpVel = 0;
      }
    }
    fpPos.y += _fpJumpVel;
    if (fpPos.y < _fpFloor) { fpPos.y = _fpFloor; _fpJumpVel = 0; }
    camera.position.copy(fpPos);
    if (_fpGrounded) camera.position.y += bob * 0.4;
    camera.position.y -= CROUCH_HEIGHT * _crouchAmount;
  } else {
    fpPos.y = _fpFloor + bob;
    camera.position.copy(fpPos);
    camera.position.y -= CROUCH_HEIGHT * _crouchAmount;
  }

  _updateSelfAstronaut();
  if (window._thirdPerson && !window._adminMode) {
    // Pull the camera back and up behind the player, still looking the same direction
    const _tpBack = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
    camera.position.addScaledVector(_tpBack, 70);
    camera.position.y += 20;
  }
}

// ── Safe zone ─────────────────────────────────────────────────────────────────
let safeZoneRadius = 5000;

// ── Planets ───────────────────────────────────────────────────────────────────
// Diamond marker above a planet — geometry created on demand, never pre-added to scene
function addDiamond(planet, color) {
  planet.userData.diamondColor = color;
  planet.userData.diamond = null;
  planet.userData.mapSelected = false;
}

function _showDiamond(planet) {
  if (planet.userData.diamond) return;
  const r = planet.userData.collisionRadius || 500;
  const geo = new THREE.OctahedronGeometry(r * 0.12, 0);
  const mat = new THREE.MeshBasicMaterial({ color: planet.userData.diamondColor });
  const gem = new THREE.Mesh(geo, mat);
  gem.position.y = r * 1.6;
  gem.userData.spin = true;
  planet.userData.diamond = gem;
  planet.add(gem);
}

function _hideDiamond(planet) {
  if (!planet.userData.diamond) return;
  planet.remove(planet.userData.diamond);
  planet.userData.diamond.geometry.dispose();
  planet.userData.diamond.material.dispose();
  planet.userData.diamond = null;
}

function createPlanet(x, z, radius, color, ringColor) {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(
    new THREE.SphereGeometry(radius, 32, 32),
    new THREE.MeshBasicMaterial({ color })
  ));
  if (ringColor) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 1.6, radius * 0.15, 4, 64),
      new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.6 })
    );
    ring.rotation.x = Math.PI / 3;
    group.add(ring);
  }
  group.position.set(x, 0, z);
  group.userData.collisionRadius = radius;
  scene.add(group);
  return group;
}

/* PLANETS DISABLED — uncomment to restore
const planetDefs = [
  [ 3200,  1800,  60, 0x4488cc, null],
  [-3500,  1000,  80, 0xcc6644, 0x886644],
  [ 1200, -3800,  45, 0x44cc88, null],
  [-2800, -3200, 100, 0xccaa44, 0xcc8822],
  [ 4200, -1500,  55, 0xaa44cc, null],
];
const planets = planetDefs.map((def, i) => {
  const p = createPlanet(...def);
  loadModel(ASSETS.planets[i], def[2] * 10, model => {
    if (!model) return;
    while (p.children.length) p.remove(p.children[0]);
    p.add(model);
  });
  return p;
});
*/
const planets = [];

// Player-placed planet at -60980, -43048, -23362
(function() {
  const p = createPlanet(-60980, -23362, 900, 0x3a7acc, 0x5599dd);
  p.position.y = -43048;
  p.userData.mapName = 'Aqua Prime';
  p.userData.mapEmoji = '💧';
  p.userData.atmosphere = {
    skyColor:  new THREE.Color(0x1a5599),   // deep ocean blue
    fogColor:  new THREE.Color(0x3377cc),
    fogDensity: 0.0018,
    atmRadius: 900 * 3.5,
  };
  planets.push(p);
})();

// Planet at 42000, 25000, -42000 (swapped with Obsidian's original position)
(function() {
  const p = createPlanet(42000, -42000, 700, 0xcc6644, 0x886644);
  p.position.y = 25000;
  p.userData.mapName = 'Phoenix';
  p.userData.mapEmoji = '🔥';
  p.userData.atmosphere = {
    skyColor:   new THREE.Color(0xbb3300),
    fogColor:   new THREE.Color(0xff5500),
    fogDensity: 0.0008,   // light haze — planet visible, atmosphere glows from far
    atmRadius:  700 * 6,  // wide so the orange tint is seen approaching
  };
  loadModel('assets/planets/planet_of_phoenix.glb', 7000, model => {
    if (!model) return;
    // Remove only original geometry (sphere/ring), keep crate wrappers
    p.children.filter(c => !c.userData.isCrateWrapper).forEach(c => p.remove(c));
    p.add(model);
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const r = Math.max(size.x, size.y, size.z) * 0.5;
    p.userData.collisionRadius = r;
    p.userData.atmosphere.atmRadius = r * 5;
    // Make every surface on the GLB always illuminated
    model.traverse(c => {
      if (!c.isMesh || !c.material) return;
      const m = c.material;
      // Replace with MeshBasicMaterial so planet is always fully bright
      const basic = new THREE.MeshBasicMaterial({ map: m.map || null, color: m.color || 0xffffff });
      c.material = basic;
    });
  });
  planets.push(p);
})();

// ── 50 procedural planets ─────────────────────────────────────────────────────
(function() {
  // Each entry: [x, y, z, radius, surfaceColor, ringColor|null, atmSkyColor, atmFogColor, fogDensity, diamondColor, secondRing]
  const defs = [
    // Icy/blue worlds
    [ 12000,  18000, -18000,  550, 0xaaccff, 0x88aadd, 0x224477, 0x4488cc, 0.0012, 0x00eeff, false],
    [-15000, -22000,  14000,  420, 0xddeeff, null,      0x113355, 0x2266aa, 0.0010, 0x88ddff, false],
    [ 22000,  35000,  10000,  700, 0xbbddff, 0xaaccee, 0x001133, 0x0033aa, 0.0008, 0x0088ff, false],
    [-28000, -14000, -12000,  380, 0x99bbdd, null,      0x112244, 0x3355bb, 0.0015, 0x44aaff, false],
    // Lava/red worlds
    [ 18000,  -28000,  22000,  600, 0xcc3300, 0xff6600, 0x550000, 0xff2200, 0.0014, 0xff3300, false],
    [-20000,   40000, -25000,  480, 0xdd4400, null,      0x440000, 0xcc3300, 0.0010, 0xff6600, false],
    [ 33000,  -10000,  -8000,  750, 0xbb2200, 0x882200, 0x660000, 0xff4400, 0.0009, 0xff2200, false],
    [-10000,   25000,  30000,  410, 0xee5500, 0xcc3300, 0x550000, 0xff3300, 0.0016, 0xdd2200, false],
    // Jungle/green worlds
    [ 25000,  -35000,  18000,  520, 0x336633, null,      0x112200, 0x44aa22, 0.0012, 0x00ff44, false],
    [-32000,   12000,   5000,  640, 0x448844, 0x226622, 0x003300, 0x33cc44, 0.0011, 0x22ff66, false],
    [ 11000,   45000, -35000,  460, 0x55aa33, null,      0x001100, 0x22bb33, 0.0013, 0x44dd22, false],
    [-18000,  -40000,  35000,  580, 0x33771f, 0x224411, 0x112200, 0x44aa22, 0.0010, 0x00ee33, false],
    // Desert/tan worlds
    [ 38000,   20000,  14000,  700, 0xddbb77, 0xcc9944, 0x3399ee, 0xddaa44, 0.0008, 0xffcc44, false],
    [-40000,  -30000,  20000,  500, 0xcc9955, null,      0x3399ee, 0xbb8833, 0.0007, 0xffaa22, false],
    [ 16000,   50000,  40000,  430, 0xeecc88, 0xddaa55, 0x3399ee, 0xeeaa44, 0.0012, 0xffdd66, false],
    [-24000,  -48000, -40000,  620, 0xbb9944, null,      0x3399ee, 0xcc9933, 0.0009, 0xffbb33, false],
    // Desert worlds (reassigned from industrial)
    [ 20000,   38000, -28000,  590, 0xddbb88, 0xccaa66, 0x3399ee, 0xddaa55, 0.0012, 0xffcc55, false],
    [-35000,  -18000,  28000,  510, 0xccaa77, null,      0x3399ee, 0xbb8844, 0.0010, 0xffbb44, false],
    [ 48000,   42000,  22000,  650, 0xeebb88, 0xddaa66, 0x3399ee, 0xeebb55, 0.0009, 0xffdd66, false],
    [-22000,  -52000,  48000,  480, 0xbb9966, null,      0x3399ee, 0xcc9944, 0.0013, 0xffcc44, false],
    // Jungle worlds (reassigned from industrial)
    [ 55000,   60000,  15000,  900, 0x44aa55, 0x227733, 0x001100, 0x33cc44, 0.0006, 0x00ff66, false],
    [-55000,  -60000,  30000,  850, 0x339944, 0x226633, 0x001100, 0x22bb33, 0.0006, 0x00ee55, false],
    [ 28000,   55000,  55000,  950, 0x55bb44, 0x338822, 0x001100, 0x44cc33, 0.0005, 0x22ff44, false],
    // Dark/charcoal worlds
    [ 2062,   -12912, -12849,  530, 0x444455, null,      0x000011, 0x222244, 0.0015, 0x6666ff, false],
    [-48000,  -35000, -38000,  470, 0x555566, 0x333355, 0x000022, 0x333366, 0.0012, 0x4444ff, false],
    [ 35000,   48000,  48000,  610, 0x334444, null,      0x001111, 0x224444, 0.0010, 0x00ffdd, false],
    [-60000,  -25000,  18000,  720, 0x445555, 0x334455, 0x001122, 0x335566, 0.0009, 0x0088dd, false],
    // Yellow/sulfur worlds
    [ 50000,   15000,  48000,  510, 0xeeee44, 0xcccc22, 0x333300, 0xdddd22, 0.0012, 0xffff00, false],
    [-50000,  -45000, -50000,  470, 0xddcc22, null,      0x222200, 0xccbb11, 0.0013, 0xeeee00, false],
    [ 65000,   58000,  35000,  700, 0xffee55, 0xddcc33, 0x443300, 0xeecc33, 0.0009, 0xffff44, false],
    [-65000,  -58000, -30000,  630, 0xccbb33, 0xbbaa22, 0x332200, 0xbbaa22, 0.0010, 0xeedd00, false],
    // Glowing/neon worlds
    [ 32000,  -75000, -68000, 580, 0x113355, 0x224488, 0x000022, 0x1144aa, 0.0018, 0x0033ff, false],
    [-72000,  65000,   22000, 540, 0x221133, null,      0x110022, 0x552288, 0.0015, 0x8800ff, false],
    [ 72000, -55000,  -40000, 620, 0x112244, 0x223366, 0x000033, 0x2233aa, 0.0012, 0x2255ff, false],
    [-35000,  48000,   72000, 500, 0x002233, null,      0x001122, 0x113355, 0.0013, 0x0066ff, false],
    // One extra varied
    [ 58000,  72000,  -62000, 680, 0x228855, 0x117733, 0x001100, 0x33aa55, 0.0010, 0x00ff88, false],
  ];

  const DIAMOND_COLORS = [
    0x00eeff,0xff3300,0x00ff44,0xffcc44,0xcc44ff,0x00ffee,
    0xffee66,0xff88ff,0x88bbff,0xffcc88,0x6666ff,0x00ffdd,
    0xff44aa,0xff2288,0xff66cc,0xffff00,0xeeee00,0xffff44,
    0xcc6633,0xbb5522,0xdd8855,0xcc7744,0x0033ff,0x8800ff,
    0x2255ff,0x0066ff,0x00ff88,0xff5533,0x44eedd,0x00ccff,
  ];

  const PLANET_NAMES = [
    'Frost Haven','Cryo Reach','Glacius','Tundra Shelf',
    'Cinder Peak','Molten Eye','Inferno','Ember Drift',
    'Greenvale','Highland Vale','Mossy Hollow','Sunken Valley',
    'Dust Bowl','Sand Veil','Mirage','Dune Scar',
    'Sunscorch','Amber Wastes','Drylands','Cracked Basin',
    'Silverbrook','Fernvale','Windmere Vale',
    'Obsidian','Slate Void','Charcoal Rim','Iron Dark',
    'Sulfur Moon','Acid Flats','Brimstone','Gilt Waste',
    'Neon Abyss','Void Pulse','Azure Neon','Deep Circuit',
    'Emerald Valley',
  ];

  // One emoji per planet, matching the biome groupings in the `defs` comments above
  // (icy, lava, jungle, desert x2, jungle-reassigned, dark/charcoal, sulfur, neon, extra).
  const PLANET_EMOJIS = [
    '❄️','❄️','❄️','❄️',
    '🔥','🔥','🔥','🔥',
    '🌴','🌴','🌴','🌴',
    '🏜️','🏜️','🏜️','🏜️',
    '🏜️','🏜️','🏜️','🏜️',
    '🌴','🌴','🌴',
    '🌑','🌑','🌑','🌑',
    '☢️','☢️','☢️','☢️',
    '✨','✨','✨','✨',
    '🌴',
  ];

  defs.forEach(([x, y, z, r, col, ring, skyC, fogC, fogD, dCol, extraRing], i) => {
    const p = createPlanet(x, z, r, col, ring);
    p.position.y = y;
    p.userData.mapName = PLANET_NAMES[i] || ('Planet ' + (i + 1));
    p.userData.mapEmoji = PLANET_EMOJIS[i] || '🪐';

    // Second ring for gas giants
    if (extraRing) {
      const r2 = new THREE.Mesh(
        new THREE.TorusGeometry(r * 2.2, r * 0.08, 4, 64),
        new THREE.MeshBasicMaterial({ color: ring || col, transparent: true, opacity: 0.35 })
      );
      r2.rotation.x = Math.PI / 2.5;
      p.add(r2);
    }

    p.userData.atmosphere = {
      skyColor:   new THREE.Color(skyC),
      fogColor:   new THREE.Color(fogC),
      fogDensity: fogD,
      atmRadius:  r * 5,
    };

    addDiamond(p, dCol);
    planets.push(p);
  });
})();
// ── End procedural planets ────────────────────────────────────────────────────

// ── Galaxy Map ────────────────────────────────────────────────────────────────
(function() {
  const mapEl     = document.getElementById('galaxy-map');
  const mapCanvas = document.getElementById('map-canvas');
  const mapInfo   = document.getElementById('map-info');
  const ctx       = mapCanvas.getContext('2d');
  const W = mapCanvas.width, H = mapCanvas.height;
  let mapOpen = false;

  function worldToMap(wx, wz) {
    // Project XZ world space onto 2D canvas, auto-scaled to fit all planets
    const SCALE = W * 0.44 / 80000; // 80000 = ~max extent
    return [W/2 + wx * SCALE, H/2 + wz * SCALE];
  }

  function drawMap() {
    ctx.clearRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = 'rgba(0,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const x = i * W / 10;
      const y = i * H / 10;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Safe zone circle
    const [sx, sy] = worldToMap(0, 0);
    const safeR = 5000 * (W * 0.44 / 80000);
    ctx.strokeStyle = 'rgba(0,255,0,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(sx, sy, safeR, 0, Math.PI*2); ctx.stroke();
    ctx.fillStyle = 'rgba(0,255,0,0.07)';
    ctx.fill();

    // Planets
    planets.forEach((p, pi) => {
      const [mx, my] = worldToMap(p.position.x, p.position.z);
      const selected = p.userData.mapSelected;
      // The crate's current planet is always highlighted, whether or not it's also been
      // manually marked — it's an active, time-limited event worth surfacing on its own.
      const hasCrate = _eventCrateState && _eventCrateState.status === 'planet' && _eventCrateState.planetIndex === pi;
      const col = hasCrate
        ? '#ffcc44'
        : p.userData.diamond
        ? '#' + p.userData.diamond.material.color.getHexString()
        : '#aaccff';

      // Dot
      ctx.beginPath();
      ctx.arc(mx, my, (selected || hasCrate) ? 7 : 5, 0, Math.PI*2);
      ctx.fillStyle = (selected || hasCrate) ? col : 'rgba(150,180,220,0.5)';
      ctx.fill();
      if (selected || hasCrate) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.stroke();
        // Outer glow ring — pulses for the crate planet so it reads as "active event", not
        // just a regularly-marked one.
        const glowR = hasCrate ? 12 + 3 * Math.sin(Date.now() * 0.005) : 12;
        ctx.beginPath();
        ctx.arc(mx, my, glowR, 0, Math.PI*2);
        ctx.strokeStyle = col + '55';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Name — prefixed with an emoji showing the planet's biome/type at a glance
      ctx.fillStyle = (selected || hasCrate) ? col : 'rgba(120,160,200,0.7)';
      ctx.font = (selected || hasCrate) ? 'bold 11px Courier New' : '10px Courier New';
      const _emoji = hasCrate ? '📦' : (p.userData.mapEmoji || '');
      const _label = (_emoji ? _emoji + ' ' : '') + (p.userData.mapName || '?');
      ctx.fillText(_label, mx + 9, my + 4);
    });

    // Trading stations — small cyan squares, same "only shown once marked" rule applies
    // to their in-world waypoint, but they're always visible here on the map itself so
    // there's a way to discover and mark them in the first place.
    if (typeof _tradingStations !== 'undefined') {
      _tradingStations.forEach(s => {
        const [mx, my] = worldToMap(s.position.x, s.position.z);
        const selected = s.userData.mapSelected;
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(Math.PI / 4);
        ctx.beginPath();
        ctx.rect(selected ? -6 : -4, selected ? -6 : -4, selected ? 12 : 8, selected ? 12 : 8);
        ctx.fillStyle = selected ? '#00ccff' : 'rgba(0,200,255,0.4)';
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = selected ? '#00ccff' : 'rgba(0,200,255,0.6)';
        ctx.font = selected ? 'bold 10px Courier New' : '9px Courier New';
        ctx.fillText(s.userData.mapName || 'TRADE STATION', mx + 8, my + 4);
      });
    }

    // Player position
    const pp = window.selfMesh ? window.selfMesh.position : null;
    if (pp) {
      const [px, py2] = worldToMap(pp.x, pp.z);
      ctx.beginPath();
      ctx.arc(px, py2, 5, 0, Math.PI*2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px Courier New';
      ctx.fillText('YOU', px + 7, py2 + 4);
    }
  }

  function openMap() {
    mapOpen = true;
    mapEl.classList.add('open');
    drawMap();
    if (document.pointerLockElement) document.exitPointerLock();
  }

  function closeMap() {
    mapOpen = false;
    mapEl.classList.remove('open');
    mapInfo.textContent = '';
    overlay.classList.add('hidden');
    setTimeout(() => document.body.requestPointerLock(), 150);
  }

  // Toggle with M key
  document.addEventListener('keydown', e => {
    if ((e.key === 'm' || e.key === 'M') && gameMode !== 'docked') {
      mapOpen ? closeMap() : openMap();
    }
    if (e.key === 'Escape' && mapOpen) closeMap();
  });

  // Click to select/deselect planet
  mapCanvas.addEventListener('click', e => {
    e.stopPropagation();
    const rect = mapCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const SCALE = W * 0.44 / 80000;

    let closest = null, closestDist = 18, closestIsStation = false;
    planets.forEach(p => {
      const [px, py2] = worldToMap(p.position.x, p.position.z);
      const d = Math.hypot(mx - px, my - py2);
      if (d < closestDist) { closestDist = d; closest = p; closestIsStation = false; }
    });
    if (typeof _tradingStations !== 'undefined') {
      _tradingStations.forEach(s => {
        const [px, py2] = worldToMap(s.position.x, s.position.z);
        const d = Math.hypot(mx - px, my - py2);
        if (d < closestDist) { closestDist = d; closest = s; closestIsStation = true; }
      });
    }

    if (closest && closestIsStation) {
      closest.userData.mapSelected = !closest.userData.mapSelected;
      mapInfo.textContent = closest.userData.mapSelected
        ? '► ' + closest.userData.mapName + ' — marker enabled'
        : '  ' + closest.userData.mapName + ' — marker hidden';
      drawMap();
    } else if (closest) {
      closest.userData.mapSelected = !closest.userData.mapSelected;
      if (closest.userData.mapSelected) {
        _showDiamond(closest);
      } else {
        _hideDiamond(closest);
      }
      mapInfo.textContent = closest.userData.mapSelected
        ? '► ' + (closest.userData.mapName || 'Planet') + ' — marker enabled'
        : '  ' + (closest.userData.mapName || 'Planet') + ' — marker hidden';
      drawMap();
    }
  });

  // Expose open for HUD button later
  window._openGalaxyMap = openMap;
})();
// ── End Galaxy Map ────────────────────────────────────────────────────────────

// ── Crate System ─────────────────────────────────────────────────────────────
const _crateObjects = []; // { mesh, planet, held, stored }
let _heldCrate     = null;
let _shipInventory = 0;

const _cratePromptEl = (() => {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:140px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.7);border:1px solid #0ff5;border-radius:4px;color:#0ff;font-family:Courier New,monospace;font-size:13px;padding:7px 18px;pointer-events:none;display:none;z-index:50;letter-spacing:1px;';
  document.body.appendChild(el);
  return el;
})();

const _cargoHudEl = (() => {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.7);border:1px solid #ffa05088;border-radius:4px;color:#ffa050;font-family:Courier New,monospace;font-size:13px;padding:6px 16px;pointer-events:none;display:none;z-index:50;letter-spacing:1px;';
  document.body.appendChild(el);
  return el;
})();

function _updateCargoHud() {
  const parts = [];
  if (_shipInventory > 0) parts.push(`CARGO: ${_shipInventory} crate${_shipInventory !== 1 ? 's' : ''}`);
  if (_heldCrate) parts.push('HOLDING CRATE');
  _cargoHudEl.textContent = parts.join('  |  ');
  _cargoHudEl.style.display = parts.length ? 'block' : 'none';
}

function _grabCrate(crate) {
  const worldPos = new THREE.Vector3();
  crate.mesh.getWorldPosition(worldPos);
  crate.planet.remove(crate.mesh);
  scene.add(crate.mesh);
  crate.mesh.position.copy(worldPos);
  // Shrink to hand size and center the inner model (remove the surface-lift offset)
  const inner = crate.mesh.children[0];
  if (inner) { crate.mesh.userData._savedInnerY = inner.position.y; inner.position.y = 0; }
  crate.mesh.scale.setScalar(2 / _CRATE_SIZE); // ~2 unit apparent size when held
  crate.held = true;
  _heldCrate = crate;
  _updateCargoHud();
}

function _storeCrate() {
  if (!_heldCrate) return;
  // Restore original scale and inner offset before storing
  _heldCrate.mesh.scale.setScalar(1);
  const inner = _heldCrate.mesh.children[0];
  if (inner && _heldCrate.mesh.userData._savedInnerY !== undefined) {
    inner.position.y = _heldCrate.mesh.userData._savedInnerY;
  }
  scene.remove(_heldCrate.mesh);
  _heldCrate.stored = true;
  _heldCrate.held   = false;
  _heldCrate = null;
  _shipInventory++;
  _updateCargoHud();
}

// Load crate GLB once then clone onto every planet
const _CRATE_SIZE = 22;
loadModel('assets/crate_03.glb', _CRATE_SIZE, template => {
  if (!template) return;
  template.traverse(c => {
    if (!c.isMesh || !c.material) return;
    const old = Array.isArray(c.material) ? c.material[0] : c.material;
    c.material = new THREE.MeshBasicMaterial({
      map: old.map || null,
      color: old.color ? old.color.clone() : new THREE.Color(0xddbb77),
    });
  });
  planets.forEach((planet, i) => {
    const r = planet.userData.collisionRadius || 500;
    const ang  = (i * 2.399) % (Math.PI * 2);
    const elev = 0.7;
    const localNorm = new THREE.Vector3(
      Math.cos(elev) * Math.cos(ang),
      Math.sin(elev),
      Math.cos(elev) * Math.sin(ang)
    ).normalize();
    const wrapper = new THREE.Group();
    wrapper.userData.isCrateWrapper = true;
    // loadModel centers at origin — lift inner model so bottom sits on surface
    const inner = template.clone();
    inner.position.y = _CRATE_SIZE * 0.5;
    wrapper.add(inner);
    wrapper.position.copy(localNorm.clone().multiplyScalar(r + 0.5));
    wrapper.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), localNorm);
    planet.add(wrapper);
    _crateObjects.push({ mesh: wrapper, planet, held: false, stored: false });
  });
});

// ── Atmosphere system ──────────────────────────────────────────────────────────
const _SPACE_FOG_COLOR   = new THREE.Color(0x000010);
const _SPACE_FOG_DENSITY = 0.0;
const _atmWork = new THREE.Color();

function updateAtmosphere() {
  const shipPos = (gameMode === 'flight') ? selfMesh.position
    : (gameMode === 'ejected') ? ejectPos
    : (gameMode === 'landing_anim' || gameMode === 'landed_ship' || gameMode === 'takeoff_anim' || gameMode === 'planet_walk') ? selfMesh.position
    : null;
  if (!shipPos) {
    // In station — restore space defaults silently
    scene.fog.color.copy(_SPACE_FOG_COLOR);
    scene.fog.density = _SPACE_FOG_DENSITY;
    if (skyboxMesh) scene.background = _skyboxTex;
    return;
  }

  let bestT = 0, bestAtm = null;
  for (const planet of planets) {
    const atm = planet.userData.atmosphere;
    if (!atm) continue;
    const dist = shipPos.distanceTo(planet.position);
    const t = Math.max(0, 1 - dist / atm.atmRadius); // 0 = space, 1 = surface
    if (t > bestT) { bestT = t; bestAtm = atm; }
  }

  const inAtm = bestT > 0;

  if (inAtm) {
    // Sky tint uses full t so the orange halo is visible from far away
    renderer.setClearColor(bestAtm.skyColor, bestT * 0.7);
    // Fog only thickens in the inner 40% of the atmosphere (close to surface)
    const fogT = Math.max(0, (bestT - 0.6) / 0.4);
    scene.fog.color.lerpColors(_SPACE_FOG_COLOR, bestAtm.fogColor, fogT);
    scene.fog.density = _SPACE_FOG_DENSITY + (bestAtm.fogDensity - _SPACE_FOG_DENSITY) * fogT;
    if (skyboxMesh) scene.background = bestT < 0.5 ? _skyboxTex : null;
  } else {
    scene.fog.color.copy(_SPACE_FOG_COLOR);
    scene.fog.density = _SPACE_FOG_DENSITY;
    renderer.setClearColor(0x000000, 0);
  }
}



// ── Player state ──────────────────────────────────────────────────────────────
const self = {
  id: null, name: 'Pilot',
  position: new THREE.Vector3(0, 0, 150),
  velocity: new THREE.Vector3(),
  inSafeZone: true,
  health: 100,
  credits: 0,
};

const selfMesh = createShipMesh(0x00ccff);
selfMesh.position.copy(self.position);
scene.add(selfMesh);
window.selfMesh = selfMesh;

// Replace procedural ship with preloaded model once it's ready
(function waitForShip() {
  if (window.PRELOADED_SHIP === undefined) {
    setTimeout(waitForShip, 100);
  } else if (window.PRELOADED_SHIP) {
    // Remove geometry children but keep the camera
    const keepGlow  = selfMesh.userData.glowMesh;
    const keepLight = selfMesh.userData.engineLight;
    selfMesh.children.slice().forEach(c => { if (c !== camera && c !== keepGlow && c !== keepLight) selfMesh.remove(c); });
    selfMesh.add(window.PRELOADED_SHIP);
  }
})();

// Camera follows behind ship — this initial parenting gets undone further down (see
// "Camera smoothing" near updateShip(), which detaches the camera and drives it with a
// per-frame world-space lerp/slerp instead); kept here only so the camera has a sane
// position/orientation for the brief window before that code runs.
camera.position.set(0, 8, 35);
camera.lookAt(0, 0, -10);
selfMesh.add(camera);

// ── Cockpit view (C, Falcon only) ────────────────────────────────────────────
// Falcon-specific interior view. The real flight camera is driven every frame by
// updateShip()'s own world-space lerp/slerp (see "Smooth follow camera" there) — toggling
// this just flips which local offset/rotation-source that per-frame code chases toward,
// and swaps which ship model (exterior hull vs cockpit interior) is visible.
let _cockpitView = false;
let _cockpitModel = null;
let _cockpitModelLoading = false;
// Where the cockpit model itself sits (ship-local) vs. where the camera's eye actually
// goes — kept separate because the model's own bounding-box center (where loadModel()
// centers it before we place it here) sits well below actual eye/seat height once you
// account for the canopy glass above pulling that center down, so the camera needs its
// own higher offset rather than sharing the model's anchor point.
const COCKPIT_MODEL_POS = new THREE.Vector3(0, 1.5, 2);
const COCKPIT_CAM_POS = new THREE.Vector3(0, 3.6, 3.5); // lowered slightly from the last raise
// The cockpit asset's own windshield/seat orientation was authored facing the opposite way
// from the -Z "forward" convention the camera and ship travel direction both use — without
// this the camera (correctly facing travel direction) ends up looking at the back of the
// seat instead of out the windshield. Rotate the model itself, not the camera, so the
// camera's forward still matches actual travel direction.
const COCKPIT_MODEL_YAW = Math.PI;
// Tilts the view up a bit so the dashboard/floor of the cockpit interior isn't in frame.
const COCKPIT_CAM_PITCH_UP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.35);
// The cockpit asset's floor/dash doesn't fully cover the bottom of the view even with the
// pitch-up above — open space shows through at bottom-center. Patch it with a plain
// metallic panel mounted straight on the camera (not the ship) so it always sits in that
// same bottom-center screen spot no matter how the ship maneuvers, like the edge of a
// dashboard/console right below the windshield.
let _cockpitDashPatch = null;
function _ensureCockpitDashPatch() {
  if (_cockpitDashPatch) return _cockpitDashPatch;
  // Small and tucked low/close so it only fills the sliver of open space at the very
  // bottom edge of the view, without extending up into (or overlapping) the actual
  // cockpit model geometry above it.
  const geo = new THREE.BoxGeometry(3, 0.35, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0x4a4f56, metalness: 0.75, roughness: 0.4, emissive: 0x0a0c10, emissiveIntensity: 0.6 });
  _cockpitDashPatch = new THREE.Mesh(geo, mat);
  _cockpitDashPatch.position.set(0, -1.9, -1.2);
  return _cockpitDashPatch;
}
// A big faint blue-tinted, semi-transparent pane right in front of the camera — gives the
// windshield an actual pane-of-glass look (subtle tint + a soft highlight) rather than a
// perfectly clear, glass-less view straight through to space.
let _cockpitGlass = null;
function _ensureCockpitGlass() {
  if (_cockpitGlass) return _cockpitGlass;
  const geo = new THREE.PlaneGeometry(14, 9);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x6fa8ff, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false,
  });
  _cockpitGlass = new THREE.Mesh(geo, mat);
  _cockpitGlass.position.set(0, 0.4, -1);
  return _cockpitGlass;
}
function _exteriorShipModel() {
  const keepGlow  = selfMesh.userData.glowMesh;
  const keepLight = selfMesh.userData.engineLight;
  return selfMesh.children.find(c => c !== camera && c !== keepGlow && c !== keepLight && c !== _cockpitModel);
}
function _toggleCockpitView() {
  if (_selectedShipId !== 'spaceship') return; // Falcon's rigid cockpit view only
  _cockpitView = !_cockpitView;
  const ext = _exteriorShipModel();
  if (_cockpitView) {
    camera.add(_ensureCockpitDashPatch());
    _cockpitDashPatch.visible = true;
    camera.add(_ensureCockpitGlass());
    _cockpitGlass.visible = true;
    if (ext) ext.visible = false;
    if (!_cockpitModel && !_cockpitModelLoading) {
      _cockpitModelLoading = true;
      loadModel('assets/ships/falcon_cockpit.glb', 6, model => {
        _cockpitModelLoading = false;
        if (!model || _selectedShipId !== 'spaceship') return;
        model.position.copy(COCKPIT_MODEL_POS);
        model.rotation.y = COCKPIT_MODEL_YAW;
        _cockpitModel = model;
        selfMesh.add(_cockpitModel);
        _cockpitModel.visible = _cockpitView;
      });
    } else if (_cockpitModel) {
      _cockpitModel.visible = true;
    }
  } else {
    if (ext) ext.visible = true;
    if (_cockpitModel) _cockpitModel.visible = false;
    if (_cockpitDashPatch) _cockpitDashPatch.visible = false;
    if (_cockpitGlass) _cockpitGlass.visible = false;
  }
}

// ── Walkable ship interior (C, Star Wing / Shuttle) ─────────────────────────────
// Unlike the Falcon's rigid cockpit view above, these two actually let you get up and
// walk around inside the ship's own modeled geometry — the ship stops drifting (velocity
// zeroed) while you're in there, the camera gets reparented onto selfMesh (it normally
// lives directly in `scene`, detached every frame by updateShip()'s own chase-cam lerp —
// see "Camera smoothing" there) so it rides along with the ship for free, and movement is
// a simple WASD-plus-mouselook-plus-floor-raycast walker in the ship's local space.
let _shipInteriorView = false;
let _shipIntYaw = 0, _shipIntPitch = 0;
let _shipIntCollidables = [];
let _shipIntBBox = null;
const _shipIntEyeHeight = 1.5;
const _shipIntSpeed = 0.5; // slow — these interiors (esp. the cockpit) are small/cramped
function _enterShipInteriorWalk() {
  const def = SHIP_DEFS[_selectedShipId];
  const ext = _exteriorShipModel();
  if (!def || !def.walkableInterior || !ext) return;
  const root = def.interiorNode ? ext.getObjectByName(def.interiorNode) : ext;
  if (!root) return;
  _shipIntCollidables = [];
  root.traverse(c => {
    if (c.isMesh) {
      _shipIntCollidables.push(c);
      // These meshes are only ever modeled/authored to be seen from outside the hull —
      // from inside, their backfaces are culled by default and you see straight through
      // to the skybox ("I just see space"). Force both sides to render so the interior
      // walls actually show up once the camera is on the inside of them.
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach(m => { if (m) m.side = THREE.DoubleSide; });
    }
  });
  if (!_shipIntCollidables.length) return;
  _shipIntBBox = new THREE.Box3().setFromObject(root);
  _shipInteriorView = true;
  gameMode = 'ship_interior';
  self.velocity.set(0, 0, 0); // ship stops drifting while you're walking around inside it
  scene.remove(camera);
  selfMesh.add(camera);
  camera.position.copy(def.interiorSpawn || new THREE.Vector3(0, 0, 0));
  _shipIntYaw = 0; _shipIntPitch = 0;
  camera.quaternion.identity();
  document.body.style.cursor = 'none';
  renderer.domElement.requestPointerLock();
}
function _exitShipInteriorWalk() {
  _shipInteriorView = false;
  gameMode = 'flight';
  selfMesh.remove(camera);
  scene.add(camera);
  camera.position.copy(selfMesh.position).add(new THREE.Vector3(0, 8, 35).applyQuaternion(selfMesh.quaternion));
  camera.quaternion.copy(selfMesh.quaternion);
}
// Floor raycast + WASD + mouselook, all in ship-local space (camera is a child of selfMesh
// here, so its .position/.quaternion are already local — no world-space math needed).
function _updateShipInteriorWalk() {
  _shipIntYaw   -= _fpMouseDX * 0.0028;
  _shipIntPitch -= _fpMouseDY * 0.0028;
  _shipIntPitch = Math.max(-Math.PI / 2.3, Math.min(Math.PI / 2.3, _shipIntPitch));
  _fpMouseDX = 0; _fpMouseDY = 0;

  const cosY = Math.cos(_shipIntYaw), sinY = Math.sin(_shipIntYaw);
  const fwd   = new THREE.Vector3(-sinY, 0, -cosY);
  const right = new THREE.Vector3(cosY, 0, -sinY);
  const move = new THREE.Vector3();
  if (keys['w']) move.add(fwd);
  if (keys['s']) move.sub(fwd);
  if (keys['a']) move.sub(right);
  if (keys['d']) move.add(right);
  if (move.lengthSq() > 0) move.normalize().multiplyScalar(_shipIntSpeed);
  // Clamp to the interior's own bounding box (with a small margin) — there's no real wall
  // collision here, just a hard box, but these interiors are small enough (especially the
  // Star Wing's one-seat cockpit bubble) that without SOME bound you'd walk straight out
  // through the hull/canopy into space within a couple of steps.
  const margin = 0.3;
  camera.position.x = Math.max(_shipIntBBox.min.x + margin, Math.min(_shipIntBBox.max.x - margin, camera.position.x + move.x));
  camera.position.z = Math.max(_shipIntBBox.min.z + margin, Math.min(_shipIntBBox.max.z - margin, camera.position.z + move.z));

  // Floor: raycast straight down from above the player's current XZ, clamp to it.
  const rc = new THREE.Raycaster(new THREE.Vector3(camera.position.x, _shipIntBBox.max.y + 5, camera.position.z), new THREE.Vector3(0, -1, 0));
  const hits = rc.intersectObjects(_shipIntCollidables, false);
  const floorY = hits.length > 0 ? hits[0].point.y : _shipIntBBox.min.y;
  camera.position.y = floorY + _shipIntEyeHeight;

  camera.quaternion.setFromEuler(new THREE.Euler(_shipIntPitch, _shipIntYaw, 0, 'YXZ'));
}
document.addEventListener('keydown', e => {
  if ((e.key === 'c' || e.key === 'C') && (gameMode === 'flight' || gameMode === 'ship_interior')) {
    const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
    if (typing) return;
    if (gameMode === 'ship_interior') { _exitShipInteriorWalk(); return; }
    const def = SHIP_DEFS[_selectedShipId];
    if (def && def.walkableInterior) _enterShipInteriorWalk();
    else _toggleCockpitView();
  }
});

// ── Remote players ────────────────────────────────────────────────────────────
const remotePlayers = {};

function _makeNameTag(name, sizeAttenuation = true) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 64);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.roundRect ? ctx.roundRect(4, 10, 248, 44, 8) : ctx.fillRect(4, 10, 248, 44);
  ctx.fill();
  ctx.font = 'bold 28px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#00ffff';
  ctx.fillText(name, 128, 33);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, sizeAttenuation });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 10;
  return sprite;
}

// ── Procedural avatar ────────────────────────────────────────────────────────
// No 3D modeling/rigging tool is available in this environment, so instead of a hand-
// authored animated GLB, this builds a simple box-humanoid entirely in code and animates
// it procedurally (limb rotations driven by real movement state each frame) rather than
// playing back baked keyframes. Built at an exact target height directly (no bounding-box
// normalization needed like loadModel() does for GLBs), so it drops into the existing
// _cloneAstronaut()/collision/scaling pipeline unchanged.
function _buildProceduralAvatar(H) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.6, metalness: 0.1 });
  const jointMat = new THREE.MeshStandardMaterial({ color: 0x9099a6, roughness: 0.6, metalness: 0.1 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xf2c9a0, roughness: 0.7 });

  const legLen = H * 0.45, torsoLen = H * 0.35, headSize = H * 0.15, armLen = H * 0.4;
  const limbThick = H * 0.11, torsoWidth = H * 0.26, torsoDepth = H * 0.14;

  function limbMesh(len, thick, material) {
    const geo = new THREE.BoxGeometry(thick, len, thick);
    geo.translate(0, -len / 2, 0); // pivot at the TOP of the box (the joint), hangs down from there
    return new THREE.Mesh(geo, material);
  }

  const root = new THREE.Group();
  root.name = 'avatarRoot';

  const hips = new THREE.Group();
  hips.name = 'hips';
  hips.position.y = legLen;
  root.add(hips);

  const legL = new THREE.Group(); legL.name = 'legL'; legL.position.set(torsoWidth * 0.28, 0, 0);
  const legR = new THREE.Group(); legR.name = 'legR'; legR.position.set(-torsoWidth * 0.28, 0, 0);
  legL.add(limbMesh(legLen, limbThick, mat));
  legR.add(limbMesh(legLen, limbThick, mat));
  hips.add(legL, legR);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(torsoWidth, torsoLen, torsoDepth), mat);
  torso.name = 'torso';
  torso.position.y = torsoLen / 2;
  hips.add(torso);

  const head = new THREE.Mesh(new THREE.BoxGeometry(headSize, headSize, headSize), headMat);
  head.name = 'head';
  // torso is a centered box, so its own top edge (in torso-local space) is at +torsoLen/2,
  // not torsoLen — head/shoulders are children of torso, so they need to be measured from
  // that center, not from the hips-space value used for torso's own placement above.
  head.position.y = torsoLen / 2 + headSize / 2 + headSize * 0.1;
  torso.add(head);

  const shoulderY = torsoLen / 2 - limbThick * 0.3;
  const armL = new THREE.Group(); armL.name = 'armL'; armL.position.set(torsoWidth / 2 + limbThick * 0.15, shoulderY, 0);
  const armR = new THREE.Group(); armR.name = 'armR'; armR.position.set(-(torsoWidth / 2 + limbThick * 0.15), shoulderY, 0);
  armL.add(limbMesh(armLen, limbThick * 0.85, jointMat));
  armR.add(limbMesh(armLen, limbThick * 0.85, jointMat));
  torso.add(armL, armR);

  // Empty anchor at the right hand for attaching a held weapon mesh.
  const gunSocket = new THREE.Object3D();
  gunSocket.name = 'gunSocket';
  gunSocket.position.set(0, -armLen, 0);
  armR.add(gunSocket);

  root.userData.legLen = legLen;
  root.userData.armLen = armLen;
  return root;
}

// Preload astronaut models — different sizes for lobby vs room.
// IMPORTANT: these start out null (not the procedural fallback) — every clone-creation
// path already checks "does this wrapper have an astronaut yet?" and retries later if not,
// so leaving these null until the real GLB loads means only ONE model ever gets built per
// player. Eagerly building the procedural placeholder here used to create a SECOND model
// once the GLB loaded afterward (the procedural one never got removed), which is why two
// overlapping avatars — one correctly grounded, one floating — could show up at once.
// The procedural builder is now only used as a genuine last-resort if the GLB fails to load.
let _astronautLobbyTemplate = null;
let _astronautRoomTemplate  = null;
// loadModel() always recenters a model's bounding box on its own origin — fine for most
// assets, but wrong for a character, where we need the FEET at local y=0 so it stands ON
// the floor instead of being vertically centered ON it. The lobby's real floor mesh sits
// at a different height than the fpPos convention assumes, and isn't flat everywhere, so a
// single fixed offset constant kept being wrong — positioning is now handled dynamically
// per-frame via a floor raycast (see _groundHeightAt) instead of a baked-in number.
function _fixFeetToOrigin(m) {
  // Shift up by exactly its own measured lowest point (not a guessed constant), so the
  // feet land at local y=0 regardless of the model's exact proportions.
  const box = new THREE.Box3().setFromObject(m);
  m.position.y -= box.min.y;
}
loadModel('assets/avatar_blender.glb', 18, m => {
  if (m) _fixFeetToOrigin(m);
  _astronautLobbyTemplate = m || _buildProceduralAvatar(18);
});
loadModel('assets/avatar_blender.glb', 100, m => {
  if (m) _fixFeetToOrigin(m);
  _astronautRoomTemplate = m || _buildProceduralAvatar(100);
});

function _cloneAstronaut(template) {
  if (!template) return new THREE.Group();
  const clone = template.clone(true);
  // The old astronaut GLB had a baked-in 270° facing quirk this correction compensated
  // for. Our own avatar (procedural or the Blender-built GLB, which nests an "avatarRoot"
  // object rather than being one) is built facing forward correctly from the start, so it
  // doesn't need it. getObjectByName searches descendants too, so this matches both the
  // procedural root itself and a loaded GLB's "Scene" wrapper containing avatarRoot.
  const _isOwnAvatar = template.name === 'avatarRoot' || (template.getObjectByName && template.getObjectByName('avatarRoot'));
  if (!_isOwnAvatar) clone.rotation.y -= Math.PI / 2 + Math.PI;
  // Cache references to the animatable limb groups + hand socket so _poseAvatar() doesn't
  // need to re-traverse the hierarchy by name every frame for every visible player.
  clone.userData.avatarParts = {
    legL: clone.getObjectByName('legL'),
    legR: clone.getObjectByName('legR'),
    kneeL: clone.getObjectByName('kneeL'), // only present on the Blender-built model, not
    kneeR: clone.getObjectByName('kneeR'), // the older box-only procedural fallback
    armL: clone.getObjectByName('armL'),
    armR: clone.getObjectByName('armR'),
    torso: clone.getObjectByName('torso'),
    hips: clone.getObjectByName('hips'),
    gunSocket: clone.getObjectByName('gunSocket'),
  };
  if (clone.userData.avatarParts.hips) clone.userData.avatarParts.hipsRestY = clone.userData.avatarParts.hips.position.y;
  clone.traverse(c => {
    if (c.isMesh && c.material) {
      c.userData.isPlayerHit = true; // lets bullet raycasts identify "this is a player"
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach(m => {
        m = m.clone();
        m.emissive = m.emissive || new THREE.Color(0xffffff);
        m.emissive.set(0xffffff);
        m.emissiveIntensity = 0.4;
        if (Array.isArray(c.material)) c.material = c.material.map(x => x === m ? m : x);
        else c.material = m;
      });
    }
  });
  // Small point light so the astronaut glows slightly in dark scenes
  const light = new THREE.PointLight(0xffffff, 0.6, 80);
  light.position.set(0, 20, 0);
  clone.add(light);
  // Precise collision footprint measured directly from the actual geometry (not guessed) —
  // used both to block movement (can't walk through another player) and to know how far
  // out a bullet raycast against this mesh is plausible. Box3 is computed BEFORE this
  // clone has a parent, so it's in the clone's own local space — same frame as the
  // wrapper group's origin. The model isn't necessarily centered on that origin (arms,
  // backpack etc. can shift the true center off to one side), so store that offset too —
  // without it the hitbox sphere was planted at the wrapper's origin, only ever lining
  // up with whichever part of the model happened to be closest to that point.
  const _box = new THREE.Box3().setFromObject(clone);
  const _size = _box.getSize(new THREE.Vector3());
  const _center = _box.getCenter(new THREE.Vector3());
  clone.userData.collisionRadius = Math.max(_size.x, _size.z) / 2;
  clone.userData.collisionHeight = _size.y;
  clone.userData.collisionCenterOffset = _center;
  return clone;
}

// Poses a procedural avatar clone's limbs based on real movement state. `speed` is
// 0-1 normalized (0 = standing still, 1 = full sprint) and drives both walk-cycle speed
// and swing amplitude, so the animation actually reflects how fast the player is moving
// rather than just an on/off walk toggle.
function _poseAvatar(clone, state) {
  const parts = clone.userData.avatarParts;
  if (!parts || !parts.legL || !parts.legR || !parts.armL || !parts.armR || !parts.torso) return;
  const speed = Math.max(0, Math.min(1, (state && state.speed) || 0));
  if (clone.userData.walkPhase === undefined) clone.userData.walkPhase = 0;
  clone.userData.walkPhase += speed * 0.25;
  const swing = Math.sin(clone.userData.walkPhase) * 0.6 * speed;
  const armSwing = Math.sin(clone.userData.walkPhase) * 0.5 * speed;

  const ease = (obj, x, z, lerp) => {
    obj.rotation.x += (x - obj.rotation.x) * lerp;
    obj.rotation.z += (z - obj.rotation.z) * lerp;
  };

  // A single rigid leg segment can only rotate at the hip, which can't actually shorten
  // it — the old fix lowered the whole hips group instead, which just pushed the still-
  // straight legs (and feet) through the floor rather than looking crouched. With a real
  // knee joint, bending the thigh forward and the shin back under it genuinely shortens
  // the leg's vertical reach, so the hips can drop by roughly that same amount while the
  // feet stay planted at the floor instead of clipping through it.
  const hasKnees = !!(parts.kneeL && parts.kneeR);
  const kneeEase = (obj, x, lerp) => { if (obj) obj.rotation.x += (x - obj.rotation.x) * lerp; };

  if (state && state.sliding) {
    if (hasKnees) {
      ease(parts.legL, -0.55, 0, 0.3);  kneeEase(parts.kneeL, 0.85, 0.3);
      ease(parts.legR, -0.3, 0, 0.3);   kneeEase(parts.kneeR, 0.5, 0.3);
    } else {
      ease(parts.legL, -0.9, 0, 0.3);
      ease(parts.legR, -0.5, 0, 0.3);
    }
    ease(parts.armL, -0.3, 0.15, 0.3);
    ease(parts.armR, -0.3, -0.15, 0.3);
    ease(parts.torso, -0.35, 0, 0.3);
    if (parts.hips && parts.hipsRestY !== undefined) {
      const targetY = parts.hipsRestY - (hasKnees ? parts.hipsRestY * 0.22 : parts.hipsRestY * 0.35);
      parts.hips.position.y += (targetY - parts.hips.position.y) * 0.3;
    }
  } else if (state && state.jumping) {
    if (hasKnees) {
      // Same sign as the thigh here (unlike crouch) — this is a tuck, so the shin should
      // fold further in the same direction the thigh already rotated, not cancel it out.
      ease(parts.legL, -0.35, 0, 0.25); kneeEase(parts.kneeL, -0.7, 0.25);
      ease(parts.legR, -0.35, 0, 0.25); kneeEase(parts.kneeR, -0.7, 0.25);
    } else {
      ease(parts.legL, -0.6, 0, 0.25);
      ease(parts.legR, -0.6, 0, 0.25);
    }
    ease(parts.armL, -0.4, 0.1, 0.25);
    ease(parts.armR, -0.4, -0.1, 0.25);
    ease(parts.torso, 0, 0, 0.25);
    if (parts.hips && parts.hipsRestY !== undefined) {
      parts.hips.position.y += (parts.hipsRestY - parts.hips.position.y) * 0.3; // stand back to full height in the air
    }
  } else {
    // Crouch blends with the walk cycle rather than replacing it, so crouch-walking still
    // animates instead of freezing into a static pose.
    const crouch = Math.max(0, Math.min(1, (state && state.crouch) || 0));
    if (hasKnees) {
      const thighFwd = 0.65 * crouch;
      // Knee rotation is relative to the thigh and composes additively (both rotate about
      // the same axis) — this needs to be NEGATIVE to fold the shin back opposite the
      // thigh's forward tilt (a real knee bend), not add to it.
      const kneeBack = -1.05 * crouch;
      ease(parts.legL, swing * (1 - crouch * 0.5) + thighFwd, 0, 0.3);
      ease(parts.legR, -swing * (1 - crouch * 0.5) + thighFwd, 0, 0.3);
      kneeEase(parts.kneeL, kneeBack, 0.3);
      kneeEase(parts.kneeR, kneeBack, 0.3);
    } else {
      const crouchLegBend = -0.55 * crouch;
      ease(parts.legL, swing * (1 - crouch * 0.5) + crouchLegBend, 0, 0.3);
      ease(parts.legR, -swing * (1 - crouch * 0.5) + crouchLegBend, 0, 0.3);
    }
    const crouchTorsoLean = -0.18 * crouch;
    ease(parts.armL, -armSwing * (1 - crouch * 0.3) + crouch * 0.2, 0, 0.3);
    ease(parts.armR, armSwing * (1 - crouch * 0.3) + crouch * 0.2, 0, 0.3);
    ease(parts.torso, crouchTorsoLean, 0, 0.3);
    if (parts.hips && parts.hipsRestY !== undefined) {
      const dropFrac = hasKnees ? 0.16 : 0.35; // knees now do most of the height work
      const targetY = parts.hipsRestY - crouch * parts.hipsRestY * dropFrac;
      parts.hips.position.y += (targetY - parts.hips.position.y) * 0.3;
    }
  }

  // With the arm hanging straight down (the base rest pose above), anything attached at
  // the hand — like a held gun — sits mostly hidden behind/beside the body from most
  // angles. Raise the gun arm into a held/ready position instead, blended on top of
  // whatever the walk/crouch/slide/jump pose above already set, so it reads as "holding
  // a gun in front of you" rather than "gun dangling at your side."
  if (clone.userData.heldWeaponId) {
    // Verified via live preview which sign actually points the arm forward: dot product
    // of the hand's direction from the torso against the character's forward vector was
    // -0.97 (pointing backward) with the negative sign this used to have, and +0.97
    // (pointing forward, correct) with positive — that's the "arms bent the wrong way" bug.
    parts.armR.rotation.x += (1.3 - parts.armR.rotation.x) * 0.25;
    parts.armR.rotation.z += (0.15 - parts.armR.rotation.z) * 0.25;
    parts.armL.rotation.x += (0.9 - parts.armL.rotation.x) * 0.25; // off-hand supporting the foregrip
  }
}

// Attaches a simple representative gun shape (barrel + receiver + grip + mag) to an
// avatar's hand socket. The real FP weapon viewmodels each have custom offsets tuned
// specifically for camera-relative first-person placement, not third-person hand
// placement, so re-using them accurately here would need a separate per-weapon tuning
// pass — this is a deliberately simple stand-in that reads as *a* gun in hand, not the
// exact equipped model.
//
// Sizing bug this replaces: the old version used flat numbers (e.g. scale 1.2/1.2/9) as
// if gunSocket's local space were world-scale units. It isn't — the avatar clone's ROOT
// carries loadModel()'s own targetSize scale factor (often ~10x or more), which multiplies
// every descendant's local coordinates. A "9 unit long" box nested that deep in the
// hierarchy rendered many times larger than intended — the "massive black cube" other
// players saw. Sizing everything as a fraction of gunSocket's own measured distance from
// the elbow (same local-unit frame the gun mesh is added into) makes it self-scaling
// instead of a guessed absolute number.
const _heldGunMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.45, metalness: 0.55 });
const _heldGunGripMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.8, metalness: 0.1 });
function _buildHeldGunMesh(refLen) {
  const group = new THREE.Group();
  const barrelLen = refLen * 0.75, thick = refLen * 0.13;
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(thick, thick, barrelLen), _heldGunMat);
  barrel.position.z = -barrelLen * 0.3;
  group.add(barrel);
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(thick * 1.4, thick * 1.6, barrelLen * 0.35), _heldGunMat);
  receiver.position.z = barrelLen * 0.12;
  group.add(receiver);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(thick * 0.9, barrelLen * 0.35, thick * 0.9), _heldGunGripMat);
  grip.position.set(0, -barrelLen * 0.16, barrelLen * 0.22);
  group.add(grip);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(thick * 0.7, barrelLen * 0.3, thick * 0.6), _heldGunMat);
  mag.position.set(0, -barrelLen * 0.16, -barrelLen * 0.02);
  mag.rotation.x = 0.35;
  group.add(mag);
  return group;
}
function _setAvatarHeldWeapon(clone, weaponId) {
  const parts = clone.userData.avatarParts;
  if (!parts || !parts.gunSocket) return;
  if (clone.userData.heldWeaponId === (weaponId || null)) return; // no change
  clone.userData.heldWeaponId = weaponId || null;
  if (clone.userData.heldGunMesh) { parts.gunSocket.remove(clone.userData.heldGunMesh); clone.userData.heldGunMesh = null; }
  if (!weaponId) return;
  const refLen = parts.gunSocket.position.length() || 1; // ~forearm length, same local-unit frame as the mesh we're adding
  const mesh = _buildHeldGunMesh(refLen);
  mesh.rotation.x = -0.15; // angle the barrel slightly up/forward instead of straight down like the arm
  parts.gunSocket.add(mesh);
  clone.userData.heldGunMesh = mesh;
}

// ── Third-person mode (toggle via /qwertyuiop in chat) ─────────────────────────
// One shared self-astronaut mesh, reparented into whichever FP scene is currently
// active and only shown while third-person is on.
window._thirdPerson = false;
let _selfAstronautMesh = null; // wrapper group — rotated to fpYaw; the clone inside keeps its own facing correction
function _updateSelfAstronaut() {
  const wantScene = gameMode === 'lobby' ? lobbyScene
                   : gameMode === 'docked' ? interiorScene
                   : gameMode === 'range' ? shootingRangeScene
                   : gameMode === 'tdm' ? tdmScene
                   : null;
  const show = !!(window._thirdPerson && wantScene && !window._adminMode);
  if (!show) {
    if (_selfAstronautMesh) _selfAstronautMesh.visible = false;
    return;
  }
  if (!_selfAstronautMesh) {
    const tmpl = gameMode === 'docked' ? _astronautRoomTemplate : _astronautLobbyTemplate;
    if (!tmpl) return; // not loaded yet
    _selfAstronautMesh = new THREE.Group();
    _selfAstronautMesh.add(_cloneAstronaut(tmpl)); // clone's own rotation correction stays intact
  }
  if (_selfAstronautMesh.parent !== wantScene) {
    if (_selfAstronautMesh.parent) _selfAstronautMesh.parent.remove(_selfAstronautMesh);
    wantScene.add(_selfAstronautMesh);
  }
  _selfAstronautMesh.visible = true;
  _selfAstronautMesh.scale.setScalar(gameMode === 'tdm' ? _TDM_ASTRONAUT_SCALE : 1); // arena map is huge-scale, astronaut needs to match
  // Stand on the real floor geometry (raycast) rather than trusting fpPos.y directly — the
  // FP movement's per-mode floor constant doesn't always match the actual floor mesh
  // height, and floors aren't flat everywhere either. Same fix as the lobby, now applied
  // to every FP scene an avatar can stand in. TDM is excluded: its fpPos.y already bakes
  // in a large eye-height offset (_TDM_EYE_OFFSET) rather than being a raw floor value, so
  // it has its own dedicated ground system instead (_tdmGroundHeightAt) — mixing the two
  // conventions here would put the avatar at the wrong height, not fix it.
  const _selfGroundCollidables = _avatarGroundCollidables(gameMode);
  // TDM was excluded from the generic raycast fix above (see comment) but never actually
  // got its own correction applied — fpPos.y there is EYE height, so positioning the avatar
  // directly at fpPos.y left it floating _TDM_EYE_OFFSET (16) units above the real floor.
  const _selfGroundY = gameMode === 'tdm' ? fpPos.y - _TDM_EYE_OFFSET
    : _selfGroundCollidables ? _groundHeightAt(_selfGroundCollidables, fpPos.x, fpPos.z, fpPos.y) : fpPos.y;
  _selfAstronautMesh.position.set(fpPos.x, _selfGroundY, fpPos.z);
  _selfAstronautMesh.rotation.set(0, fpYaw, 0);
  // Drive the walk/jump/slide animation from real movement state, so toggling third
  // person is a direct way to check the animations are actually working.
  const _selfAvatar = _selfAstronautMesh.children[0];
  if (_selfAvatar) {
    const _maxSpeed = FP_SPEED * FP_SPRINT_MUL;
    _poseAvatar(_selfAvatar, {
      speed: fpVel.length() / _maxSpeed,
      jumping: _fpJumpVel !== 0, // nonzero exactly while airborne — 0 the instant updateFP() detects landing
      sliding: _slideTimer > 0,
      crouch: _crouchAmount,
    });
    _setAvatarHeldWeapon(_selfAvatar, _equippedWeaponId);
  }
}

function addRemotePlayer(data) {
  if (remotePlayers[data.id]) return;

  // Flight mesh (in main scene)
  const mesh = createShipMesh(0xff6600);
  scene.add(mesh);
  const shipTag = _makeNameTag(data.name || 'Pilot', true);
  shipTag.scale.set(40, 10, 1);
  shipTag.position.set(0, 30, 0);
  mesh.add(shipTag);
  loadModel(ASSETS.enemyShip, 20, model => {
    if (!model || !remotePlayers[data.id]) return;
    // See SHIP_DEFS.cargo for why cargo_ship.glb specifically needs the size/yaw correction.
    const _isCargo = ASSETS.enemyShip.includes('cargo_ship');
    _normalizeShipModel(model, _isCargo ? 20 * SHIP_DEFS.cargo.sizeMul : 20, _isCargo ? SHIP_DEFS.cargo.yawOffset : 0);
    while (mesh.children.length) mesh.remove(mesh.children[0]);
    mesh.add(model);
    mesh.add(shipTag);
  });

  // FP mesh for lobby (astronaut in lobbyScene)
  const lobbyMesh = new THREE.Group();
  lobbyScene.add(lobbyMesh);
  lobbyMesh.visible = false;

  // FP mesh for room (astronaut in interiorScene)
  const roomMesh = new THREE.Group();
  interiorScene.add(roomMesh);
  roomMesh.visible = false;

  // FP mesh for shooting range
  const rangeMesh = new THREE.Group();
  shootingRangeScene.add(rangeMesh);
  rangeMesh.visible = false;

  // FP mesh for TDM arena
  const tdmMesh = new THREE.Group();
  tdmScene.add(tdmMesh);
  tdmMesh.visible = false;

  // FP mesh for planet walk (world space, lives in main scene)
  const planetMesh = new THREE.Group();
  scene.add(planetMesh);
  planetMesh.visible = false;

  // FP mesh for the terrain-based planet surface walk (separate scene/mode from the
  // older spherical planet_walk above — this is the one actually reachable from landing
  // on a planet's GLB terrain).
  const planetSurfMesh = new THREE.Group();
  _planetSurfScene.add(planetSurfMesh);
  planetSurfMesh.visible = false;

  // FP mesh for ejected (floating astronaut in main scene)
  const ejectedMesh = new THREE.Group();
  scene.add(ejectedMesh);
  ejectedMesh.visible = false;

  // Add astronaut clones. Mark each wrapper as already-populated — _updateRemoteFPMeshes
  // has a self-heal path that adds an astronaut if a mesh looks empty, but it was
  // checking a flag that only IT ever set, never this direct path, so it kept adding a
  // second astronaut on top of this one every time a position update came in.
  // IMPORTANT: only mark hasAstronaut true if the template actually existed — if a remote
  // player joins before this client's own astronaut GLB has finished loading, _cloneAstronaut
  // silently returns an empty group, and marking it "done" anyway meant the self-heal path
  // never got a chance to retry once the template did load — leaving only the name tag
  // visible forever.
  lobbyMesh.add(_cloneAstronaut(_astronautLobbyTemplate));
  lobbyMesh.userData.hasAstronaut = !!_astronautLobbyTemplate;
  roomMesh.add(_cloneAstronaut(_astronautRoomTemplate));
  roomMesh.userData.hasAstronaut = !!_astronautRoomTemplate;
  const _rangeAstronaut = _cloneAstronaut(_astronautLobbyTemplate);
  const _rangeScaleXZ = 48 / 18; // lobby template is normalized to 18 units — make it 30 units bigger (48) in the range
  _rangeAstronaut.scale.multiplyScalar(_rangeScaleXZ);
  // 5 units taller (Y-only stretch on top of the uniform scale above) and moved down 5 units total.
  const _baseHeight = (_rangeAstronaut.userData.collisionHeight || 18) * _rangeScaleXZ;
  const _rangeScaleY = (_baseHeight + 5) / _baseHeight;
  const _rangeDropY = 7.5;
  _rangeAstronaut.scale.y *= _rangeScaleY;
  _rangeAstronaut.position.y -= _rangeDropY;
  // Hit-detection reads collisionRadius/collisionHeight/collisionCenterOffset directly as
  // world-space values — keep them in sync with the extra scaling above, otherwise the
  // range astronaut's hitbox stays sized for the original 18-unit template.
  _rangeAstronaut.userData.collisionRadius *= _rangeScaleXZ;
  _rangeAstronaut.userData.collisionHeight = _baseHeight + 5;
  if (_rangeAstronaut.userData.collisionCenterOffset) {
    _rangeAstronaut.userData.collisionCenterOffset.x *= _rangeScaleXZ;
    _rangeAstronaut.userData.collisionCenterOffset.z *= _rangeScaleXZ;
    _rangeAstronaut.userData.collisionCenterOffset.y = _rangeAstronaut.userData.collisionCenterOffset.y * _rangeScaleY - _rangeDropY;
  }
  rangeMesh.add(_rangeAstronaut);
  rangeMesh.userData.hasAstronaut = !!_astronautLobbyTemplate;
  // TDM arena's map is loaded at a much larger scale than other scenes (see
  // _selfAstronautMesh's own 6x scale for the same reason). Hit-detection reads
  // collisionRadius/collisionCenterOffset directly as world-space values, so they need
  // to be rescaled by the same factor — same fix as the range astronaut above.
  const _tdmAstronaut = _cloneAstronaut(_astronautLobbyTemplate);
  _tdmAstronaut.scale.multiplyScalar(_TDM_ASTRONAUT_SCALE);
  _tdmAstronaut.position.y += 1;
  if (_astronautLobbyTemplate) {
    _tdmAstronaut.userData.collisionRadius *= _TDM_ASTRONAUT_SCALE;
    _tdmAstronaut.userData.collisionHeight *= _TDM_ASTRONAUT_SCALE;
    if (_tdmAstronaut.userData.collisionCenterOffset) _tdmAstronaut.userData.collisionCenterOffset.multiplyScalar(_TDM_ASTRONAUT_SCALE);
  }
  tdmMesh.add(_tdmAstronaut);
  tdmMesh.userData.hasAstronaut = !!_astronautLobbyTemplate;
  planetMesh.add(_cloneAstronaut(_astronautLobbyTemplate));
  planetMesh.userData.hasAstronaut = !!_astronautLobbyTemplate;
  planetSurfMesh.add(_cloneAstronaut(_astronautLobbyTemplate));
  planetSurfMesh.userData.hasAstronaut = !!_astronautLobbyTemplate;
  // Ejected mode broadcasts the player's actual eye/camera position (free-floating in
  // space, no ground to raycast against) — but the astronaut clone is built feet-at-origin
  // like every other mode, so planting it directly at that position put the feet at eye
  // height and the whole body floated a full body-height above where the player actually
  // is. Shift it down by its own measured height so the head (not the feet) lines up with
  // the broadcast position instead.
  const _ejectedAstro = _cloneAstronaut(_astronautLobbyTemplate);
  _ejectedAstro.position.y -= _ejectedAstro.userData.collisionHeight || 18;
  ejectedMesh.add(_ejectedAstro);
  ejectedMesh.userData.hasAstronaut = !!_astronautLobbyTemplate;

  // Name tags
  const tagName = data.name || 'Pilot';
  const lobbyTag   = _makeNameTag(tagName); lobbyTag.scale.set(14, 3.5, 1);  lobbyTag.position.set(0, 24, 0);   lobbyMesh.add(lobbyTag);
  const roomTag    = _makeNameTag(tagName); roomTag.scale.set(60, 15, 1);    roomTag.position.set(0, 115, 0);   roomMesh.add(roomTag);
  const rangeTag   = _makeNameTag(tagName); rangeTag.scale.set(14, 3.5, 1);  rangeTag.position.set(0, 24, 0);   rangeMesh.add(rangeTag);
  const tdmTag     = _makeNameTag(tagName); tdmTag.scale.set(14 * _TDM_ASTRONAUT_SCALE, 3.5 * _TDM_ASTRONAUT_SCALE, 1); tdmTag.position.set(0, 24 * _TDM_ASTRONAUT_SCALE, 0); tdmMesh.add(tdmTag);
  const planetTag  = _makeNameTag(tagName, false); planetTag.scale.set(0.12, 0.03, 1);  planetTag.position.set(0, 30, 0);  planetMesh.add(planetTag);
  const planetSurfTag = _makeNameTag(tagName); planetSurfTag.scale.set(14, 3.5, 1); planetSurfTag.position.set(0, 24, 0); planetSurfMesh.add(planetSurfTag);
  const ejectedTag = _makeNameTag(tagName, false); ejectedTag.scale.set(0.12, 0.03, 1); ejectedTag.position.set(0, 20, 0); ejectedMesh.add(ejectedTag);

  remotePlayers[data.id] = { mesh, lobbyMesh, roomMesh, rangeMesh, tdmMesh, planetMesh, planetSurfMesh, ejectedMesh, data, fpMode: null };
}

function removeRemotePlayer(id) {
  const rp = remotePlayers[id];
  if (!rp) return;
  scene.remove(rp.mesh);
  lobbyScene.remove(rp.lobbyMesh);
  interiorScene.remove(rp.roomMesh);
  shootingRangeScene.remove(rp.rangeMesh);
  tdmScene.remove(rp.tdmMesh);
  scene.remove(rp.planetMesh);
  _planetSurfScene.remove(rp.planetSurfMesh);
  scene.remove(rp.ejectedMesh);
  delete remotePlayers[id];
}

function _updateRemoteFPMeshes(p) {
  const rp = remotePlayers[p.id];
  if (!rp) return;
  // rp.data was only ever set once at connect time and never refreshed — anything reading
  // rp.data.fpPos (like the TDM zone player-count check) saw permanently stale/null data,
  // so a second player was never actually detected as being in the zone.
  rp.data = p;
  const fpMode = p.fpMode; // 'lobby' | 'docked' | 'range' | null
  rp.fpMode = fpMode;

  rp.mesh.visible         = !fpMode;
  rp.lobbyMesh.visible    = fpMode === 'lobby';
  rp.roomMesh.visible     = false; // room is private
  rp.rangeMesh.visible    = fpMode === 'range';
  rp.tdmMesh.visible      = fpMode === 'tdm';
  rp.planetMesh.visible   = fpMode === 'planet_walk';
  rp.planetSurfMesh.visible = fpMode === 'planet_surface';
  rp.ejectedMesh.visible  = fpMode === 'ejected';

  if (fpMode && p.fpPos) {
    const target = fpMode === 'lobby'      ? rp.lobbyMesh
                 : fpMode === 'range'       ? rp.rangeMesh
                 : fpMode === 'tdm'         ? rp.tdmMesh
                 : fpMode === 'planet_walk' ? rp.planetMesh
                 : fpMode === 'planet_surface' ? rp.planetSurfMesh
                 : fpMode === 'ejected'     ? rp.ejectedMesh
                 : rp.roomMesh;
    // Same floor-mismatch fix as the self avatar, across every applicable mode — don't
    // trust the broadcast fpPos.y directly, raycast the real floor at that XZ instead.
    // TDM's fpPos.y is eye height (see _TDM_EYE_OFFSET), not a raw floor value, so it needs
    // its own correction instead of the generic raycast (same fix as the self avatar).
    // planet_surface broadcasts _surfPos directly, which — like TDM — bakes in SURF_EYE_H
    // above the real ground, so remote avatars floated SURF_EYE_H units above the terrain
    // instead of standing on it.
    const _targetGroundCollidables = _avatarGroundCollidables(fpMode);
    const _targetGroundY = fpMode === 'tdm' ? p.fpPos.y - _TDM_EYE_OFFSET
      : fpMode === 'planet_surface' ? p.fpPos.y - SURF_EYE_H
      : _targetGroundCollidables ? _groundHeightAt(_targetGroundCollidables, p.fpPos.x, p.fpPos.z, p.fpPos.y) : p.fpPos.y;
    if (fpMode === 'planet_walk' && _landedPlanet) {
      // planet_walk broadcasts real world XYZ on the sphere's surface, offset outward along
      // the surface normal by PW_EYE_H — pull it back in along that same normal so the feet
      // land on the actual planet radius instead of floating just above it.
      const _pwWorld = new THREE.Vector3(p.fpPos.x, p.fpPos.y, p.fpPos.z);
      const _pwNormal = _pwWorld.clone().sub(_landedPlanet.position).normalize();
      _pwWorld.addScaledVector(_pwNormal, -PW_EYE_H);
      target.position.copy(_pwWorld);
    } else {
      target.position.set(p.fpPos.x, _targetGroundY, p.fpPos.z);
    }
    target.rotation.set(0, p.fpYaw || 0, 0);

    // The name tag is always already a child of `target` (added at player creation), so
    // "no children" is never true — that meant the astronaut body never actually got added.
    // Track it explicitly instead.
    if (!target.userData.hasAstronaut) {
      const tmpl = fpMode === 'docked' ? _astronautRoomTemplate : _astronautLobbyTemplate;
      if (tmpl) {
        const _astro = _cloneAstronaut(tmpl);
        if (fpMode === 'range') _astro.scale.multiplyScalar(48 / 18); // 30 units bigger in the range
        if (fpMode === 'tdm') {
          _astro.scale.multiplyScalar(_TDM_ASTRONAUT_SCALE); // matches _selfAstronautMesh's tdm scale
          _astro.position.y += 1;
          _astro.userData.collisionRadius *= _TDM_ASTRONAUT_SCALE;
          _astro.userData.collisionHeight *= _TDM_ASTRONAUT_SCALE;
          if (_astro.userData.collisionCenterOffset) _astro.userData.collisionCenterOffset.multiplyScalar(_TDM_ASTRONAUT_SCALE);
        }
        target.add(_astro);
        target.userData.hasAstronaut = true;
      }
    }

    // Drive this remote player's procedural avatar and held-weapon display from the
    // movement state they broadcast, and update the hit-target list to reflect it.
    const _avatar = target.children[0];
    if (_avatar) {
      _poseAvatar(_avatar, p.fpAnim);
      _setAvatarHeldWeapon(_avatar, p.equippedWeaponId);
    }
  }
}

// ── Input ─────────────────────────────────────────────────────────────────────
const keys = {};
window.addEventListener('keydown', e => {
  if (e.key === 'F11') {
    // The blanket preventDefault() below blocks the browser's own F11 fullscreen toggle
    // (it swallows every key), so handle it explicitly instead of just skipping it.
    e.preventDefault();
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
    return;
  }
  keys[e.key.toLowerCase()] = true;
  e.preventDefault();
});
window.addEventListener('keyup',   e => { keys[e.key.toLowerCase()] = false; });

// Pointer lock + NMS-style reticle steering
let pointerLocked = false;

// Reticle position in screen pixels, clamped to a circle
const RETICLE_RADIUS = 160;
let reticleX = 0, reticleY = 0;

// Missile lock-on: hitting a ship with the laser marks it as the current target. Keeping
// its on-screen square inside the steering circle for SHIP_LOCK_TIME_MS builds up a lock;
// once full, right-click fires a homing missile at it.
const SHIP_LOCK_TIME_MS = 3000;
const MISSILE_COOLDOWN_FRAMES = 90;
let _shipTarget = null; // { id, lockedMs, screenX, screenY, onScreen, inCircle }
let _missileCooldown = 0;
const _missiles = [];

// Reticle canvas overlay
const reticleCanvas = document.createElement('canvas');
reticleCanvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10';
document.body.appendChild(reticleCanvas);
const rCtx = reticleCanvas.getContext('2d');

function resizeReticleCanvas() {
  reticleCanvas.width  = window.innerWidth;
  reticleCanvas.height = window.innerHeight;
}
resizeReticleCanvas();
window.addEventListener('resize', resizeReticleCanvas);

// Animated star-streak particles — fly outward from center when moving fast
const STREAK_COUNT = 120;
const _streaks = Array.from({length: STREAK_COUNT}, () => ({
  ang: Math.random() * Math.PI * 2,
  r:   Math.random(),   // 0–1 normalized radius, randomized start
  spd: 0.3 + Math.random() * 0.7,
}));

// ── Minimap ───────────────────────────────────────────────────────────────────
const _minimapCanvas = document.getElementById('minimap');
const _mmCtx = _minimapCanvas ? _minimapCanvas.getContext('2d') : null;
const MM_SIZE = 200;
const MM_R = MM_SIZE / 2;
const MM_RANGE = 15000; // world units visible from center

function _drawMinimap() {
  if (!_mmCtx) return;
  const inSpace = gameMode === 'flight';
  _minimapCanvas.style.display = inSpace ? 'block' : 'none';
  if (!inSpace) return;

  _mmCtx.clearRect(0, 0, MM_SIZE, MM_SIZE);

  // Circular clip
  _mmCtx.save();
  _mmCtx.beginPath();
  _mmCtx.arc(MM_R, MM_R, MM_R - 1, 0, Math.PI * 2);
  _mmCtx.clip();

  // Background
  _mmCtx.fillStyle = 'rgba(0,0,10,0.75)';
  _mmCtx.fillRect(0, 0, MM_SIZE, MM_SIZE);

  // Grid rings
  _mmCtx.strokeStyle = 'rgba(0,255,255,0.08)';
  _mmCtx.lineWidth = 1;
  [0.33, 0.66, 1].forEach(r => {
    _mmCtx.beginPath();
    _mmCtx.arc(MM_R, MM_R, r * (MM_R - 2), 0, Math.PI * 2);
    _mmCtx.stroke();
  });

  const playerPos = selfMesh.position;
  // yaw of ship for rotation
  const shipYaw = selfMesh.rotation.y;

  function worldToMM(wx, wz) {
    const dx = wx - playerPos.x;
    const dz = wz - playerPos.z;
    // Rotate so ship faces up
    const rx =  dx * Math.cos(-shipYaw) - dz * Math.sin(-shipYaw);
    const rz =  dx * Math.sin(-shipYaw) + dz * Math.cos(-shipYaw);
    return [
      MM_R + (rx / MM_RANGE) * MM_R,
      MM_R + (rz / MM_RANGE) * MM_R,
    ];
  }

  // Station
  const [sx, sy] = worldToMM(station.position.x, station.position.z);
  _mmCtx.beginPath();
  _mmCtx.arc(sx, sy, 5, 0, Math.PI * 2);
  _mmCtx.fillStyle = '#ffffff';
  _mmCtx.fill();
  _mmCtx.font = '8px monospace';
  _mmCtx.fillStyle = '#cccccc';
  _mmCtx.textAlign = 'center';
  _mmCtx.fillText('STATION', sx, sy - 8);

  // Planets — only show if within MM_RANGE
  planets.forEach(p => {
    const dist = playerPos.distanceTo(p.position);
    if (dist > MM_RANGE) return;
    const [mx, my] = worldToMM(p.position.x, p.position.z);
    const r = Math.max(3, Math.min(10, 80000 / dist));
    _mmCtx.beginPath();
    _mmCtx.arc(mx, my, r, 0, Math.PI * 2);
    _mmCtx.fillStyle = p.userData.mapColor || '#4488ff';
    _mmCtx.fill();
    if (p.userData.mapName) {
      _mmCtx.font = '8px monospace';
      _mmCtx.fillStyle = '#aaddff';
      _mmCtx.textAlign = 'center';
      _mmCtx.fillText(p.userData.mapName, mx, my - r - 2);
    }
  });

  // Remote ships — always show, clamped to edge if far
  Object.values(remotePlayers).forEach(rp => {
    if (rp.fpMode) return;
    const sp = rp.mesh.position;
    let [mx, my] = worldToMM(sp.x, sp.z);
    const edgeDx = mx - MM_R, edgeDy = my - MM_R;
    const edgeDist = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
    if (edgeDist > MM_R - 4) { mx = MM_R + (edgeDx / edgeDist) * (MM_R - 5); my = MM_R + (edgeDy / edgeDist) * (MM_R - 5); }
    _mmCtx.beginPath();
    _mmCtx.arc(mx, my, 3, 0, Math.PI * 2);
    _mmCtx.fillStyle = '#ff6600';
    _mmCtx.fill();
    _mmCtx.font = '9px monospace';
    _mmCtx.fillStyle = '#ffaa66';
    _mmCtx.textAlign = 'center';
    _mmCtx.fillText(rp.data.name || 'Pilot', mx, my - 6);
  });

  // Self — triangle pointing up (ship heading)
  _mmCtx.beginPath();
  _mmCtx.moveTo(MM_R, MM_R - 6);
  _mmCtx.lineTo(MM_R - 4, MM_R + 4);
  _mmCtx.lineTo(MM_R + 4, MM_R + 4);
  _mmCtx.closePath();
  _mmCtx.fillStyle = '#00ffff';
  _mmCtx.fill();

  _mmCtx.restore();

  // Border
  _mmCtx.beginPath();
  _mmCtx.arc(MM_R, MM_R, MM_R - 1, 0, Math.PI * 2);
  _mmCtx.strokeStyle = 'rgba(0,255,255,0.35)';
  _mmCtx.lineWidth = 1.5;
  _mmCtx.stroke();
}

function drawReticle() {
  rCtx.clearRect(0, 0, reticleCanvas.width, reticleCanvas.height);
  const cx = reticleCanvas.width  / 2;
  const cy = reticleCanvas.height / 2;
  _drawHitMarker();

  // Star streaks — always visible, speed up with velocity
  const speed  = self ? self.velocity.length() : 0;
  const speedT = Math.min(1, speed / MAX_SPEED);
  const baseMove = 0.0018;                          // slow drift at rest
  const moveAmt  = baseMove + speedT * speedT * 0.026;
  const maxR     = Math.sqrt(cx*cx + cy*cy) * 1.05;
  rCtx.lineWidth = 1.2;
  // In cockpit view this is a full-screen radial overlay drawn independent of the 3D scene,
  // so streaks were rendering right over the solid cockpit frame/dash instead of stopping
  // at the "glass" — clip to roughly the windshield's screen area (upper-center, well short
  // of the dash patch at the bottom and the frame at the sides) so they only ever appear to
  // pass by outside the glass, not through the cockpit itself.
  const _cockpitClip = _cockpitView;
  if (_cockpitClip) {
    rCtx.save();
    rCtx.beginPath();
    rCtx.rect(cx - reticleCanvas.width * 0.32, cy - reticleCanvas.height * 0.4, reticleCanvas.width * 0.64, reticleCanvas.height * 0.55);
    rCtx.clip();
  }
  for (const s of _streaks) {
    s.r += moveAmt * s.spd;
    if (s.r > 1) { s.r = 0.0; s.ang = Math.random() * Math.PI * 2; }

    const r1      = s.r * maxR;
    const tailLen = Math.min(r1, (0.8 + speedT * 60) * s.spd);
    const r0      = Math.max(0, r1 - tailLen);
    const cos     = Math.cos(s.ang), sin = Math.sin(s.ang);
    // At rest: dim tiny dots; at speed: bright long streaks
    const alpha   = (0.15 + speedT * 0.6) * Math.min(1, s.r * 2.5);

    const grad = rCtx.createLinearGradient(cx + cos*r0, cy + sin*r0, cx + cos*r1, cy + sin*r1);
    grad.addColorStop(0, `rgba(200,220,255,0)`);
    grad.addColorStop(1, `rgba(210,235,255,${alpha.toFixed(2)})`);
    rCtx.strokeStyle = grad;
    rCtx.beginPath();
    rCtx.moveTo(cx + cos*r0, cy + sin*r0);
    rCtx.lineTo(cx + cos*r1, cy + sin*r1);
    rCtx.stroke();
  }
  if (_cockpitClip) rCtx.restore();

  // Planet-walk HUD markers (drawn before early-return so they always appear)
  if (gameMode === 'planet_walk') {
    if (_shipMarker) {
      const shipWP = new THREE.Vector3();
      _shipMarker.getWorldPosition(shipWP);
      drawWaypoint(shipWP, 0, 'rgba(0,255,255,A)', 'SHIP');
    }
    _crateObjects.forEach(c => {
      if (c.held || c.stored || c.planet !== _landedPlanet) return;
      const crateWP = new THREE.Vector3();
      c.mesh.getWorldPosition(crateWP);
      drawWaypoint(crateWP, 0, 'rgba(255,180,50,A)', 'CRATE');
    });
  }

  // Event crate marker — deliberately NOT gated to any particular gameMode, so the
  // "you can see this from anywhere" marker really does show up whether you're flying,
  // ejected, or walking around a planet. Points at whichever representation is currently
  // relevant: the planet itself (from anywhere else), the actual crate mesh once you're
  // on the right planet, or the floating wreck-site crate once it's been dropped.
  if (_eventCrateState) {
    if (_eventCrateState.status === 'planet') {
      if (_eventCratePlanetMesh.visible) {
        const wp = new THREE.Vector3();
        _eventCratePlanetMesh.getWorldPosition(wp);
        drawWaypoint(wp, 0, 'rgba(255,180,50,A)', '📦 CRATE', true);
      } else if (typeof planets !== 'undefined' && planets[_eventCrateState.planetIndex]) {
        drawWaypoint(planets[_eventCrateState.planetIndex].position, 0, 'rgba(255,180,50,A)', '📦 CRATE PLANET', true);
      }
    } else if (_eventCrateState.status === 'floating' && _floatingCrateMesh.visible) {
      const wp = new THREE.Vector3();
      _floatingCrateMesh.getWorldPosition(wp);
      drawWaypoint(wp, 0, 'rgba(120,255,120,A)', '📦 CRATE', true);
    }
    // status === 'carried': nothing to point at — it's with whoever picked it up.
  }
  if (gameMode === 'flight') {
    // Only show a trading station's waypoint once it's been marked on the galaxy map, or
    // while actively carrying the crate (worth knowing where the nearest one is if you're
    // hauling something valuable) — otherwise 4 permanent markers scattered across the map
    // is clutter for something most flights never need.
    _tradingStations.forEach(s => {
      if (s.userData.mapSelected || _iAmCarryingCrate) drawWaypoint(s.position, 0, 'rgba(0,200,255,A)', 'TRADE STATION');
    });
  }

  // Admin noclip dot + world coords of looked-at point
  if (window._adminMode && pointerLocked) {
    rCtx.beginPath();
    rCtx.arc(cx, cy, 4, 0, Math.PI * 2);
    rCtx.fillStyle = 'rgba(255,80,80,0.95)';
    rCtx.fill();
    rCtx.beginPath();
    rCtx.arc(cx, cy, 7, 0, Math.PI * 2);
    rCtx.strokeStyle = 'rgba(255,80,80,0.5)';
    rCtx.lineWidth = 1.5;
    rCtx.stroke();

    // Raycast from camera center to find looked-at world coords
    const _adminRay = new THREE.Raycaster();
    _adminRay.setFromCamera(new THREE.Vector2(0, 0), camera);
    const _adminTargets = [...scene.children, ...(gameMode === 'lobby' ? _lobbyCollidables : gameMode === 'hangar' ? _hangarCollidables : gameMode === 'range' ? _rangeCollidables : _roomCollidables)];
    const _adminHits = _adminRay.intersectObjects(_adminTargets, true);
    const _adminPt = _adminHits.length > 0 ? _adminHits[0].point : camera.position.clone().addScaledVector(_adminRay.ray.direction, 100);
    const _coordStr = `${_adminPt.x.toFixed(1)}, ${_adminPt.y.toFixed(1)}, ${_adminPt.z.toFixed(1)}`;
    rCtx.font = '12px monospace';
    rCtx.fillStyle = 'rgba(255,80,80,0.9)';
    rCtx.fillText(_coordStr, cx + 14, cy - 10);
  }

  if (!pointerLocked || gameMode === 'docked' || gameMode === 'lobby' || gameMode === 'hangar' || gameMode === 'range' || gameMode === 'tdm' || gameMode === 'ejected' || gameMode === 'planet_walk' || gameMode === 'landing_anim' || gameMode === 'takeoff_anim') return;

  // Outer boundary ring
  rCtx.beginPath();
  rCtx.arc(cx, cy, RETICLE_RADIUS, 0, Math.PI * 2);
  rCtx.strokeStyle = 'rgba(0,255,200,0.25)';
  rCtx.lineWidth = 1;
  rCtx.stroke();

  // Moving reticle dot — only show when moved away from center
  const dist = Math.sqrt(reticleX*reticleX + reticleY*reticleY);
  if (dist > 6) {
    const dx = cx + reticleX, dy = cy + reticleY;
    const t = dist / RETICLE_RADIUS;
    rCtx.beginPath();
    rCtx.arc(dx, dy, 5, 0, Math.PI * 2);
    rCtx.fillStyle = `rgba(${Math.round(t*255)},${Math.round((1-t)*255)},150,0.9)`;
    rCtx.fill();
    rCtx.beginPath(); rCtx.moveTo(cx, cy); rCtx.lineTo(dx, dy);
    rCtx.strokeStyle = 'rgba(0,255,200,0.2)'; rCtx.lineWidth = 1; rCtx.stroke();
  }

  // Ship lock-on target square — pops up wherever the ship you just hit is on screen.
  // Fills in as an arc while it sits inside the steering circle; a full green ring means
  // the missile lock is ready (right-click to fire).
  if (_shipTarget && _shipTarget.onScreen) {
    const sx = _shipTarget.screenX, sy = _shipTarget.screenY;
    const locked = _shipTarget.lockedMs >= SHIP_LOCK_TIME_MS;
    const pct = _shipTarget.lockedMs / SHIP_LOCK_TIME_MS;
    const boxCol = locked ? '#00ff66' : _shipTarget.inCircle ? '#ffcc33' : '#ff4444';
    const s = 22;
    rCtx.save();
    rCtx.strokeStyle = boxCol;
    rCtx.lineWidth = 2;
    rCtx.strokeRect(sx - s/2, sy - s/2, s, s);
    if (pct > 0) {
      rCtx.beginPath();
      rCtx.arc(sx, sy, s * 0.85, -Math.PI/2, -Math.PI/2 + pct * Math.PI * 2);
      rCtx.strokeStyle = boxCol;
      rCtx.lineWidth = 3;
      rCtx.stroke();
    }
    rCtx.fillStyle = boxCol;
    rCtx.font = 'bold 11px monospace';
    rCtx.textAlign = 'center';
    rCtx.fillText(locked ? 'LOCKED — FIRE' : 'TARGET', sx, sy + s/2 + 14);
    rCtx.restore();
  }

  // Waypoint helper — works at any distance using direction projection. `big` draws a
  // noticeably larger, faster-pulsing marker for map-wide events (cargo ship/crate)
  // instead of the normal small waypoint used for the station/planet-walk markers.
  function drawWaypoint(targetWorldPos, minDist, color, label, big) {
    if (!self) return;
    const dist = selfMesh.position.distanceTo(targetWorldPos);
    if (dist < minDist) return;

    // Project a point 1 unit toward target — avoids float precision at large coords
    const dir = targetWorldPos.clone().sub(camera.position).normalize();
    const near = camera.position.clone().addScaledVector(dir, 1);
    near.project(camera);

    let sx = (near.x * 0.5 + 0.5) * reticleCanvas.width;
    let sy = (-near.y * 0.5 + 0.5) * reticleCanvas.height;
    const onScreen = near.z < 1 && sx > 0 && sx < reticleCanvas.width && sy > 0 && sy < reticleCanvas.height;

    if (!onScreen) {
      if (near.z >= 1) { sx = reticleCanvas.width - sx; sy = reticleCanvas.height - sy; }
      const margin = 28;
      const hw = cx - margin, hh = cy - margin;
      const ang = Math.atan2(sy - cy, sx - cx);
      const cos = Math.cos(ang), sin = Math.sin(ang);
      const scale = Math.min(
        cos !== 0 ? Math.abs(hw / cos) : Infinity,
        sin !== 0 ? Math.abs(hh / sin) : Infinity
      );
      sx = cx + cos * scale;
      sy = cy + sin * scale;
    }

    const pulse = big ? (0.5 + 0.5 * Math.sin(Date.now() * 0.006)) : (0.6 + 0.4 * Math.sin(Date.now() * 0.003));
    const s = big ? 26 : 10;
    rCtx.save();
    rCtx.translate(sx, sy);
    rCtx.rotate(Math.PI / 4);
    rCtx.beginPath();
    rCtx.rect(-s/2, -s/2, s, s);
    rCtx.strokeStyle = color.replace('A', (pulse).toFixed(2));
    rCtx.lineWidth = big ? 3 : 1.5;
    rCtx.stroke();
    if (big) {
      rCtx.beginPath();
      rCtx.rect(-s*0.7, -s*0.7, s*1.4, s*1.4);
      rCtx.strokeStyle = color.replace('A', (pulse * 0.5).toFixed(2));
      rCtx.lineWidth = 1.5;
      rCtx.stroke();
    }
    rCtx.restore();

    const distStr = dist >= 1000 ? `${(dist/1000).toFixed(1)}ku` : `${Math.round(dist)}u`;
    rCtx.fillStyle = color.replace('A', (pulse * 0.85).toFixed(2));
    rCtx.font = big ? 'bold 14px monospace' : '11px monospace';
    rCtx.textAlign = 'center';
    rCtx.fillText(`${label}  ${distStr}`, sx, sy + (big ? 30 : 20));
  }

  if (typeof station !== 'undefined') {
    drawWaypoint(station.position, 700, 'rgba(100,200,255,A)', 'STATION');
  }
  // Planet waypoints — only when marked on Galaxy Map
  planets.forEach(p => {
    if (!p.userData.mapSelected) return;
    const col = p.userData.diamondColor
      ? 'rgba(' + [
          (p.userData.diamondColor >> 16 & 255),
          (p.userData.diamondColor >> 8  & 255),
          (p.userData.diamondColor        & 255),
          'A'].join(',') + ')'
      : 'rgba(80,220,120,A)';
    drawWaypoint(p.position, 0, col, p.userData.mapName || 'PLANET');
  });

}

const overlay = document.getElementById('click-overlay');

// ── Background music (radio) ────────────────────────────────────────────────────
// Autoplay-with-sound is blocked until a real user gesture, so this only actually
// starts inside the click handler below (which already exists to grab pointer lock).
// Drop files in client/assets/sounds/ and add their paths here (optionally with a matching
// entry in _musicTrackGain if one plays quieter than the rest) and the ArrowUp/Down/Left/
// Right controls below pick them up with no other changes.
const _musicPlaylist = [];
const _musicTrackGain = []; // per-track volume multiplier, index-aligned with _musicPlaylist
let _musicIndex = 0;
let _musicUserVolume = 0.25; // the 0..1 level ArrowUp/ArrowDown actually adjust
const _bgMusic = new Audio();
_bgMusic.loop = false; // looping/advancing the whole playlist is handled by the 'ended' listener below
_bgMusic.addEventListener('ended', () => _musicSkip(1));
let _bgMusicStarted = false;
function _startBgMusic() {
  if (_bgMusicStarted || _musicPlaylist.length === 0) return;
  _bgMusicStarted = true;
  _bgMusic.src = _musicPlaylist[_musicIndex];
  _applyMusicVolume();
  _bgMusic.play().catch(() => { _bgMusicStarted = false; }); // retry on the next click if it was blocked
}
function _applyMusicVolume() {
  const gain = _musicTrackGain[_musicIndex] != null ? _musicTrackGain[_musicIndex] : 1.0;
  _bgMusic.volume = Math.max(0, Math.min(1, _musicUserVolume * gain));
}
function _musicSkip(dir) {
  if (_musicPlaylist.length === 0) return;
  _musicIndex = (_musicIndex + dir + _musicPlaylist.length) % _musicPlaylist.length;
  _bgMusic.src = _musicPlaylist[_musicIndex];
  _bgMusic.currentTime = 0;
  _applyMusicVolume();
  if (_bgMusicStarted) _bgMusic.play().catch(() => {});
}
function _musicVolume(delta) {
  _musicUserVolume = Math.max(0, Math.min(1, _musicUserVolume + delta));
  _applyMusicVolume();
}
document.addEventListener('keydown', e => {
  // Don't hijack arrow keys while typing in a text field (chat, username, etc.) or while
  // a menu with its own arrow-key navigation (hub, shop, etc.) is open.
  const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
  if (typing || hubOpen) return;
  if (e.key === 'ArrowUp')   { _musicVolume(0.05); e.preventDefault(); }
  if (e.key === 'ArrowDown') { _musicVolume(-0.05); e.preventDefault(); }
  if (e.key === 'ArrowRight') { _musicSkip(1); e.preventDefault(); }
  if (e.key === 'ArrowLeft')  { _musicSkip(-1); e.preventDefault(); }
});

let lockRequested = false;
document.addEventListener('click', () => {
  _startBgMusic();
  if (_sfxCtx.state === 'suspended') _sfxCtx.resume(); // warm it up now, not on the first gunshot
  // Dismiss the title screen on the very first click once it's actually ready — the same
  // click that follows also requests pointer lock below, so this doesn't need its own
  // separate "Play" button wiring.
  if (window._titleScreenReady && window._titleScreenEl && window._titleScreenEl.style.display !== 'none') {
    window._titleScreenEl.style.display = 'none';
    // The socket connected at page load using whatever username was saved from a previous
    // visit (or none) — if they typed a new/different one on the title screen just now,
    // reconnect so this session actually uses it instead of requiring a page reload.
    const typedName = document.getElementById('title-username-input') ? document.getElementById('title-username-input').value.trim().slice(0, 20) : '';
    if (socket && typedName && typedName !== (socket.auth && socket.auth.username)) {
      socket.auth = { username: typedName };
      socket.disconnect();
      socket.connect();
    }
  }
  if (hubOpen || shopOpen || bountiesOpen || roomCustomOpen || shipUpgradeOpen || inventoryOpen || gameMode === 'hangar') return;
  if (!document.pointerLockElement && !lockRequested) {
    lockRequested = true;
    setTimeout(() => { lockRequested = false; }, 2000);
    document.body.requestPointerLock();
  }
});

document.addEventListener('pointerlockchange', () => {
  pointerLocked = !!document.pointerLockElement;
  const mapIsOpen = document.getElementById('galaxy-map').classList.contains('open');
  const menuOpen = hubOpen || shopOpen || bountiesOpen || roomCustomOpen || shipUpgradeOpen || inventoryOpen || mapIsOpen || (window._chatOpen && window._chatOpen()) || gameMode === 'hangar';
  if (!menuOpen) overlay.classList.toggle('hidden', pointerLocked);
  if (!pointerLocked) { reticleX = 0; reticleY = 0; }
  // body has cursor:none globally so the game can draw its own reticle instead of the OS
  // cursor — but real DOM menus (room hub, shop, etc.) need the actual cursor visible so
  // you can see what you're clicking on.
  document.body.style.cursor = menuOpen ? 'auto' : 'none';
});

document.addEventListener('mousemove', e => {
  if (!pointerLocked) return;
  if (gameMode === 'docked' || gameMode === 'lobby' || gameMode === 'range' || gameMode === 'tdm' || gameMode === 'trade_station' || gameMode === 'ship_interior') {
    const cap = 40;
    _fpMouseDX += Math.max(-cap, Math.min(cap, e.movementX));
    _fpMouseDY += Math.max(-cap, Math.min(cap, e.movementY));
    return;
  }
  if (gameMode === 'planet_walk' || gameMode === 'planet_surface') {
    const cap = 40;
    _pwMouseDX += Math.max(-cap, Math.min(cap, e.movementX));
    _pwMouseDY += Math.max(-cap, Math.min(cap, e.movementY));
    return;
  }
  if (gameMode === 'landed_ship') {
    const cap = 40;
    _landedCamMouseDX += Math.max(-cap, Math.min(cap, e.movementX));
    _landedCamMouseDY += Math.max(-cap, Math.min(cap, e.movementY));
    return;
  }
  reticleX += e.movementX;
  reticleY += e.movementY;
  // Clamp to circle
  const len = Math.sqrt(reticleX*reticleX + reticleY*reticleY);
  if (len > RETICLE_RADIUS) {
    reticleX = reticleX / len * RETICLE_RADIUS;
    reticleY = reticleY / len * RETICLE_RADIUS;
  }
});

// ── Eject system ──────────────────────────────────────────────────────────────
const ejectPos = new THREE.Vector3();
const ejectVel = new THREE.Vector3();
let   _ejectMouseDX = 0, _ejectMouseDY = 0;
let   _ejectYaw = 0, _ejectPitch = 0, _ejectDriftT = 0, _ejectTime = 0;
let   _ejectFreezeDamageTimer = 0; // counts frames once fully iced over, ticking cold damage
const _ejectEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _ejectQuat  = new THREE.Quaternion();
const FP_EJECT_SPEED = 0.12, FP_EJECT_ACCEL = 0.0018, FP_EJECT_FRICTION = 0.994;

const reboardPrompt = document.createElement('div');
reboardPrompt.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);color:#0ff;font-family:monospace;font-size:15px;letter-spacing:3px;text-shadow:0 0 10px #0ff;pointer-events:none;display:none;';
reboardPrompt.textContent = '[ E ]  RE-BOARD SHIP';
document.body.appendChild(reboardPrompt);

// ── Frost / cold overlay ──────────────────────────────────────────────────────
const frostCanvas = document.createElement('canvas');
frostCanvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:50;display:none;';
document.body.appendChild(frostCanvas);
const frostCtx = frostCanvas.getContext('2d');

function resizeFrost() {
  frostCanvas.width  = window.innerWidth;
  frostCanvas.height = window.innerHeight;
}
resizeFrost();
window.addEventListener('resize', resizeFrost);

function drawFrost(p) { // p = 0 (just ejected) → 1 (fully formed)
  if (p <= 0) return;
  const w = frostCanvas.width, h = frostCanvas.height;
  frostCtx.clearRect(0, 0, w, h);
  const rng = s => { let x = Math.sin(s) * 43758.5453; return x - Math.floor(x); };

  // Blue vignette — fades in
  const vign = frostCtx.createRadialGradient(w/2, h/2, h*0.3, w/2, h/2, h*0.85);
  vign.addColorStop(0, 'rgba(100,180,255,0)');
  vign.addColorStop(1, `rgba(60,120,220,${(0.38 * p).toFixed(3)})`);
  frostCtx.fillStyle = vign;
  frostCtx.fillRect(0, 0, w, h);

  // Top icicles — grow downward with p
  for (let i = 0; i < 38; i++) {
    const x     = rng(i * 3.1) * w;
    const maxLen = 30 + rng(i * 1.7) * 150;
    const len   = maxLen * p;
    const wid   = (2 + rng(i * 2.3) * 10) * Math.min(1, p * 2);
    const alpha = (0.35 + rng(i * 0.9) * 0.45) * p;
    frostCtx.beginPath();
    frostCtx.moveTo(x - wid/2, 0);
    frostCtx.lineTo(x + wid/2, 0);
    frostCtx.lineTo(x, len);
    frostCtx.closePath();
    frostCtx.fillStyle = `rgba(160,215,255,${alpha.toFixed(3)})`;
    frostCtx.fill();
    frostCtx.beginPath();
    frostCtx.moveTo(x - wid*0.15, 0);
    frostCtx.lineTo(x + wid*0.15, 0);
    frostCtx.lineTo(x, len * 0.6);
    frostCtx.closePath();
    frostCtx.fillStyle = `rgba(230,245,255,${(alpha*0.5).toFixed(3)})`;
    frostCtx.fill();
  }

  // Bottom icicles
  for (let i = 0; i < 28; i++) {
    const x     = rng(i * 4.7 + 100) * w;
    const maxLen = 20 + rng(i * 2.1 + 50) * 100;
    const len   = maxLen * p;
    const wid   = (2 + rng(i * 3.3 + 30) * 8) * Math.min(1, p * 2);
    const alpha = (0.25 + rng(i * 1.1 + 20) * 0.35) * p;
    frostCtx.beginPath();
    frostCtx.moveTo(x - wid/2, h);
    frostCtx.lineTo(x + wid/2, h);
    frostCtx.lineTo(x, h - len);
    frostCtx.closePath();
    frostCtx.fillStyle = `rgba(160,215,255,${alpha.toFixed(3)})`;
    frostCtx.fill();
  }

  // Side frost spears
  for (const side of [0, w]) {
    for (let i = 0; i < 22; i++) {
      const y     = rng(i * 5.3 + side * 0.01) * h;
      const maxLen = 15 + rng(i * 1.9 + side * 0.02) * 90;
      const len   = maxLen * p;
      const wid   = (2 + rng(i * 2.7 + side * 0.03) * 7) * Math.min(1, p * 2);
      const alpha = (0.2 + rng(i * 0.7 + side * 0.01) * 0.35) * p;
      const dir   = side === 0 ? 1 : -1;
      frostCtx.beginPath();
      frostCtx.moveTo(side, y - wid/2);
      frostCtx.lineTo(side, y + wid/2);
      frostCtx.lineTo(side + dir * len, y);
      frostCtx.closePath();
      frostCtx.fillStyle = `rgba(160,215,255,${alpha.toFixed(3)})`;
      frostCtx.fill();
    }
  }

  // Corner crystal arms — grow with p
  for (const [cx2, cy2] of [[0,0],[w,0],[0,h],[w,h]]) {
    for (let arm = 0; arm < 8; arm++) {
      const angle  = (arm / 8) * Math.PI * 2;
      const maxR   = 40 + rng(arm + cx2 * 0.001) * 100;
      const r      = maxR * p;
      const alpha  = 0.4 * p;
      frostCtx.beginPath();
      frostCtx.moveTo(cx2, cy2);
      frostCtx.lineTo(cx2 + Math.cos(angle)*r, cy2 + Math.sin(angle)*r);
      frostCtx.strokeStyle = `rgba(180,225,255,${alpha.toFixed(3)})`;
      frostCtx.lineWidth = 1.5;
      frostCtx.stroke();
      if (p > 0.3) {
        const bx = cx2 + Math.cos(angle)*r*0.5, by = cy2 + Math.sin(angle)*r*0.5;
        const br = 25 * ((p - 0.3) / 0.7);
        frostCtx.beginPath();
        frostCtx.moveTo(bx, by);
        frostCtx.lineTo(bx + Math.cos(angle+Math.PI/3)*br, by + Math.sin(angle+Math.PI/3)*br);
        frostCtx.strokeStyle = `rgba(180,225,255,${(alpha*0.6).toFixed(3)})`;
        frostCtx.lineWidth = 1;
        frostCtx.stroke();
        frostCtx.beginPath();
        frostCtx.moveTo(bx, by);
        frostCtx.lineTo(bx + Math.cos(angle-Math.PI/3)*br, by + Math.sin(angle-Math.PI/3)*br);
        frostCtx.stroke();
      }
    }
  }
}

function ejectFromShip() {
  if (gameMode !== 'flight') return;
  gameMode = 'ejected';
  ejectPos.copy(selfMesh.position).addScaledVector(new THREE.Vector3(0,1,0).applyQuaternion(selfMesh.quaternion), 8);
  ejectVel.set(0, 0, 0);
  _ejectYaw = 0; _ejectPitch = 0; _ejectMouseDX = 0; _ejectMouseDY = 0; _ejectDriftT = 0; _ejectTime = 0;
  _ejectFreezeDamageTimer = 0;
  selfMesh.visible = true;
  elHud.style.display = 'none';
  frostCanvas.style.display = 'block';
}

function reboardShip() {
  if (gameMode !== 'ejected') return;
  gameMode = 'flight';
  self.velocity.copy(ejectVel);
  reboardPrompt.style.display = 'none';
  elHud.style.display = 'block';
  frostCanvas.style.display = 'none';
}

function updateEjected() {
  // Mouse look
  _ejectYaw   -= _ejectMouseDX * 0.0028;
  _ejectPitch -= _ejectMouseDY * 0.0028;
  _ejectPitch  = Math.max(-Math.PI/2, Math.min(Math.PI/2, _ejectPitch));
  _ejectMouseDX = 0; _ejectMouseDY = 0;
  _ejectEuler.set(_ejectPitch, _ejectYaw, 0, 'YXZ');
  _ejectQuat.setFromEuler(_ejectEuler);
  camera.quaternion.copy(_ejectQuat);

  // 3D free-float movement aligned to look direction
  const fwd   = new THREE.Vector3(0, 0, -1).applyQuaternion(_ejectQuat);
  const right = new THREE.Vector3(1, 0,  0).applyQuaternion(_ejectQuat);
  const up    = new THREE.Vector3(0, 1,  0).applyQuaternion(_ejectQuat);

  if (keys['w']) ejectVel.addScaledVector(fwd,   FP_EJECT_ACCEL);
  if (keys['s']) ejectVel.addScaledVector(fwd,  -FP_EJECT_ACCEL);
  if (keys['a']) ejectVel.addScaledVector(right, -FP_EJECT_ACCEL);
  if (keys['d']) ejectVel.addScaledVector(right,  FP_EJECT_ACCEL);
  if (keys[' ']) ejectVel.addScaledVector(up,     FP_EJECT_ACCEL);

  ejectVel.multiplyScalar(FP_EJECT_FRICTION);
  if (ejectVel.length() > FP_EJECT_SPEED) ejectVel.setLength(FP_EJECT_SPEED);
  ejectPos.add(ejectVel);

  // Gentle open-space drift — slow sinusoidal float on all axes
  _ejectDriftT += 0.012;
  const drift = new THREE.Vector3(
    Math.sin(_ejectDriftT * 0.7)  * 0.04,
    Math.sin(_ejectDriftT * 1.0)  * 0.06,
    Math.sin(_ejectDriftT * 0.5)  * 0.03,
  );
  camera.position.copy(ejectPos).add(drift);

  // Re-board prompt
  const distToShip = ejectPos.distanceTo(selfMesh.position);
  reboardPrompt.style.display = distToShip < 60 ? 'block' : 'none';

  // Stars + skybox follow camera
  
  

  // Grow frost over time — full formation after ~20 seconds (1200 frames)
  _ejectTime++;
  const frostP = Math.min(1, _ejectTime / 1200);
  drawFrost(frostP);

  // Once the ice has fully formed, exposure starts taking a real toll — small ticks of
  // cold damage every half-second until you either freeze to death or get back to a
  // ship/station. Routed through the server the same way any other damage is (via
  // 'environmental_damage', which mirrors player_hit's health/death handling but always
  // targets yourself), so health stays authoritative instead of drifting client-side.
  if (frostP >= 1) {
    _ejectFreezeDamageTimer++;
    if (_ejectFreezeDamageTimer >= 30) {
      _ejectFreezeDamageTimer = 0;
      if (socket) socket.emit('environmental_damage', { damage: 3 });
    }
  } else {
    _ejectFreezeDamageTimer = 0;
  }
}

// J to eject, E to re-board
document.addEventListener('keydown', e => {
  if ((e.key === 'j' || e.key === 'J') && gameMode === 'flight' && pointerLocked) ejectFromShip();
  if ((e.key === 'e' || e.key === 'E') && gameMode === 'ejected') {
    if (ejectPos.distanceTo(selfMesh.position) < 60) reboardShip();
  }
});

// Route ejected mouse movement
document.addEventListener('mousemove', e => {
  if (!pointerLocked || gameMode !== 'ejected') return;
  const cap = 40;
  _ejectMouseDX += Math.max(-cap, Math.min(cap, e.movementX));
  _ejectMouseDY += Math.max(-cap, Math.min(cap, e.movementY));
});

// Shortest distance from `point` to the segment a→b — used to catch fast projectiles
// against the path they swept this frame, not just where they ended up.
const _p2sAP = new THREE.Vector3(), _p2sAB = new THREE.Vector3();
function _pointToSegmentDistance(point, a, b) {
  _p2sAB.subVectors(b, a);
  const lenSq = _p2sAB.lengthSq();
  if (lenSq < 1e-8) return point.distanceTo(a);
  _p2sAP.subVectors(point, a);
  const t = Math.max(0, Math.min(1, _p2sAP.dot(_p2sAB) / lenSq));
  return point.distanceTo(a.clone().addScaledVector(_p2sAB, t));
}

// Ship-vs-ship hit effect — a quick decaying point-light burst. Uses its own rAF fade
// loop instead of a frame-array tied into updateLasers(), since a fatal hit switches the
// victim straight into 'ejected' mode (a different animate() branch) and the flash still
// needs to finish playing out regardless of which mode is active afterward.
function _spawnShipImpact(pos, big) {
  const baseIntensity = big ? 400 : 150;
  const light = new THREE.PointLight(0xff6600, baseIntensity, big ? 800 : 400);
  light.position.copy(pos);
  scene.add(light);
  const duration = big ? 500 : 250;
  const start = performance.now();
  (function fade() {
    const t = (performance.now() - start) / duration;
    if (t >= 1) { scene.remove(light); return; }
    light.intensity = baseIntensity * (1 - t);
    requestAnimationFrame(fade);
  })();
}

// Full ship-destruction explosion — a layered additive fireball (hot core + mid + outer
// glow), an expanding shockwave ring, flying debris chunks, and a spark burst. All driven
// by its own rAF loop (same reasoning as _spawnShipImpact above: the death that triggers
// this immediately switches gameMode to 'ejected', a different animate() branch, and the
// explosion still needs to keep playing through that transition).
function _spawnBigShipExplosion(pos) {
  const group = new THREE.Group();
  group.position.copy(pos);
  scene.add(group);

  const ballGeo = new THREE.SphereGeometry(1, 14, 10);
  const core  = new THREE.Mesh(ballGeo, new THREE.MeshBasicMaterial({ color: 0xfff2cc, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  const mid   = new THREE.Mesh(ballGeo, new THREE.MeshBasicMaterial({ color: 0xff9900, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  const outer = new THREE.Mesh(ballGeo, new THREE.MeshBasicMaterial({ color: 0xff2200, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  group.add(outer, mid, core);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1, 1.35, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  group.add(ring);

  const DEBRIS_COUNT = 12;
  const debris = [];
  for (let i = 0; i < DEBRIS_COUNT; i++) {
    const s = 1 + Math.random() * 2.2;
    const chunk = new THREE.Mesh(
      new THREE.BoxGeometry(s, s * 0.6, s * 0.8),
      new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.8, metalness: 0.3, emissive: 0xff4400, emissiveIntensity: 0.8 })
    );
    const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    chunk.userData.vel  = dir.multiplyScalar(1.5 + Math.random() * 4);
    chunk.userData.spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.25);
    group.add(chunk);
    debris.push(chunk);
  }

  const SPARK_COUNT = 70;
  const sparkPos = new Float32Array(SPARK_COUNT * 3);
  const sparkVel = [];
  for (let i = 0; i < SPARK_COUNT; i++) {
    const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    sparkVel.push(dir.multiplyScalar(2 + Math.random() * 7));
  }
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({
    color: 0xffcc66, size: 3, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  group.add(sparks);

  const light = new THREE.PointLight(0xffaa44, 600, 1400);
  group.add(light);

  const DURATION = 1500;
  const start = performance.now();
  (function step() {
    const t = (performance.now() - start) / DURATION; // 0 -> 1
    if (t >= 1) { scene.remove(group); return; }

    const fireScale = 1 + t * 36;
    core.scale.setScalar(fireScale * 0.45);
    mid.scale.setScalar(fireScale * 0.75);
    outer.scale.setScalar(fireScale);
    const fireFade = Math.max(0, 1 - t / 0.6);
    core.material.opacity  = fireFade;
    mid.material.opacity   = fireFade * 0.9;
    outer.material.opacity = fireFade * 0.6;

    ring.scale.setScalar(1 + t * 65);
    ring.material.opacity = Math.max(0, 0.8 * (1 - t));
    ring.lookAt(camera.position);

    debris.forEach(c => {
      c.position.add(c.userData.vel);
      c.rotation.x += c.userData.spin.x;
      c.rotation.y += c.userData.spin.y;
      c.rotation.z += c.userData.spin.z;
    });

    const posAttr = sparks.geometry.attributes.position;
    for (let i = 0; i < SPARK_COUNT; i++) {
      posAttr.array[i * 3]     += sparkVel[i].x;
      posAttr.array[i * 3 + 1] += sparkVel[i].y;
      posAttr.array[i * 3 + 2] += sparkVel[i].z;
    }
    posAttr.needsUpdate = true;
    sparks.material.opacity = Math.max(0, 1 - t);

    light.intensity = 600 * Math.max(0, 1 - t / 0.4);

    requestAnimationFrame(step);
  })();
}

// ── Laser cannon ─────────────────────────────────────────────────────────────
const LASER_SPEED    = 80;
const LASER_LIFETIME   = 55;  // frames
const LASER_COOLDOWN   = 22;  // frames between shots
const SHIP_HIT_RADIUS = 16;   // rough ship collision radius (enemy ships load at targetSize 20)
const LASER_DAMAGE    = 12;
const LASER_HEAT_PER   = 5;   // heat added per shot (0-100 scale)
const LASER_COOL_RATE  = 0.6; // heat lost per frame when not firing
const LASER_OVERHEAT   = 100;
const LASER_RECOVER    = 15;  // must cool to this before firing again
let   _laserCooldown   = 0;
let   _laserHeat       = 0;
let   _laserOverheated = false;
const _lasers = [];

const _laserGeo = new THREE.CylinderGeometry(0.6, 0.6, 28, 6);
_laserGeo.rotateX(Math.PI / 2); // align along Z axis
const _laserMat = new THREE.MeshBasicMaterial({ color: 0xff5500 });

// Point light that travels with each bolt
function spawnLaser() {
  if (gameMode !== 'flight' || !self) return;
  if (self.inSafeZone) { showWeaponsLocked(); return; }
  if (_laserCooldown > 0 || _laserOverheated) return;
  _laserCooldown = LASER_COOLDOWN;
  _laserHeat = Math.min(LASER_OVERHEAT, _laserHeat + LASER_HEAT_PER);
  if (_laserHeat >= LASER_OVERHEAT) _laserOverheated = true;

  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(selfMesh.quaternion);

  const mesh = new THREE.Mesh(_laserGeo, _laserMat);
  mesh.position.copy(selfMesh.position).addScaledVector(fwd, 14);
  mesh.quaternion.copy(selfMesh.quaternion);
  scene.add(mesh);

  const glow = new THREE.PointLight(0xff5500, 55, 250);
  glow.position.copy(mesh.position);
  scene.add(glow);

  _lasers.push({
    mesh, glow,
    vel: fwd.clone().multiplyScalar(LASER_SPEED).add(self.velocity),
    life: LASER_LIFETIME,
  });
}

function updateLasers() {
  if (_mouseFireHeld && pointerLocked && gameMode === 'flight') spawnLaser();
  _laserCooldown = Math.max(0, _laserCooldown - 1);
  // Heat dissipates when not firing; recover from overheat once cool enough
  if (!_mouseFireHeld || _laserOverheated) {
    _laserHeat = Math.max(0, _laserHeat - LASER_COOL_RATE);
    if (_laserOverheated && _laserHeat <= LASER_RECOVER) _laserOverheated = false;
  }
  updateHeatBar();
  if (_weaponsLockedTimer > 0) {
    _weaponsLockedTimer--;
    if (_weaponsLockedTimer === 0) _weaponsLockedEl.style.display = 'none';
  }
  for (let i = _lasers.length - 1; i >= 0; i--) {
    const l = _lasers[i];
    const _prevPos = l.mesh.position.clone();
    l.mesh.position.add(l.vel);
    l.glow.position.copy(l.mesh.position);
    l.life--;

    // Ship-vs-ship hit detection — only against players actually flying (their ship mesh
    // is only visible while not in any FP sub-mode), and never anyone currently inside the
    // safe zone, mirroring the same inSafeZone check that already blocks firing in the
    // first place (this covers the receiving end too, e.g. shooting in from just outside).
    // Checked against the swept segment from last frame's position to this frame's, not
    // just the new point — LASER_SPEED (80/frame) is faster than SHIP_HIT_RADIUS (16), so
    // a plain point check let fast-moving bolts tunnel straight through nearby targets
    // without ever landing a sample inside the hit radius.
    let hitId = null;
    for (const id in remotePlayers) {
      const rp = remotePlayers[id];
      if (!rp.mesh.visible) continue;
      if (rp.data && rp.data.inSafeZone) continue;
      if (_pointToSegmentDistance(rp.mesh.position, _prevPos, l.mesh.position) < SHIP_HIT_RADIUS) { hitId = id; break; }
    }
    if (hitId) {
      socket.emit('player_hit', { targetId: hitId, damage: LASER_DAMAGE });
      _spawnShipImpact(l.mesh.position.clone());
      // A hit on a new ship starts a fresh lock; re-hitting the ship already being
      // tracked doesn't reset progress already built up toward the 3-second lock.
      if (!_shipTarget || _shipTarget.id !== hitId) _shipTarget = { id: hitId, lockedMs: 0 };
    }

    const t = l.life / LASER_LIFETIME;
    l.glow.intensity = 55 * t;
    if (hitId || l.life <= 0) {
      scene.remove(l.mesh);
      scene.remove(l.glow);
      _lasers.splice(i, 1);
    }
  }

  _updateShipTargeting();
  _updateMissiles();
}

// Projects the current lock target's world position to reticle-canvas screen space, same
// math as drawWaypoint() above but kept standalone since that helper is local to
// drawReticle() and this needs to run every frame regardless of the HUD redraw, to build
// up lock time even on frames where drawing itself is skipped.
function _shipTargetMesh(targetId) {
  const rp = remotePlayers[targetId];
  return (rp && rp.mesh.visible && !(rp.data && rp.data.inSafeZone)) ? rp.mesh : null;
}

function _updateShipTargeting() {
  if (_missileCooldown > 0) _missileCooldown--;
  if (!_shipTarget) return;
  const targetMesh = _shipTargetMesh(_shipTarget.id);
  if (!targetMesh) { _shipTarget = null; return; }
  const rp = { mesh: targetMesh };

  const dir = rp.mesh.position.clone().sub(camera.position).normalize();
  const near = camera.position.clone().addScaledVector(dir, 1);
  near.project(camera);
  const sx = (near.x * 0.5 + 0.5) * reticleCanvas.width;
  const sy = (-near.y * 0.5 + 0.5) * reticleCanvas.height;
  const cx = reticleCanvas.width / 2, cy = reticleCanvas.height / 2;
  const onScreen = near.z < 1 && sx > 0 && sx < reticleCanvas.width && sy > 0 && sy < reticleCanvas.height;
  const inCircle = onScreen && Math.hypot(sx - cx, sy - cy) <= RETICLE_RADIUS;

  _shipTarget.screenX = sx;
  _shipTarget.screenY = sy;
  _shipTarget.onScreen = onScreen;
  _shipTarget.inCircle = inCircle;
  if (inCircle) {
    _shipTarget.lockedMs = Math.min(SHIP_LOCK_TIME_MS, _shipTarget.lockedMs + 1000 / 60);
  } else {
    _shipTarget.lockedMs = Math.max(0, _shipTarget.lockedMs - 1000 / 60); // decays, doesn't reset instantly
  }
}

const MISSILE_SPEED = 55;
const MISSILE_TURN  = 0.09;   // how sharply it steers toward the target each frame
const MISSILE_LIFETIME = 220; // frames before it gives up and self-destructs
const MISSILE_DAMAGE = 40;
const _missileGeo = new THREE.CylinderGeometry(0.9, 0.9, 10, 8);
_missileGeo.rotateX(Math.PI / 2);
const _missileMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0xff3300, emissiveIntensity: 0.5 });

function _fireMissile() {
  if (gameMode !== 'flight' || !self || self.inSafeZone) return;
  if (!_shipTarget || _shipTarget.lockedMs < SHIP_LOCK_TIME_MS) return;
  if (_missileCooldown > 0) return;
  const targetMesh = _shipTargetMesh(_shipTarget.id);
  if (!targetMesh) return;
  const rp = { mesh: targetMesh };
  _missileCooldown = MISSILE_COOLDOWN_FRAMES;

  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(selfMesh.quaternion);
  const mesh = new THREE.Mesh(_missileGeo, _missileMat);
  mesh.position.copy(selfMesh.position).addScaledVector(fwd, 16);
  mesh.quaternion.copy(selfMesh.quaternion);
  scene.add(mesh);
  const flame = new THREE.PointLight(0xff8833, 40, 200);
  flame.position.copy(mesh.position);
  scene.add(flame);

  // Launch velocity aims straight at the target's current position rather than the ship's
  // own forward vector — at long range even a few degrees of initial offset needs many
  // frames of the gradual homing turn to correct, and by then a fast missile has already
  // flown straight past its target's z-plane without ever coming within hit range (closest
  // approach still 50+ units on a shot that "should" have connected). Aiming at the target
  // immediately means homing only has to correct for the target's own movement afterward.
  const toTargetInitial = rp.mesh.position.clone().sub(mesh.position).normalize();
  _missiles.push({
    mesh, flame,
    targetId: _shipTarget.id,
    vel: toTargetInitial.multiplyScalar(MISSILE_SPEED),
    life: MISSILE_LIFETIME,
  });
  // Firing consumes the lock — has to be rebuilt (re-hit + hold) for another shot.
  _shipTarget.lockedMs = 0;
}

function _updateMissiles() {
  for (let i = _missiles.length - 1; i >= 0; i--) {
    const m = _missiles[i];
    m.life--;
    const targetMesh = _shipTargetMesh(m.targetId);
    const targetAlive = !!targetMesh;
    if (targetAlive) {
      // Steer velocity toward the target — a homing turn, not an instant snap.
      const toTarget = targetMesh.position.clone().sub(m.mesh.position).normalize();
      m.vel.lerp(toTarget.multiplyScalar(MISSILE_SPEED), MISSILE_TURN).setLength(MISSILE_SPEED);
    }
    const _prevPos = m.mesh.position.clone();
    m.mesh.position.add(m.vel);
    m.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), m.vel.clone().normalize());
    m.flame.position.copy(m.mesh.position);

    let hit = false;
    if (targetAlive && _pointToSegmentDistance(targetMesh.position, _prevPos, m.mesh.position) < SHIP_HIT_RADIUS) {
      socket.emit('player_hit', { targetId: m.targetId, damage: MISSILE_DAMAGE });
      _spawnShipImpact(m.mesh.position.clone(), true);
      hit = true;
    }

    if (hit || m.life <= 0) {
      scene.remove(m.mesh);
      scene.remove(m.flame);
      _missiles.splice(i, 1);
    }
  }
}

// ── Cargo ship event / crate economy ────────────────────────────────────────────
// Entirely server-driven: the server decides when the cargo ship spawns, tracks its
// health, and owns the floating crate afterward, so every client sees the same thing at
// the same time regardless of who's actually nearby when it happens.
const CRATE_PICKUP_RADIUS = 80; // matches server's CRATE_COLLECT_RADIUS
const PLANET_CRATE_PICKUP_RADIUS = 30; // tighter on foot than in a ship

// Full state mirrors the server's _eventCrate: { status: 'planet', planetIndex, localX, localZ }
// | { status: 'carried', holderId, holderName } | { status: 'floating', position } | null.
let _eventCrateState = null;
let _iAmCarryingCrate = false;

// Crate mesh for when it's sitting on a planet's surface. Landing on a planet doesn't
// give it its own unique scene/geometry — every planet that shares a terrain type (icy,
// desert, volcanic, etc) reuses the exact same terrain mesh in _planetSurfScene, loaded
// once — so this mesh lives in that shared scene and is only ever made visible while the
// player has actually landed on the SPECIFIC planet the crate is on (checked against
// _surfCurrentPlanet), not just any planet using the same terrain art.
//
// Both crate representations are Group wrappers around the real crate_03.glb model (same
// asset the decorative planet crates use) instead of a plain colored box — populated with
// a plain-box placeholder immediately, then swapped for the real model once it finishes
// downloading (same fallback-then-upgrade pattern used for grenades/skybox elsewhere).
const _eventCratePlanetMesh = new THREE.Group();
_eventCratePlanetMesh.visible = false;

const _floatingCrateMesh = new THREE.Group();
_floatingCrateMesh.visible = false;
scene.add(_floatingCrateMesh);

let _eventCrateTemplate = null;
function _populateCrateMesh(group, size) {
  while (group.children.length) group.remove(group.children[0]);
  if (_eventCrateTemplate) {
    const clone = _eventCrateTemplate.clone(true);
    clone.scale.setScalar(1); // loadModel() already baked its own targetSize scale into the template;
    // reset to 1 first so the box below measures the raw geometry, not that inherited scale.
    const box = new THREE.Box3().setFromObject(clone);
    const scale = size / Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z, 1e-5);
    clone.scale.setScalar(scale);
    const box2 = new THREE.Box3().setFromObject(clone);
    clone.position.y -= box2.min.y; // sit flush on the ground instead of centered on it
    group.add(clone);
  } else {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size, size, size),
      new THREE.MeshStandardMaterial({ color: 0xffcc44, roughness: 0.5, emissive: 0x664400, emissiveIntensity: 0.6 })
    );
    mesh.position.y = size / 2;
    group.add(mesh);
  }
}
_populateCrateMesh(_eventCratePlanetMesh, 40);
_populateCrateMesh(_floatingCrateMesh, 55);
loadModel('assets/crate_03.glb', 8, model => {
  if (!model) return;
  model.traverse(c => {
    if (c.isMesh && c.material) {
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach(m => { if (m.emissive !== undefined) { m.emissive = new THREE.Color(0x664400); m.emissiveIntensity = 0.5; } });
    }
  });
  _eventCrateTemplate = model;
  _populateCrateMesh(_eventCratePlanetMesh, 40);
  _populateCrateMesh(_floatingCrateMesh, 55);
});

// Shows/hides/positions the on-planet crate mesh for whatever planet the player is
// CURRENTLY standing on — called both right after a fresh spawn and every time a landing
// completes, since the crate's target planet might not be the one just landed on.
const _crateGroundRaycaster = new THREE.Raycaster();
function _syncEventCratePlanetMesh() {
  if (!_eventCrateState || _eventCrateState.status !== 'planet') { _eventCratePlanetMesh.visible = false; return; }
  if (gameMode !== 'planet_surface' || _surfCurrentPlanet !== planets[_eventCrateState.planetIndex]) {
    _eventCratePlanetMesh.visible = false;
    return;
  }
  const groundMesh = _surfTerrainMesh || _surfGround;
  // The server picks localX/localZ in a fixed +-300 range with no idea how big any given
  // planet's actual terrain mesh is — some terrain GLBs have a real footprint smaller than
  // that (halfX/halfZ computed from the model's own bbox), so an unclamped spawn can land
  // past the mesh's edge, miss the ground raycast entirely, and fall back to a floating,
  // unreachable position. Clamp into the real walkable bounds (with margin) first.
  const _margin = 40;
  const localX = Math.max(-_surfTerrainHalfX + _margin, Math.min(_surfTerrainHalfX - _margin, _eventCrateState.localX));
  const localZ = Math.max(-_surfTerrainHalfZ + _margin, Math.min(_surfTerrainHalfZ - _margin, _eventCrateState.localZ));
  _crateGroundRaycaster.set(new THREE.Vector3(localX, 3000, localZ), new THREE.Vector3(0, -1, 0));
  const hits = _crateGroundRaycaster.intersectObject(groundMesh, true);
  const groundY = hits.length > 0 ? hits[0].point.y : 0;
  _eventCratePlanetMesh.position.set(localX, groundY + 3, localZ);
  _eventCratePlanetMesh.quaternion.identity();
  if (_eventCratePlanetMesh.parent !== _planetSurfScene) {
    if (_eventCratePlanetMesh.parent) _eventCratePlanetMesh.parent.remove(_eventCratePlanetMesh);
    _planetSurfScene.add(_eventCratePlanetMesh);
  }
  _eventCratePlanetMesh.visible = true;
}

function _onEventCrateSpawned(data) {
  _eventCrateState = data;
  _iAmCarryingCrate = false;
  _floatingCrateMesh.visible = false;
  _syncEventCratePlanetMesh();
  const planetName = (typeof planets !== 'undefined' && planets[data.planetIndex] && planets[data.planetIndex].userData.mapName) || 'a nearby planet';
  if (window._chatAddMsg) window._chatAddMsg('📦 SERVER', `A crate has landed on ${planetName}! Get there and grab it before someone else does.`, false);
}

function _onEventCratePickedUp(data) {
  _eventCrateState = { status: 'carried', holderId: data.holderId, holderName: data.holderName };
  _iAmCarryingCrate = !!(self && data.holderId === self.id);
  _eventCratePlanetMesh.visible = false;
  _floatingCrateMesh.visible = false;
}

function _onEventCrateDropped(data) {
  _eventCrateState = { status: 'floating', position: data.position };
  _iAmCarryingCrate = false;
  _eventCratePlanetMesh.visible = false;
  _floatingCrateMesh.position.set(data.position.x, data.position.y, data.position.z);
  _floatingCrateMesh.visible = true;
}

function _onEventCrateDelivered() {
  _eventCrateState = null;
  _iAmCarryingCrate = false;
  _eventCratePlanetMesh.visible = false;
  _floatingCrateMesh.visible = false;
  // Covers selling at a trading station too (same event fires either way) — hide the
  // sell row immediately instead of leaving a stale "SELL" button up with nothing to sell.
  const sellRow = document.getElementById('shop-sell-crate-row');
  if (sellRow) sellRow.style.display = 'none';
}

// Slow tumble so both crate representations read as physical objects, not static props.
function _updateEventCrateVisuals() {
  if (_eventCratePlanetMesh.visible) _eventCratePlanetMesh.rotation.y += 0.004;
  if (_floatingCrateMesh.visible) { _floatingCrateMesh.rotation.x += 0.004; _floatingCrateMesh.rotation.y += 0.006; }
}

// Picking up the crate works from two different states: sitting on a planet (on foot, in
// planet_walk mode, right on the planet it landed on) or floating loose in space (flying
// or freshly ejected). Both funnel into the same 'collect_crate' server event.
const _cratePrompt = document.createElement('div');
_cratePrompt.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#fc6;font-family:monospace;font-size:15px;letter-spacing:2px;text-shadow:0 0 8px #000;pointer-events:none;display:none;z-index:30;';
_cratePrompt.textContent = '[ E ]  PICK UP CRATE';
document.body.appendChild(_cratePrompt);

function _crateCollectCheck() {
  if (!_eventCrateState) return null;
  if (_eventCrateState.status === 'planet' && gameMode === 'planet_surface'
      && _surfCurrentPlanet === planets[_eventCrateState.planetIndex] && _eventCratePlanetMesh.visible) {
    if (camera.position.distanceTo(_eventCratePlanetMesh.position) < PLANET_CRATE_PICKUP_RADIUS) {
      return { x: camera.position.x, y: camera.position.y, z: camera.position.z };
    }
  } else if (_eventCrateState.status === 'floating' && (gameMode === 'flight' || gameMode === 'ejected')) {
    const myPos = gameMode === 'ejected' ? ejectPos : selfMesh.position;
    if (myPos.distanceTo(_floatingCrateMesh.position) < CRATE_PICKUP_RADIUS) {
      return { x: myPos.x, y: myPos.y, z: myPos.z };
    }
  }
  return null;
}

function _updateCrateCollection() {
  _cratePrompt.style.display = _crateCollectCheck() ? 'block' : 'none';
}

document.addEventListener('keydown', e => {
  if (e.key !== 'e' && e.key !== 'E') return;
  const pos = _crateCollectCheck();
  if (pos) socket.emit('collect_crate', { position: pos });
});

// ── Trading stations ─────────────────────────────────────────────────────────
// Independent shop access points scattered out near the edges of the explorable area —
// gives flying way out there its own reason beyond just reaching a particular planet.
// Docking with one just opens the same shop panel directly (no hangar interior/customize
// tabs like the home station has — these are remote outposts, not your own hangar).
const TRADING_STATION_DOCK_RADIUS = 500;
const TRADING_STATION_POSITIONS = [
  new THREE.Vector3(78000, 4000, -20000),
  new THREE.Vector3(-72000, -6000, 30000),
  new THREE.Vector3(15000, 8000, 82000),
  new THREE.Vector3(-30000, -9000, -80000),
];
const _tradingStations = [];
let _tradingStationTemplate = null;
loadModel('assets/space_station_v_2001_a_space_odyssey.glb', 900, model => {
  if (!model) return;
  _tradingStationTemplate = model;
  TRADING_STATION_POSITIONS.forEach((pos, i) => {
    const clone = model.clone(true);
    clone.position.copy(pos);
    clone.userData.mapSelected = false; // only shown in-world once marked on the galaxy map (or while carrying the crate)
    clone.userData.mapName = `Trade Station ${i + 1}`;
    scene.add(clone);
    _tradingStations.push(clone);
  });
});

const _tradeStationPrompt = document.createElement('div');
_tradeStationPrompt.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);color:#0ff;font-family:monospace;font-size:15px;letter-spacing:3px;text-shadow:0 0 10px #0ff;pointer-events:none;display:none;z-index:30;';
_tradeStationPrompt.textContent = '[ E ]  TRADE';
document.body.appendChild(_tradeStationPrompt);
let _nearestTradingStation = null;

function _updateTradingStations() {
  if (gameMode !== 'flight' || _tradingStations.length === 0) {
    _tradeStationPrompt.style.display = 'none';
    _nearestTradingStation = null;
    return;
  }
  _tradingStations.forEach(s => { s.rotation.y += 0.0006; }); // slow tumble, reads as a real structure
  let nearest = null, nearestDist = Infinity;
  _tradingStations.forEach(s => {
    const d = selfMesh.position.distanceTo(s.position);
    if (d < nearestDist) { nearestDist = d; nearest = s; }
  });
  _nearestTradingStation = nearestDist < TRADING_STATION_DOCK_RADIUS ? nearest : null;
  _tradeStationPrompt.style.display = _nearestTradingStation ? 'block' : 'none';
}

// Trading-station interior — a real walkable FP space (same underlying updateFP()
// controller the room/lobby/range use), not just a static camera + shop overlay like the
// home hangar. A fixed "shop counter" spot opens the shop panel on E, and walking back
// near the entrance and pressing E leaves the station.
// A genuine standalone THREE.Scene (like tdmScene/shootingRangeScene), not just a Group
// hanging off the shared main `scene` — the club-house interior model sits near world
// origin, the same coordinate range as the home station hub and other ships, so rendering
// it as part of the main scene let that unrelated geometry clip straight through its walls.
// Rendering this scene exclusively in the trade_station branch below avoids that entirely.
const _tradeStationScene = new THREE.Scene();
_tradeStationScene.visible = false;
const _tradeStationAmbient = new THREE.AmbientLight(0xffddbb, 0);
_tradeStationScene.add(_tradeStationAmbient);
const _tradeStationLight = new THREE.PointLight(0xffaa66, 0, 800);
_tradeStationLight.position.set(0, 40, 20);
_tradeStationScene.add(_tradeStationLight);
let _tradeStationInteriorReady = false;
loadModel('assets/space_smugglers_club_house_-_dark_version.glb', 300, model => {
  if (!model) return;
  model.traverse(c => { if (c.isMesh) _tradeStationCollidables.push(c); });
  _tradeStationScene.add(model);
  _tradeStationBBox = new THREE.Box3().setFromObject(model);
  // Floor height + a walkable spawn point. Raycasting straight down from the model's XZ
  // CENTER turned out to land in an open void (an atrium/stairwell with no floor directly
  // beneath it), silently falling through to a "no hit" fallback based on the building's
  // lowest point overall (basement level) rather than the real floor anywhere walkable —
  // that's what was putting the camera almost at ground level. Raycast at the actual
  // spawn point instead (measured to have ~35 units of headroom above it), and use a
  // proper eye-height offset instead of the flat +2 tuned for a completely different,
  // much smaller room model.
  const _tsCenter = _tradeStationBBox.getCenter(new THREE.Vector3());
  const _tsEyeHeight = 18; // ~35 units of headroom measured at spawn, raised further per feedback
  function _tsFloorAt(x, z) {
    const rc = new THREE.Raycaster(new THREE.Vector3(x, _tradeStationBBox.max.y - 1, z), new THREE.Vector3(0, -1, 0));
    const hits = rc.intersectObjects(_tradeStationCollidables, false);
    return hits.length > 0 ? hits[0].point.y : _tradeStationBBox.min.y;
  }
  const _spawnX = _tsCenter.x, _spawnZ = _tradeStationBBox.max.z - 15;
  const _spawnFloorY = _tsFloorAt(_spawnX, _spawnZ);
  _tradeStationSpawn.set(_spawnX, _spawnFloorY + _tsEyeHeight, _spawnZ);
  _tradeStationFloorY = _spawnFloorY + _tsEyeHeight; // used as the flat _fpFloor for the whole interior
  _tradeStationShopPos.set(_tsCenter.x, _tradeStationFloorY, _tsCenter.z);
  _tradeStationInteriorReady = true;
});

const _tradeShopPrompt = document.createElement('div');
_tradeShopPrompt.style.cssText = 'position:fixed;bottom:150px;left:50%;transform:translateX(-50%);color:#0ff;font-family:monospace;font-size:15px;letter-spacing:3px;text-shadow:0 0 10px #0ff;pointer-events:none;display:none;z-index:30;';
_tradeShopPrompt.textContent = '[ E ]  TRADE';
document.body.appendChild(_tradeShopPrompt);
const _tradeExitPrompt = document.createElement('div');
_tradeExitPrompt.style.cssText = 'position:fixed;bottom:150px;left:50%;transform:translateX(-50%);color:#0ff;font-family:monospace;font-size:15px;letter-spacing:3px;text-shadow:0 0 10px #0ff;pointer-events:none;display:none;z-index:30;';
_tradeExitPrompt.textContent = '[ E ]  LEAVE STATION';
document.body.appendChild(_tradeExitPrompt);

let _shopOpenedFromTradeStation = false;
function enterTradeStation() {
  gameMode = 'trade_station';
  _restoreSceneLights(); // reset from flight first, then kill, same order enterHangarFromFlight uses
  _killAllExteriorLights();
  interiorScene.visible = false;
  lobbyScene.visible = false;
  hangarScene.visible = false;
  _tradeStationScene.visible = true;
  _tradeStationAmbient.intensity = 1.0;
  _tradeStationLight.intensity = 1.3;
  _tradeStationPrompt.style.display = 'none';
  renderer.toneMappingExposure = 0.7;
  fpPos.copy(_tradeStationSpawn);
  fpVel.set(0, 0, 0);
  _fpJumpVel = 0;
  // fpFwd = (-sin(yaw), 0, -cos(yaw)) — yaw 0 faces -Z, which is toward the shop counter
  // at the model's center from the spawn point near the +Z edge.
  fpYaw = 0; fpPitch = 0;
  camera.quaternion.identity();
  camera.position.copy(fpPos);
  document.body.style.cursor = 'none';
  renderer.domElement.requestPointerLock();
}

function exitTradeStation() {
  gameMode = 'flight';
  _shopOpenedFromTradeStation = false;
  _tradeStationScene.visible = false;
  _tradeStationAmbient.intensity = 0;
  _tradeStationLight.intensity = 0;
  _tradeShopPrompt.style.display = 'none';
  _tradeExitPrompt.style.display = 'none';
  document.body.style.cursor = 'none';
  renderer.toneMappingExposure = 1.0;
  setTimeout(() => document.body.requestPointerLock(), 150);
}

// Exit-door prompt near the entrance; the shop itself is reachable from anywhere else
// inside — the interior's actual layout (hallways/doors) isn't guaranteed to have a clear
// straight path to any one fixed "counter" spot, so requiring you to reach one exact point
// deep in unexplored geometry risked making the shop unreachable depending on the route.
function _updateTradeStationInterior() {
  if (gameMode !== 'trade_station') { _tradeShopPrompt.style.display = 'none'; _tradeExitPrompt.style.display = 'none'; return; }
  const nearExit = fpPos.distanceTo(_tradeStationSpawn) < 20;
  _tradeExitPrompt.style.display = (nearExit && !shopOpen) ? 'block' : 'none';
  _tradeShopPrompt.style.display = (!nearExit && !shopOpen) ? 'block' : 'none';
}

document.addEventListener('keydown', e => {
  if (e.key !== 'e' && e.key !== 'E') return;
  if (_nearestTradingStation && gameMode === 'flight') { enterTradeStation(); return; }
  if (gameMode === 'trade_station' && !shopOpen) {
    if (fpPos.distanceTo(_tradeStationSpawn) < 20) { exitTradeStation(); return; }
    _shopOpenedFromTradeStation = true;
    openShop();
  }
});

let _mouseFireHeld = false;
document.addEventListener('mousedown', e => { if (e.button === 0) _mouseFireHeld = true; });
document.addEventListener('mouseup',   e => { if (e.button === 0) _mouseFireHeld = false; });
document.addEventListener('mousedown', e => {
  if (e.button === 2 && gameMode === 'flight' && pointerLocked) { e.preventDefault(); _fireMissile(); }
});
document.addEventListener('contextmenu', e => { if (gameMode === 'flight') e.preventDefault(); });

// ── Physics ───────────────────────────────────────────────────────────────────
const THRUST        = 0.4;
const BOOST_MULT    = 2.8;
const DRAG          = 0.94;
const BRAKE_DRAG    = 0.80;
const MAX_SPEED     = 12;
const MAX_BOOST     = 32;
const MOUSE_SENS    = 0.000035;
const TURN_DAMPING  = 0.85;
const ROLL_ACCEL    = 0.002;

// Engine warmup — throttle ramps from 0→1 slowly, cuts quickly
let engineThrottle = 0;
let boostThrottle  = 0;  // separate ramp for boost
let camShakeAmt    = 0;

// Angular velocity (gives smooth, momentum-based turning)
const angVel = new THREE.Vector3();

// Camera smoothing — separate object that lags behind ship
const camTarget  = new THREE.Object3D();
scene.add(camTarget);
selfMesh.remove(camera);         // detach from ship
scene.add(camera);               // put camera directly in scene
camera.position.copy(selfMesh.position).add(new THREE.Vector3(0, 8, 35));

const _fwd    = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camLook= new THREE.Vector3();
const _q      = new THREE.Quaternion();

function updateShip() {
  const boosting = keys['shift'];
  const braking  = keys[' '];

  // ── NMS-style reticle steering — steer toward reticle offset ────────────
  angVel.x += -reticleY * MOUSE_SENS;
  angVel.y += -reticleX * MOUSE_SENS;
  // Gradually re-center reticle when ship catches up
  reticleX *= 0.97;
  reticleY *= 0.97;

  // Roll from A/D, Q/E
  if (keys['a'] || keys['q']) angVel.z += ROLL_ACCEL;
  if (keys['d'] || keys['e']) angVel.z -= ROLL_ACCEL;

  // Clamp angular velocity so it doesn't spin out of control
  angVel.clampLength(0, 0.08);
  angVel.multiplyScalar(TURN_DAMPING);

  // Apply rotation in ship's local space
  selfMesh.rotateX(angVel.x);
  selfMesh.rotateY(angVel.y);
  selfMesh.rotateZ(angVel.z);

  // ── Linear thrust ────────────────────────────────────────────────────────
  _fwd.set(0, 0, -1).applyQuaternion(selfMesh.quaternion);

  // Engine warmup: very gradual ramp-up, quick cut
  if (keys['w'] || keys['s']) {
    engineThrottle = Math.min(1, engineThrottle + 0.006);
  } else {
    engineThrottle = Math.max(0, engineThrottle - 0.04);
  }
  // Boost ramps even more slowly — like a second-stage engine spooling up
  if (boosting && keys['w']) {
    boostThrottle = Math.min(1, boostThrottle + 0.004);
  } else {
    boostThrottle = Math.max(0, boostThrottle - 0.03);
  }
  const _devSpeedMul = window._adminMode ? 5 : 1;
  const basePower  = THRUST * engineThrottle * _devSpeedMul;
  const boostExtra = THRUST * (BOOST_MULT - 1) * boostThrottle * _devSpeedMul;
  const thrustPower = basePower + boostExtra;
  if (keys['w']) self.velocity.addScaledVector(_fwd,  thrustPower);
  if (keys['s']) self.velocity.addScaledVector(_fwd, -basePower * 0.5);

  // Drag / brake (safe zone always applies full brake)
  const drag = (braking || self.inSafeZone) ? BRAKE_DRAG : DRAG;
  self.velocity.multiplyScalar(drag);

  // Speed cap (higher when boosting) — 5x in dev/admin mode
  const cap = (boosting ? MAX_BOOST : MAX_SPEED) * _devSpeedMul;
  if (self.velocity.length() > cap) self.velocity.setLength(cap);

  selfMesh.position.add(self.velocity);

  // ── Station collision ─────────────────────────────────────────────────────
  const STATION_RADIUS = 320;
  const toStation = selfMesh.position.clone().sub(station.position);
  const stationDist = toStation.length();
  if (stationDist < STATION_RADIUS) {
    // Push ship back to surface and reflect velocity
    selfMesh.position.copy(station.position).addScaledVector(toStation.normalize(), STATION_RADIUS);
    const normal = toStation; // already normalized
    const dot = self.velocity.dot(normal);
    self.velocity.addScaledVector(normal, -dot * 1.6); // bounce with slight damping
    self.velocity.multiplyScalar(0.4);
  }

  // Planet collisions + gravity dampening
  _nearPlanet = null;
  for (const planet of planets) {
    const r = planet.userData.collisionRadius;
    if (!r) continue;
    const toPlanet = selfMesh.position.clone().sub(planet.position);
    const dist = toPlanet.length();
    // Collision bounce
    if (dist < r) {
      toPlanet.normalize();
      selfMesh.position.copy(planet.position).addScaledVector(toPlanet, r);
      const dot = self.velocity.dot(toPlanet);
      self.velocity.addScaledVector(toPlanet, -dot * 1.6);
      self.velocity.multiplyScalar(0.4);
    }
    // Landing approach zone — 1.6x collision radius
    const landZone = r * 1.6;
    if (dist < landZone) {
      // Gravity drag: scales from 0 at edge to heavy at surface
      const gravT = 1 - (dist - r) / (landZone - r); // 0→1 as you approach
      const gravDrag = 1 - gravT * 0.94; // max ~6% speed per frame at closest
      self.velocity.multiplyScalar(gravDrag);
      _nearPlanet = planet;
    }
  }
  landPrompt.style.display = _nearPlanet ? 'block' : 'none';

  self.position.copy(selfMesh.position);

  // ── Engine glow scales with speed ────────────────────────────────────────
  const speedRatio = self.velocity.length() / MAX_SPEED;
  const t = engineThrottle;                         // 0→1 as engine warms
  const engLight = selfMesh.userData.engineLight;
  if (engLight) {
    const targetIntensity = t * (boosting ? 6 + boostThrottle * 10 : 1.5 + speedRatio * 5);
    engLight.intensity += (targetIntensity - engLight.intensity) * 0.04;
    engLight.color.setRGB(1, 0.3 + speedRatio * 0.35, 0);
  }

  // ── Smooth follow camera ─────────────────────────────────────────────────
  const camDist = 38;
  if (_cockpitView) {
    _camPos.copy(COCKPIT_CAM_POS).applyQuaternion(selfMesh.quaternion).add(selfMesh.position);
  } else {
    _camPos.set(0, 10, camDist).applyQuaternion(selfMesh.quaternion).add(selfMesh.position);
  }

  // Camera shake scales with boost throttle — cut way down in cockpit view, where the
  // camera sits rigidly inside a fixed interior mesh and any shake reads as much more
  // jarring/disorienting than the same jitter does on the normal exterior chase cam.
  camShakeAmt = boostThrottle * 3.5 * (_cockpitView ? 0.002 : 1);
  if (camShakeAmt > 0.01) {
    _camPos.x += (Math.random() - 0.5) * camShakeAmt;
    _camPos.y += (Math.random() - 0.5) * camShakeAmt;
    _camPos.z += (Math.random() - 0.5) * camShakeAmt * 0.6;
  }

  // Cockpit view is rigidly mounted (no lag) — chasing a lerp/slerp target while sitting
  // inside the cockpit mesh would make the interior visibly swim relative to the camera.
  if (_cockpitView) {
    camera.position.copy(_camPos);
    // Facing (not position) matches the ship's actual travel direction here, same
    // convention as the normal chase cam below — if the view feels backward, it's the
    // cockpit model's own authored orientation that's flipped, not this. The extra pitch
    // multiply tilts the view up so the cockpit's own dashboard/floor stays out of frame.
    camera.quaternion.copy(selfMesh.quaternion).multiply(COCKPIT_CAM_PITCH_UP);
    return;
  }
  camera.position.lerp(_camPos, 0.1);

  // Slerp camera rotation toward ship — avoids lookAt flipping upside down
  camera.quaternion.slerp(selfMesh.quaternion, 0.08);
}

// ── HUD ───────────────────────────────────────────────────────────────────────
const elPos    = document.getElementById('pos');
const elSpeed  = document.getElementById('speed');
const elZone   = document.getElementById('zone-indicator');
const elPcount = document.getElementById('pcount');
const elName   = document.getElementById('pilot-name');
const elHud    = document.getElementById('hud');
const elControls = document.getElementById('controls');

function updateHUD() {
  // HUD shake mirrors camera shake
  if (camShakeAmt > 0.05) {
    const sx = (Math.random() - 0.5) * camShakeAmt * 1.8;
    const sy = (Math.random() - 0.5) * camShakeAmt * 1.8;
    elHud.style.transform = `translate(${sx}px, ${sy}px)`;
  } else {
    elHud.style.transform = '';
  }

  const p = self.position;
  elPos.textContent  = `${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}`;
  elSpeed.textContent = self.velocity.length().toFixed(2);
  const dist = p.length();
  const inZone = dist < safeZoneRadius;
  const nearEdge = inZone && dist > safeZoneRadius * 0.9;
  self.inSafeZone = inZone;
  if (!inZone) {
    elZone.textContent = '⚠ PVP ZONE';
    elZone.className = 'pvp';
  } else if (nearEdge) {
    elZone.textContent = '⚠ CAUTION — LEAVING SAFE ZONE, PVP ENABLED';
    elZone.className = 'caution';
  } else {
    elZone.textContent = 'SAFE ZONE';
    elZone.className = 'safe';
  }
  elPcount.textContent = 1 + Object.keys(remotePlayers).length;
  elName.textContent = self.name;

}

// ── Chat ──────────────────────────────────────────────────────────────────────
(function() {
  const log       = document.getElementById('chat-log');
  const inputRow  = document.getElementById('chat-input-row');
  const input     = document.getElementById('chat-input');
  const sendBtn   = document.getElementById('chat-send');
  const hint      = document.getElementById('chat-hint');
  let chatOpen    = false;
  window._chatOpen = () => chatOpen;
  const fadeDelay     = 7000;  // ms before a message fades out normally
  const fadeDelayOpen = 25000; // ms while the chat bar is actively open — you're reading it, give it longer
  const _activeMsgTimers = []; // { el, t } for every message not yet removed

  function _scheduleFade(el) {
    const t = setTimeout(() => el.classList.add('fading'), chatOpen ? fadeDelayOpen : fadeDelay);
    _activeMsgTimers.push({ el, t });
  }

  function addMsg(name, text, isOwn) {
    const el = document.createElement('div');
    el.className = 'chat-msg';
    el.innerHTML = `<span class="chat-name">${name}:</span>${text}`;
    if (isOwn) el.style.borderLeft = '2px solid #0ff4';
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    _scheduleFade(el);
    el.addEventListener('transitionend', () => {
      el.remove();
      const idx = _activeMsgTimers.findIndex(x => x.el === el);
      if (idx !== -1) _activeMsgTimers.splice(idx, 1);
    });
    // Hovering the log resets fade
    log.addEventListener('mouseenter', () => {
      const entry = _activeMsgTimers.find(x => x.el === el);
      if (entry) clearTimeout(entry.t);
      el.classList.remove('fading');
    }, { once: true });
  }

  function openChat() {
    if (chatOpen) return;
    chatOpen = true;
    inputRow.classList.add('open');
    hint.style.display = 'none';
    document.exitPointerLock();
    setTimeout(() => input.focus(), 20);
    // Give every message currently on screen a fresh, longer countdown now that the bar
    // is open — otherwise a message that arrived just before you opened chat could still
    // fade out on its original short timer while you're actively reading it.
    _activeMsgTimers.forEach(entry => {
      clearTimeout(entry.t);
      entry.el.classList.remove('fading');
      entry.t = setTimeout(() => entry.el.classList.add('fading'), fadeDelayOpen);
    });
  }

  function closeChat() {
    chatOpen = false;
    inputRow.classList.remove('open');
    hint.style.display = '';
    input.value = '';
    setTimeout(() => document.body.requestPointerLock(), 100);
    // Back to the normal (shorter) fade timing for whatever's still visible.
    _activeMsgTimers.forEach(entry => {
      clearTimeout(entry.t);
      entry.t = setTimeout(() => entry.el.classList.add('fading'), fadeDelay);
    });
  }

  function sendMsg() {
    const text = input.value.trim();
    if (!text) { closeChat(); return; }
    // Admin command — never sent to server
    if (text === '/676741') {
      window._adminMode = !window._adminMode;
      addMsg('SYSTEM', window._adminMode ? '⚡ ADMIN MODE ON — fly+noclip enabled' : '⚡ ADMIN MODE OFF', false);
      closeChat();
      return;
    }
    // Third-person toggle — never sent to server
    if (text === '/qwertyuiop') {
      window._thirdPerson = !window._thirdPerson;
      addMsg('SYSTEM', window._thirdPerson ? '🎥 THIRD PERSON ON' : '🎥 THIRD PERSON OFF', false);
      closeChat();
      return;
    }
    // Debug cheat — grants credits server-side (server owns the real balance) and never
    // shows up as a real chat message.
    if (text === '/money') {
      if (socket) socket.emit('debug_add_credits');
      window._freeWeapons = true; // also drop every weapon's price so the shop's fully testable
      if (typeof _updateShopAffordability === 'function') _updateShopAffordability();
      addMsg('SYSTEM', '💰 +100,000,000 CR — all weapons unlocked free', false);
      closeChat();
      return;
    }
    // Debug teleport straight into a trading station's interior — never sent to server
    if (text === '/kettle') {
      if (typeof enterTradeStation === 'function') {
        if (gameMode !== 'flight') gameMode = 'flight'; // enterTradeStation only makes sense coming from flight
        enterTradeStation();
        addMsg('SYSTEM', '🏚️ Teleported into the trading station', false);
      }
      closeChat();
      return;
    }
    const name = self.name || 'You';
    addMsg(name, text, true);
    if (socket) socket.emit('chat', { name, text });
    closeChat();
  }

  sendBtn.addEventListener('click', sendMsg);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendMsg(); }
    if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
    e.stopPropagation();
  });
  input.addEventListener('keyup', e => e.stopPropagation());

  // T to open chat (when pointer is locked / in game)
  document.addEventListener('keydown', e => {
    if ((e.key === 't' || e.key === 'T') && !chatOpen && pointerLocked) {
      e.preventDefault();
      openChat();
    }
  });

  // Receive messages from other players
  window._chatAddMsg = addMsg;
})();

// ── Socket events ─────────────────────────────────────────────────────────────
if (socket) {
  socket.on('init', (data) => {
    self.id   = data.self.id;
    self.name = data.self.name;
    safeZoneRadius = data.safeZoneRadius;
    selfMesh.position.set(data.self.position.x, data.self.position.y, data.self.position.z);
    self.position.copy(selfMesh.position);
    self.health = typeof data.self.health === 'number' ? data.self.health : 100;
    _updateHealthHUD();
    self.credits = typeof data.self.credits === 'number' ? data.self.credits : 0;
    _updateCreditsHUD();
    // Resuming into whatever state the event crate is already in (a newly-connecting
    // player might join mid-event) — dispatch to whichever handler matches its status
    // rather than re-announcing it as a fresh spawn.
    if (data.eventCrate) {
      const ec = data.eventCrate;
      if (ec.status === 'planet') { _eventCrateState = ec; _syncEventCratePlanetMesh(); }
      else if (ec.status === 'carried') _onEventCratePickedUp(ec);
      else if (ec.status === 'floating') _onEventCrateDropped(ec);
    }
    data.players.forEach(addRemotePlayer);
  });
  socket.on('took_damage', ({ health }) => {
    self.health = health;
    _updateHealthHUD();
    _flashDamageVignette();
  });
  socket.on('credits_update', ({ credits, reward, reason, kind }) => {
    self.credits = credits;
    _updateCreditsHUD();
    if (reward) _popCreditsReward(reward, reason);
    _updateShopAffordability();
    if (reason === 'kill') {
      _bountyProgress.kills++;
      if (kind === 'ship') _bountyProgress.shipKills++;
      if (bountiesOpen) _renderBounties();
    }
    // reason==='crate' only ever arrives via io.to(socket.id) — i.e. this fires just for
    // whoever actually collected it, unlike the broadcast 'crate_collected' event below
    // (sent to everyone, purely so all clients hide the now-gone crate mesh).
    if (reason === 'crate') {
      _bountyProgress.crates++;
      if (bountiesOpen) _renderBounties();
    }
  });
  // Pickup/drop/delivery chat announcements are sent by the server directly (as regular
  // 'chat' messages) since it already knows the player's name at that point — these
  // handlers only need to update the local state/meshes, not duplicate that text.
  socket.on('event_crate_spawned', (data) => _onEventCrateSpawned(data));
  socket.on('event_crate_picked_up', (data) => _onEventCratePickedUp(data));
  socket.on('event_crate_dropped', (data) => _onEventCrateDropped(data));
  socket.on('event_crate_delivered', () => _onEventCrateDelivered());
  socket.on('you_died', () => {
    if (gameMode === 'tdm') {
      // Server already reset health to 100 server-side before sending this, but the
      // 'took_damage' just before it carried the damaged (possibly 0) value — apply the
      // healed value locally. Actual respawn positioning happens via 'tdm_kill' below,
      // which fires for both the killer and victim at once.
      self.health = 100;
      _updateHealthHUD();
      return;
    }
    if (gameMode === 'flight') {
      // Ship destroyed in combat — explode and eject into space (reusing the same
      // free-float 'ejected' mode as manually pressing J) instead of yanking the player
      // back to their room and wiping their inventory, which only makes sense for the
      // FP-combat death flow below.
      self.health = 100;
      _updateHealthHUD();
      if (window._chatAddMsg) window._chatAddMsg('🛸 SERVER', 'Your ship was destroyed!', false);
      _spawnBigShipExplosion(selfMesh.position.clone());
      ejectFromShip();
      // ejectFromShip() reuses the ship mesh as the thing you can reboard (the normal
      // J-eject flow just leaves an intact ship floating where you left it) — but this
      // ship just exploded, so leaving it intact right under the player made it look
      // like the wreck had simply teleported back instead of being destroyed. Move the
      // (now-replacement) ship to wait at the station instead — ejectPos was already
      // captured above at the explosion site, so the player still floats there; only
      // the ship itself relocates.
      selfMesh.position.copy(station.position).addScaledVector(new THREE.Vector3(0, 0, 1), 320);
      self.velocity.set(0, 0, 0);
      return;
    }
    if (window._chatAddMsg) window._chatAddMsg('🛸 SERVER', 'You died — respawning in your room', false);
    _respawnInRoom();
  });
  socket.on('tdm_kill', ({ killerId, victimId }) => {
    if (self.id === killerId || self.id === victimId) {
      if (gameMode === 'tdm') _tdmRespawnAtTeamSpawn();
    }
  });
  socket.on('tdm_match_end', ({ stats }) => {
    _showTDMMatchEnd(stats);
  });
  socket.on('player_joined', data => {
    addRemotePlayer(data);
    if (window._chatAddMsg) window._chatAddMsg('🛸 SERVER', `${data.name} joined the game`, false);
  });
  socket.on('chat', ({ name, text }) => {
    if (window._chatAddMsg) window._chatAddMsg(name, text, false);
  });
  socket.on('player_left', id => {
    const rp = remotePlayers[id];
    const leaveName = rp ? (rp.data && rp.data.name) : null;
    removeRemotePlayer(id);
    if (leaveName && window._chatAddMsg) window._chatAddMsg('🛸 SERVER', `${leaveName} left the game`, false);
  });
  // Server-authoritative TDM countdown — see server/index.js. Every client gets the same
  // endsAt timestamp and the same 'tdm_go' event at the same time, so everyone actually
  // teleports together instead of each client racing its own local timer.
  socket.on('tdm_countdown_start', ({ endsAt }) => { _tdmServerEndsAt = endsAt; _loadTDMMap(); });
  socket.on('tdm_countdown_cancel', () => { _tdmServerEndsAt = null; });
  socket.on('tdm_go', ({ participants }) => {
    _tdmServerEndsAt = null;
    // 'tdm_go' is broadcast to every connected client, not just the ones who were in the
    // zone — only actually start the intro for players who were among the participants
    // the server counted, so someone docked/shopping elsewhere doesn't get yanked in.
    if (Array.isArray(participants) && participants.length > 0 && participants.includes(self.id)) {
      _startTDMIntro(participants);
    }
  });
  socket.on('world_state', (players) => {
    players.forEach(p => {
      if (p.id === self.id) return;
      if (!remotePlayers[p.id]) addRemotePlayer(p);
      const rp = remotePlayers[p.id];
      rp.mesh.position.set(p.position.x, p.position.y, p.position.z);
      rp.mesh.rotation.set(p.rotation.x, p.rotation.y, p.rotation.z);
      _updateRemoteFPMeshes(p);
    });
  });

  setInterval(() => {
    if (!self.id) return;
    const inFP = gameMode === 'lobby' || gameMode === 'docked' || gameMode === 'range' || gameMode === 'planet_walk' || gameMode === 'planet_surface' || gameMode === 'ejected' || gameMode === 'tdm';
    const _fpBroadcastPos = (gameMode === 'planet_walk' || gameMode === 'ejected')
      ? { x: camera.position.x, y: camera.position.y, z: camera.position.z }
      : gameMode === 'planet_surface'
      ? { x: _surfPos.x, y: _surfPos.y, z: _surfPos.z }
      : { x: fpPos.x, y: fpPos.y, z: fpPos.z };
    const _fpBroadcastYaw = gameMode === 'planet_walk' ? _pwYaw : gameMode === 'planet_surface' ? _surfYaw : fpYaw;
    // Movement state for other clients to animate this player's procedural avatar with —
    // real speed/jump/slide, not just position deltas, which would lag a frame behind and
    // couldn't distinguish "airborne" from "walking on a ledge" at all.
    const _fpAnimSpeed = gameMode === 'planet_surface' ? _surfVel.length() / SURF_SPRINT
      : (gameMode === 'lobby' || gameMode === 'docked' || gameMode === 'range' || gameMode === 'tdm') ? fpVel.length() / (FP_SPEED * FP_SPRINT_MUL)
      : 0;
    const _fpAnim = {
      speed: Math.max(0, Math.min(1, _fpAnimSpeed)),
      jumping: gameMode === 'planet_surface' ? _surfVertVel !== 0 : _fpJumpVel !== 0,
      sliding: _slideTimer > 0,
      crouch: _crouchAmount,
    };
    socket.emit('player_update', {
      position: { x: self.position.x, y: self.position.y, z: self.position.z },
      rotation: { x: selfMesh.rotation.x, y: selfMesh.rotation.y, z: selfMesh.rotation.z },
      velocity: { x: self.velocity.x, y: self.velocity.y, z: self.velocity.z },
      fpMode: inFP ? gameMode : null,
      fpPos:  inFP ? _fpBroadcastPos : null,
      fpYaw:  inFP ? _fpBroadcastYaw : null,
      fpAnim: inFP ? _fpAnim : null,
      equippedWeaponId: inFP ? _equippedWeaponId : null,
    });
  }, 50);
}

// ── Main loop ─────────────────────────────────────────────────────────────────
function animate(t) {
  requestAnimationFrame(animate);
  _updateHealthRegen();
  // Ship flight-control legend only makes sense while actually piloting the ship.
  elControls.style.display = gameMode === 'flight' ? 'block' : 'none';
  if (gameMode === 'docked' || gameMode === 'lobby' || gameMode === 'range' || gameMode === 'tdm' || gameMode === 'trade_station') {
    updateFP();
    elPos.textContent = window._adminMode
      ? `X:${fpPos.x.toFixed(1)} Y:${fpPos.y.toFixed(1)} Z:${fpPos.z.toFixed(1)} ⚡ADMIN`
      : `${fpPos.x.toFixed(1)}, ${fpPos.z.toFixed(1)} (fp)`;
  } else if (gameMode === 'tdm_intro') {
    _updateTDMIntro();
  } else if (gameMode === 'ejected') {
    updateEjected();
    updateAtmosphere();
    selfMesh.visible = true;
  } else if (gameMode === 'landing_anim') {
    updateLandingAnim();
    updateAtmosphere();
  } else if (gameMode === 'landed_ship') {
    updateLandedShip();
    updateAtmosphere();
  } else if (gameMode === 'takeoff_anim') {
    updateTakeoffAnim();
    updateAtmosphere();
  } else if (gameMode === 'planet_surface') {
    updateLandedShip();
    if (_surfLeaving) { _updateLeavePlanet(); } else { _updatePlanetSurface(); }
  } else if (gameMode === 'planet_walk') {
    updateLandedShip(); // keep ship glued to planet surface, not following player
    updatePlanetWalk();
    updateAtmosphere();
  } else if (gameMode === 'hangar') {
    // Docked at the home hangar's static interior view — nothing to simulate. Crucially,
    // this must NOT fall into the flight branch below: updateShip() unconditionally moves
    // the ship on WASD input and lerps the camera toward a chase-cam position every frame
    // regardless of pointer lock, which would fight the fixed interior camera framing.
  } else if (gameMode === 'ship_interior') {
    // Same reasoning as hangar above — updateShip() would fight the walk-around camera
    // (which is parented straight onto selfMesh rather than driven by its chase-cam lerp).
    _updateShipInteriorWalk();
  } else {
    updateShip();
    updateLasers();
    updateHUD();
    updateAtmosphere();
    const dockDist = selfMesh.position.distanceTo(station.position);
    dockPrompt.style.display = (gameMode === 'flight' && dockDist < 400) ? 'block' : 'none';
  }
  _updateSniperShots(); // always run — handles hand model + shots in all modes
  _updateGrenades(); // always run — thrown grenades keep arcing/ticking regardless of mode changes mid-flight
  _updateSmokeVision(); // always run — smoke cloud obstruction shouldn't stop just because gameMode changed
  _updateEventCrateVisuals(); // always run — tumble animation regardless of mode
  _updateCrateCollection(); // always run — E-to-collect prompt only actually shows in flight/ejected
  _updateTradingStations(); // always run — no-ops outside flight mode internally
  _updateTradeStationInterior(); // always run — no-ops outside trade_station mode internally
  if (_hangarShip) {
    _hangarShip.rotation.y = t * 0.0004;
    _hangarShip.position.y = 22 + Math.sin(t * 0.0008) * 3;
    _hangarShip.position.z = 78;
  }
  if (gameMode === 'docked' || gameMode === 'lobby' || gameMode === 'hangar') {
    station.visible = false;
    if (gameMode === 'hangar') {
      camera.position.set(0, 32, 20);
      camera.lookAt(_hangarCamTarget);
    }
    if (skyboxMesh) scene.background = null;
    if (window._setStarsVisible) window._setStarsVisible(false);
    planets.forEach(p => { p.visible = false; });
  } else if (gameMode === 'planet_walk' || gameMode === 'landing_anim' || gameMode === 'landed_ship' || gameMode === 'takeoff_anim') {
    planets.forEach((p, i) => {
      p.rotation.y = t * 0.001 * (0.2 + i * 0.05);
      p.visible = true; // always show the planet you're on/near
      p.children.forEach(c => {
        if (c.userData.spin) c.rotation.y = t * 0.002;
      });
    });
    station.rotation.y = t * 0.0001;
    if (skyboxMesh) scene.background = null;
  } else {
    planets.forEach((p, i) => {
      p.rotation.y = t * 0.001 * (0.2 + i * 0.05); p.visible = true;
      p.children.forEach(c => {
        if (c.userData.spin) c.rotation.y = t * 0.002;
      });
    });
    station.rotation.y = t * 0.0001;
    const targetOpacity = self.inSafeZone ? 1 : 0;
    stationOpacity += (targetOpacity - stationOpacity) * 0.03;
    station.traverse(c => { if (c.isMesh && c.material.transparent) c.material.opacity = stationOpacity; });
    station.visible = stationOpacity > 0.01;
    if (skyboxMesh) scene.background = _skyboxTex;
  }
  // ── Crate: held position + prompts ──────────────────────────────────────────
  const _camDir = new THREE.Vector3();
  camera.getWorldDirection(_camDir);
  if (_heldCrate) {
    const _right = new THREE.Vector3().crossVectors(_camDir, camera.up).normalize();
    const holdPos = camera.position.clone()
      .addScaledVector(_camDir, 4)
      .addScaledVector(_right, 1.5)
      .addScaledVector(camera.up, -1.5);
    _heldCrate.mesh.position.copy(holdPos);
    _heldCrate.mesh.quaternion.copy(camera.quaternion);
  }

  // Prompts
  _cratePromptEl.style.display = 'none';
  if (gameMode === 'planet_walk' || gameMode === 'docked') {
    if (_heldCrate) {
      if (gameMode === 'planet_walk' && _shipMarker) {
        const shipPos = new THREE.Vector3();
        _shipMarker.getWorldPosition(shipPos);
        if (camera.position.distanceTo(shipPos) < 40) {
          _cratePromptEl.textContent = '[E] Store crate in ship';
          _cratePromptEl.style.display = 'block';
        }
      }
    } else if (gameMode === 'planet_walk') {
      let nearestDist = 18, nearestCrate = null;
      _crateObjects.forEach(c => {
        if (c.held || c.stored) return;
        const wp = new THREE.Vector3();
        c.mesh.getWorldPosition(wp);
        const d = camera.position.distanceTo(wp);
        if (d < nearestDist) { nearestDist = d; nearestCrate = c; }
      });
      if (nearestCrate) {
        _cratePromptEl.textContent = '[E] Pick up crate';
        _cratePromptEl.style.display = 'block';
      }
    }
  }

  // Stars update every frame except when docked, in shooting range, or on a planet
  // surface — the surface scene renders separately and never shows the starfield,
  // so updating it there was pure wasted work hurting surface framerate.
  if (gameMode !== 'docked' && gameMode !== 'range' && gameMode !== 'tdm' && gameMode !== 'tdm_intro' && gameMode !== 'planet_surface' && gameMode !== 'trade_station' && window._updateStars) {
    if (window._setStarsVisible) window._setStarsVisible(true);
    const p = camera.position;
    window._updateStars(p.x, p.y, p.z, camera.quaternion);
  } else if (gameMode === 'planet_surface' && window._setStarsVisible) {
    window._setStarsVisible(false);
  }
  if (gameMode === 'range') {
    renderer.render(shootingRangeScene, camera);
  } else if (gameMode === 'tdm' || gameMode === 'tdm_intro') {
    renderer.render(tdmScene, camera);
  } else if (gameMode === 'planet_surface') {
    const _surfAtm = _surfCurrentPlanet && _surfCurrentPlanet.userData.atmosphere;
    renderer.setClearColor(_surfAtm ? _surfAtm.skyColor : 0x88bbff, 1);
    renderer.render(_planetSurfScene, camera);
    renderer.setClearColor(0x000000, 0);
  } else if (gameMode === 'trade_station') {
    renderer.render(_tradeStationScene, camera);
  } else {
    renderer.render(scene, camera);
  }
  // Second pass: render gun on top with fresh depth so it never clips into walls
  if (_sniperMesh && _sniperMesh.visible) {
    renderer.clearDepth();
    renderer.autoClear = false;
    renderer.render(_viewmodelScene, camera);
    renderer.autoClear = true;
  }
  drawReticle();
  _drawMinimap();
}
enterStation();

// ── Title screen — doubles as the initial loading screen ──────────────────────
// Replaces the old bare "ENTERING STATION" progress bar: shows the game's actual
// branding immediately, fills a progress bar while everything queued above finishes
// loading in the background, then swaps to a "click to enter" prompt once ready —
// the loading itself stays hidden behind a real title screen instead of a blank bar.
const _titleScreenEl = document.createElement('div');
_titleScreenEl.style.cssText = `
  position:fixed; inset:0; z-index:1000; display:flex; flex-direction:column;
  align-items:center; justify-content:center; text-align:center;
  background:radial-gradient(ellipse at center, #001428 0%, #000005 80%);
  font-family:'Courier New',monospace; color:#0ff; cursor:auto;
`;
_titleScreenEl.innerHTML = `
  <div style="font-size:clamp(26px, 8vw, 52px);letter-spacing:clamp(3px, 1.5vw, 10px);font-weight:bold;text-shadow:0 0 20px #0ff,0 0 40px #0af;padding:0 12px;">STARBOUND NEXUS</div>
  <div style="font-size:clamp(10px, 2.8vw, 14px);letter-spacing:2px;color:#7cf;margin-top:14px;padding:0 12px;">FREE MULTIPLAYER BROWSER SPACE GAME</div>
  <div id="title-loading-wrap" style="margin-top:60px;width:90vw;max-width:340px;">
    <div id="title-loading-label" style="font-size:13px;letter-spacing:4px;margin-bottom:14px;">LOADING</div>
    <div style="width:100%;height:10px;border:1px solid #0af;border-radius:5px;overflow:hidden;background:rgba(0,255,255,0.08);">
      <div id="title-loading-bar" style="width:0%;height:100%;background:#0ff;box-shadow:0 0 10px #0ff;transition:width 0.15s;"></div>
    </div>
  </div>
  <div id="title-username-wrap" style="display:none;margin-top:40px;width:90vw;max-width:300px;">
    <div style="font-size:12px;letter-spacing:2px;color:#7cf;margin-bottom:8px;">PILOT NAME</div>
    <input id="title-username-input" type="text" maxlength="20" placeholder="enter a username" style="width:100%;box-sizing:border-box;padding:9px 10px;background:rgba(0,20,30,0.8);border:1px solid #0af;border-radius:4px;color:#0ff;font-family:inherit;font-size:14px;text-align:center;letter-spacing:1px;">
  </div>
  <div id="title-play-prompt" style="display:none;margin-top:30px;font-size:clamp(14px, 3.5vw, 20px);letter-spacing:2px;border:2px solid #0ff;padding:16px 28px;border-radius:8px;background:rgba(0,255,255,0.08);text-shadow:0 0 10px #0ff;cursor:pointer;max-width:90vw;">
    CLICK ANYWHERE TO ENTER
  </div>
`;
document.body.appendChild(_titleScreenEl);
window._titleScreenEl = _titleScreenEl;
const _titleLoadingWrap  = _titleScreenEl.querySelector('#title-loading-wrap');
const _titleLoadingBar   = _titleScreenEl.querySelector('#title-loading-bar');
const _titlePlayPrompt   = _titleScreenEl.querySelector('#title-play-prompt');
const _titleUsernameWrap = _titleScreenEl.querySelector('#title-username-wrap');
const _titleUsernameInput = _titleScreenEl.querySelector('#title-username-input');

_titleUsernameInput.value = localStorage.getItem('sn_username') || '';
// Typing in the field shouldn't dismiss the title screen (that's bound to any click on
// the document) — only saves the name as you type, live.
_titleUsernameWrap.addEventListener('click', e => e.stopPropagation());
// The game's own global keydown handler (WASD movement) calls preventDefault() on every
// key so it doesn't leak into browser shortcuts — same reason the chat box needs this,
// otherwise every keystroke gets swallowed before it ever reaches the input.
_titleUsernameInput.addEventListener('keydown', e => e.stopPropagation());
_titleUsernameInput.addEventListener('keyup', e => e.stopPropagation());
_titleUsernameInput.addEventListener('input', () => {
  const name = _titleUsernameInput.value.trim().slice(0, 20);
  localStorage.setItem('sn_username', name);
  if (socket) socket.auth = { username: name }; // takes effect next (re)connect
  _updateRoomWelcomeScreen(name);
});

window._titleScreenReady = false;
(function pollTitleScreenLoad() {
  const startPending = _loadStats.pending;
  const startTime = Date.now();
  const TIMEOUT_MS = 60000; // safety net so a single stuck asset can't strand the title screen forever
  (function poll() {
    const finishedSinceShown = Math.max(startPending - _loadStats.pending, 0);
    const pct = startPending > 0 ? Math.min(99, Math.round((finishedSinceShown / startPending) * 100)) : 99;
    _titleLoadingBar.style.width = pct + '%';
    if (_loadStats.pending <= 0 || Date.now() - startTime > TIMEOUT_MS) {
      _titleLoadingBar.style.width = '100%';
      _titleLoadingWrap.style.display = 'none';
      _titleUsernameWrap.style.display = 'block';
      _titlePlayPrompt.style.display = 'block';
      window._titleScreenReady = true;
      return;
    }
    requestAnimationFrame(poll);
  })();
})();
requestAnimationFrame(animate);
