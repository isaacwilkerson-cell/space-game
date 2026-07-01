// ── Game.js ─────────────────────────────────────────────────────────────────
console.log('%c GAME.JS v209 LOADED', 'color:lime;font-size:18px;font-weight:bold');
document.title = 'Space Game v209';

// Socket is optional — game runs offline if server isn't up
let socket = null;
try {
  const _serverURL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? '' : 'https://space-game-production-1d20.up.railway.app';
  socket = io(_serverURL, { timeout: 3000, reconnectionAttempts: 3 });
  socket.on('connect_error', () => { socket = null; });
} catch(e) { socket = null; }

// ── Asset config — drop files in client/assets/ and set names here ───────────
const ASSETS = {
  skybox:      'assets/deep_space_skybox.glb',
  playerShip:  'assets/ships/spaceship.glb',
  enemyShip:   'assets/ships/spaceship.glb',
  planets: [
    'assets/planets/planet_of_phoenix.glb',
    'assets/planets/planet_of_phoenix.glb',
    'assets/planets/planet_of_phoenix.glb',
    'assets/planets/planet_of_phoenix.glb',
    'assets/planets/planet_of_phoenix.glb',
  ],
  station: 'assets/space_station.glb',
};


function loadModel(path, targetSize, onLoaded) {
  fetch(path)
    .then(r => { if (!r.ok) { onLoaded(null); return null; } return r.blob(); })
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
        onLoaded(model);
      }, undefined, () => { URL.revokeObjectURL(url); onLoaded(null); });
    })
    .catch(() => onLoaded(null));
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
let fpBobT = 0;
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
function _tdmPlayerCount() {
  let n = _inTDMZone() ? 1 : 0;
  Object.values(remotePlayers).forEach(rp => {
    if (rp.fpMode === 'lobby' && rp.data && rp.data.fpPos && _posInTDMZone(rp.data.fpPos.x, rp.data.fpPos.z)) n++;
  });
  return n;
}
const _tdmEl = document.createElement('div');
_tdmEl.style.cssText = 'position:fixed;top:30%;left:50%;transform:translateX(-50%);color:#0ff;font-family:monospace;font-size:20px;letter-spacing:3px;text-align:center;text-shadow:0 0 8px #000;pointer-events:none;display:none;z-index:40;';
document.body.appendChild(_tdmEl);
let _tdmCountdown = null;
let _tdmCountdownLastTick = 0;
function _updateTDMZone() {
  const count = _tdmPlayerCount();
  const localInZone = _inTDMZone();
  if (!localInZone) {
    _tdmEl.style.display = 'none';
    _tdmCountdown = null;
    return;
  }
  _tdmEl.style.display = 'block';
  if (count >= 2) {
    if (_tdmCountdown === null) {
      _tdmCountdown = 20;
      _tdmCountdownLastTick = Date.now();
    }
    if (Date.now() - _tdmCountdownLastTick >= 1000) {
      _tdmCountdown = Math.max(0, _tdmCountdown - 1);
      _tdmCountdownLastTick = Date.now();
    }
    _tdmEl.textContent = `TEAM DEATHMATCH STARTING IN ${_tdmCountdown}`;
  } else {
    _tdmCountdown = null;
    _tdmEl.textContent = 'TEAM DEATHMATCH — AT LEAST 2 PLAYERS NEEDED TO START';
  }
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
  fpPos.set(55, 2, -155);
  fpVel.set(0, 0, 0);
  fpYaw = Math.PI; fpPitch = 0;
  camera.position.copy(fpPos);
  renderer.toneMappingExposure = 0.18;
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
const SURF_EYE_H = 12, SURF_SPEED = 0.22, SURF_SPRINT = 0.42, SURF_ACCEL = 0.18, SURF_FRICTION = 0.82;
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
  desert:     { mesh: null, ready: false, halfX: 1400, halfZ: 1400, tint: 0xddbb77, dim: 0.75, walkMul: 1.0, sprintMul: 1.0, jumpVelMul: 1.0, gravityMul: 1.0, climbMul: 1.0 },
  industrial: { mesh: null, ready: false, halfX: 1400, halfZ: 1400, tint: 0x555566, dim: 1.0, walkMul: 2.0, sprintMul: 2.0, jumpVelMul: 1.0, gravityMul: 1.0, climbMul: 0.18 },
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

  // Start landing animation — clone ship into surface scene
  _surfLanding = true;
  _surfLandT = 0;
  _surfLandGroundY = null;
  if (_surfLandShip) { _planetSurfScene.remove(_surfLandShip); _surfLandShip = null; }
  loadModel('assets/ships/spaceship.glb', 60, m => {
    if (!m) return;
    _surfLandShip = m;
    _surfLandShip.position.set(0, 800, 0);
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

  const _surfMoveMul = keys['shift'] ? _surfSprintMul : _surfWalkMul;
  const _accelAmt = (keys['shift'] ? SURF_ACCEL * 4 : SURF_ACCEL) * _surfMoveMul;
  const accel = new THREE.Vector3();
  if (keys['w'] || keys['arrowup'])    accel.addScaledVector(forward,  _accelAmt);
  if (keys['s'] || keys['arrowdown'])  accel.addScaledVector(forward, -_accelAmt);
  if (keys['a'] || keys['arrowleft'])  accel.addScaledVector(right,    _accelAmt);
  if (keys['d'] || keys['arrowright']) accel.addScaledVector(right,   -_accelAmt);

  _surfVel.add(accel);
  _surfVel.y = 0;
  _surfVel.multiplyScalar(SURF_FRICTION);
  const _surfSpeedCap = (keys['shift'] ? SURF_SPRINT : SURF_SPEED) * _surfMoveMul;
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
    <button class="h-tab h-tab-active" data-tab="color">COLOR</button>
    <button class="h-tab" data-tab="decals">DECALS</button>
    <button class="h-tab" data-tab="engine">ENGINE</button>
  </div>
  <div id="hangar-panels" style="flex:1; overflow-y:auto; padding:16px;">
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

// ── Inventory system ──────────────────────────────────────────────────────────
const INVENTORY_SIZE = 8;
const _inventory = Array(INVENTORY_SIZE).fill(null); // null = empty
let _activeSlot = 0;

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
  slot.appendChild(icon);
  slot.appendChild(num);
  _inventoryBar.appendChild(slot);
  _invSlotEls.push({ el: slot, icon });
}
document.body.appendChild(_inventoryBar);

// Item definitions
const _itemDefs = {
  sniper: { name: 'Sniper Rifle' },
};

function _invSetActive(idx) {
  _activeSlot = (idx + INVENTORY_SIZE) % INVENTORY_SIZE;
  _invSlotEls.forEach((s, i) => {
    s.el.style.borderColor = i === _activeSlot ? '#0ff' : 'rgba(0,255,255,0.25)';
    s.el.style.boxShadow   = i === _activeSlot
      ? '0 0 12px rgba(0,255,255,0.5) inset, 0 0 8px rgba(0,255,255,0.4)'
      : '0 0 6px rgba(0,255,255,0.1) inset';
    s.el.style.transform   = i === _activeSlot ? 'translateY(-4px)' : 'none';
  });
  // Show sniper only if active slot has it
  _hasSniper = _inventory[_activeSlot] === 'sniper';
}

function _invAddItem(itemId) {
  // Put in first empty slot
  const emptyIdx = _inventory.indexOf(null);
  if (emptyIdx === -1) return; // full
  _inventory[emptyIdx] = itemId;
  const def = _itemDefs[itemId];
  _invSlotEls[emptyIdx].icon.textContent = def ? def.icon : '?';
  _invSetActive(emptyIdx); // auto-select the new item
}

// Switch slots with 1-8 keys
window.addEventListener('keydown', e => {
  const n = parseInt(e.key);
  if (n >= 1 && n <= 8) { _invSetActive(n - 1); }
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
    ['color','decals','engine'].forEach(t => {
      document.getElementById('htab-' + t).style.display = t === btn.dataset.tab ? 'block' : 'none';
    });
  });
});

