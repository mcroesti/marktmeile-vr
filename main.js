// Marktmeile VR - Elektro Challenge
// WebXR prototype for Meta Quest 3/3S
// Flow: Intro -> Wiring (5) -> Fuses (3) -> Lamp -> Switch -> Finish -> Auto-Reset 15s

import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

// ---------- Asset loader ----------
const gltfLoader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();

function loadColorTex(url, rx = 1, ry = 1) {
  const t = texLoader.load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = 8;
  return t;
}
function loadDataTex(url, rx = 1, ry = 1) {
  const t = texLoader.load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = 8;
  return t;
}
// Build a PBR material from a Poly Haven texture folder
function makePBRMaterial(slug, { repeat = [1, 1], ...rest } = {}) {
  const base = `./assets/textures/${slug}/${slug}`;
  return new THREE.MeshStandardMaterial({
    map:          loadColorTex(`${base}_diff_1k.jpg`,   repeat[0], repeat[1]),
    normalMap:    loadDataTex (`${base}_nor_gl_1k.jpg`, repeat[0], repeat[1]),
    roughnessMap: loadDataTex (`${base}_rough_1k.jpg`,  repeat[0], repeat[1]),
    ...rest,
  });
}

// ---------- Glow / fake-bloom helpers ----------
// Additive-blended radial-gradient sprite. XR-safe (no EffectComposer needed).
const _glowTexCache = new Map();
function getGlowTexture(colorHex = 0xffffff) {
  if (_glowTexCache.has(colorHex)) return _glowTexCache.get(colorHex);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const c = new THREE.Color(colorHex);
  const r = (c.r * 255) | 0, g = (c.g * 255) | 0, b = (c.b * 255) | 0;
  const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0.00, `rgba(${r},${g},${b},1.0)`);
  grad.addColorStop(0.20, `rgba(${r},${g},${b},0.55)`);
  grad.addColorStop(0.55, `rgba(${r},${g},${b},0.15)`);
  grad.addColorStop(1.00, `rgba(${r},${g},${b},0.0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  _glowTexCache.set(colorHex, tex);
  return tex;
}
function makeGlowSprite(colorHex = 0xfff1c4, size = 0.4, opacity = 0.8) {
  const mat = new THREE.SpriteMaterial({
    map: getGlowTexture(colorHex),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(size, size, 1);
  // Don't intercept XR controller raycasts — Sprite.raycast requires
  // raycaster.camera which we don't set for controller rays, and we don't
  // want glow halos to be clickable anyway.
  sprite.raycast = () => {};
  return sprite;
}
// A 3D "bar glow" — two crossed planes with additive blending, for linear light sources
function makeGlowBar(colorHex, length, thickness = 0.35, opacity = 0.6) {
  const group = new THREE.Group();
  const tex = getGlowTexture(colorHex);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, opacity, side: THREE.DoubleSide,
  });
  const p1 = new THREE.Mesh(new THREE.PlaneGeometry(length, thickness), mat);
  const p2 = new THREE.Mesh(new THREE.PlaneGeometry(length, thickness), mat);
  p2.rotation.x = Math.PI / 2;  // crossed: makes the bar look volumetric from any angle
  group.add(p1, p2);
  return group;
}
const ASSETS = {
  bulb: { url: './assets/sketchfab/bulb_edison.glb', scene: null, loaded: false, loading: false, callbacks: [] },
};
function loadAsset(key) {
  const a = ASSETS[key];
  if (a.loaded) return Promise.resolve(a.scene);
  if (a.loading) return new Promise((resolve, reject) => a.callbacks.push({ resolve, reject }));
  a.loading = true;
  return new Promise((resolve, reject) => {
    a.callbacks.push({ resolve, reject });
    gltfLoader.load(
      a.url,
      (gltf) => {
        a.scene = gltf.scene;
        a.loaded = true;
        a.loading = false;
        for (const cb of a.callbacks) cb.resolve(a.scene);
        a.callbacks = [];
        console.log(`[Assets] loaded ${key} from ${a.url}`);
      },
      undefined,
      (err) => {
        a.loading = false;
        console.error(`[Assets] failed to load ${key}:`, err);
        for (const cb of a.callbacks) cb.reject(err);
        a.callbacks = [];
      }
    );
  });
}

// ---------- Config ----------
const COLORS = {
  L1: 0x8B4513, // Braun
  L2: 0x1a1a1a, // Schwarz
  L3: 0x808080, // Grau
  N:  0x2A5CAA, // Blau
  PE: 0x9ACD32, // Gelb-Grün
};
const LABELS = ['L1', 'L2', 'L3', 'N', 'PE'];
const GRAB_DIST = 0.30;      // m, controller → object to grab (proximity fallback)
const SNAP_DIST = 0.35;      // m, object → socket on release
const BUTTON_DIST = 0.30;    // m, controller → button to press
const AUTO_RESET_DELAY = 15; // seconds
const USE_RAYCAST = true;    // primary interaction = ray from controller

// ---------- State ----------
const STATE = {
  INTRO: 'intro',
  WIRING: 'wiring',
  FUSES: 'fuses',
  LAMP: 'lamp',
  SWITCH: 'switch',
  FINISH: 'finish',
};
let currentState = STATE.INTRO;
let startTime = 0;
let finishTime = 0;
let resetTimer = null;

// ---------- Three.js boilerplate ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4f1ec);
scene.fog = new THREE.Fog(0xf4f1ec, 6, 14);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 50);
camera.position.set(0, 1.6, 0.3);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// Realistic tonemapping + correct color space
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer, {
  optionalFeatures: ['hand-tracking']
}));

// ---------- Environment (HDRI / IBL) ----------
// Loading the HDRI sets scene.environment — every PBR material gets realistic
// reflections and ambient lighting for free. We leave scene.background as the
// default (null / scene colour) so players don't see warehouse-through-walls.
new RGBELoader().load('./assets/hdri/empty_warehouse_1k.hdr', (tex) => {
  tex.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = tex;
  console.log('[Env] HDRI loaded, IBL active');
}, undefined, (err) => console.warn('[Env] HDRI load failed:', err));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Lighting ----------
// Note: the HDRI (scene.environment) provides most of the ambient fill, so the
// analytical lights below are dialed down compared to pre-IBL. The directional
// light stays for crisp shadows, the work-spot accents the interaction zone.
const ambient = new THREE.AmbientLight(0xffffff, 0.15);
scene.add(ambient);

const hemi = new THREE.HemisphereLight(0xfff4e0, 0x505560, 0.25);
scene.add(hemi);

const dir = new THREE.DirectionalLight(0xffffff, 0.55);
dir.position.set(2, 4, 2);
dir.castShadow = true;
dir.shadow.mapSize.set(2048, 2048);
dir.shadow.camera.left = -4; dir.shadow.camera.right = 4;
dir.shadow.camera.top = 4; dir.shadow.camera.bottom = -4;
dir.shadow.bias = -0.0005;
scene.add(dir);

// Fill light from opposite side (cool studio fill)
const fill = new THREE.DirectionalLight(0xbcd4ff, 0.12);
fill.position.set(-3, 3, 1);
scene.add(fill);

// Work spotlight on junction box — boosted for accent
const workSpot = new THREE.SpotLight(0xfff1c4, 1.4, 4, Math.PI / 6, 0.4, 1);
workSpot.position.set(0, 2.5, -0.2);
workSpot.target.position.set(0, 1.05, -0.95);
scene.add(workSpot); scene.add(workSpot.target);

// Warm accent light near workbench — breaks the neutral flatness
const warmAccent = new THREE.PointLight(0xffaa55, 0.35, 3.5, 2);
warmAccent.position.set(-0.6, 1.8, -0.5);
scene.add(warmAccent);

// Room light that will "turn on" at finish
const roomLight = new THREE.PointLight(0xfff1c4, 0, 8, 2);
roomLight.position.set(0, 2.35, -1.0);
scene.add(roomLight);

// ---------- Room ----------
function buildRoom() {
  // PBR materials from Poly Haven textures (CC0)
  const wallMat = makePBRMaterial('plastered_wall_04', { repeat: [2, 1.2], roughness: 1.0 });
  const baseMat = makePBRMaterial('metal_plate',       { repeat: [4, 0.2], metalness: 0.6 });
  const floorMat = makePBRMaterial('concrete_floor_02', { repeat: [6, 6] });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Walls
  const walls = [
    { w: 8, h: 3, p: [0, 1.5, -2.5], r: [0, 0, 0] },            // back
    { w: 5, h: 3, p: [-2.5, 1.5, 0], r: [0, Math.PI / 2, 0] },   // left
    { w: 5, h: 3, p: [2.5, 1.5, 0],  r: [0, -Math.PI / 2, 0] },  // right
  ];
  for (const cfg of walls) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(cfg.w, cfg.h), wallMat);
    wall.position.set(...cfg.p); wall.rotation.set(...cfg.r);
    wall.receiveShadow = true;
    scene.add(wall);
    // Sockelleiste (baseboard)
    const base = new THREE.Mesh(new THREE.BoxGeometry(cfg.w, 0.08, 0.015), baseMat);
    base.position.set(cfg.p[0], 0.04, cfg.p[2]);
    if (cfg.r[1] !== 0) { base.rotation.y = cfg.r[1]; }
    // nudge baseboard slightly inward off the wall to avoid z-fighting
    const nx = cfg.p[0] !== 0 ? -Math.sign(cfg.p[0]) * 0.008 : 0;
    const nz = cfg.p[2] !== 0 ? -Math.sign(cfg.p[2]) * 0.008 : 0;
    base.position.x += nx; base.position.z += nz;
    scene.add(base);
  }

  // Ceiling — plaster texture, tinted slightly lighter than walls
  const ceilMat = makePBRMaterial('plastered_wall_04', { repeat: [3, 2], roughness: 1.0 });
  ceilMat.color.setHex(0xf6f2ea); // tint the albedo for a lighter painted ceiling look
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(8, 5), ceilMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = 3;
  scene.add(ceiling);

  // Leuchtstoffröhre (zwei Röhren in Metallhalter)
  const tubeHousing = new THREE.Mesh(
    new THREE.BoxGeometry(1.3, 0.06, 0.24),
    new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.4, roughness: 0.5 })
  );
  tubeHousing.position.set(0, 2.98, -0.4);
  scene.add(tubeHousing);
  for (const dz of [-0.07, 0.07]) {
    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.022, 1.22, 18),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 2.5, roughness: 0.15 })
    );
    tube.rotation.z = Math.PI / 2;
    tube.position.set(0, 2.95, -0.4 + dz);
    scene.add(tube);
    // Glow bar around the tube — fakes bloom halo
    const glow = makeGlowBar(0xfff8d8, 1.4, 0.18, 0.55);
    glow.rotation.z = Math.PI / 2;
    glow.position.copy(tube.position);
    scene.add(glow);
    // Endkappen
    for (const dx of [-0.61, 0.61]) {
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.025, 0.02, 16),
        new THREE.MeshStandardMaterial({ color: 0xa0a0a0, metalness: 0.8, roughness: 0.3 })
      );
      cap.rotation.z = Math.PI / 2;
      cap.position.set(dx, 2.95, -0.4 + dz);
      scene.add(cap);
    }
  }

  // Tür an rechter Wand
  const doorFrame = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 2.1, 0.92),
    new THREE.MeshStandardMaterial({ color: 0x6d5a3e, roughness: 0.7 })
  );
  doorFrame.position.set(2.46, 1.05, 1.2);
  scene.add(doorFrame);
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.02, 2.0, 0.84),
    new THREE.MeshStandardMaterial({ color: 0xbfb3a1, roughness: 0.55 })
  );
  door.position.set(2.44, 1.0, 1.2);
  scene.add(door);
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 0.08, 12),
    new THREE.MeshStandardMaterial({ color: 0xbdbdbd, metalness: 0.85, roughness: 0.3 })
  );
  handle.rotation.z = Math.PI / 2;
  handle.position.set(2.42, 1.0, 0.85);
  scene.add(handle);

  // Steckdose an rechter Wand
  const outletPlate = new THREE.Mesh(
    new THREE.BoxGeometry(0.02, 0.085, 0.085),
    new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.35 })
  );
  outletPlate.position.set(2.445, 1.1, -0.6);
  scene.add(outletPlate);
  // Zwei runde Steckkontakte
  for (const dy of [-0.01, 0.01]) {
    const hole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.005, 0.005, 0.006, 10),
      new THREE.MeshStandardMaterial({ color: 0x111, roughness: 0.8 })
    );
    hole.rotation.z = Math.PI / 2;
    hole.position.set(2.437, 1.1 + dy, -0.6);
    scene.add(hole);
  }
  // PE-Kontakt
  const outletPE = new THREE.Mesh(
    new THREE.BoxGeometry(0.004, 0.003, 0.018),
    new THREE.MeshStandardMaterial({ color: 0x666, metalness: 0.7, roughness: 0.4 })
  );
  outletPE.position.set(2.437, 1.1, -0.57);
  scene.add(outletPE);

  // Whiteboard an linker Wand mit Schaltplan
  const wbFrame = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.8, 1.2),
    new THREE.MeshStandardMaterial({ color: 0x8a8a8a, metalness: 0.6, roughness: 0.4 })
  );
  wbFrame.position.set(-2.46, 1.5, -0.8);
  scene.add(wbFrame);
  // Schaltplan-Canvas
  const plan = document.createElement('canvas');
  plan.width = 1024; plan.height = 720;
  const pctx = plan.getContext('2d');
  pctx.fillStyle = '#fafafa'; pctx.fillRect(0, 0, 1024, 720);
  // Titel
  pctx.fillStyle = '#1a1a1a';
  pctx.font = 'bold 44px sans-serif';
  pctx.fillText('Aufgabe: 3~ Anschluss', 40, 70);
  pctx.font = '26px sans-serif';
  pctx.fillStyle = '#444';
  pctx.fillText('L1 · L2 · L3 · N · PE  →  Sicherungen  →  Lampe  →  Schalter', 40, 110);
  // Einfaches Schaltbild
  pctx.strokeStyle = '#1a1a1a';
  pctx.lineWidth = 3;
  // 3 horizontale Linien L1/L2/L3 + N
  const colors = ['#8B4513', '#1a1a1a', '#808080', '#2A5CAA', '#6a8f2a'];
  const names = ['L1', 'L2', 'L3', 'N', 'PE'];
  for (let k = 0; k < 5; k++) {
    const y = 200 + k * 70;
    pctx.strokeStyle = colors[k]; pctx.lineWidth = 6;
    pctx.beginPath(); pctx.moveTo(80, y); pctx.lineTo(340, y); pctx.stroke();
    pctx.fillStyle = colors[k]; pctx.font = 'bold 28px sans-serif';
    pctx.fillText(names[k], 30, y + 9);
  }
  // Sicherungen (3 Kästchen)
  pctx.strokeStyle = '#1a1a1a'; pctx.lineWidth = 3;
  for (let k = 0; k < 3; k++) {
    const y = 200 + k * 70;
    pctx.strokeRect(340, y - 22, 100, 44);
    pctx.fillStyle = '#fff'; pctx.fillRect(341, y - 21, 98, 42);
    pctx.fillStyle = '#1a1a1a';
    pctx.font = 'bold 22px sans-serif';
    pctx.fillText('F' + (k+1), 373, y + 8);
    // Symbol Sicherung (Rechteck mit Linie quer)
    pctx.beginPath(); pctx.moveTo(340, y); pctx.lineTo(440, y); pctx.stroke();
  }
  // Nach Sicherungen: Verbindung zur Lampe
  pctx.strokeStyle = '#1a1a1a'; pctx.lineWidth = 3;
  pctx.beginPath();
  pctx.moveTo(440, 200); pctx.lineTo(680, 200); pctx.lineTo(680, 460);
  pctx.moveTo(440, 270); pctx.lineTo(760, 270); pctx.lineTo(760, 460);
  pctx.moveTo(440, 340); pctx.lineTo(600, 340); pctx.lineTo(600, 460);
  pctx.stroke();
  // Schalter-Symbol
  pctx.beginPath(); pctx.moveTo(680, 460); pctx.lineTo(720, 430); pctx.stroke();
  pctx.beginPath(); pctx.arc(680, 460, 4, 0, Math.PI * 2); pctx.fill();
  pctx.beginPath(); pctx.arc(720, 430, 4, 0, Math.PI * 2); pctx.fill();
  pctx.font = 'bold 22px sans-serif';
  pctx.fillText('S', 700, 485);
  // Lampen-Symbol
  pctx.beginPath(); pctx.arc(600, 520, 40, 0, Math.PI * 2); pctx.stroke();
  pctx.beginPath(); pctx.moveTo(572, 492); pctx.lineTo(628, 548); pctx.stroke();
  pctx.beginPath(); pctx.moveTo(572, 548); pctx.lineTo(628, 492); pctx.stroke();
  pctx.font = 'bold 22px sans-serif';
  pctx.fillText('H', 588, 528);
  // PE nach unten
  pctx.strokeStyle = '#6a8f2a'; pctx.lineWidth = 5;
  pctx.beginPath();
  pctx.moveTo(340, 480); pctx.lineTo(880, 480); pctx.stroke();
  // Stempel / Signatur
  pctx.font = 'italic 20px sans-serif';
  pctx.fillStyle = '#999';
  pctx.fillText('RSK Elektro AG — Marktmeile 2026', 40, 690);
  const planTex = new THREE.CanvasTexture(plan);
  const wbSurface = new THREE.Mesh(
    new THREE.BoxGeometry(0.02, 0.74, 1.14),
    new THREE.MeshStandardMaterial({ map: planTex, roughness: 0.5 })
  );
  wbSurface.position.set(-2.44, 1.5, -0.8);
  wbSurface.rotation.y = -Math.PI / 2;
  // Richtige Texturausrichtung: planTex soll auf der rechten Seite stehen, lesbar
  // Nach rotation.y = -PI/2 zeigt +X nach +Z. Der "front face" ist in +X im lokalen.
  scene.add(wbSurface);
  // Warnschild "Vorsicht Strom" rechts neben der Schaltdose
  const warnSign = document.createElement('canvas');
  warnSign.width = 256; warnSign.height = 256;
  const sctx = warnSign.getContext('2d');
  // Gelber Hintergrund mit schwarzem Rand (Warnzeichen-Style)
  sctx.fillStyle = '#000'; sctx.fillRect(0, 0, 256, 256);
  sctx.fillStyle = '#ffcc00';
  sctx.beginPath();
  sctx.moveTo(128, 20); sctx.lineTo(236, 236); sctx.lineTo(20, 236); sctx.closePath();
  sctx.fill();
  // Blitzsymbol
  sctx.fillStyle = '#000';
  sctx.beginPath();
  sctx.moveTo(140, 80); sctx.lineTo(90, 170); sctx.lineTo(125, 170);
  sctx.lineTo(90, 220); sctx.lineTo(175, 140); sctx.lineTo(140, 140);
  sctx.lineTo(170, 80); sctx.closePath(); sctx.fill();
  const warnTex2 = new THREE.CanvasTexture(warnSign);
  const signPanel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.18, 0.18),
    new THREE.MeshBasicMaterial({ map: warnTex2, transparent: true })
  );
  signPanel.position.set(-1.2, 1.9, -2.48);
  scene.add(signPanel);

  // --- Grunge / Dirt decals for realism ---
  function makeGrungeCanvas(w, h, seed) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    // Random stains and smudges
    const rng = (s) => { s = Math.sin(s) * 43758.5453; return s - Math.floor(s); };
    for (let i = 0; i < 18; i++) {
      const x = rng(seed + i * 7.1) * w;
      const y = rng(seed + i * 3.3) * h;
      const r = 20 + rng(seed + i * 11.7) * 80;
      const alpha = 0.03 + rng(seed + i * 5.9) * 0.08;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(40,35,28,${alpha})`);
      grad.addColorStop(0.6, `rgba(50,42,32,${alpha * 0.5})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }
    // Scratch lines
    ctx.strokeStyle = 'rgba(30,25,20,0.04)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      ctx.beginPath();
      ctx.moveTo(rng(seed + i * 13) * w, rng(seed + i * 17) * h);
      ctx.lineTo(rng(seed + i * 19) * w, rng(seed + i * 23) * h);
      ctx.stroke();
    }
    return c;
  }
  // Dirt on back wall
  const dirtTex1 = new THREE.CanvasTexture(makeGrungeCanvas(512, 512, 42));
  const dirtDecal1 = new THREE.Mesh(
    new THREE.PlaneGeometry(3.5, 1.8),
    new THREE.MeshBasicMaterial({ map: dirtTex1, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 })
  );
  dirtDecal1.position.set(-0.5, 0.9, -2.498);
  scene.add(dirtDecal1);
  // Dirt on floor
  const dirtTex2 = new THREE.CanvasTexture(makeGrungeCanvas(512, 512, 77));
  const dirtDecal2 = new THREE.Mesh(
    new THREE.PlaneGeometry(3.0, 2.5),
    new THREE.MeshBasicMaterial({ map: dirtTex2, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 })
  );
  dirtDecal2.rotation.x = -Math.PI / 2;
  dirtDecal2.position.set(0, 0.002, -0.5);
  scene.add(dirtDecal2);
  // Scuff marks near workbench
  const dirtTex3 = new THREE.CanvasTexture(makeGrungeCanvas(256, 256, 13));
  const dirtDecal3 = new THREE.Mesh(
    new THREE.PlaneGeometry(1.8, 1.0),
    new THREE.MeshBasicMaterial({ map: dirtTex3, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 })
  );
  dirtDecal3.rotation.x = -Math.PI / 2;
  dirtDecal3.position.set(0, 0.003, -0.8);
  scene.add(dirtDecal3);
  // Water stain on left wall
  const stainCanvas = document.createElement('canvas');
  stainCanvas.width = 256; stainCanvas.height = 256;
  const stainCtx = stainCanvas.getContext('2d');
  const sg = stainCtx.createRadialGradient(128, 80, 10, 128, 140, 120);
  sg.addColorStop(0, 'rgba(80,70,50,0.06)');
  sg.addColorStop(0.4, 'rgba(60,55,40,0.04)');
  sg.addColorStop(0.7, 'rgba(50,45,35,0.02)');
  sg.addColorStop(1, 'rgba(0,0,0,0)');
  stainCtx.fillStyle = sg;
  stainCtx.fillRect(0, 0, 256, 256);
  // Drip line
  stainCtx.strokeStyle = 'rgba(70,60,45,0.06)';
  stainCtx.lineWidth = 3;
  stainCtx.beginPath(); stainCtx.moveTo(128, 80); stainCtx.lineTo(130, 230); stainCtx.stroke();
  const stainTex = new THREE.CanvasTexture(stainCanvas);
  const stainDecal = new THREE.Mesh(
    new THREE.PlaneGeometry(0.8, 1.2),
    new THREE.MeshBasicMaterial({ map: stainTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 })
  );
  stainDecal.position.set(-2.498, 1.8, -0.3);
  stainDecal.rotation.y = Math.PI / 2;
  scene.add(stainDecal);

  // Kleines Wandregal mit Ersatz-Sicherungs-Kartons
  const shelfMat = new THREE.MeshStandardMaterial({ color: 0xad8f5a, roughness: 0.75 });
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.02, 0.25), shelfMat);
  shelf.position.set(-1.3, 2.0, -2.38);
  scene.add(shelf);
  // Kartons drauf
  for (let k = 0; k < 3; k++) {
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.1, 0.14),
      new THREE.MeshStandardMaterial({ color: [0x7b5a2e, 0x8a6b3a, 0x715224][k], roughness: 0.85 })
    );
    box.position.set(-1.55 + k * 0.18, 2.065, -2.4);
    scene.add(box);
    // Etikett
    const boxLabel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.09, 0.04),
      new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.3 })
    );
    boxLabel.position.set(-1.55 + k * 0.18, 2.08, -2.329);
    scene.add(boxLabel);
  }
}
buildRoom();

// Workbench (metal frame + brushed steel top)
const benchGroup = new THREE.Group();
scene.add(benchGroup);
{
  // Arbeitsplatte — echtes Holz (Werkbank-Gefühl)
  const topMat = makePBRMaterial('wood_table_001', { repeat: [2, 1] });
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.04, 0.75), topMat);
  top.position.set(0, 0.92, -1.0);
  top.castShadow = true; top.receiveShadow = true;
  benchGroup.add(top);
  // Kante (subtile Metall-Abschlussleiste)
  const edge = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.012, 0.76),
    new THREE.MeshStandardMaterial({ color: 0x6b6f75, metalness: 0.85, roughness: 0.35 })
  );
  edge.position.set(0, 0.898, -1.0);
  benchGroup.add(edge);
  // Gestell-Rahmen — lackiertes dunkles Metall
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x1e2430, roughness: 0.45, metalness: 0.75 });
  for (const [x, z] of [[-0.75, -0.7], [0.75, -0.7], [-0.75, -1.3], [0.75, -1.3]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.9, 0.05), frameMat);
    leg.position.set(x, 0.45, z);
    leg.castShadow = true;
    benchGroup.add(leg);
  }
  // Querstreben
  const crossFront = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.04, 0.04), frameMat);
  crossFront.position.set(0, 0.15, -0.7); benchGroup.add(crossFront);
  const crossBack = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.04, 0.04), frameMat);
  crossBack.position.set(0, 0.15, -1.3); benchGroup.add(crossBack);
  // Schublade vorne
  const drawer = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.18, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x3c4657, roughness: 0.55, metalness: 0.4 })
  );
  drawer.position.set(0, 0.72, -0.675);
  benchGroup.add(drawer);
  const handle = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.018, 0.025),
    new THREE.MeshStandardMaterial({ color: 0xcccfd4, metalness: 0.9, roughness: 0.2 })
  );
  handle.position.set(0, 0.72, -0.655);
  benchGroup.add(handle);
}

// ---------- Werkzeug auf der Bank (dekorativ) ----------
function buildTools() {
  const g = new THREE.Group();

  // (Schraubendreher temporär entfernt — stand auf gleicher X-Position wie das
  //  Lampen-Home auf der Bank und könnte die Grab-Erkennung verwirrt haben.
  //  Wird später als Sketchfab-GLB an anderer Stelle wieder eingebaut.)

  // Seitenschneider
  const plHandleMat = new THREE.MeshStandardMaterial({ color: 0xd32f2f, roughness: 0.5 });
  const plJawMat = new THREE.MeshStandardMaterial({ color: 0x8892a0, metalness: 0.8, roughness: 0.3 });
  const pl = new THREE.Group();
  for (const dy of [-0.012, 0.012]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.012, 0.014), plHandleMat);
    h.position.set(-0.05, dy, 0); pl.add(h);
  }
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.012), plJawMat);
  jaw.position.set(0.04, 0, 0); pl.add(jaw);
  const pivot = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.03, 10), plJawMat);
  pivot.rotation.x = Math.PI / 2;
  pivot.position.set(0, 0, 0); pl.add(pivot);
  pl.position.set(0.55, 0.945, -0.78);
  pl.rotation.y = -0.3;
  g.add(pl);

  // Abisolierzange daneben
  const pl2 = pl.clone();
  pl2.position.set(0.55, 0.945, -0.85);
  pl2.rotation.y = 0.2;
  g.add(pl2);

  // Multimeter (gelbes Gehäuse mit Display)
  const mm = new THREE.Group();
  const mmBody = new THREE.Mesh(
    new THREE.BoxGeometry(0.11, 0.025, 0.17),
    new THREE.MeshStandardMaterial({ color: 0xfbc02d, roughness: 0.6 })
  );
  mm.add(mmBody);
  // Display
  const disp = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.002, 0.045),
    new THREE.MeshStandardMaterial({ color: 0x8ea89a, emissive: 0x2a3a2e, emissiveIntensity: 0.4, roughness: 0.3 })
  );
  disp.position.set(0, 0.014, -0.05);
  mm.add(disp);
  // Display-Text "230 V~"
  const dispCanvas = document.createElement('canvas');
  dispCanvas.width = 256; dispCanvas.height = 128;
  const dctx = dispCanvas.getContext('2d');
  dctx.fillStyle = '#b7c9bc'; dctx.fillRect(0, 0, 256, 128);
  dctx.fillStyle = '#1a2a1e';
  dctx.font = 'bold 72px monospace';
  dctx.textAlign = 'center'; dctx.textBaseline = 'middle';
  dctx.fillText('230 V~', 128, 64);
  const dispTex = new THREE.CanvasTexture(dispCanvas);
  const dispFace = new THREE.Mesh(
    new THREE.PlaneGeometry(0.075, 0.04),
    new THREE.MeshBasicMaterial({ map: dispTex })
  );
  dispFace.rotation.x = -Math.PI / 2;
  dispFace.position.set(0, 0.0152, -0.05);
  mm.add(dispFace);
  // Drehschalter
  const dial = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.008, 18),
    new THREE.MeshStandardMaterial({ color: 0x222, roughness: 0.5 })
  );
  dial.position.set(0, 0.016, 0.02);
  mm.add(dial);
  const dialMark = new THREE.Mesh(
    new THREE.BoxGeometry(0.003, 0.002, 0.018),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  dialMark.position.set(0, 0.021, 0.028);
  mm.add(dialMark);
  // Buchsen
  for (let k = 0; k < 3; k++) {
    const j = new THREE.Mesh(
      new THREE.CylinderGeometry(0.005, 0.005, 0.008, 10),
      new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.6 })
    );
    j.position.set(-0.03 + k * 0.03, 0.016, 0.06);
    mm.add(j);
  }
  mm.position.set(-0.45, 0.94, -1.15);
  mm.rotation.y = 0.15;
  g.add(mm);

  // Messleitungen (rot + schwarz, gewickelt)
  const leadMat1 = new THREE.MeshStandardMaterial({ color: 0xd32f2f, roughness: 0.7 });
  const leadMat2 = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.75 });
  for (const [mat, zoff] of [[leadMat1, 0.01], [leadMat2, -0.01]]) {
    const coil = new THREE.Mesh(
      new THREE.TorusGeometry(0.035, 0.005, 8, 24),
      mat
    );
    coil.rotation.x = Math.PI / 2;
    coil.position.set(-0.25, 0.947, -1.2 + zoff);
    g.add(coil);
  }

  // Iso-Tape-Rolle (schwarz)
  const tape = new THREE.Mesh(
    new THREE.TorusGeometry(0.028, 0.012, 10, 24),
    new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.6 })
  );
  tape.rotation.x = Math.PI / 2;
  tape.position.set(0.28, 0.958, -1.15);
  g.add(tape);
  const tapeInner = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.016, 0.023, 16, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x6c5b3a, roughness: 0.8, side: THREE.DoubleSide })
  );
  tapeInner.position.set(0.28, 0.958, -1.15);
  g.add(tapeInner);

  // Schutzhandschuhe (Paar, zerknautscht — dargestellt als zwei flache Ovale)
  const gloveMat = new THREE.MeshStandardMaterial({ color: 0x1e2530, roughness: 0.85 });
  for (const dx of [-0.08, 0.06]) {
    const palm = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.025, 0.11),
      gloveMat
    );
    palm.position.set(dx, 0.942, -1.22);
    palm.rotation.y = dx < 0 ? -0.3 : 0.3;
    g.add(palm);
    // Finger-Andeutung
    for (let k = 0; k < 4; k++) {
      const finger = new THREE.Mesh(
        new THREE.BoxGeometry(0.014, 0.02, 0.035),
        gloveMat
      );
      finger.position.set(dx + (k - 1.5) * 0.016, 0.942, -1.28);
      finger.rotation.y = dx < 0 ? -0.3 : 0.3;
      g.add(finger);
    }
  }

  // Kabelrolle (kleine Trommel mit schwarzem Kabel)
  const drum = new THREE.Group();
  const drumSide1 = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.055, 0.006, 24),
    new THREE.MeshStandardMaterial({ color: 0xbdbdbd, metalness: 0.5, roughness: 0.5 })
  );
  const drumSide2 = drumSide1.clone();
  drumSide1.position.y = 0.025; drumSide2.position.y = -0.025;
  drum.add(drumSide1); drum.add(drumSide2);
  const drumCore = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.032, 0.05, 24),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 })
  );
  drum.add(drumCore);
  // Aufgewickeltes Kabel (schmale Torus-Ringe in verschiedenen Höhen)
  for (let k = 0; k < 6; k++) {
    const loop = new THREE.Mesh(
      new THREE.TorusGeometry(0.048, 0.0035, 8, 30),
      new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.7 })
    );
    loop.rotation.x = Math.PI / 2;
    loop.position.y = -0.02 + k * 0.008;
    drum.add(loop);
  }
  drum.rotation.z = Math.PI / 2;
  drum.position.set(0.55, 0.982, -1.22);
  g.add(drum);

  scene.add(g);
}
buildTools();

// ---------- Junction Box (realistische Schaltdose) ----------
const junctionBox = new THREE.Group();
junctionBox.position.set(0, 0.95, -0.95);
scene.add(junctionBox);
{
  // Gehäuse aus leicht rauem ABS-Kunststoff
  const shellMat = new THREE.MeshStandardMaterial({ color: 0xe8e5dc, roughness: 0.6, metalness: 0.0 });
  const innerMat = new THREE.MeshStandardMaterial({ color: 0xc8c5bc, roughness: 0.75 });
  const W = 0.52, H = 0.42, D = 0.20, T = 0.018;

  // Rückwand (tiefer, mit sichtbarem Innenraum)
  const back = new THREE.Mesh(new THREE.BoxGeometry(W, H, T), innerMat);
  back.position.set(0, H/2, -D + T/2);
  junctionBox.add(back);
  // Boden, Deckel, Seitenwände
  const bottom = new THREE.Mesh(new THREE.BoxGeometry(W, T, D), shellMat);
  bottom.position.set(0, T/2, -D/2 + T/2);
  junctionBox.add(bottom);
  const top = new THREE.Mesh(new THREE.BoxGeometry(W, T, D), shellMat);
  top.position.set(0, H - T/2, -D/2 + T/2);
  junctionBox.add(top);
  const left = new THREE.Mesh(new THREE.BoxGeometry(T, H, D), shellMat);
  left.position.set(-W/2 + T/2, H/2, -D/2 + T/2);
  junctionBox.add(left);
  const right = new THREE.Mesh(new THREE.BoxGeometry(T, H, D), shellMat);
  right.position.set(W/2 - T/2, H/2, -D/2 + T/2);
  junctionBox.add(right);

  // Kabelverschraubungen (3 unten, 3 oben, 1 pro Seite)
  const glandMat = new THREE.MeshStandardMaterial({ color: 0xd4d0c5, roughness: 0.55 });
  const glandRingMat = new THREE.MeshStandardMaterial({ color: 0xb8b3a7, roughness: 0.5 });
  function makeGland(px, py, pz, axis) {
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.04, 16), glandMat);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.012, 16), glandRingMat);
    if (axis === 'y') { /* default */ }
    if (axis === 'x') { sleeve.rotation.z = Math.PI / 2; ring.rotation.z = Math.PI / 2; }
    sleeve.position.set(px, py, pz); ring.position.set(px, py, pz);
    junctionBox.add(sleeve); junctionBox.add(ring);
  }
  // unten (am Boden)
  for (let i = -1; i <= 1; i++) makeGland(i * 0.14, -0.01, -0.07, 'y');
  // oben (am Deckel)
  for (let i = -1; i <= 1; i++) makeGland(i * 0.14, H + 0.01, -0.07, 'y');
  // seitlich
  makeGland(-W/2 - 0.01, H/2, -0.07, 'x');
  makeGland( W/2 + 0.01, H/2, -0.07, 'x');

  // DIN-Schiene (Hutschiene) für Sicherungsautomaten
  const railMat = new THREE.MeshStandardMaterial({ color: 0xd0cfc8, metalness: 0.7, roughness: 0.4 });
  const rail = new THREE.Mesh(new THREE.BoxGeometry(W - 0.05, 0.022, 0.025), railMat);
  rail.position.set(0, 0.30, -0.08);
  junctionBox.add(rail);
  // Montage Schiene für die Reihenklemmen unten
  const rail2 = new THREE.Mesh(new THREE.BoxGeometry(W - 0.05, 0.022, 0.025), railMat);
  rail2.position.set(0, 0.07, -0.08);
  junctionBox.add(rail2);

  // PE-Schiene (grün-gelb) rechts im Gehäuse
  const peBar = new THREE.Mesh(
    new THREE.BoxGeometry(0.035, H - 0.06, 0.025),
    new THREE.MeshStandardMaterial({ color: 0x9ACD32, metalness: 0.4, roughness: 0.45 })
  );
  peBar.position.set(W/2 - 0.05, H/2, -0.06);
  junctionBox.add(peBar);
  // kleine Schrauben auf der PE-Schiene (Anschlusspunkte)
  for (let k = 0; k < 4; k++) {
    const s = new THREE.Mesh(
      new THREE.CylinderGeometry(0.005, 0.005, 0.008, 8),
      new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.85, roughness: 0.3 })
    );
    s.rotation.x = Math.PI / 2;
    s.position.set(W/2 - 0.05, 0.08 + k * 0.08, -0.045);
    junctionBox.add(s);
  }

  // Warnaufkleber "400V" an Außenseite oben
  const warnCanvas = document.createElement('canvas');
  warnCanvas.width = 256; warnCanvas.height = 256;
  const wctx = warnCanvas.getContext('2d');
  wctx.fillStyle = '#ffd600'; wctx.fillRect(0, 0, 256, 256);
  wctx.strokeStyle = '#000'; wctx.lineWidth = 10;
  wctx.strokeRect(10, 10, 236, 236);
  // Blitz-Symbol
  wctx.fillStyle = '#000';
  wctx.beginPath();
  wctx.moveTo(130, 40); wctx.lineTo(80, 140); wctx.lineTo(115, 140);
  wctx.lineTo(80, 220); wctx.lineTo(180, 110); wctx.lineTo(140, 110);
  wctx.lineTo(175, 40); wctx.closePath(); wctx.fill();
  wctx.font = 'bold 40px sans-serif';
  wctx.textAlign = 'center';
  wctx.fillText('400V', 128, 246);
  const warnTex = new THREE.CanvasTexture(warnCanvas);
  const warn = new THREE.Mesh(
    new THREE.PlaneGeometry(0.06, 0.06),
    new THREE.MeshBasicMaterial({ map: warnTex, transparent: true })
  );
  warn.position.set(-0.18, H + 0.012, 0.001);
  warn.rotation.x = -Math.PI / 2;
  junctionBox.add(warn);

  // Hersteller-Label auf Deckel
  const mfgCanvas = document.createElement('canvas');
  mfgCanvas.width = 512; mfgCanvas.height = 96;
  const mctx = mfgCanvas.getContext('2d');
  mctx.fillStyle = '#1f1f1f'; mctx.fillRect(0, 0, 512, 96);
  mctx.fillStyle = '#e8e6df';
  mctx.font = 'bold 54px sans-serif';
  mctx.textAlign = 'center'; mctx.textBaseline = 'middle';
  mctx.fillText('HENSEL KF 9060', 256, 48);
  const mfgTex = new THREE.CanvasTexture(mfgCanvas);
  const mfg = new THREE.Mesh(
    new THREE.PlaneGeometry(0.18, 0.034),
    new THREE.MeshBasicMaterial({ map: mfgTex })
  );
  mfg.position.set(0.05, H + 0.012, 0.001);
  mfg.rotation.x = -Math.PI / 2;
  junctionBox.add(mfg);
}

// ---------- Decorative cable bundles entering the box ----------
function buildCableFeeds() {
  // Aus den unteren und oberen Kabelverschraubungen tritt jeweils ein schwarzes
  // Mantelkabel aus — das Zuleitungskabel der Anlage.
  const sheathMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.75 });
  const sheathMat2 = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.65 });

  function makeFeed(startLocal, endLocal, radius, mat, bendOffset) {
    const start = new THREE.Vector3().copy(startLocal);
    const end = new THREE.Vector3().copy(endLocal);
    const mid = new THREE.Vector3().lerpVectors(start, end, 0.5).add(bendOffset);
    const curve = new THREE.CatmullRomCurve3([start, mid, end]);
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 24, radius, 10, false),
      mat
    );
    junctionBox.add(tube);
  }

  // Hauptzuleitung links unten → in die Kabelverschraubung
  makeFeed(
    new THREE.Vector3(-0.28, -0.08, -0.07),
    new THREE.Vector3(-0.14, -0.01, -0.07),
    0.012, sheathMat,
    new THREE.Vector3(0, -0.03, 0)
  );
  // Lampenkabel oben mittig
  makeFeed(
    new THREE.Vector3(0, 0.46, -0.07),
    new THREE.Vector3(0, 0.43, -0.07),
    0.009, sheathMat2,
    new THREE.Vector3(0, 0, 0)
  );
  // Hochgeführtes Lampenkabel (geht dann zur Decke — wir zeichnen einen Stub)
  const riseA = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.15, 10), sheathMat2);
  riseA.position.set(0, 0.56, -0.07);
  junctionBox.add(riseA);
}
buildCableFeeds();

// ---------- Atmospheric dust motes (floating particles in spotlight) ----------
const dustMotes = [];
{
  const dustTex = getGlowTexture(0xfff8e0);
  for (let i = 0; i < 35; i++) {
    const mat = new THREE.SpriteMaterial({
      map: dustTex, transparent: true,
      opacity: 0.06 + Math.random() * 0.07,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(mat);
    const size = 0.008 + Math.random() * 0.018;
    sprite.scale.set(size, size, 1);
    // Distribute in the spotlight cone area (above and around the workbench)
    sprite.position.set(
      (Math.random() - 0.5) * 1.8,
      0.95 + Math.random() * 1.6,
      -0.5 - Math.random() * 1.0
    );
    sprite.userData.basePos = sprite.position.clone();
    sprite.userData.driftSpeed = 0.3 + Math.random() * 0.7;
    sprite.userData.driftOffset = Math.random() * Math.PI * 2;
    sprite.userData.driftRadius = 0.05 + Math.random() * 0.15;
    sprite.raycast = () => {}; // XR-safe: don't intercept controller rays
    scene.add(sprite);
    dustMotes.push(sprite);
  }
}

// ---------- Reihenklemmen (Phoenix-Contact-Style) ----------
const wireSockets = [];
LABELS.forEach((label, i) => {
  const color = COLORS[label];
  const socketGroup = new THREE.Group();

  // Klemmenkörper — hoher schmaler Block
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.055, 0.12, 0.065),
    new THREE.MeshStandardMaterial({ color, roughness: 0.45 })
  );
  body.position.y = 0.06;
  socketGroup.add(body);
  // Schraubenkopf oben
  const screwHead = new THREE.Mesh(
    new THREE.CylinderGeometry(0.014, 0.014, 0.01, 12),
    new THREE.MeshStandardMaterial({ color: 0xd9d9d9, metalness: 0.85, roughness: 0.25 })
  );
  screwHead.position.set(0, 0.125, -0.01);
  socketGroup.add(screwHead);
  // Schlitz in der Schraube
  const slot = new THREE.Mesh(
    new THREE.BoxGeometry(0.016, 0.0015, 0.003),
    new THREE.MeshBasicMaterial({ color: 0x222222 })
  );
  slot.position.set(0, 0.1305, -0.01);
  socketGroup.add(slot);
  // Einführöffnung vorne (dunkles Loch)
  const hole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.009, 0.009, 0.022, 10),
    new THREE.MeshStandardMaterial({ color: 0x181818, roughness: 0.9 })
  );
  hole.rotation.x = Math.PI / 2;
  hole.position.set(0, 0.04, 0.035);
  socketGroup.add(hole);

  // Label
  const labelMesh = makeLabel(label, 0.05, 0.022, '#ffffff', 0x1a1a1a);
  labelMesh.position.set(0, 0.09, 0.034);
  socketGroup.add(labelMesh);

  const x = (i - 2) * 0.063;
  socketGroup.position.set(x, 0.018, 0.045);
  junctionBox.add(socketGroup);

  // Status-Ring vor der Einführöffnung
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.022, 0.003, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0x22dd22, transparent: true, opacity: 0 })
  );
  ring.position.set(0, 0.04, 0.048);
  socketGroup.add(ring);

  wireSockets.push({
    group: socketGroup,
    mesh: body,
    ring,
    label,
    color,
    expectedId: label,
    filled: false,
    worldPos: new THREE.Vector3(),
  });
});

// ---------- Diazed-Sicherungssockel (horizontal, Öffnung nach vorne) ----------
const fuseSockets = [];
for (let i = 0; i < 3; i++) {
  const group = new THREE.Group();
  // Porzellan-Sockelkörper gegen Rückwand
  const socketBase = new THREE.Mesh(
    new THREE.BoxGeometry(0.075, 0.075, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xe8e6df, roughness: 0.4 })
  );
  socketBase.position.set(0, 0, -0.025);
  group.add(socketBase);
  // Metallkragen (Gewindering der Patronenaufnahme), Achse = Z
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.028, 0.025, 20),
    new THREE.MeshStandardMaterial({ color: 0xbdbdbd, metalness: 0.85, roughness: 0.3 })
  );
  collar.rotation.x = Math.PI / 2;
  collar.position.set(0, 0, 0.0125);
  group.add(collar);
  // Innenraum (dunkles Loch)
  const inner = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.03, 20),
    new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 })
  );
  inner.rotation.x = Math.PI / 2;
  inner.position.set(0, 0, 0.00);
  group.add(inner);
  // Gewinde-Rillen am Kragen
  const threadMat = new THREE.MeshStandardMaterial({ color: 0xa0a0a0, metalness: 0.9, roughness: 0.3 });
  for (let r = 0; r < 3; r++) {
    const ridge = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.0013, 6, 20), threadMat);
    ridge.position.set(0, 0, 0.003 + r * 0.008);
    group.add(ridge);
  }
  // Zwei Befestigungsschrauben seitlich
  for (const dy of [-0.032, 0.032]) {
    const s = new THREE.Mesh(
      new THREE.CylinderGeometry(0.004, 0.004, 0.005, 8),
      new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.8, roughness: 0.3 })
    );
    s.rotation.x = Math.PI / 2;
    s.position.set(0, dy, 0.003);
    group.add(s);
  }

  // horizontal auf DIN-Schiene (oben im Gehäuse), Öffnung zeigt +Z
  const x = (i - 1) * 0.095;
  group.position.set(x, 0.295, 0.04);
  junctionBox.add(group);

  fuseSockets.push({
    group,
    expectedId: `F${i+1}`,
    filled: false,
    installing: false,
    worldPos: new THREE.Vector3(),
  });
}

// ---------- Pendelleuchte an der Decke ----------
const lampSocketGroup = new THREE.Group();
lampSocketGroup.position.set(0, 2.35, -1.0);
scene.add(lampSocketGroup);
{
  // Deckenbaldachin (Rosette) — relative to lampSocketGroup (y=2.35)
  const rosette = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.055, 0.025, 20),
    new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.45 })
  );
  rosette.position.y = 0.63; // world y ≈ 2.98 (near ceiling at 3.0)
  lampSocketGroup.add(rosette);
  // Hängekabel (schwarz, 60 cm)
  const cord = new THREE.Mesh(
    new THREE.CylinderGeometry(0.005, 0.005, 0.6, 8),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 })
  );
  cord.position.y = 0.3;
  lampSocketGroup.add(cord);
  // Fassungs-Kopf (weißer Kunststoff)
  const fixCap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.045, 0.035, 18),
    new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.4 })
  );
  fixCap.position.y = 0.02;
  lampSocketGroup.add(fixCap);
  // Schirmring unter Fassung
  const flange = new THREE.Mesh(
    new THREE.CylinderGeometry(0.052, 0.052, 0.01, 20),
    new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.5 })
  );
  flange.position.y = -0.005;
  lampSocketGroup.add(flange);
  // E27-Gewinde (sichtbar, Metall)
  const thread = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.045, 16),
    new THREE.MeshStandardMaterial({ color: 0x999, metalness: 0.85, roughness: 0.35 })
  );
  thread.position.y = -0.045;
  lampSocketGroup.add(thread);
  // Gewinde-Rillen
  for (let r = 0; r < 4; r++) {
    const ridge = new THREE.Mesh(
      new THREE.TorusGeometry(0.022, 0.0012, 6, 18),
      new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0.9, roughness: 0.3 })
    );
    ridge.rotation.x = Math.PI / 2;
    ridge.position.y = -0.03 - r * 0.01;
    lampSocketGroup.add(ridge);
  }
  // Dunkle Öffnung unten (wo die Birne reinkommt)
  const cavity = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.018, 0.02, 14),
    new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.9 })
  );
  cavity.position.y = -0.065;
  lampSocketGroup.add(cavity);
}
const lampSocket = {
  group: lampSocketGroup,
  expectedId: 'LAMP',
  filled: false,
  installing: false,
  worldPos: new THREE.Vector3(),
};

// ---------- EU-Lichtschalter (klassisch weiß, Wippe) ----------
const switchGroup = new THREE.Group();
switchGroup.position.set(1.1, 1.4, -2.48);
scene.add(switchGroup);
{
  // Unsichtbarer Aura-Glow (nur aktiv wenn Step 4 dran)
  const auraMat = new THREE.MeshBasicMaterial({
    color: 0xffeb3b, transparent: true, opacity: 0.0
  });
  const aura = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.32), auraMat);
  aura.position.z = -0.002;
  switchGroup.add(aura);
  switchGroup.userData.auraMat = auraMat;

  // Klassische quadratische Schalterplatte (EU-Style)
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(0.085, 0.085, 0.012),
    new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.35 })
  );
  plate.position.z = 0.006;
  switchGroup.add(plate);
  // Leichte Einfassung
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(0.095, 0.095, 0.006),
    new THREE.MeshStandardMaterial({ color: 0xededed, roughness: 0.4 })
  );
  frame.position.z = 0.003;
  switchGroup.add(frame);
  // Wippe (Kippschalter als quadratisches Plättchen)
  const toggle = new THREE.Mesh(
    new THREE.BoxGeometry(0.055, 0.055, 0.008),
    new THREE.MeshStandardMaterial({ color: 0xfdfdfd, roughness: 0.25 })
  );
  // Gekippt "off": leicht nach oben, Oberkante näher — simulieren wir mit rotX
  toggle.position.set(0, 0, 0.015);
  toggle.rotation.x = 0.25;
  switchGroup.add(toggle);
  switchGroup.userData.toggleMesh = toggle;

  // Dezentes Pfeil-/Licht-Symbol unterhalb (bleibt gut sichtbar)
  const lblCanvas = document.createElement('canvas');
  lblCanvas.width = 256; lblCanvas.height = 64;
  const lctx = lblCanvas.getContext('2d');
  lctx.clearRect(0, 0, 256, 64);
  lctx.fillStyle = '#2b2b2b';
  lctx.font = 'bold 36px sans-serif';
  lctx.textAlign = 'center'; lctx.textBaseline = 'middle';
  lctx.fillText('◔ LICHT', 128, 32);
  const lblTex = new THREE.CanvasTexture(lblCanvas);
  const lbl = new THREE.Mesh(
    new THREE.PlaneGeometry(0.10, 0.025),
    new THREE.MeshBasicMaterial({ map: lblTex, transparent: true })
  );
  lbl.position.set(0, -0.065, 0.013);
  switchGroup.add(lbl);
}
switchGroup.userData.activated = false;

// ---------- Grabbable helpers ----------
const grabbables = [];

function makeWire(label, startPos) {
  const color = COLORS[label];
  const group = new THREE.Group();
  // Isolierter Aderabschnitt (PVC-Mantel, leicht matt)
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.011, 0.011, 0.16, 16),
    new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.02 })
  );
  body.rotation.z = Math.PI / 2;
  group.add(body);
  // Übergang zwischen Isolierung und abisoliertem Ende
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 0.004, 14),
    new THREE.MeshStandardMaterial({ color: 0x222, roughness: 0.7 })
  );
  collar.rotation.z = Math.PI / 2;
  collar.position.x = 0.082;
  group.add(collar);
  // Abisoliertes Kupfer-Ende (heller goldener Ton, glänzend)
  const tip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.006, 0.006, 0.035, 12),
    new THREE.MeshStandardMaterial({ color: 0xe0a868, metalness: 0.9, roughness: 0.25 })
  );
  tip.rotation.z = Math.PI / 2;
  tip.position.x = 0.102;
  group.add(tip);
  // Aderendhülse (Ferrule) in hellem Grau zwischen Isolierung und blankem Ende
  const ferrule = new THREE.Mesh(
    new THREE.CylinderGeometry(0.009, 0.009, 0.012, 12),
    new THREE.MeshStandardMaterial({ color: 0xc8c8c8, metalness: 0.8, roughness: 0.3 })
  );
  ferrule.rotation.z = Math.PI / 2;
  ferrule.position.x = 0.09;
  group.add(ferrule);

  group.position.copy(startPos);
  group.userData = {
    kind: 'wire',
    id: label,
    homePos: startPos.clone(),
    homeRot: group.rotation.clone(),
    grabbed: false,
    snapped: false,
  };
  scene.add(group);
  grabbables.push(group);
  return group;
}

function makeFuse(i, startPos) {
  const group = new THREE.Group();
  // Keramik-Schraubkappe (weiß/creme)
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.028, 0.04, 20),
    new THREE.MeshStandardMaterial({ color: 0xf1ece0, roughness: 0.5, metalness: 0.0 })
  );
  cap.position.y = 0.035;
  group.add(cap);
  // Rändelung oben (kleiner Rand für Griff)
  const knurl = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.032, 0.008, 20),
    new THREE.MeshStandardMaterial({ color: 0xe4ddc9, roughness: 0.6 })
  );
  knurl.position.y = 0.054;
  group.add(knurl);
  // Glasfenster mit Kennmelder
  const window = new THREE.Mesh(
    new THREE.CylinderGeometry(0.014, 0.014, 0.003, 16),
    new THREE.MeshStandardMaterial({ color: 0xdce8f2, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.7 })
  );
  window.position.y = 0.0585;
  group.add(window);
  // Kennmeldeplättchen im Fenster (rot/gelb je nach Nennstrom)
  const indicatorColor = [0xd32f2f, 0xfbc02d, 0x388e3c][i];
  const ind = new THREE.Mesh(
    new THREE.CircleGeometry(0.008, 12),
    new THREE.MeshBasicMaterial({ color: indicatorColor })
  );
  ind.position.y = 0.0598;
  ind.rotation.x = -Math.PI / 2;
  group.add(ind);
  // Metall-Gewindesockel darunter
  const thread = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.02, 16),
    new THREE.MeshStandardMaterial({ color: 0xbdbdbd, metalness: 0.9, roughness: 0.3 })
  );
  thread.position.y = 0.005;
  group.add(thread);
  // Kontaktstift ganz unten
  const tip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.006, 0.006, 0.01, 10),
    new THREE.MeshStandardMaterial({ color: 0xa0a0a0, metalness: 0.95, roughness: 0.2 })
  );
  tip.position.y = -0.01;
  group.add(tip);

  group.position.copy(startPos);
  group.userData = {
    kind: 'fuse',
    id: `F${i+1}`,
    homePos: startPos.clone(),
    homeRot: group.rotation.clone(),
    grabbed: false,
    snapped: false,
  };
  scene.add(group);
  grabbables.push(group);
  return group;
}

// Procedural lamp builder (fallback + placeholder while GLB loads)
function buildProceduralLampChildren() {
  const children = [];
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.038, 20, 16),
    new THREE.MeshPhysicalMaterial({
      color: 0xfff4d6, roughness: 0.05, metalness: 0.0,
      transmission: 0.85, thickness: 0.3, ior: 1.4,
      transparent: true, opacity: 0.6, emissive: 0x000000,
    })
  );
  bulb.position.y = 0.025;
  children.push(bulb);
  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.022, 0.012, 14),
    new THREE.MeshPhysicalMaterial({
      color: 0xfff4d6, roughness: 0.05, transmission: 0.8,
      thickness: 0.3, transparent: true, opacity: 0.55,
    })
  );
  neck.position.y = -0.008;
  children.push(neck);
  const filament = new THREE.Mesh(
    new THREE.CylinderGeometry(0.001, 0.001, 0.03, 6),
    new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0x000000, roughness: 0.4 })
  );
  filament.position.y = 0.025;
  children.push(filament);
  const screw = new THREE.Mesh(
    new THREE.CylinderGeometry(0.021, 0.019, 0.035, 14),
    new THREE.MeshStandardMaterial({ color: 0xa0a0a0, metalness: 0.9, roughness: 0.3 })
  );
  screw.position.y = -0.032;
  children.push(screw);
  const iso = new THREE.Mesh(
    new THREE.CylinderGeometry(0.007, 0.012, 0.012, 12),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7 })
  );
  iso.position.y = -0.056;
  children.push(iso);
  const tip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.006, 0.006, 0.005, 10),
    new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.9, roughness: 0.3 })
  );
  tip.position.y = -0.064;
  children.push(tip);
  return { children, bulbMesh: bulb, filamentMesh: filament };
}

function makeLampBulb(startPos) {
  const group = new THREE.Group();

  // Start with procedural placeholder so the scene renders immediately
  const proc = buildProceduralLampChildren();
  for (const c of proc.children) group.add(c);

  // Persistent glow sprite (invisible until FINISH). Kept outside the procedural
  // children array so the GLB swap doesn't accidentally remove it.
  const glowSprite = makeGlowSprite(0xfff1c4, 0.5, 0.0);
  // Sit on the glass centre of the procedural bulb (≈ y +0.025)
  glowSprite.position.set(0, 0.025, 0);
  group.add(glowSprite);

  group.position.copy(startPos);
  group.userData = {
    kind: 'lamp',
    id: 'LAMP',
    homePos: startPos.clone(),
    homeRot: group.rotation.clone(),
    grabbed: false,
    snapped: false,
    bulbMesh: proc.bulbMesh,
    filamentMesh: proc.filamentMesh,
    glowSprite,
    _gltfApplied: false,
  };
  scene.add(group);
  grabbables.push(group);

  // Attempt to upgrade to GLB asset. The Blender-processed glb is already
  // in the main.js convention: natural orientation = threads down, glass up.
  // Origin sits at the thread tip (bottom of threads). The game-side
  // rotation.x = Math.PI flip still turns threads up / glass down for the
  // ceiling socket snap, exactly like the procedural build.
  loadAsset('bulb').then((scn) => {
    // Preserve the glow sprite before clearing
    const savedGlow = group.userData.glowSprite;
    while (group.children.length) group.remove(group.children[0]);
    if (savedGlow) {
      // GLB glass spans y ≈ 0.025 .. 0.11, centre at ≈ 0.067 in un-flipped space
      savedGlow.position.set(0, 0.067, 0);
      group.add(savedGlow);
    }

    // Clone the loaded gltf scene so we don't share materials across multiple bulbs
    const clone = scn.clone(true);
    // Clone materials so per-instance emissive tweaks stay local
    clone.traverse((o) => {
      if (o.isMesh) {
        if (Array.isArray(o.material)) o.material = o.material.map((m) => m.clone());
        else if (o.material) o.material = o.material.clone();
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });

    // Locate materials we want to drive emissively.
    //   'glass' (and 'glass-thicker') = outer glass → bulb glow
    //   'glow'  = filament            → filament glow
    let bulbMesh = null, filamentMesh = null;
    clone.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        const n = (m.name || '').toLowerCase();
        if (!bulbMesh && n.startsWith('glass')) bulbMesh = o;
        if (!filamentMesh && n === 'glow') filamentMesh = o;
      }
    });
    // Make the glass actually translucent (Sketchfab materials often arrive
    // fully opaque; we want light to show through when lit).
    if (bulbMesh && bulbMesh.material) {
      const m = bulbMesh.material;
      if ('transmission' in m) m.transmission = 0.85;
      if ('thickness'    in m) m.thickness = 0.3;
      if ('ior'          in m) m.ior = 1.4;
      m.transparent = true;
      m.opacity = Math.min(m.opacity ?? 1.0, 0.7);
      m.roughness = 0.05;
      m.needsUpdate = true;
    }

    group.add(clone);
    group.userData.bulbMesh = bulbMesh;
    group.userData.filamentMesh = filamentMesh;
    group.userData._gltfApplied = true;
    console.log(`[Lamp] GLB applied; bulbMesh=${!!bulbMesh}, filamentMesh=${!!filamentMesh}`);
  }).catch((err) => {
    console.warn('[Lamp] GLB load failed, keeping procedural fallback:', err);
  });

  return group;
}

// Create all grabbables
const wires = LABELS.map((lbl, i) => makeWire(lbl, new THREE.Vector3(0.45 - i * 0.05, 0.94, -0.7 + i * 0.03)));
const fuses = [0,1,2].map(i => makeFuse(i, new THREE.Vector3(-0.35 + i * 0.07, 0.94, -0.75)));
const lampBulb = makeLampBulb(new THREE.Vector3(-0.55, 0.97, -1.0));

// ---------- Label helper ----------
function makeLabel(text, w, h, fg = '#fff', bgHex = 0x000000) {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#' + bgHex.toString(16).padStart(6, '0');
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = fg;
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true })
  );
}

// ---------- HUD (worldspace canvas) ----------
const hudCanvas = document.createElement('canvas');
hudCanvas.width = 1024; hudCanvas.height = 512;
const hudCtx = hudCanvas.getContext('2d');
const hudTex = new THREE.CanvasTexture(hudCanvas);
const hudMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1.0, 0.5),
  new THREE.MeshBasicMaterial({ map: hudTex, transparent: true })
);
hudMesh.position.set(-0.9, 1.55, -1.0);
hudMesh.rotation.y = Math.PI / 6;
scene.add(hudMesh);

function drawHUD() {
  const ctx = hudCtx;
  ctx.clearRect(0, 0, 1024, 512);

  // Sci-Fi Panel mit leichtem Blauschimmer und Glas-Effekt
  const grd = ctx.createLinearGradient(0, 0, 0, 512);
  grd.addColorStop(0, 'rgba(12,22,40,0.88)');
  grd.addColorStop(1, 'rgba(8,14,30,0.92)');
  ctx.fillStyle = grd;
  roundRect(ctx, 8, 8, 1008, 496, 18);
  ctx.fill();
  // Äußerer Glow-Rahmen
  ctx.strokeStyle = '#4fd1ff';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#4fd1ff';
  ctx.shadowBlur = 18;
  ctx.stroke();
  ctx.shadowBlur = 0;
  // Ecken-Akzente
  ctx.strokeStyle = '#7adfff';
  ctx.lineWidth = 5;
  const corner = 48;
  const drawCorner = (x, y, dx, dy) => {
    ctx.beginPath();
    ctx.moveTo(x, y + dy * corner);
    ctx.lineTo(x, y);
    ctx.lineTo(x + dx * corner, y);
    ctx.stroke();
  };
  drawCorner(24, 24, 1, 1);
  drawCorner(1000, 24, -1, 1);
  drawCorner(24, 488, 1, -1);
  drawCorner(1000, 488, -1, -1);

  // Titel
  ctx.fillStyle = '#eaf6ff';
  ctx.font = 'bold 38px sans-serif';
  ctx.fillText('ELEKTRO CHALLENGE', 50, 60);

  // Timer
  const t = currentState === STATE.FINISH ? (finishTime - startTime) / 1000
          : currentState === STATE.INTRO ? 0
          : (performance.now() - startTime) / 1000;
  ctx.font = 'bold 82px monospace';
  ctx.fillStyle = currentState === STATE.FINISH ? '#7CFC00' : '#ffcc33';
  ctx.shadowColor = ctx.fillStyle;
  ctx.shadowBlur = 14;
  ctx.fillText(formatTime(t), 50, 150);
  ctx.shadowBlur = 0;

  // Trennlinie
  ctx.strokeStyle = 'rgba(79,209,255,0.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(50, 180); ctx.lineTo(974, 180); ctx.stroke();

  // Checklist
  ctx.font = '28px sans-serif';
  const items = [
    { txt: 'AUFGABE 1: Drähte anschließen (L1/L2/L3/N/PE)', done: wireSockets.every(s => s.filled),   active: currentState === STATE.WIRING },
    { txt: `AUFGABE 2: ${fuseSockets.filter(s=>s.filled).length}/3 Sicherungen eindrehen`,            done: fuseSockets.every(s => s.filled), active: currentState === STATE.FUSES },
    { txt: 'AUFGABE 3: Lampe eindrehen',                    done: lampSocket.filled,                  active: currentState === STATE.LAMP },
    { txt: 'AUFGABE 4: Licht einschalten',                  done: switchGroup.userData.activated,     active: currentState === STATE.SWITCH },
  ];
  items.forEach((it, i) => {
    const y = 230 + i * 48;
    ctx.fillStyle = it.done ? '#7CFC00' : it.active ? '#ffcc33' : '#95a6b8';
    const mark = it.done ? '✓' : it.active ? '▶' : '○';
    ctx.fillText(mark, 55, y);
    ctx.fillText(it.txt, 105, y);
  });

  // State-spezifisch
  if (currentState === STATE.INTRO) {
    ctx.fillStyle = '#4fd1ff';
    ctx.font = 'italic 22px sans-serif';
    ctx.fillText('› Grünen START-Button drücken', 55, 475);
  } else if (currentState === STATE.FINISH) {
    ctx.fillStyle = '#7CFC00';
    ctx.font = 'bold 36px sans-serif';
    ctx.shadowColor = '#7CFC00'; ctx.shadowBlur = 16;
    ctx.fillText('AUFGABE ERLEDIGT', 55, 473);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#eaf6ff';
    ctx.font = '22px sans-serif';
    ctx.fillText(`ZEIT GESTOPPT: ${formatTime((finishTime - startTime) / 1000)}`, 420, 473);
  }
  hudTex.needsUpdate = true;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const ss = (s - m * 60).toFixed(1).padStart(4, '0');
  return `${m.toString().padStart(2, '0')}:${ss}`;
}

// ---------- Start Button ----------
const startButton = new THREE.Group();
startButton.position.set(0.55, 1.3, -0.8);
scene.add(startButton);
{
  const btn = new THREE.Mesh(
    new THREE.BoxGeometry(0.25, 0.12, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x22aa33, emissive: 0x114411, roughness: 0.4 })
  );
  startButton.add(btn);
  const label = makeLabel('START', 0.2, 0.08, '#fff', 0x22aa33);
  label.position.z = 0.035;
  startButton.add(label);
  startButton.userData = { active: true, mesh: btn };
}

// ---------- Debug panel (disabled for production) ----------
function dbg(msg) { console.log('[dbg]', msg); }

// ---------- Controllers ----------
const controllers = [];
const controllerGrips = [];
const controllerFactory = new XRControllerModelFactory();

for (let i = 0; i < 2; i++) {
  const ctrl = renderer.xr.getController(i);
  ctrl.userData = { hand: null, holding: null, triggerDown: false, idx: i };
  ctrl.addEventListener('selectstart', onSelectStart);
  ctrl.addEventListener('selectend', onSelectEnd);
  ctrl.addEventListener('connected', (e) => { dbg(`C${i} connected: ${e.data?.handedness || '?'}`); });
  ctrl.addEventListener('disconnected', () => { dbg(`C${i} disconnected`); });
  scene.add(ctrl);
  controllers.push(ctrl);

  // Long ray for visual feedback + selection
  const rayGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,-5)]);
  const ray = new THREE.Line(rayGeom, new THREE.LineBasicMaterial({ color: 0x5aa8ff, transparent: true, opacity: 0.8 }));
  ray.name = 'ray';
  ctrl.add(ray);

  // Small sphere at tip for reference
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(0.012, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffcc33 })
  );
  tip.position.z = -0.04;
  ctrl.add(tip);

  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerFactory.createControllerModel(grip));
  scene.add(grip);
  controllerGrips.push(grip);
}

// ---------- Hand Tracking ----------
const hands = [];
const handModelFactory = new XRHandModelFactory();

// Tuning constants
const HAND_FINGER_TOUCH   = 0.08;  // 8cm — fingertip-to-object = "touching"
const HAND_GRAB_CURL      = 0.085; // avg fingertip-to-metacarpal < this = grip closed
const HAND_RELEASE_CURL   = 0.11;  // > this = grip open (hysteresis)
const HAND_BUTTON_TOUCH   = 0.06;  // fingertip to button/switch distance

// All fingertip joint names for proximity checks
const FINGERTIP_JOINTS = [
  'thumb-tip',
  'index-finger-tip',
  'middle-finger-tip',
  'ring-finger-tip',
  'pinky-finger-tip',
];

for (let i = 0; i < 2; i++) {
  const hand = renderer.xr.getHand(i);
  hand.userData = {
    holding: null,       // currently grabbed object
    gripping: false,     // is hand in grip pose?
    nearObj: null,       // object currently in touch range (for highlight)
    idx: i,
  };

  // Three.js built-in mesh hand model
  const handModel = handModelFactory.createHandModel(hand, 'mesh');
  hand.add(handModel);

  scene.add(hand);
  hands.push(hand);
}

// --- Helpers ---

// Grip strength: average distance from each fingertip to its own metacarpal.
function getFingerCurl(hand) {
  const pairs = [
    ['index-finger-tip',  'index-finger-metacarpal'],
    ['middle-finger-tip', 'middle-finger-metacarpal'],
    ['ring-finger-tip',   'ring-finger-metacarpal'],
    ['pinky-finger-tip',  'pinky-finger-metacarpal'],
  ];
  let total = 0, count = 0;
  for (const [tipName, metaName] of pairs) {
    const tip  = hand.joints[tipName];
    const meta = hand.joints[metaName];
    if (tip && meta) {
      total += tip.position.distanceTo(meta.position);
      count++;
    }
  }
  return count > 0 ? total / count : Infinity;
}

// Find the closest grabbable to ANY fingertip. Returns {obj, dist} or null.
// This is the key difference: fingertips reach objects, not the palm.
const _tipWorld = new THREE.Vector3();
const _objWorld = new THREE.Vector3();
function findNearestToFingertips(hand, maxDist) {
  const candidates = grabbables.filter(g =>
    !g.userData.snapped && g.visible && isGrabbableInCurrentState(g)
  );
  if (candidates.length === 0) return null;

  let bestObj = null, bestDist = maxDist;

  for (const tipName of FINGERTIP_JOINTS) {
    const tipJoint = hand.joints[tipName];
    if (!tipJoint) continue;
    tipJoint.getWorldPosition(_tipWorld);

    for (const g of candidates) {
      g.getWorldPosition(_objWorld);
      const d = _tipWorld.distanceTo(_objWorld);
      if (d < bestDist) {
        bestDist = d;
        bestObj = g;
      }
    }
  }
  return bestObj;
}

// Check if any fingertip is near a world position
function anyFingertipNear(hand, targetWorldPos, maxDist) {
  for (const tipName of FINGERTIP_JOINTS) {
    const tipJoint = hand.joints[tipName];
    if (!tipJoint) continue;
    tipJoint.getWorldPosition(_tipWorld);
    if (_tipWorld.distanceTo(targetWorldPos) < maxDist) return true;
  }
  return false;
}

// --- Highlight: glow when fingertips are near a grabbable ---
const _highlightOrigColors = new WeakMap();

function setHighlight(obj, on) {
  obj.traverse(child => {
    if (!child.isMesh || !child.material) return;
    if (on) {
      if (!_highlightOrigColors.has(child)) {
        _highlightOrigColors.set(child, child.material.emissive?.clone());
      }
      if (child.material.emissive) {
        child.material.emissive.setHex(0x224400);
        child.material.emissiveIntensity = 0.6;
      }
    } else {
      const orig = _highlightOrigColors.get(child);
      if (orig && child.material.emissive) {
        child.material.emissive.copy(orig);
        child.material.emissiveIntensity = 0;
      }
    }
  });
}

// --- Per-frame update ---
function updateHandTracking() {
  for (const hand of hands) {
    const wrist = hand.joints['wrist'];
    if (!wrist) continue;

    const curl = getFingerCurl(hand);
    const isGripping = curl < HAND_GRAB_CURL;
    const wasGripping = hand.userData.gripping;

    // -- Proximity highlight via fingertips (only when NOT holding) --
    if (!hand.userData.holding) {
      const near = findNearestToFingertips(hand, HAND_FINGER_TOUCH);
      if (near !== hand.userData.nearObj) {
        if (hand.userData.nearObj) setHighlight(hand.userData.nearObj, false);
        hand.userData.nearObj = near;
        if (near) setHighlight(near, true);
      }
    }

    // -- Grip transition: open → closed --
    if (isGripping && !wasGripping) {
      hand.userData.gripping = true;

      if (!hand.userData.holding) {
        // Grab: whatever was highlighted (fingertips touching) gets grabbed
        const target = hand.userData.nearObj || findNearestToFingertips(hand, HAND_FINGER_TOUCH);
        if (target) {
          if (hand.userData.nearObj) setHighlight(hand.userData.nearObj, false);
          hand.userData.nearObj = null;
          attachToHand(target, hand);
        }

        // Start button — any fingertip near it
        if (!hand.userData.holding && startButton?.visible) {
          const btnPos = new THREE.Vector3();
          startButton.getWorldPosition(btnPos);
          if (anyFingertipNear(hand, btnPos, HAND_BUTTON_TOUCH)) onStart();
        }

        // Switch — any fingertip near it
        if (!hand.userData.holding && currentState === STATE.SWITCH && !switchGroup.userData.activated) {
          const swPos = new THREE.Vector3();
          switchGroup.getWorldPosition(swPos);
          if (anyFingertipNear(hand, swPos, HAND_BUTTON_TOUCH)) onSwitchToggle();
        }
      }
    }

    // -- Fuse screw-in: track wrist rotation while holding fuse near socket --
    if (hand.userData.holding && hand.userData.holding.userData.kind === 'fuse' && isGripping) {
      trackFuseScrewIn(hand);
    }

    // -- Grip transition: closed → open --
    if (!isGripping && wasGripping && curl > HAND_RELEASE_CURL) {
      hand.userData.gripping = false;
      if (hand.userData.holding) {
        const g = hand.userData.holding;
        // Reset screw tracking
        hand.userData.screwAngle = 0;
        hand.userData.lastWristAngle = null;
        detachFromHand(g, hand);
        trySnap(g);
      }
    }
  }
}

// --- Fuse screw-in mechanic ---
// When holding a fuse near a fuse socket, track cumulative wrist rotation.
// After enough rotation (~720° = 2 full turns), auto-snap the fuse.
const FUSE_SCREW_DIST = 0.15;      // max distance to socket for screw-in
const FUSE_SCREW_NEEDED = Math.PI * 3; // ~1.5 full turns needed (540°)

function trackFuseScrewIn(hand) {
  const g = hand.userData.holding;
  const gp = new THREE.Vector3();
  g.getWorldPosition(gp);

  // Find nearest unfilled fuse socket in range
  let nearSocket = null, nearDist = FUSE_SCREW_DIST;
  for (const s of fuseSockets) {
    if (s.filled) continue;
    s.group.getWorldPosition(s.worldPos);
    const d = gp.distanceTo(s.worldPos);
    if (d < nearDist) { nearDist = d; nearSocket = s; }
  }

  if (!nearSocket) {
    // Not near a socket — reset tracking
    hand.userData.screwAngle = 0;
    hand.userData.lastWristAngle = null;
    return;
  }

  // Measure wrist rotation around the fist's forward axis (roll)
  const wrist = hand.joints['wrist'];
  if (!wrist) return;
  const wristQuat = new THREE.Quaternion();
  wrist.getWorldQuaternion(wristQuat);
  // Extract roll: project wrist Z-axis onto a plane, measure angle
  const wristRight = new THREE.Vector3(1, 0, 0).applyQuaternion(wristQuat);
  const currentAngle = Math.atan2(wristRight.y, wristRight.x);

  if (hand.userData.lastWristAngle !== null && hand.userData.lastWristAngle !== undefined) {
    let delta = currentAngle - hand.userData.lastWristAngle;
    // Normalize to [-PI, PI]
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    // Only count clockwise rotation (positive delta = screwing in)
    // Accept both directions since handedness varies
    hand.userData.screwAngle = (hand.userData.screwAngle || 0) + Math.abs(delta);

    // Visual feedback: rotate the fuse model as user twists
    g.rotateY(delta * 0.5);

    // Check if enough rotation accumulated
    if (hand.userData.screwAngle >= FUSE_SCREW_NEEDED) {
      // Screw-in complete! Snap the fuse
      hand.userData.screwAngle = 0;
      hand.userData.lastWristAngle = null;
      hand.userData.holding = null;
      g.userData.grabbed = false;
      if (g.parent) g.parent.remove(g);
      scene.add(g);
      snapIntoSocket(g, nearSocket);
      dbg('Fuse screwed in!');
      return;
    }
  }
  hand.userData.lastWristAngle = currentAngle;
}

// --- Attach / Detach ---

function attachToHand(g, hand) {
  // Anchor = middle-finger-phalanx-proximal (knuckle = center of closed fist)
  const anchor = hand.joints['middle-finger-phalanx-proximal'] || hand.joints['wrist'];
  if (!anchor) return;

  g.userData.grabbed = true;
  hand.userData.holding = g;

  // Remove from scene
  if (g.parent) g.parent.remove(g);
  anchor.add(g);

  // Simple local-space rotations. NO world-space quaternion math.
  // WebXR knuckle joint local axes (per spec):
  //   -Z = toward fingertip (forward when fist points at socket)
  //   +Y = toward back of hand (away from palm)
  //   +X = lateral
  //
  // So to make something point "out of the fist" = align it with -Z.

  if (g.userData.kind === 'wire') {
    // Wire built along +X, copper tip at +X (x=0.102).
    // Want +X → -Z (copper points forward out of fist)
    // rotation.y = -PI/2: +X rotates to -Z ✓
    g.quaternion.identity();
    g.rotation.set(0, -Math.PI / 2, 0);
    g.position.set(0, 0, -0.04);
  } else if (g.userData.kind === 'fuse') {
    // Fuse built along +Y. Thread at -Y, cap at +Y.
    // Want -Y → -Z (thread points forward into socket)
    // rotation.x = -PI/2: +Y→+Z, -Y→-Z ✓
    g.quaternion.identity();
    g.rotation.set(-Math.PI / 2, 0, 0);
    g.position.set(0, 0, -0.03);
  } else if (g.userData.kind === 'lamp') {
    // Lamp built along +Y. Screw at -Y, bulb at +Y.
    // Want -Y → -Z (screw points forward toward ceiling socket)
    g.quaternion.identity();
    g.rotation.set(-Math.PI / 2, 0, 0);
    g.position.set(0, 0, -0.05);
  } else {
    g.quaternion.identity();
    g.position.set(0, 0, -0.04);
  }

  dbg(`Hand grab: ${g.userData.kind}`);
}

function detachFromHand(g, hand) {
  g.userData.grabbed = false;
  hand.userData.holding = null;

  const wp = new THREE.Vector3();
  const wq = new THREE.Quaternion();
  g.getWorldPosition(wp);
  g.getWorldQuaternion(wq);

  if (g.parent) g.parent.remove(g);
  scene.add(g);
  g.position.copy(wp);
  g.quaternion.copy(wq);

  dbg(`Hand release: ${g.userData.kind}`);
}

// Raycaster for pointer-style interaction
const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();

function getControllerRay(ctrl) {
  tempMatrix.identity().extractRotation(ctrl.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(ctrl.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
  return raycaster;
}

// Walk up parent chain until we find an object with userData.kind (a grabbable) or a button group
function findInteractableRoot(obj) {
  while (obj) {
    if (obj.userData && (obj.userData.kind || obj === startButton || obj === switchGroup)) return obj;
    obj = obj.parent;
  }
  return null;
}

function onSelectStart(event) {
  const ctrl = event.target;
  ctrl.userData.triggerDown = true;

  const ray = getControllerRay(ctrl);

  // 1. Start button (via ray)
  if (currentState === STATE.INTRO && startButton.userData.active && startButton.visible) {
    const hits = ray.intersectObject(startButton, true);
    if (hits.length > 0) { onStart(); return; }
  }

  // 2. Wall switch (via ray)
  if (currentState === STATE.SWITCH && !switchGroup.userData.activated) {
    const hits = ray.intersectObject(switchGroup, true);
    if (hits.length > 0) { onSwitchToggle(); return; }
  }

  // 3. Grabbables (via ray first, then proximity fallback)
  const candidates = grabbables.filter(g => !g.userData.snapped && isGrabbableInCurrentState(g));
  if (candidates.length === 0) return;

  // Ray check
  const hits = ray.intersectObjects(candidates, true);
  if (hits.length > 0) {
    const root = findInteractableRoot(hits[0].object);
    if (root && root.userData.kind) {
      attachToController(root, ctrl);
      return;
    }
  }

  // Proximity fallback
  const cp = new THREE.Vector3();
  ctrl.getWorldPosition(cp);
  let nearest = null;
  let nearestDist = GRAB_DIST;
  for (const g of candidates) {
    const gp = new THREE.Vector3();
    g.getWorldPosition(gp);
    const d = cp.distanceTo(gp);
    if (d < nearestDist) { nearestDist = d; nearest = g; }
  }
  if (nearest) {
    attachToController(nearest, ctrl);
  }
}

function onSelectEnd(event) {
  const ctrl = event.target;
  ctrl.userData.triggerDown = false;
  const held = ctrl.userData.holding;
  if (!held) return;

  // Detach
  detachFromController(held, ctrl);

  // Try to snap
  trySnap(held);
}

function isGrabbableInCurrentState(g) {
  if (currentState === STATE.WIRING && g.userData.kind === 'wire') return true;
  if (currentState === STATE.FUSES && g.userData.kind === 'fuse') return true;
  if (currentState === STATE.LAMP && g.userData.kind === 'lamp') return true;
  return false;
}

function attachToController(g, ctrl) {
  g.userData.grabbed = true;
  ctrl.userData.holding = g;
  // Reparent: compute local transform
  const wp = new THREE.Vector3();
  g.getWorldPosition(wp);
  scene.remove(g);
  ctrl.add(g);
  ctrl.worldToLocal(wp);
  g.position.copy(wp);
  // Auto-Orientierung abhängig vom Objekt:
  if (g.userData.kind === 'lamp') {
    // Gewinde zeigt hoch, Glaskolben runter — direkt passend zur Deckenfassung
    g.rotation.set(Math.PI, 0, 0);
    g.position.y += 0.04; // etwas über der Hand halten
  } else if (g.userData.kind === 'fuse') {
    // Kappe zeigt weg vom User (+Z im Controller-Space), Gewinde vorne
    g.rotation.set(-Math.PI / 2, 0, 0);
    g.position.y += 0.02;
  } else if (g.userData.kind === 'wire') {
    // Draht horizontal, Spitze nach vorne (in -Z des Controllers)
    g.rotation.set(0, -Math.PI / 2, 0);
  } else {
    g.quaternion.identity();
  }
}

function detachFromController(g, ctrl) {
  g.userData.grabbed = false;
  ctrl.userData.holding = null;
  const wp = new THREE.Vector3();
  const wq = new THREE.Quaternion();
  g.getWorldPosition(wp);
  g.getWorldQuaternion(wq);
  ctrl.remove(g);
  scene.add(g);
  g.position.copy(wp);
  g.quaternion.copy(wq);
}

// ---------- Snap logic ----------
function trySnap(g) {
  const gp = new THREE.Vector3();
  g.getWorldPosition(gp);

  let sockets = [];
  if (g.userData.kind === 'wire') sockets = wireSockets;
  else if (g.userData.kind === 'fuse') sockets = fuseSockets;
  else if (g.userData.kind === 'lamp') sockets = [lampSocket];

  let best = null;
  let bestDist = SNAP_DIST;
  for (const s of sockets) {
    if (s.filled) continue;
    s.group.getWorldPosition(s.worldPos);
    const d = gp.distanceTo(s.worldPos);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }

  if (!best) {
    // No socket in range → return home
    tweenHome(g);
    return;
  }

  // Validate
  const valid =
    (g.userData.kind === 'wire' && best.expectedId === g.userData.id) ||
    (g.userData.kind === 'fuse') || // any fuse in any fuse socket
    (g.userData.kind === 'lamp');

  if (!valid) {
    // Wrong wire color → bounce back with red flash
    flashSocket(best, 0xff3333);
    tweenHome(g);
    return;
  }

  // Snap it in!
  snapIntoSocket(g, best);
}

function snapIntoSocket(g, s) {
  g.userData.snapped = true;
  s.filled = true;
  // Zielposition im World-Space
  s.group.getWorldPosition(s.worldPos);
  g.position.copy(s.worldPos);
  g.quaternion.identity();

  if (g.userData.kind === 'wire') {
    // Draht horizontal, Spitze zeigt in -Z (ins Loch der Klemme)
    // Der Draht wurde so gebaut: body liegt entlang X, tip bei +X.
    // Wir wollen tip in -Z: Rotation um Y um -Math.PI/2 → +X wird zu +Z ??
    // Standard Three.js: rotation.y = -PI/2 rotiert X-Achse zu -Z. Passt.
    g.rotation.set(0, -Math.PI / 2, 0);
    // Leicht nach vorne setzen so dass Draht aus der Klemme rausragt
    g.position.z += 0.09;
    // Status = "lose" → gelber Ring (noch nicht festgeschraubt)
    g.userData.loose = true;
    s.ring.material.color.setHex(0xffd633);
    s.ring.material.opacity = 1.0;
    s.wireObj = g;
  } else if (g.userData.kind === 'fuse') {
    // Sicherung horizontal: Kappe zeigt in +Z, Gewindesockel geht ins Loch (-Z)
    // Die Sicherung wurde entlang Y gebaut (Kappe oben). Rotation X um -PI/2
    // dreht +Y nach +Z → Kappe zeigt zum User, Gewindeseite geht in die Dose.
    g.rotation.set(-Math.PI / 2, 0, 0);
    // Leicht nach vorne, so dass Patronen-Kappe vor dem Sockel sichtbar bleibt
    g.position.z += 0.035;
    // Einschraub-Animation um Z-Achse (die neue Längsachse nach Rotation)
    animateScrewAxis(g, 'z', 0.9, 2.5);
  } else if (g.userData.kind === 'lamp') {
    // Lampe hängt unter der Deckenfassung (Gewinde oben, Glaskolben unten)
    // makeLampBulb baut: bulb oben (y+), screw unten (y-). Also Rotation.x = PI
    // dreht Birne nach unten, Gewinde nach oben = direkt in die Deckenfassung.
    g.rotation.set(Math.PI, 0, 0);
    g.position.y -= 0.05;
    // Einschraub-Animation — 3 volle Umdrehungen um Y-Achse
    animateScrewAxis(g, 'y', 1.2, 3);
  }

  // State progression (Drähte: erst wenn alle festgezogen)
  advanceState();
}

function tweenHome(g) {
  // Simple instant return (could animate later)
  g.position.copy(g.userData.homePos);
  g.rotation.copy(g.userData.homeRot);
}

function flashSocket(s, color) {
  if (s.ring) {
    s.ring.material.color.setHex(color);
    s.ring.material.opacity = 1;
    setTimeout(() => {
      s.ring.material.color.setHex(0x22dd22);
      fadeOut(s.ring.material, 0.5);
    }, 300);
  }
}

function fadeOut(material, duration) {
  const start = performance.now();
  const startOpacity = material.opacity;
  function step() {
    const t = (performance.now() - start) / (duration * 1000);
    if (t >= 1) { material.opacity = 0; return; }
    material.opacity = startOpacity * (1 - t);
    requestAnimationFrame(step);
  }
  step();
}

function animateScrew(obj, duration) {
  animateScrewAxis(obj, 'y', duration, 2);
}

// Schraubt das Objekt um die gegebene lokale Achse, "turns" volle Umdrehungen.
// Behält End-Rotation 0 auf dieser Achse (fertig eingedreht).
function animateScrewAxis(obj, axis, duration, turns) {
  const start = performance.now();
  const baseRot = { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z };
  const axisKey = axis;
  function step() {
    const t = (performance.now() - start) / (duration * 1000);
    if (t >= 1) {
      obj.rotation[axisKey] = baseRot[axisKey];
      return;
    }
    // ease-out (startet schnell, endet langsam — wie echtes Reindrehen mit Widerstand)
    const eased = 1 - Math.pow(1 - t, 2);
    obj.rotation[axisKey] = baseRot[axisKey] + (1 - eased) * Math.PI * 2 * turns;
    requestAnimationFrame(step);
  }
  step();
}

// ---------- State machine ----------
function onStart() {
  startTime = performance.now();
  currentState = STATE.WIRING;
  startButton.userData.active = false;
  startButton.visible = false;
  console.log('[Game] STARTED → WIRING');
  dbg('>> STARTED: grab wires');
}

function advanceState() {
  if (currentState === STATE.WIRING && wireSockets.every(s => s.filled)) {
    currentState = STATE.FUSES;
    dbg('>> WIRES DONE -> FUSES');
  } else if (currentState === STATE.FUSES && fuseSockets.every(s => s.filled)) {
    currentState = STATE.LAMP;
    dbg('>> FUSES DONE -> LAMP');
  } else if (currentState === STATE.LAMP && lampSocket.filled) {
    currentState = STATE.SWITCH;
    dbg('>> LAMP DONE -> SWITCH');
  }
}

function onSwitchToggle() {
  if (switchGroup.userData.activated) return;
  switchGroup.userData.activated = true;
  // Flip toggle visually
  switchGroup.userData.toggleMesh.rotation.x = -0.25;
  // Turn on room light + lamp emissive
  roomLight.intensity = 2.5;
  ambient.intensity = 0.9;
  if (lampBulb.userData.bulbMesh) {
    lampBulb.userData.bulbMesh.material.emissive.setHex(0xfff1c4);
    lampBulb.userData.bulbMesh.material.emissiveIntensity = 2.2;
  }
  if (lampBulb.userData.filamentMesh) {
    lampBulb.userData.filamentMesh.material.emissive.setHex(0xffcc66);
    lampBulb.userData.filamentMesh.material.emissiveIntensity = 4.5;
  }
  // Fake-bloom halo around the lit glass
  if (lampBulb.userData.glowSprite) {
    const s = lampBulb.userData.glowSprite;
    s.material.opacity = 0.0;
    s.scale.set(0.3, 0.3, 1);
    // Gentle fade-in + scale-up to hint at warm-up
    const start = performance.now();
    function step() {
      const t = Math.min(1, (performance.now() - start) / 350);
      s.material.opacity = 0.9 * t;
      const sz = 0.3 + 0.35 * t;
      s.scale.set(sz, sz, 1);
      if (t < 1) requestAnimationFrame(step);
    }
    step();
  }
  finishTime = performance.now();
  currentState = STATE.FINISH;
  console.log(`[Game] FINISH! Time: ${((finishTime-startTime)/1000).toFixed(2)}s`);

  // Schedule auto-reset
  resetTimer = setTimeout(doReset, AUTO_RESET_DELAY * 1000);
}

function doReset() {
  console.log('[Game] RESET');
  // Reset all grabbables
  for (const g of grabbables) {
    if (g.parent !== scene) {
      g.parent.remove(g);
      scene.add(g);
    }
    g.position.copy(g.userData.homePos);
    g.rotation.copy(g.userData.homeRot);
    g.userData.grabbed = false;
    g.userData.snapped = false;
  }
  // Reset sockets
  for (const s of wireSockets) { s.filled = false; s.ring.material.opacity = 0; }
  for (const s of fuseSockets) { s.filled = false; }
  lampSocket.filled = false;
  // Reset switch
  switchGroup.userData.activated = false;
  switchGroup.userData.toggleMesh.rotation.x = 0.25;
  // Reset lamp bulb emissive + glow halo
  if (lampBulb.userData.glowSprite) {
    lampBulb.userData.glowSprite.material.opacity = 0;
    lampBulb.userData.glowSprite.scale.set(0.3, 0.3, 1);
  }
  if (lampBulb.userData.bulbMesh) {
    lampBulb.userData.bulbMesh.material.emissive.setHex(0x000000);
    lampBulb.userData.bulbMesh.material.emissiveIntensity = 0;
  }
  if (lampBulb.userData.filamentMesh) {
    lampBulb.userData.filamentMesh.material.emissive.setHex(0x000000);
    lampBulb.userData.filamentMesh.material.emissiveIntensity = 0;
  }
  // Reset light
  roomLight.intensity = 0;
  ambient.intensity = 0.55;
  // Reset start button
  startButton.userData.active = true;
  startButton.visible = true;
  // Reset state
  currentState = STATE.INTRO;
  startTime = 0;
  finishTime = 0;
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
}

// ---------- Render loop ----------
let lastHudUpdate = 0;
function loop(now) {
  // Throttle HUD redraw to ~10fps (expensive)
  if (now - lastHudUpdate > 100) {
    drawHUD();
    lastHudUpdate = now;
  }
  // Animate dust motes — gentle drift
  const timeS = now * 0.001;
  for (const d of dustMotes) {
    const u = d.userData;
    d.position.x = u.basePos.x + Math.sin(timeS * u.driftSpeed + u.driftOffset) * u.driftRadius;
    d.position.y = u.basePos.y + Math.cos(timeS * u.driftSpeed * 0.7 + u.driftOffset * 1.3) * u.driftRadius * 0.5;
    d.position.z = u.basePos.z + Math.sin(timeS * u.driftSpeed * 0.5 + u.driftOffset * 2.1) * u.driftRadius * 0.3;
  }
  // Pulse switch aura while it's the active step
  const aura = switchGroup.userData.auraMat;
  if (aura) {
    if (currentState === STATE.SWITCH && !switchGroup.userData.activated) {
      const p = 0.5 + 0.5 * Math.sin(now * 0.006);
      aura.color.setRGB(1.0, 0.9, 0.2);
      aura.opacity = 0.35 + 0.35 * p;
    } else if (switchGroup.userData.activated) {
      aura.color.setRGB(0.3, 1.0, 0.3);
      aura.opacity = 0.45;
    } else {
      aura.opacity = 0.0;
    }
  }
  updateHandTracking();
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(loop);

// ---------- Desktop fallback: keyboard Start ----------
window.addEventListener('keydown', (e) => {
  if (e.key === 's' && currentState === STATE.INTRO) onStart();
  if (e.key === 'r') doReset();
});

console.log('[Marktmeile VR] Loaded. Press VR button on Quest, or press "s" on desktop.');