// Color swatches
const _shipColors = ['#00ccff','#ff4400','#00ff88','#ffdd00','#ff00aa','#8844ff','#ffffff','#444444'];
const _swatchEl = document.getElementById('hangar-color-swatches');
_shipColors.forEach(hex => {
  const s = document.createElement('div');
  s.style.cssText = `width:36px;height:36px;border-radius:4px;background:${hex};cursor:pointer;border:2px solid transparent;transition:border-color 0.15s;`;
  s.title = hex;
  s.addEventListener('click', () => { _applyShipColor(hex); document.getElementById('hangar-hex').value = hex; });
  s.addEventListener('mouseenter', () => { s.style.borderColor = '#fff'; });
  s.addEventListener('mouseleave', () => { s.style.borderColor = 'transparent'; });
  _swatchEl.appendChild(s);
});
document.getElementById('hangar-hex-apply').addEventListener('click', () => {
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
  if (_hangarShip) _hangarShip.traverse(c => {
    if (c.isMesh && c.material) {
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach(m => { if (m.color) m.color.set(col); });
    }
  });
  // Also tint the player's actual ship
  selfMesh.traverse(c => {
    if (c.isMesh && c.material) {
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach(m => { if (m.color) m.color.set(col); });
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
loadModel('assets/ships/spaceship.glb', 60, model => {
  if (!model) return;
  model.traverse(c => {
    if (c.isMesh && c.material) {
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach(m => {
        const basic = new THREE.MeshBasicMaterial({ map: m.map || null, color: m.color ? m.color.clone() : 0x00ccff });
        Object.assign(c, { material: basic });
      });
    }
  });
  model.position.set(0, 22, 78);
  _hangarShip = model;
  hangarScene.add(_hangarShip);
});

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
const hubOptions = ['SHOP', 'ROOM', 'SHIP'];

function hubSelect(idx) {
  hubOpen = false;
  roomHubEl.style.display = 'none';
  const opt = hubOptions[idx].toLowerCase();
  if (opt === 'shop') { openShop(); return; }
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
}
function closeHub() {
  hubOpen = false;
  roomHubEl.style.display = 'none';
  hubApproachPrompt.style.display = 'none';
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

// ── Shop ──────────────────────────────────────────────────────────────────────
const shopEl = makePanel('SHOP', '#0af', 'shop');
// Replace default "COMING SOON" content with actual shop items
shopEl.innerHTML = `
  <div style="font-size:18px;letter-spacing:4px;margin-bottom:20px;text-shadow:0 0 10px #0af;">SHOP</div>
  <div style="color:#0af8;font-size:11px;letter-spacing:2px;margin-bottom:18px;">WEAPONS</div>
  <div style="border:1px solid #0af4;border-radius:6px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:24px;">
    <div style="text-align:left;">
      <div style="font-size:14px;letter-spacing:2px;color:#fff;">SNIPER RIFLE</div>
      <div style="font-size:11px;color:#667;margin-top:5px;line-height:1.6;">Long-range precision weapon<br>RMB to zoom scope</div>
    </div>
    <button id="shop-sniper-btn" style="background:#0af2;border:1px solid #0af;border-radius:4px;color:#0af;font-family:'Courier New',monospace;font-size:12px;letter-spacing:1px;padding:8px 16px;cursor:pointer;white-space:nowrap;">EQUIP</button>
  </div>
  <div style="border:1px solid #0af;border-radius:5px;padding:10px 0;font-size:13px;letter-spacing:3px;cursor:pointer;" id="shop-close">[ BACK ]</div>`;
let shopOpen = false;
function openShop()  { shopOpen = true;  shopEl.style.display = 'block'; document.exitPointerLock(); }
function closeShop() { shopOpen = false; shopEl.style.display = 'none'; }
shopEl.querySelector('#shop-close').addEventListener('click', closeShop);
document.addEventListener('keydown', e => { if (shopOpen  && e.key === 'Escape') { closeShop(); e.stopPropagation(); } });

// ── Sniper System ─────────────────────────────────────────────────────────────
// _hasSniper declared earlier near inventory system
let _sniperMesh     = null; // loaded GLB scene, attached to camera each frame
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

// Load the sniper model (done once; shown/hidden based on equip state)
loadModel('assets/sniper.glb', 40, model => {
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
  _sniperMesh = model;
  _sniperMesh.visible = false;
  _viewmodelScene.add(_sniperMesh);

  // Dedicated side light — lives in viewmodel scene so it only ever lights the gun
  _sniperLight = new THREE.PointLight(0xffffff, 9, 150);
  _viewmodelScene.add(_sniperLight);

  // Store for icon rendering when equipped
  window._sniperModelRef = model;
});

// Shop equip button
shopEl.querySelector('#shop-sniper-btn').addEventListener('click', () => {
  if (_inventory.includes('sniper')) return;
  const slotIdx = _inventory.indexOf(null);
  _invAddItem('sniper');
  if (window._sniperModelRef) _renderIconToSlot(window._sniperModelRef, slotIdx);
  const btn = shopEl.querySelector('#shop-sniper-btn');
  btn.textContent = 'EQUIPPED';
  btn.style.background = '#0f42';
  btn.style.borderColor = '#0f4';
  btn.style.color = '#0f4';
});

// Recoil state
let _sniperRecoil = 0;
let _sniperLight  = null;

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
const BULLET_HOLE_LIFE = 3600; // ~1 minute at 60fps
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

  // Sparks — more of them, live longer
  const sparks = [];
  for (let i = 0; i < 10; i++) {
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
  activeScene.add(hole);
  _bulletHoles.push({ mesh: hole, life: BULLET_HOLE_LIFE, scene: activeScene });
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

function _fireSniper() {
  if (!_hasSniper || (gameMode !== 'planet_walk' && gameMode !== 'docked' && gameMode !== 'lobby' && gameMode !== 'ejected' && gameMode !== 'range') || !pointerLocked) return;
  if (_sniperCooldown > 0) return;
  _sniperCooldown = SNIPER_COOLDOWN;
  _sniperRecoil = 12; // frames of recoil

  const activeScene = gameMode === 'docked' ? interiorScene
                    : gameMode === 'lobby'   ? lobbyScene
                    : gameMode === 'range'   ? shootingRangeScene
                    : scene;

  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);

  // Bullet tracer
  const mesh = new THREE.Mesh(_sniperGeo, _sniperMat);
  mesh.position.copy(camera.position).addScaledVector(dir, 8);
  mesh.quaternion.copy(camera.quaternion);
  activeScene.add(mesh);

  const glow = new THREE.PointLight(0x00ffaa, 40, 300);
  glow.position.copy(mesh.position);
  activeScene.add(glow);

  // Muzzle flash — bright burst at gun tip
  const muzzlePos = camera.position.clone()
    .addScaledVector(dir, 20)
    .addScaledVector(new THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion), 8)
    .addScaledVector(new THREE.Vector3(0,1,0).applyQuaternion(camera.quaternion), -6);
  if (_muzzleFlash.parent !== activeScene) {
    if (_muzzleFlash.parent) _muzzleFlash.parent.remove(_muzzleFlash);
    activeScene.add(_muzzleFlash);
  }
  _muzzleFlash.position.copy(muzzlePos);
  _muzzleFlash.intensity = 120;

  // Raycast for bullet impact
  const raycaster = new THREE.Raycaster(camera.position.clone(), dir.clone(), 0, 2000);
  const collidables = gameMode === 'lobby'  ? _lobbyCollidables
                    : gameMode === 'docked' ? _roomCollidables
                    : gameMode === 'range'  ? _rangeCollidables
                    : [];
  const hits = raycaster.intersectObjects(collidables, true);
  if (hits.length > 0) {
    const normal = hits[0].face ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld).normalize() : dir.clone().negate();
    const hitColor = _sampleHitColor(hits[0]);
    _spawnImpact(hits[0].point, normal, activeScene, hitColor);
    if (gameMode === 'range') {
      // Only show hit marker if the hit surface faces roughly toward the player (Z-axis) = target face
      const faceNorm = hits[0].face ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld) : null;
      if (faceNorm && Math.abs(faceNorm.z) > 0.6) {
        _hitMarker = { color: hitColor, life: HIT_MARKER_LIFE };
      }
    }
  }

  _sniperShots.push({ mesh, glow, vel: dir.clone().multiplyScalar(SNIPER_SPEED), life: SNIPER_LIFETIME, scene: activeScene });
}

function _updateSniperShots() {
  if (_sniperCooldown > 0) _sniperCooldown--;
  _muzzleFlash.intensity = 0; // instant off
  _updateImpacts();

  for (let i = _sniperShots.length - 1; i >= 0; i--) {
    const s = _sniperShots[i];
    s.mesh.position.add(s.vel);
    s.glow.position.copy(s.mesh.position);
    s.life--;
    s.glow.intensity = 40 * (s.life / SNIPER_LIFETIME);
    if (s.life <= 0) {
      s.scene.remove(s.mesh); s.scene.remove(s.glow);
      _sniperShots.splice(i, 1);
    }
  }

  // Position sniper model in lower-right of view when in planet_walk
  if (_sniperMesh) {
    const show = _hasSniper && (gameMode === 'planet_walk' || gameMode === 'docked' || gameMode === 'lobby' || gameMode === 'ejected' || gameMode === 'range') && pointerLocked && !_heldCrate;
    _sniperMesh.visible = show;
    if (show) {
      // Sniper always lives in _viewmodelScene — no reparenting needed
      const dir   = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const right = new THREE.Vector3(1, 0,  0).applyQuaternion(camera.quaternion);
      const up    = new THREE.Vector3(0, 1,  0).applyQuaternion(camera.quaternion);
      // Recoil — kick gun back and up, then recover
      if (_sniperRecoil > 0) _sniperRecoil--;
      const recoilT = _sniperRecoil / 12;
      const recoilBack = recoilT * 5;
      const recoilUp   = recoilT * 2;
      _sniperMesh.position.copy(camera.position)
        .addScaledVector(dir,   14 - recoilBack)
        .addScaledVector(right,  8)
        .addScaledVector(up,    -6 + recoilUp);
      _sniperMesh.quaternion.copy(camera.quaternion);
      _sniperMesh.rotateY(Math.PI);
      _sniperMesh.rotateX(-0.1 - recoilT * 0.3);

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

  // Scope zoom
  if (_sniperScoped) {
    camera.fov = 15;
    camera.updateProjectionMatrix();
    _scopeEl.style.display = 'block';
  } else {
    camera.fov = 75;
    camera.updateProjectionMatrix();
    _scopeEl.style.display = 'none';
  }
}

// Fire on left-click, scope on right-click — only in planet_walk with sniper
document.addEventListener('mousedown', e => {
  if (!_hasSniper || (gameMode !== 'planet_walk' && gameMode !== 'docked' && gameMode !== 'ejected' && gameMode !== 'range') || !pointerLocked) return;
  if (e.button === 0) _fireSniper();
  if (e.button === 2) { e.preventDefault(); _sniperScoped = true; }
});
document.addEventListener('mouseup', e => {
  if (e.button === 2) _sniperScoped = false;
});
document.addEventListener('contextmenu', e => { if (_hasSniper && (gameMode === 'planet_walk' || gameMode === 'docked' || gameMode === 'ejected' || gameMode === 'range')) e.preventDefault(); });

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

  const _fpSprinting = gameMode === 'lobby' && keys['shift'];
  const _fpSpeedCap  = FP_SPEED * (_fpSprinting ? FP_SPRINT_MUL : 1);
  const _fpAccel     = FP_ACCEL * (_fpSprinting ? FP_SPRINT_MUL : 1);
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
  fpVel.multiplyScalar(FP_FRICTION);
  if (fpVel.length() > _fpSpeedCap) fpVel.setLength(_fpSpeedCap);

  // Precise mesh collision — slide along walls (skipped in admin/noclip mode)
  const _activeCollidables = gameMode === 'lobby' ? _lobbyCollidables : gameMode === 'hangar' ? _hangarCollidables : gameMode === 'range' ? _rangeCollidables : _roomCollidables;
  if (!window._adminMode && _activeCollidables.length > 0 && fpVel.lengthSq() > 0.0001) {
    const PLAYER_RADIUS = 2.5;
    const origin = fpPos.clone();
    origin.y += 1; // cast from mid-chest height

    // Try X and Z axes independently (slide)
    const axes = [
      new THREE.Vector3(fpVel.x, 0, 0),
      new THREE.Vector3(0, 0, fpVel.z),
    ];
    for (const axisVel of axes) {
      if (axisVel.lengthSq() < 0.00001) continue;
      _fpRayDir.copy(axisVel).normalize();
      _fpRaycaster.set(origin, _fpRayDir);
      _fpRaycaster.far = PLAYER_RADIUS + axisVel.length();
      const hits = _fpRaycaster.intersectObjects(_activeCollidables, false);
      if (hits.length > 0 && hits[0].distance < PLAYER_RADIUS) {
        // Zero out just this axis
        if (axisVel.x !== 0) fpVel.x = 0;
        if (axisVel.z !== 0) fpVel.z = 0;
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
  } else {
    _tdmEl.style.display = 'none';
  }

  fpPos.add(fpVel);
  if (!window._adminMode) {
    // Clamp to active scene bounding box
    const _activeBBox = gameMode === 'lobby' ? _lobbyBBox : gameMode === 'hangar' ? _hangarBBox : gameMode === 'range' ? _rangeBBox : _roomBBox;
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
  const _fpFloor = gameMode === 'lobby' ? -7.5 : gameMode === 'range' ? 0 : 2;
  const _fpGrounded = fpPos.y <= _fpFloor + 0.1;
  const _fpSprinting2 = gameMode === 'lobby' && keys['shift'];
  // Bob: faster + bigger in lobby to feel like real footsteps
  const bobSpeed = gameMode === 'lobby' ? (_fpSprinting2 ? 0.16 : 0.11) : 0.08;
  const bobAmp   = gameMode === 'lobby' ? 1.8 : 0.8;
  if (moving && (gameMode !== 'lobby' || _fpGrounded)) fpBobT += bobSpeed;
  else fpBobT += (Math.round(fpBobT / Math.PI) * Math.PI - fpBobT) * 0.12;
  const bob = Math.sin(fpBobT) * bobAmp * (moving ? 1 : Math.exp(-0.1));
  if (window._adminMode) {
    camera.position.copy(fpPos);
  } else if (gameMode === 'lobby') {
    // Jump + gravity
    if (keys[' '] && _fpGrounded && _fpJumpVel <= 0) _fpJumpVel = FP_JUMP_V;
    _fpJumpVel -= FP_GRAVITY;
    fpPos.y += _fpJumpVel;
    if (fpPos.y < _fpFloor) { fpPos.y = _fpFloor; _fpJumpVel = 0; }
    camera.position.copy(fpPos);
    if (_fpGrounded) camera.position.y += bob * 0.4;
  } else {
    fpPos.y = _fpFloor + bob;
    camera.position.copy(fpPos);
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
  p.userData.atmosphere = {
    skyColor:  new THREE.Color(0x1a5599),   // deep ocean blue
    fogColor:  new THREE.Color(0x3377cc),
    fogDensity: 0.0018,
    atmRadius: 900 * 3.5,
  };
  planets.push(p);
})();

// Planet at 2062, -12912, -12849
(function() {
  const p = createPlanet(2062, -12849, 700, 0xcc6644, 0x886644);
  p.position.y = -12912;
  p.userData.mapName = 'Phoenix';
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
    [ 38000,   20000,  14000,  700, 0xddbb77, 0xcc9944, 0x442200, 0xddaa44, 0.0008, 0xffcc44, false],
    [-40000,  -30000,  20000,  500, 0xcc9955, null,      0x331100, 0xbb8833, 0.0007, 0xffaa22, false],
    [ 16000,   50000,  40000,  430, 0xeecc88, 0xddaa55, 0x553300, 0xeeaa44, 0.0012, 0xffdd66, false],
    [-24000,  -48000, -40000,  620, 0xbb9944, null,      0x442200, 0xcc9933, 0.0009, 0xffbb33, false],
    // Desert worlds (reassigned from industrial)
    [ 20000,   38000, -28000,  590, 0xddbb88, 0xccaa66, 0x442200, 0xddaa55, 0.0012, 0xffcc55, false],
    [-35000,  -18000,  28000,  510, 0xccaa77, null,      0x331100, 0xbb8844, 0.0010, 0xffbb44, false],
    [ 48000,   42000,  22000,  650, 0xeebb88, 0xddaa66, 0x442200, 0xeebb55, 0.0009, 0xffdd66, false],
    [-22000,  -52000,  48000,  480, 0xbb9966, null,      0x331100, 0xcc9944, 0.0013, 0xffcc44, false],
    // Jungle worlds (reassigned from industrial)
    [ 55000,   60000,  15000,  900, 0x44aa55, 0x227733, 0x001100, 0x33cc44, 0.0006, 0x00ff66, false],
    [-55000,  -60000,  30000,  850, 0x339944, 0x226633, 0x001100, 0x22bb33, 0.0006, 0x00ee55, false],
    [ 28000,   55000,  55000,  950, 0x55bb44, 0x338822, 0x001100, 0x44cc33, 0.0005, 0x22ff44, false],
    // Dark/charcoal worlds
    [ 42000,   25000, -42000,  530, 0x444455, null,      0x000011, 0x222244, 0.0015, 0x6666ff, false],
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

  defs.forEach(([x, y, z, r, col, ring, skyC, fogC, fogD, dCol, extraRing], i) => {
    const p = createPlanet(x, z, r, col, ring);
    p.position.y = y;
    p.userData.mapName = PLANET_NAMES[i] || ('Planet ' + (i + 1));

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
    planets.forEach(p => {
      const [mx, my] = worldToMap(p.position.x, p.position.z);
      const selected = p.userData.mapSelected;
      const col = p.userData.diamond
        ? '#' + p.userData.diamond.material.color.getHexString()
        : '#aaccff';

      // Dot
      ctx.beginPath();
      ctx.arc(mx, my, selected ? 7 : 5, 0, Math.PI*2);
      ctx.fillStyle = selected ? col : 'rgba(150,180,220,0.5)';
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.stroke();
        // Outer glow ring
        ctx.beginPath();
        ctx.arc(mx, my, 12, 0, Math.PI*2);
        ctx.strokeStyle = col + '55';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Name
      ctx.fillStyle = selected ? col : 'rgba(120,160,200,0.7)';
      ctx.font = selected ? 'bold 11px Courier New' : '10px Courier New';
      ctx.fillText(p.userData.mapName || '?', mx + 9, my + 4);
    });

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

    let closest = null, closestDist = 18;
    planets.forEach(p => {
      const [px, py2] = worldToMap(p.position.x, p.position.z);
      const d = Math.hypot(mx - px, my - py2);
      if (d < closestDist) { closestDist = d; closest = p; }
    });

    if (closest) {
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

// Camera follows behind ship
camera.position.set(0, 8, 35);
camera.lookAt(0, 0, -10);
selfMesh.add(camera);

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

// Preload astronaut models — different sizes for lobby vs room
let _astronautLobbyTemplate = null;
let _astronautRoomTemplate  = null;
loadModel('assets/astronaught.glb', 18, m => { if (m) { m.position.y -= 2.7; } _astronautLobbyTemplate = m; });
loadModel('assets/astronaught.glb', 100, m => { if (m) { m.position.y -= 25; } _astronautRoomTemplate  = m; });

function _cloneAstronaut(template) {
  if (!template) return new THREE.Group();
  const clone = template.clone(true);
  clone.traverse(c => {
    if (c.isMesh && c.material) {
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
  return clone;
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

  // FP mesh for planet walk (world space, lives in main scene)
  const planetMesh = new THREE.Group();
  scene.add(planetMesh);
  planetMesh.visible = false;

  // FP mesh for ejected (floating astronaut in main scene)
  const ejectedMesh = new THREE.Group();
  scene.add(ejectedMesh);
  ejectedMesh.visible = false;

  // Add astronaut clones
  lobbyMesh.add(_cloneAstronaut(_astronautLobbyTemplate));
  roomMesh.add(_cloneAstronaut(_astronautRoomTemplate));
  rangeMesh.add(_cloneAstronaut(_astronautLobbyTemplate));
  planetMesh.add(_cloneAstronaut(_astronautLobbyTemplate));
  ejectedMesh.add(_cloneAstronaut(_astronautLobbyTemplate));

  // Name tags
  const tagName = data.name || 'Pilot';
  const lobbyTag   = _makeNameTag(tagName); lobbyTag.scale.set(14, 3.5, 1);  lobbyTag.position.set(0, 24, 0);   lobbyMesh.add(lobbyTag);
  const roomTag    = _makeNameTag(tagName); roomTag.scale.set(60, 15, 1);    roomTag.position.set(0, 115, 0);   roomMesh.add(roomTag);
  const rangeTag   = _makeNameTag(tagName); rangeTag.scale.set(14, 3.5, 1);  rangeTag.position.set(0, 24, 0);   rangeMesh.add(rangeTag);
  const planetTag  = _makeNameTag(tagName, false); planetTag.scale.set(0.12, 0.03, 1);  planetTag.position.set(0, 30, 0);  planetMesh.add(planetTag);
  const ejectedTag = _makeNameTag(tagName, false); ejectedTag.scale.set(0.12, 0.03, 1); ejectedTag.position.set(0, 20, 0); ejectedMesh.add(ejectedTag);

  remotePlayers[data.id] = { mesh, lobbyMesh, roomMesh, rangeMesh, planetMesh, ejectedMesh, data, fpMode: null };
}

function removeRemotePlayer(id) {
  const rp = remotePlayers[id];
  if (!rp) return;
  scene.remove(rp.mesh);
  lobbyScene.remove(rp.lobbyMesh);
  interiorScene.remove(rp.roomMesh);
  shootingRangeScene.remove(rp.rangeMesh);
  scene.remove(rp.planetMesh);
  scene.remove(rp.ejectedMesh);
  delete remotePlayers[id];
}

function _updateRemoteFPMeshes(p) {
  const rp = remotePlayers[p.id];
  if (!rp) return;
  const fpMode = p.fpMode; // 'lobby' | 'docked' | 'range' | null
  rp.fpMode = fpMode;

  rp.mesh.visible         = !fpMode;
  rp.lobbyMesh.visible    = fpMode === 'lobby';
  rp.roomMesh.visible     = false; // room is private
  rp.rangeMesh.visible    = fpMode === 'range';
  rp.planetMesh.visible   = fpMode === 'planet_walk';
  rp.ejectedMesh.visible  = fpMode === 'ejected';

  if (fpMode && p.fpPos) {
    const target = fpMode === 'lobby'      ? rp.lobbyMesh
                 : fpMode === 'range'       ? rp.rangeMesh
                 : fpMode === 'planet_walk' ? rp.planetMesh
                 : fpMode === 'ejected'     ? rp.ejectedMesh
                 : rp.roomMesh;
    target.position.set(p.fpPos.x, p.fpPos.y, p.fpPos.z);
    target.rotation.set(0, p.fpYaw || 0, 0);

    if (target.children.length === 0) {
      const tmpl = fpMode === 'docked' ? _astronautRoomTemplate : _astronautLobbyTemplate;
      if (tmpl) target.add(_cloneAstronaut(tmpl));
    }
  }
}

// ── Input ─────────────────────────────────────────────────────────────────────
const keys = {};
window.addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; e.preventDefault(); });
window.addEventListener('keyup',   e => { keys[e.key.toLowerCase()] = false; });

// Pointer lock + NMS-style reticle steering
let pointerLocked = false;

// Reticle position in screen pixels, clamped to a circle
const RETICLE_RADIUS = 160;
let reticleX = 0, reticleY = 0;

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

  if (!pointerLocked || gameMode === 'docked' || gameMode === 'lobby' || gameMode === 'hangar' || gameMode === 'range' || gameMode === 'ejected' || gameMode === 'planet_walk' || gameMode === 'landing_anim' || gameMode === 'takeoff_anim') return;

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

  // Waypoint helper — works at any distance using direction projection
  function drawWaypoint(targetWorldPos, minDist, color, label) {
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

    const pulse = 0.6 + 0.4 * Math.sin(Date.now() * 0.003);
    const s = 10;
    rCtx.save();
    rCtx.translate(sx, sy);
    rCtx.rotate(Math.PI / 4);
    rCtx.beginPath();
    rCtx.rect(-s/2, -s/2, s, s);
    rCtx.strokeStyle = color.replace('A', (pulse).toFixed(2));
    rCtx.lineWidth = 1.5;
    rCtx.stroke();
    rCtx.restore();

    const distStr = dist >= 1000 ? `${(dist/1000).toFixed(1)}ku` : `${Math.round(dist)}u`;
    rCtx.fillStyle = color.replace('A', (pulse * 0.85).toFixed(2));
    rCtx.font = '11px monospace';
    rCtx.textAlign = 'center';
    rCtx.fillText(`${label}  ${distStr}`, sx, sy + 20);
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

let lockRequested = false;
document.addEventListener('click', () => {
  if (hubOpen || shopOpen || roomCustomOpen || shipUpgradeOpen || gameMode === 'hangar') return;
  if (!document.pointerLockElement && !lockRequested) {
    lockRequested = true;
    setTimeout(() => { lockRequested = false; }, 2000);
    document.body.requestPointerLock();
  }
});

document.addEventListener('pointerlockchange', () => {
  pointerLocked = !!document.pointerLockElement;
  const mapIsOpen = document.getElementById('galaxy-map').classList.contains('open');
  const menuOpen = hubOpen || shopOpen || roomCustomOpen || shipUpgradeOpen || mapIsOpen || (window._chatOpen && window._chatOpen()) || gameMode === 'hangar';
  if (!menuOpen) overlay.classList.toggle('hidden', pointerLocked);
  if (!pointerLocked) { reticleX = 0; reticleY = 0; }
});

document.addEventListener('mousemove', e => {
  if (!pointerLocked) return;
  if (gameMode === 'docked' || gameMode === 'lobby' || gameMode === 'range') {
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

// ── Laser cannon ─────────────────────────────────────────────────────────────
const LASER_SPEED    = 80;
const LASER_LIFETIME   = 55;  // frames
const LASER_COOLDOWN   = 22;  // frames between shots
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
    l.mesh.position.add(l.vel);
    l.glow.position.copy(l.mesh.position);
    l.life--;
    const t = l.life / LASER_LIFETIME;
    l.glow.intensity = 55 * t;
    if (l.life <= 0) {
      scene.remove(l.mesh);
      scene.remove(l.glow);
      _lasers.splice(i, 1);
    }
  }
}

let _mouseFireHeld = false;
document.addEventListener('mousedown', e => { if (e.button === 0) _mouseFireHeld = true; });
document.addEventListener('mouseup',   e => { if (e.button === 0) _mouseFireHeld = false; });

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
  _camPos.set(0, 10, camDist).applyQuaternion(selfMesh.quaternion).add(selfMesh.position);

  // Camera shake scales with boost throttle
  camShakeAmt = boostThrottle * 3.5;
  if (camShakeAmt > 0.01) {
    _camPos.x += (Math.random() - 0.5) * camShakeAmt;
    _camPos.y += (Math.random() - 0.5) * camShakeAmt;
    _camPos.z += (Math.random() - 0.5) * camShakeAmt * 0.6;
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
  const fadeDelay = 7000; // ms before a message fades out

  function addMsg(name, text, isOwn) {
    const el = document.createElement('div');
    el.className = 'chat-msg';
    el.innerHTML = `<span class="chat-name">${name}:</span>${text}`;
    if (isOwn) el.style.borderLeft = '2px solid #0ff4';
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    // Fade out after delay
    const t = setTimeout(() => el.classList.add('fading'), fadeDelay);
    el.addEventListener('transitionend', () => el.remove());
    // Hovering the log resets fade
    log.addEventListener('mouseenter', () => {
      clearTimeout(t); el.classList.remove('fading');
    }, { once: true });
  }

  function openChat() {
    if (chatOpen) return;
    chatOpen = true;
    inputRow.classList.add('open');
    hint.style.display = 'none';
    document.exitPointerLock();
    setTimeout(() => input.focus(), 20);
  }

  function closeChat() {
    chatOpen = false;
    inputRow.classList.remove('open');
    hint.style.display = '';
    input.value = '';
    setTimeout(() => document.body.requestPointerLock(), 100);
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
    data.players.forEach(addRemotePlayer);
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
    const inFP = gameMode === 'lobby' || gameMode === 'docked' || gameMode === 'range' || gameMode === 'planet_walk' || gameMode === 'ejected';
    const _fpBroadcastPos = (gameMode === 'planet_walk' || gameMode === 'ejected')
      ? { x: camera.position.x, y: camera.position.y, z: camera.position.z }
      : { x: fpPos.x, y: fpPos.y, z: fpPos.z };
    const _fpBroadcastYaw = gameMode === 'planet_walk' ? _pwYaw : fpYaw;
    socket.emit('player_update', {
      position: { x: self.position.x, y: self.position.y, z: self.position.z },
      rotation: { x: selfMesh.rotation.x, y: selfMesh.rotation.y, z: selfMesh.rotation.z },
      velocity: { x: self.velocity.x, y: self.velocity.y, z: self.velocity.z },
      fpMode: inFP ? gameMode : null,
      fpPos:  inFP ? _fpBroadcastPos : null,
      fpYaw:  inFP ? _fpBroadcastYaw : null,
    });
  }, 50);
}

// ── Main loop ─────────────────────────────────────────────────────────────────
function animate(t) {
  requestAnimationFrame(animate);
  if (gameMode === 'docked' || gameMode === 'lobby' || gameMode === 'range') {
    updateFP();
    elPos.textContent = window._adminMode
      ? `X:${fpPos.x.toFixed(1)} Y:${fpPos.y.toFixed(1)} Z:${fpPos.z.toFixed(1)} ⚡ADMIN`
      : `${fpPos.x.toFixed(1)}, ${fpPos.z.toFixed(1)} (fp)`;
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
  } else {
    updateShip();
    updateLasers();
    updateHUD();
    updateAtmosphere();
    const dockDist = selfMesh.position.distanceTo(station.position);
    dockPrompt.style.display = (gameMode === 'flight' && dockDist < 400) ? 'block' : 'none';
  }
  _updateSniperShots(); // always run — handles hand model + shots in all modes
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
  if (gameMode !== 'docked' && gameMode !== 'range' && gameMode !== 'planet_surface' && window._updateStars) {
    if (window._setStarsVisible) window._setStarsVisible(true);
    const p = camera.position;
    window._updateStars(p.x, p.y, p.z, camera.quaternion);
  } else if (gameMode === 'planet_surface' && window._setStarsVisible) {
    window._setStarsVisible(false);
  }
  if (gameMode === 'range') {
    renderer.render(shootingRangeScene, camera);
  } else if (gameMode === 'planet_surface') {
    const _surfAtm = _surfCurrentPlanet && _surfCurrentPlanet.userData.atmosphere;
    renderer.setClearColor(_surfAtm ? _surfAtm.skyColor : 0x88bbff, 1);
    renderer.render(_planetSurfScene, camera);
    renderer.setClearColor(0x000000, 0);
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
requestAnimationFrame(animate);
