/* Blarf OS P3a: 3D avatar renderer (three.js r170, ES module, loaded lazily by blarf-avatar.js only when 3D is on).
   One brain, two renderers: the 2D face engine in index.html keeps running and publishes its per-frame state in
   window.blarfFace3 (mouth curve, brows, lids, gaze, head, current act, needs, grouch, cigarette). This module draws it:
   either the built-in procedural 3D Blarf (driven point-for-point from the 2D mouth/brow curves, so every viseme, act and
   reaction matches), or Kyle's own .glb/.gltf/.vrm, whose VRM expressions / ARKit blendshapes / Oculus visemes, blink,
   brows, emotions, gaze and head bone are driven from the same state. Everything stays on the device. */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export const VERSION = "p3a-1";
const PI = Math.PI;
const cl = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const ss = t => { t = cl(t); return t * t * (3 - 2 * t); };
const env = (p, a, b) => (p < a ? ss(p / a) : p > b ? 1 - ss((p - b) / (1 - b)) : 1);
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-dt / k));

/* ---------- built-in head geometry: the 2D face (viewBox 0..200) projected onto an ellipsoid ---------- */
export const RX = 1, RY = 1.3, RZ = 0.95;
export function face2D(x, y) { return [(x - 100) / 98 * RX, -(y - 105) / 128 * RY]; }
export function surfZ(X, Y) { const q = 1 - (X / RX) * (X / RX) - (Y / RY) * (Y / RY); return q > 0 ? RZ * Math.sqrt(q) : 0; }
export function to3D(x, y, lift = 0, out) {
  const [X, Y] = face2D(x, y), v = out || new THREE.Vector3();
  const z = surfZ(X, Y);
  /* lift along the surface normal so features hug the head */
  const n = new THREE.Vector3(X / (RX * RX), Y / (RY * RY), z / (RZ * RZ)).normalize();
  return v.set(X + n.x * lift, Y + n.y * lift, z + n.z * lift);
}
/* head-local point back to 2D face coordinates (what zoneAt() in index.html understands) */
export function from3D(v) { return { x: 100 + v.x / RX * 98, y: 105 - v.y / RY * 128 }; }
/* the 2D hero jaw transform: translate(0 j) translate(100 150) rotate(-9) scale(0.92 0.84) skewX(-8) translate(-94 -150) */
const JC = Math.cos(-9 * PI / 180), JS = Math.sin(-9 * PI / 180), JK = Math.tan(-8 * PI / 180);
export function jawPt(x, y, j) { let a = x - 94, b = y - 150; a = (a + JK * b) * 0.92; b *= 0.84; return [100 + a * JC - b * JS, 150 + a * JS + b * JC + j]; }
const VA_REST = [64, 143, 82, 147, 120, 146, 136, 138, 122, 163, 78, 165];
const BROW_REST = [44, 50, 68, 38, 92, 48, 108, 48, 132, 38, 156, 50];
function bez(p0, p1, p2, p3, t) { const u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; }
/* the mouth outline (2D, before the jaw transform) sampled into 2*N points */
export function mouthOutline(m, N = 14) {
  const out = [];
  for (let i = 0; i < N; i++) { const t = i / N; out.push([bez(m[0], m[2], m[4], m[6], t), bez(m[1], m[3], m[5], m[7], t)]); }
  for (let i = 0; i < N; i++) { const t = i / N; out.push([bez(m[6], m[8], m[10], m[0], t), bez(m[7], m[9], m[11], m[1], t)]); }
  return out;
}

/* ---------- reading the face state into generic channels (any model) ---------- */
export function mouthGeo(m, jaw = 0) {
  const top = (m[3] + m[5]) / 2, bot = (m[9] + m[11]) / 2, h = bot - top;
  const w = m[6] - m[0], cy = (m[1] + m[7]) / 2, mid = (top + bot) / 2;
  return { open: cl((h - 14) / 60 + jaw / 14 * 0.4), wide: cl((w - 72) / 18, -1, 1), smile: cl((mid - cy - 7) / 8, -1, 1) };
}
const VNAMES = ["rest", "MBP", "AH", "EE", "OH", "OO", "FV", "SS"];
export function channels(D) {
  D = D || {};
  const m = D.mouth && D.mouth.length === 12 ? D.mouth : VA_REST, g = mouthGeo(m, D.jaw || 0);
  let v = [1, 0, 0, 0, 0, 0, 0, 0];
  if (D.lip && D.vis) {
    let t = 0; for (let i = 0; i < 8; i++) t += D.vis[i] || 0;
    v = D.vis.map(x => (x || 0) / (t || 1));
  } else if (g.open > 0.08) {
    const round = cl(-g.wide * 1.4);
    v = [0, 0, g.open * (1 - round), cl(g.wide) * 0.5, g.open * round, round * (1 - g.open), 0, 0];
  }
  const b = D.brows && D.brows.length === 12 ? D.brows : BROW_REST;
  const avg = o => (b[o + 1] + b[o + 3] + b[o + 5]) / 3;
  const raiseL = cl((45.3 - avg(0)) / 14, -1, 1), raiseR = cl((45.3 - avg(6)) / 14, -1, 1);
  const anger = cl(Math.max(D.sc || 0, D.ign ? 1 : 0));
  const act = D.act || "", ap = D.ap || 0;
  const happy = cl((D.md === "excited" ? 0.6 : 0) + (/^(proud|play|gamer)$/.test(act) ? 0.5 * env(ap, 0.15, 0.8) : 0));
  const relaxed = cl((D.soft ? 0.5 : 0) + (act === "pet" ? 0.6 * env(ap, 0.15, 0.85) : 0));
  const sad = cl((D.sulk || 0) * 1.2 + (act === "phew" ? 0.2 : 0));
  const surprised = cl(Math.max(raiseL, raiseR) - 0.45) * 1.6;
  const lid = D.lid || [0, 0];
  return {
    open: g.open, wide: g.wide, smile: g.smile, v, vn: VNAMES, lip: !!D.lip,
    blinkL: cl(lid[0]), blinkR: cl(lid[1]), raiseL, raiseR, anger, happy, relaxed, sad, surprised: cl(surprised),
    cheekL: cl((D.cheek || [0, 0])[0]), cheekR: cl((D.cheek || [0, 0])[1]),
    lookX: cl(D.gx || 0, -1, 1), lookY: cl(D.gy || 0, -1, 1)
  };
}
/* extra 3D head motion per act (the 2D act already moves eyes, mouth, brows and roll); radians */
export function actMotion(D, t) {
  const p = D.ap || 0, n = D.act || "";
  let yaw = 0, pitch = 0, e;
  if (n === "shake" || n === "error") { e = env(p, 0.1, 0.85); yaw = 0.32 * Math.sin(6 * PI * p) * e; }
  else if (n === "nod" || n === "onit") pitch = 0.2 * Math.abs(Math.sin(2 * PI * p)) * (1 - 0.4 * p);
  else if (n === "yawn") pitch = -0.28 * env(p, 0.35, 0.72);
  else if (n === "phone") pitch = 0.3 * env(p, 0.22, 0.8);
  else if (n === "side") { e = env(p, 1 / 7, 6 / 7); yaw = -0.28 * e; }
  else if (n === "roll") pitch = -0.12 * Math.sin(PI * p);
  else if (n === "sip") pitch = (p < 0.62 ? -0.18 : 0.05) * env(p, 0.15, 0.85);
  else if (n === "eat") pitch = 0.07 * Math.sin(8 * PI * p) * env(p, 0.12, 0.88);
  else if (n === "wake") { e = env(p, 0.05, 0.8); yaw = 0.12 * Math.sin(5 * PI * p) * (p < 0.6 ? 1 : 0); pitch = -0.08 * e; }
  else if (n === "gamer" || n === "play") pitch = -0.1 * env(p, 0.08, 0.85);
  else if (n === "crew") { e = Math.sin(2 * PI * p); yaw = 0.25 * e * env(p, 0.1, 0.9); }
  else if (n === "think" || n === "expert") { e = env(p, 0.1, 0.88); yaw = -0.12 * e; pitch = -0.1 * e; }
  if (!n && D.md === "thinking") { yaw = -0.12; pitch = -0.12; }
  if (D.sleep) pitch += 0.25;
  if (D.ign) yaw += 0.5 * Math.sign(D.hx || 1);
  const k = D.calm ? 0.3 : 1;
  /* idle life: a slow drift so he never looks frozen */
  const drift = D.calm ? 0 : 1;
  return { yaw: yaw * k + drift * (Math.sin(t / 3100) * 0.035 + Math.sin(t / 1900) * 0.012), pitch: pitch * k + drift * Math.sin(t / 4300) * 0.02 };
}

/* ---------- textures generated on the device (no image files) ---------- */
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function dataTex(w, h, fill, srgb) {
  const d = new Uint8Array(w * h * 4); fill(d, w, h);
  const t = new THREE.DataTexture(d, w, h, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true; return t;
}
function gritTex() {
  const r = rng(7);
  return dataTex(128, 128, (d, w, h) => {
    for (let i = 0; i < w * h; i++) { const n = 200 + r() * 55 - (r() < 0.04 ? 60 : 0); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = n; d[i * 4 + 3] = 255; }
  }, false);
}
function veinTex() {
  const r = rng(11), W = 256, H = 128;
  return dataTex(W, H, (d) => {
    for (let i = 0; i < W * H; i++) { d[i * 4] = 246; d[i * 4 + 1] = 217; d[i * 4 + 2] = 206; d[i * 4 + 3] = 255; }
    const dot = (x, y, a) => { x = ((x % W) + W) % W; if (y < 0 || y >= H) return; const k = (y * W + (x | 0)) * 4; d[k] = d[k] * (1 - a) + 192 * a; d[k + 1] = d[k + 1] * (1 - a) + 57 * a; d[k + 2] = d[k + 2] * (1 - a) + 43 * a; };
    /* veins creep in from the sides of the eye (u ~ 0 and 0.5 are the sides; front is u = 0.25) */
    for (let v = 0; v < 14; v++) {
      let x = (r() < 0.5 ? 0.05 : 0.45) * W + r() * 12, y = H * (0.3 + r() * 0.4), a = r() * PI * 2;
      for (let s = 0; s < 40; s++) { a += (r() - 0.5) * 0.7; x += Math.cos(a) * 1.4; y += Math.sin(a) * 0.9; dot(x, y | 0, 0.85 - s / 60); }
    }
  }, true);
}

/* ---------- a tube whose points we rewrite every frame (brows) ---------- */
function liveTube(seg, rad, mat) {
  const g = new THREE.BufferGeometry(), n = (seg + 1) * rad, idx = [];
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  for (let i = 0; i < seg; i++) for (let j = 0; j < rad; j++) {
    const a = i * rad + j, b = i * rad + (j + 1) % rad, c = a + rad, d = b + rad; idx.push(a, c, b, b, c, d);
  }
  g.setIndex(idx);
  const m = new THREE.Mesh(g, mat); m.userData.tube = { seg, rad }; m.frustumCulled = false; return m;
}
const _t = new THREE.Vector3(), _n = new THREE.Vector3(), _b = new THREE.Vector3(), _p = new THREE.Vector3();
function setTube(mesh, pts, r) {
  const { seg, rad } = mesh.userData.tube, pos = mesh.geometry.attributes.position.array;
  for (let i = 0; i <= seg; i++) {
    const p = pts[i], q = pts[Math.min(seg, i + 1)], o = pts[Math.max(0, i - 1)];
    _t.subVectors(q, o).normalize();
    _n.set(p.x / (RX * RX), p.y / (RY * RY), p.z / (RZ * RZ)).normalize();
    _b.crossVectors(_t, _n).normalize(); _n.crossVectors(_b, _t).normalize();
    const rr = r * (0.55 + 0.45 * Math.sin(PI * i / seg));
    for (let j = 0; j < rad; j++) {
      const a = j / rad * PI * 2, k = (i * rad + j) * 3;
      _p.copy(p).addScaledVector(_n, Math.cos(a) * rr * 0.75).addScaledVector(_b, Math.sin(a) * rr);
      pos[k] = _p.x; pos[k + 1] = _p.y; pos[k + 2] = _p.z;
    }
  }
  mesh.geometry.attributes.position.needsUpdate = true; mesh.geometry.computeVertexNormals();
}

/* ---------- the built-in procedural Blarf ---------- */
export function buildBlarf() {
  const root = new THREE.Group(); root.name = "BlarfBuiltin";
  const head = new THREE.Group(); head.name = "head"; root.add(head);
  const std = (c, o) => new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.8, metalness: 0 }, o || {}));
  const ink = new THREE.MeshBasicMaterial({ color: 0x0b0b0b, side: THREE.BackSide });
  const grit = gritTex();
  /* skull: unit sphere scaled to the head ellipsoid, blue with a top-lit gradient and grain */
  const skull = new THREE.Group(); skull.scale.set(RX, RY, RZ); head.add(skull);
  const sg = new THREE.SphereGeometry(1, 64, 48), col = [], c1 = new THREE.Color("#58B0E6"), c2 = new THREE.Color("#1F6593"), cc = new THREE.Color();
  const sp = sg.attributes.position;
  for (let i = 0; i < sp.count; i++) { const y = sp.getY(i), z = sp.getZ(i); cc.copy(c2).lerp(c1, cl(0.5 + y * 0.45 + z * 0.15)); col.push(cc.r, cc.g, cc.b); }
  sg.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const skin = std(0xffffff, { vertexColors: true, map: grit, bumpMap: grit, bumpScale: 1.2, roughness: 0.78 });
  grit.repeat.set(3, 3);
  const headMesh = new THREE.Mesh(sg, skin); headMesh.name = "skin"; skull.add(headMesh);
  const hull = new THREE.Mesh(sg, ink); hull.scale.setScalar(1.035); skull.add(hull);
  /* cheeks that puff (hidden inside until poked) */
  const cheeks = [-1, 1].map(s => { const c = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 16), skin); c.position.copy(to3D(100 + s * 60, 130, -0.24)); c.userData.base = c.position.clone(); head.add(c); return c; });
  /* little nose bump */
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14), std(0x2E7FB8, { roughness: 0.7 })); nose.position.copy(to3D(100, 116, -0.045)); nose.scale.set(1, 0.85, 0.7); head.add(nose);
  /* eyes: bags, veiny eyeballs that turn, droopy upper lids */
  const eyeMat = std(0xffffff, { map: veinTex(), roughness: 0.35 });
  const bagMat = std(0x2A6C9C, { roughness: 0.85 });
  const lidMat = std(0x3C8FC6, { roughness: 0.75, side: THREE.DoubleSide });
  const eyes = [68, 132].map((cx, j) => {
    const bag = new THREE.Mesh(new THREE.SphereGeometry(0.3, 28, 18), bagMat);
    bag.position.copy(to3D(cx, 100, -0.24)); bag.scale.set(1.0, 0.9, 0.6); head.add(bag);
    const g = new THREE.Group(); g.position.copy(to3D(cx, 84, -0.13)); g.scale.set(1, 1.12, 1); head.add(g);
    const pivot = new THREE.Group(); g.add(pivot);
    const R = 0.262;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(R, 40, 28), eyeMat); pivot.add(ball);
    const rim = new THREE.Mesh(new THREE.SphereGeometry(R, 32, 20), ink); rim.scale.setScalar(1.07); g.add(rim);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.07, 20, 14), std(0x0b0b0b, { roughness: 0.25 }));
    pupil.position.set(0, 0, R * 0.985); pupil.scale.set(1, 1, 0.35); pivot.add(pupil);
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    shine.position.set(0.025, 0.028, R * 1.01); pivot.add(shine);
    const lid = new THREE.Group(); g.add(lid);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(R * 1.05, 40, 14, 0, PI * 2, 0, PI / 2), lidMat); lid.add(cap);
    const edge = new THREE.Mesh(new THREE.TorusGeometry(R * 1.05, 0.016, 8, 48), std(0x0b0b0b)); edge.rotation.x = PI / 2; lid.add(edge);
    return { g, pivot, lid, cx, j };
  });
  /* brows: thick black tubes rebuilt from the 2D brow curves every frame */
  const browMat = std(0x0d0d0d, { roughness: 0.95 });
  const brows = [0, 1].map(() => { const t = liveTube(20, 10, browMat); head.add(t); return t; });
  /* mouth: dark fill that also writes the stencil, so the yellow teeth only show inside it (like the 2D clip-path) */
  const N = 14, MP = 2 * N;
  const mouthGeom = new THREE.BufferGeometry();
  mouthGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array((MP + 1) * 3), 3));
  const mi = []; for (let i = 0; i < MP; i++) mi.push(MP, i, (i + 1) % MP); mouthGeom.setIndex(mi);
  const mouthMat = std(0x3A1218, { roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp });
  const mouth = new THREE.Mesh(mouthGeom, mouthMat); mouth.renderOrder = 2; mouth.frustumCulled = false; mouth.name = "mouth"; head.add(mouth);
  const lipGeom = new THREE.BufferGeometry();
  lipGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MP * 2 * 3), 3));
  const li = []; for (let i = 0; i < MP; i++) { const a = i * 2, b = ((i + 1) % MP) * 2; li.push(a, a + 1, b, b, a + 1, b + 1); } lipGeom.setIndex(li);
  const lips = new THREE.Mesh(lipGeom, new THREE.MeshBasicMaterial({ color: 0x0b0b0b, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }));
  lips.renderOrder = 4; lips.frustumCulled = false; head.add(lips);
  const toothMat = (c) => std(c, { roughness: 0.55, depthTest: false, depthWrite: false, stencilWrite: true, stencilRef: 1,
    stencilFunc: THREE.EqualStencilFunc, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp });
  const TEETH = [[73, 126, 11, 24, -4, 0], [86, 126, 12, 28, 0, 1], [99, 126, 10, 21, 5, 0], [113, 126, 12, 26, -3, 0], [126, 126, 9, 19, 0, 1], [91, 158, 11, 30, 6, 2], [117, 160, 10, 30, 0, 3]];
  const teeth = TEETH.map(([x, y, w, h, r, k]) => {
    const t = new THREE.Mesh(new THREE.BoxGeometry(w / 98, h / 128 * RY, 0.03), toothMat(k & 1 ? 0xCDB45A : 0xE8D27C));
    t.renderOrder = 3; t.frustumCulled = false; t.userData.tooth = { x: x + w / 2, y: y + h / 2, r, low: k >= 2 }; head.add(t); return t;
  });
  /* cigarette at the smirk's right corner, ember and smoke */
  const cig = new THREE.Group(); head.add(cig);
  const cigBody = new THREE.Group(); cig.add(cigBody);
  const paper = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.26, 14), std(0xF2EFE8, { roughness: 0.9 })); paper.rotation.z = PI / 2; paper.position.x = 0.17; cigBody.add(paper);
  const filter = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.08, 14), std(0xD9894A, { roughness: 0.8 })); filter.rotation.z = PI / 2; filter.position.x = 0.02; cigBody.add(filter);
  const ash = new THREE.Mesh(new THREE.CylinderGeometry(0.023, 0.024, 0.025, 12), std(0x6F6F6F)); ash.rotation.z = PI / 2; ash.position.x = 0.31; cigBody.add(ash);
  const emberMat = new THREE.MeshStandardMaterial({ color: 0xFF5A1F, emissive: 0xFF5A1F, emissiveIntensity: 1.2 });
  const ember = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 10), emberMat); ember.position.x = 0.322; cigBody.add(ember);
  cigBody.rotation.set(0, -0.55, -0.38);
  const smokeMat = new THREE.MeshBasicMaterial({ color: 0xD5D9DE, transparent: true, opacity: 0.3, depthWrite: false });
  const smoke = [];
  for (let i = 0; i < 7; i++) { const s = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), smokeMat.clone()); s.userData.ph = i / 7; head.add(s); smoke.push(s); }
  const puffs = [];
  for (let i = 0; i < 4; i++) { const s = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), smokeMat.clone()); s.visible = false; s.userData.ph = i / 4; head.add(s); puffs.push(s); }
  const outfits = buildOutfits(head, skull, std);
  const rig = { kind: "builtin", root, head, skull, eyes, brows, mouth, lips, teeth, cig, cigBody, ember, emberMat, smoke, puffs, cheeks, outfits,
    N, MP, browPts: [[], []], mouthLocal: [], picks: [headMesh, ...eyes.map(e => e.pivot.children[0]), mouth, nose, ...cheeks],
    st: { yaw: 0, pitch: 0, lid: [0.38, 0.38], cig: 1 } };
  cig.traverse(x => { x.renderOrder = 5; });
  for (let b = 0; b < 2; b++) for (let i = 0; i <= 20; i++) rig.browPts[b].push(new THREE.Vector3());
  return rig;
}

function buildOutfits(head, skull, std) {
  const O = {};
  const g = name => { const x = new THREE.Group(); x.name = "outfit-" + name; x.visible = false; head.add(x); O[name] = x; return x; };
  const sk = name => { const x = new THREE.Group(); x.scale.set(RX, RY, RZ); O[name].add(x); return x; };
  /* beanie */
  g("beanie"); let s = sk("beanie");
  let m = new THREE.Mesh(new THREE.SphereGeometry(1.08, 40, 16, 0, PI * 2, 0, PI * 0.36), std(0xB8553C, { roughness: 0.95 })); s.add(m);
  m = new THREE.Mesh(new THREE.TorusGeometry(Math.sin(PI * 0.36) * 1.08, 0.09, 12, 48), std(0x9E4230, { roughness: 0.95 })); m.rotation.x = PI / 2; m.position.y = Math.cos(PI * 0.36) * 1.08; s.add(m);
  m = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), std(0xD9774F, { roughness: 1 })); m.position.y = 1.16; s.add(m);
  O.beanie.rotation.z = 0.07;
  /* Dunkin' cap */
  g("dunkin"); s = sk("dunkin");
  s.add(new THREE.Mesh(new THREE.SphereGeometry(1.07, 40, 16, 0, PI * 2, 0, PI * 0.38), std(0xFF6E1B, { roughness: 0.7 })));
  m = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.04, 32, 1, false, -PI / 2, PI), std(0xE11383, { roughness: 0.6 }));
  m.position.set(0, Math.cos(PI * 0.38) * 1.07 - 0.02, 0.62); m.rotation.x = 0.12; s.add(m);
  m = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.05), std(0xE11383, { roughness: 0.6 })); m.position.set(0, 0.62, 0.86); m.rotation.x = -0.6; s.add(m);
  O.dunkin.rotation.z = 0.08;
  /* crown */
  g("crown");
  const gold = std(0xD4A73A, { metalness: 0.75, roughness: 0.3 });
  m = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.55, 0.26, 32, 1, true), gold); m.material.side = THREE.DoubleSide; O.crown.add(m);
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * PI * 2, k = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.24, 10), gold); k.position.set(Math.sin(a) * 0.52, 0.24, Math.cos(a) * 0.52); O.crown.add(k);
    const gem = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), std([0xC0392B, 0x1E88E5, 0x3E9A4F][i % 3], { roughness: 0.2 })); gem.position.set(Math.sin(a) * 0.56, 0, Math.cos(a) * 0.56); O.crown.add(gem);
  }
  O.crown.position.set(0.05, RY * 0.93, 0); O.crown.rotation.set(-0.12, 0, 0.16);
  /* headphones */
  g("headphones"); s = sk("headphones");
  const dark = std(0x2E3237, { roughness: 0.5, metalness: 0.3 });
  m = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.055, 10, 48, PI), dark); s.add(m);
  [-1, 1].forEach(d => {
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.22, 24), dark); cup.rotation.z = PI / 2; cup.position.set(d * 1.04, 0, 0); s.add(cup);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.025, 8, 32), new THREE.MeshStandardMaterial({ color: 0x4FC3F7, emissive: 0x4FC3F7, emissiveIntensity: 1.5 }));
    ring.rotation.y = PI / 2; ring.position.set(d * 1.16, 0, 0); s.add(ring);
  });
  O.headphones.rotation.z = -0.05;
  /* shades */
  g("shades");
  const lens = new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 0.08, metalness: 0.6, transparent: true, opacity: 0.88 });
  [68, 132].forEach(cx => { const l = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.36, 0.05), lens); l.position.copy(to3D(cx, 82, 0.2)); l.rotation.y = (cx - 100) / 98 * 0.5; O.shades.add(l); });
  m = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.05, 0.05), std(0x0b0b0b)); m.position.copy(to3D(100, 70, 0.17)); O.shades.add(m);
  O.shades.rotation.z = 0.05;
  /* Bruins jersey: shoulders under the head */
  g("bruins");
  m = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20), std(0x111111, { roughness: 0.85 })); m.scale.set(1.6, 0.62, 0.9); m.position.y = -RY - 0.5; O.bruins.add(m);
  m = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.06, 10, 40), std(0xFDB927, { roughness: 0.6 })); m.rotation.x = PI / 2; m.position.y = -RY + 0.0; m.scale.set(1.2, 0.9, 1); O.bruins.add(m);
  m = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.03, 24), std(0xFDB927)); m.rotation.x = PI / 2 - 0.3; m.position.set(0.7, -RY - 0.25, 0.62); O.bruins.add(m);
  return O;
}

/* drive the built-in head from the 2D face state */
const _v = new THREE.Vector3(), _w = new THREE.Vector3();
export function driveBuiltin(rig, D, t, dt, opts) {
  D = D || {};
  const st = rig.st, h = rig.head, calm = !!D.calm;
  const am = actMotion(D, t);
  st.yaw = damp(st.yaw, am.yaw + (D.hx || 0) / 16 * 0.28, 90, dt); st.pitch = damp(st.pitch, am.pitch + (D.ty || 0) / 60 * 0.12, 90, dt);
  h.position.set((D.hx || 0) / 100, -(D.ty || 0) / 100, 0);
  h.rotation.set(st.pitch, st.yaw, -(D.rot || 0) * PI / 180);
  h.scale.setScalar(D.s || 1);
  /* mouth from the exact 2D curve, through the crooked-jaw transform */
  const m = D.mouth && D.mouth.length === 12 ? D.mouth : VA_REST, j = D.jaw || 0, ol = mouthOutline(m, rig.N);
  const pos = rig.mouth.geometry.attributes.position.array, lp = rig.lips.geometry.attributes.position.array;
  let cx = 0, cy = 0;
  const pts = ol.map(([x, y]) => { const q = jawPt(x, y, j); cx += q[0]; cy += q[1]; return q; });
  cx /= pts.length; cy /= pts.length;
  for (let i = 0; i < pts.length; i++) {
    to3D(pts[i][0], pts[i][1], 0.012, _v); pos[i * 3] = _v.x; pos[i * 3 + 1] = _v.y; pos[i * 3 + 2] = _v.z;
    const a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length];
    let nx = b[1] - a[1], ny = -(b[0] - a[0]); const L = Math.hypot(nx, ny) || 1; nx /= L; ny /= L;
    if (nx * (pts[i][0] - cx) + ny * (pts[i][1] - cy) < 0) { nx = -nx; ny = -ny; }
    to3D(pts[i][0] - nx * 0.5, pts[i][1] - ny * 0.5, 0.013, _v); to3D(pts[i][0] + nx * 4.5, pts[i][1] + ny * 4.5, 0.013, _w);
    lp.set([_v.x, _v.y, _v.z, _w.x, _w.y, _w.z], i * 6);
  }
  to3D(cx, cy, 0.012, _v); pos.set([_v.x, _v.y, _v.z], pts.length * 3);
  rig.mouth.geometry.attributes.position.needsUpdate = true; rig.mouth.geometry.computeVertexNormals(); rig.mouth.geometry.computeBoundingSphere();
  rig.lips.geometry.attributes.position.needsUpdate = true;
  rig.mouthLocal = pts;
  rig.teeth.forEach(tm => {
    const u = tm.userData.tooth, q = jawPt(u.x, u.y, j);
    to3D(q[0], q[1], 0.03, tm.position); tm.rotation.set(0, (q[0] - 100) / 98 * 0.5, (-9 + u.r) * PI / 180);
  });
  /* brows */
  const b = D.brows && D.brows.length === 12 ? D.brows : BROW_REST;
  for (let k = 0; k < 2; k++) {
    const o = k * 6, P = rig.browPts[k];
    for (let i = 0; i <= 20; i++) {
      const s = i / 20, u = 1 - s;
      const x = u * u * b[o] + 2 * u * s * b[o + 2] + s * s * b[o + 4], y = u * u * b[o + 1] + 2 * u * s * b[o + 3] + s * s * b[o + 5];
      to3D(x, y + 4, 0.05, P[i]);
    }
    setTube(rig.brows[k], P, 0.075);
  }
  /* eyes: gaze, lids (Blarf's droop is built in), excited wide eyes */
  const lid = D.lid || [0, 0], es = D.es || 1;
  rig.eyes.forEach((e, k) => {
    e.pivot.rotation.set(cl((D.gy || 0) + 0.18, -1, 1) * 0.42, cl(D.gx || 0, -1, 1) * 0.5, 0);
    const want = D.sleep ? 1 : cl(0.38 + lid[k] * 0.72 - (es - 1) * 1.5);
    st.lid[k] = damp(st.lid[k], want, want > st.lid[k] ? 30 : 70, dt);
    e.lid.rotation.x = -1.05 + st.lid[k] * (PI / 2 + 1.05) + (k ? 0.04 : -0.06);
    e.g.scale.y = 1.12 * (0.9 + 0.1 * es);
  });
  rig.cheeks.forEach((c, k) => { const p = (D.cheek || [0, 0])[k] || 0; c.position.copy(c.userData.base).multiplyScalar(1 + p * 0.12); c.scale.setScalar(1 + p * 0.4); });
  /* cigarette: Swearing ON only, hidden while the mouth is wide open; drags glow the ember */
  const cigOK = opts && opts.cig !== false && (D.cigO === undefined || D.cigO > 0.5);
  st.cig = damp(st.cig, cigOK ? 1 : 0, 90, dt);
  rig.cig.visible = st.cig > 0.05; rig.cig.scale.setScalar(Math.max(0.001, st.cig));
  const rc = jawPt(m[6], m[7], j); to3D(rc[0] - 1, rc[1], 0.02, rig.cig.position);
  rig.emberMat.emissiveIntensity = D.drag ? 3 + Math.sin(t / 90) * 0.6 : 1 + Math.sin(t / 700) * 0.25;
  rig.ember.updateWorldMatrix(true, false);
  const tip = rig.cigBody.localToWorld(_w.set(0.33, 0, 0)), tipL = rig.head.worldToLocal(tip.clone());
  rig.smoke.forEach(s => {
    const ph = ((t / 2600) + s.userData.ph) % 1;
    s.visible = rig.cig.visible && !calm;
    s.position.set(tipL.x + Math.sin(ph * 7 + s.userData.ph * 9) * 0.04 * ph, tipL.y + ph * 0.55, tipL.z + ph * 0.05);
    s.scale.setScalar(0.6 + ph * 2.2); s.material.opacity = 0.32 * (1 - ph) * Math.min(1, ph * 6);
  });
  const lc = jawPt(m[0], m[1], j), lcv = to3D(lc[0] - 4, lc[1] - 2, 0.06, _v.set(0, 0, 0)).clone();
  rig.puffs.forEach(s => {
    const ph = ((t / 1500) + s.userData.ph) % 1;
    s.visible = !!D.puff && rig.cig.visible && !calm;
    s.position.set(lcv.x - ph * 0.25, lcv.y + ph * 0.3, lcv.z + ph * 0.2); s.scale.setScalar(0.8 + ph * 3); s.material.opacity = 0.35 * (1 - ph);
  });
  /* outfits follow the html.x-out-<id> class the 2D face uses */
  const wear = (opts && opts.outfit) || "";
  for (const k in rig.outfits) rig.outfits[k].visible = k === wear;
}

/* ---------- custom models: inspect, detect morphs/expressions/clips/bones, drive ---------- */
export const ARKIT = ["eyeBlinkLeft", "eyeLookDownLeft", "eyeLookInLeft", "eyeLookOutLeft", "eyeLookUpLeft", "eyeSquintLeft", "eyeWideLeft",
  "eyeBlinkRight", "eyeLookDownRight", "eyeLookInRight", "eyeLookOutRight", "eyeLookUpRight", "eyeSquintRight", "eyeWideRight",
  "jawForward", "jawLeft", "jawRight", "jawOpen", "mouthClose", "mouthFunnel", "mouthPucker", "mouthLeft", "mouthRight",
  "mouthSmileLeft", "mouthSmileRight", "mouthFrownLeft", "mouthFrownRight", "mouthDimpleLeft", "mouthDimpleRight", "mouthStretchLeft", "mouthStretchRight",
  "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper", "mouthPressLeft", "mouthPressRight", "mouthLowerDownLeft", "mouthLowerDownRight",
  "mouthUpperUpLeft", "mouthUpperUpRight", "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
  "cheekPuff", "cheekSquintLeft", "cheekSquintRight", "noseSneerLeft", "noseSneerRight", "tongueOut"];
export const OCULUS = ["viseme_sil", "viseme_PP", "viseme_FF", "viseme_TH", "viseme_DD", "viseme_kk", "viseme_CH", "viseme_SS", "viseme_nn", "viseme_RR", "viseme_aa", "viseme_E", "viseme_I", "viseme_O", "viseme_U"];
export const VRM_EXPR = ["aa", "ih", "ou", "ee", "oh", "blink", "blinkLeft", "blinkRight", "happy", "angry", "sad", "relaxed", "surprised", "neutral", "lookUp", "lookDown", "lookLeft", "lookRight"];
/* "mouthSmile_L", "blendShape1.mouthSmileLeft", "ARKit_jawOpen" -> one key */
export function normMorph(n) {
  let s = String(n || "").split(/[.|:]/).pop().replace(/^(arkit|blendshape\d*|bs)[_\- ]?/i, "");
  s = s.replace(/[_\- ]?(l|left)$/i, "Left").replace(/[_\- ]?(r|right)$/i, "Right");
  return s.replace(/[^a-z0-9]/gi, "").toLowerCase();
}
const NK = {}; ARKIT.concat(OCULUS).forEach(n => { NK[n] = normMorph(n); });

/* GLB/glTF header: JSON, whether it is a VRM (0.x "VRM" or 1.0 "VRMC_vrm"), and outside files it needs */
export function inspect(buf) {
  const u8 = new Uint8Array(buf);
  let json = null, glb = false;
  if (u8.length >= 20 && u8[0] === 0x67 && u8[1] === 0x6C && u8[2] === 0x54 && u8[3] === 0x46) {
    glb = true;
    const dv = new DataView(buf instanceof ArrayBuffer ? buf : u8.buffer, u8.byteOffset), len = dv.getUint32(12, true), type = dv.getUint32(16, true);
    if (type !== 0x4E4F534A) throw new Error("This .glb has no JSON header");
    json = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + len)));
  } else {
    try { json = JSON.parse(new TextDecoder().decode(u8)); } catch (e) { throw new Error("Not a glTF/GLB/VRM file"); }
  }
  if (!json || !json.asset) throw new Error("Not a glTF/GLB/VRM file");
  const ext = (json.extensionsUsed || []).concat(Object.keys(json.extensions || {}));
  const vrm = ext.indexOf("VRMC_vrm") >= 0 ? "1.0" : ext.indexOf("VRM") >= 0 ? "0.x" : "";
  const outside = []
    .concat((json.buffers || []).filter(b => b.uri && !/^data:/.test(b.uri)).map(b => b.uri))
    .concat((json.images || []).filter(i => i.uri && !/^data:/.test(i.uri)).map(i => i.uri));
  let maxTex = 0;
  return { json, glb, vrm, outside, meshes: (json.meshes || []).length, anims: (json.animations || []).map(a => a.name || "clip"), maxTex };
}

const HEAD_RE = /(^|[^a-z])(head)([^a-z]|$)|^head|j_bip_c_head|mixamorig:?head|cc_base_head|bip01_head/i;
export function detectRig(root, opts) {
  opts = opts || {};
  const vrm = opts.vrm || null, clips = opts.clips || [];
  const morph = {}, names = [];
  let tris = 0, maxTex = 0, texN = 0; const seenTex = new Set();
  let head = null, neck = null, spine = null, jaw = null, eyeL = null, eyeR = null, headObj = null;
  root.traverse(o => {
    if (o.isMesh) {
      const g = o.geometry; if (g) tris += (g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0)) / 3;
      if (o.morphTargetDictionary) for (const n in o.morphTargetDictionary) {
        const k = normMorph(n); (morph[k] = morph[k] || []).push({ mesh: o, i: o.morphTargetDictionary[n] }); if (names.indexOf(n) < 0) names.push(n);
      }
      [].concat(o.material || []).forEach(mt => { for (const key in mt) { const t = mt[key]; if (t && t.isTexture && !seenTex.has(t)) { seenTex.add(t); texN++; const im = t.image; if (im && im.width) maxTex = Math.max(maxTex, im.width, im.height); } } });
    }
    if (o.isObject3D) {
      const n = o.name || "", bone = o.isBone || o.type === "Bone";
      if (HEAD_RE.test(n) && !/top|end|nub|_end/i.test(n)) { if (bone && !head) head = o; else if (!bone && !o.isSkinnedMesh && !headObj) headObj = o; }
      if (!neck && /neck/i.test(n)) neck = o;
      if (!spine && /(upperchest|chest|spine2|spine1|spine)/i.test(n) && (o.isBone || o.type === "Bone")) spine = o;
      if (!jaw && /jaw/i.test(n) && (o.isBone || o.type === "Bone")) jaw = o;
      if (!eyeL && /(left.?eye|eye.?l$|eye_l|l_eye|lefteye)/i.test(n) && (o.isBone || o.type === "Bone")) eyeL = o;
      if (!eyeR && /(right.?eye|eye.?r$|eye_r|r_eye|righteye)/i.test(n) && (o.isBone || o.type === "Bone")) eyeR = o;
    }
  });
  head = head || headObj;
  if (vrm && vrm.humanoid) {
    const nb = n => { try { return vrm.humanoid.getNormalizedBoneNode(n) || null; } catch (e) { return null; } };
    head = nb("head") || head; neck = nb("neck") || neck; spine = nb("upperChest") || nb("chest") || nb("spine") || spine; jaw = nb("jaw") || jaw;
    eyeL = nb("leftEye") || eyeL; eyeR = nb("rightEye") || eyeR;
  }
  const arkit = ARKIT.filter(n => morph[NK[n]]), oculus = OCULUS.filter(n => morph[NK[n]]);
  let vrmExpr = [];
  if (vrm && vrm.expressionManager) {
    const em = vrm.expressionManager;
    vrmExpr = VRM_EXPR.filter(n => { try { return !!em.getExpression(n); } catch (e) { return false; } });
  }
  /* generic fallbacks by name for models that use their own words */
  const findK = re => Object.keys(morph).filter(k => re.test(k));
  const generic = { blink: findK(/blink|eyesclosed|eyeclose/), open: findK(/^(mouthopen|jawopen|open|a|mtha|fclmtha|vrca|aa)$/), smile: findK(/^(smile|mouthsmile|happy|joy|fclalljoy)$/) };
  const clipMap = mapClips(clips);
  let lip = "none";
  if (vrmExpr.indexOf("aa") >= 0) lip = "vrm"; else if (oculus.length >= 5) lip = "oculus"; else if (arkit.indexOf("jawOpen") >= 0) lip = "arkit";
  else if (generic.open.length) lip = "generic"; else if (jaw) lip = "jawbone";
  const rest = new Map();
  [head, neck, spine, jaw, eyeL, eyeR].forEach(b => { if (b && !rest.has(b)) rest.set(b, b.quaternion.clone()); });
  return { kind: vrm ? "vrm" : "gltf", vrm, morph, names, arkit, oculus, vrmExpr, generic, head, neck, spine, jaw, eyeL, eyeR, clips: clipMap, clipNames: clips.map(c => c.name), lip,
    tris: Math.round(tris), maxTex, texN, rest, lastW: {} };
}
export function mapClips(clips) {
  const pick = re => clips.find(c => re.test(c.name || "")) || null;
  return {
    idle: pick(/idle|breath|stand|loop|default/i) || (clips.length === 1 ? clips[0] : null),
    talk: pick(/talk|speak|speech|conversation/i), wave: pick(/wave|hello|greet|\bhi\b/i),
    yawn: pick(/yawn/i), shake: pick(/shake|\bno\b|disagree/i), nod: pick(/nod|\byes\b|agree/i), roll: pick(/eye.?roll|\broll/i),
    side: pick(/side.?eye|glance|look.?(left|away)/i), phone: pick(/phone|text/i), smoke: pick(/smok|cig/i), eat: pick(/eat|chew/i),
    sip: pick(/drink|sip|coffee/i), play: pick(/dance|celebrat|happy|jump/i), proud: pick(/proud|wave|thumb/i), error: pick(/angry|mad|annoy/i),
    sleep: pick(/sleep|nap/i), think: pick(/think|ponder/i)
  };
}
/* what to put in the Model check readout */
export function report(rig, meta) {
  meta = meta || {};
  const L = [];
  if (rig.kind === "vrm") L.push("VRM " + (meta.vrm || "") + " · expressions: " + (rig.vrmExpr.join(", ") || "none"));
  if (rig.arkit.length) L.push("ARKit blendshapes: " + rig.arkit.length + "/52");
  if (rig.oculus.length) L.push("Oculus visemes: " + rig.oculus.length + "/15");
  if (!rig.arkit.length && !rig.oculus.length && rig.kind !== "vrm") L.push("Morph targets: " + (rig.names.length ? rig.names.length + " (" + rig.names.slice(0, 8).join(", ") + (rig.names.length > 8 ? "…" : "") + ")" : "none"));
  const lipTxt = { vrm: "full (VRM aa/ih/ou/ee/oh)", oculus: "full (Oculus visemes)", arkit: "full (ARKit jaw + mouth)", generic: "basic (one mouth-open shape)", jawbone: "jaw bone only", none: "none, head bob only" }[rig.lip];
  L.push("Lip sync: " + lipTxt);
  const blink = rig.vrmExpr.indexOf("blink") >= 0 || rig.vrmExpr.indexOf("blinkLeft") >= 0 || rig.arkit.indexOf("eyeBlinkLeft") >= 0 || rig.generic.blink.length;
  L.push("Blink: " + (blink ? "yes" : "no") + " · Brows: " + (rig.arkit.some(n => /^brow/.test(n)) ? "yes" : rig.kind === "vrm" ? "via emotions" : "no") +
    " · Emotions: " + (rig.vrmExpr.filter(n => /happy|angry|sad|relaxed/.test(n)).length ? "VRM" : rig.arkit.indexOf("mouthSmileLeft") >= 0 ? "ARKit" : "no"));
  L.push("Head bone: " + (rig.head ? "yes (" + (rig.head.name || "head") + ")" : "no, whole model tilts") + (rig.eyeL ? " · eye bones" : ""));
  L.push("Clips: " + (rig.clipNames.length ? rig.clipNames.slice(0, 8).join(", ") + (rig.clipNames.length > 8 ? "…" : "") : "none") +
    (rig.clips.idle ? " · idle loop: " + rig.clips.idle.name : ""));
  L.push("Size: " + (meta.mb ? meta.mb.toFixed(1) + " MB · " : "") + rig.tris.toLocaleString("en-US") + " triangles · " + rig.texN + " textures" + (rig.maxTex ? " (max " + rig.maxTex + " px)" : ""));
  const warn = [];
  if (meta.mb > 15) warn.push("file is over 15 MB, slow to load");
  if (rig.tris > 100000) warn.push("over 100k triangles, may drop frames on iPhone");
  if (rig.maxTex > 2048) warn.push("textures over 2048 px use a lot of iPhone memory");
  if (rig.lip === "none") warn.push("no mouth shapes, so no lip sync");
  return { lines: L, warn, lip: rig.lip };
}
/* how strongly each named shape should be on right now, from the face channels */
export function weights(rig, c) {
  const W = {}, v = c.v, set = (k, x) => { W[k] = Math.max(W[k] || 0, cl(x)); };
  const sm = Math.max(0, c.smile), fr = Math.max(0, -c.smile);
  if (rig.lip === "vrm") {
    if (c.lip) { set("aa", v[2] * 0.9 + c.open * 0.2); set("ih", v[7] * 0.45 + v[3] * 0.25); set("ee", v[3] * 0.75); set("oh", v[4] * 0.85); set("ou", v[5] * 0.85 + v[6] * 0.15); }
    else { set("aa", c.open * 0.9); set("ou", Math.max(0, -c.wide) * 0.6); set("ee", Math.max(0, c.wide) * c.open * 0.5); }
  }
  if (rig.lip === "oculus") {
    if (c.lip) {
      set("viseme_sil", v[0]); set("viseme_PP", v[1]); set("viseme_aa", v[2]); set("viseme_E", v[3] * 0.7); set("viseme_I", v[3] * 0.4 + v[7] * 0.2);
      set("viseme_O", v[4]); set("viseme_U", v[5]); set("viseme_FF", v[6]); set("viseme_SS", v[7] * 0.7); set("viseme_DD", v[7] * 0.25);
      set("viseme_nn", v[7] * 0.15); set("viseme_CH", v[7] * 0.2); set("viseme_kk", v[2] * 0.15); set("viseme_RR", v[5] * 0.2); set("viseme_TH", v[6] * 0.2);
    } else { set("viseme_aa", c.open * 0.9); set("viseme_U", Math.max(0, -c.wide) * 0.5); }
  }
  if (rig.arkit.length) {
    if (rig.lip === "arkit") {
      set("jawOpen", c.open * 0.85);
      if (c.lip) {
        set("mouthFunnel", v[4] * 0.7); set("mouthPucker", v[5] * 0.8); set("mouthPressLeft", v[1] * 0.6); set("mouthPressRight", v[1] * 0.6);
        set("mouthClose", v[1] * 0.3); set("mouthStretchLeft", v[3] * 0.45 + v[7] * 0.3); set("mouthStretchRight", v[3] * 0.45 + v[7] * 0.3);
        set("mouthRollLower", v[6] * 0.6); set("mouthUpperUpLeft", v[6] * 0.3 + v[3] * 0.2); set("mouthUpperUpRight", v[6] * 0.3 + v[3] * 0.2);
        set("mouthLowerDownLeft", v[2] * 0.3 + v[3] * 0.3); set("mouthLowerDownRight", v[2] * 0.3 + v[3] * 0.3);
      } else { set("mouthPucker", Math.max(0, -c.wide) * 0.6); set("mouthStretchLeft", Math.max(0, c.wide) * 0.4); set("mouthStretchRight", Math.max(0, c.wide) * 0.4); }
    }
    /* Blarf's crooked smirk: right side up more than the left */
    set("mouthSmileLeft", sm * 0.12 + c.happy * 0.55); set("mouthSmileRight", sm * 0.42 + c.happy * 0.6);
    set("mouthFrownLeft", fr * 0.7 + c.sad * 0.4 + c.anger * 0.3); set("mouthFrownRight", fr * 0.7 + c.sad * 0.4 + c.anger * 0.3);
    set("eyeBlinkLeft", c.blinkL); set("eyeBlinkRight", c.blinkR);
    set("eyeSquintLeft", c.relaxed * 0.4 + c.anger * 0.3); set("eyeSquintRight", c.relaxed * 0.4 + c.anger * 0.3);
    set("eyeWideLeft", c.surprised * 0.6); set("eyeWideRight", c.surprised * 0.6);
    set("browInnerUp", Math.max(0, (c.raiseL + c.raiseR) / 2) * 0.7 + c.sad * 0.6 + c.surprised * 0.3);
    set("browOuterUpLeft", Math.max(0, c.raiseL) * 0.8); set("browOuterUpRight", Math.max(0, c.raiseR) * 0.8);
    set("browDownLeft", Math.max(0, -c.raiseL) * 0.8 + c.anger * 0.7); set("browDownRight", Math.max(0, -c.raiseR) * 0.8 + c.anger * 0.7);
    set("cheekPuff", Math.max(c.cheekL, c.cheekR)); set("cheekSquintLeft", c.happy * 0.4); set("cheekSquintRight", c.happy * 0.5);
    set("noseSneerLeft", c.anger * 0.4); set("noseSneerRight", c.anger * 0.5);
    if (!rig.eyeL) {
      const x = c.lookX, y = c.lookY;
      set("eyeLookOutLeft", Math.max(0, -x)); set("eyeLookInLeft", Math.max(0, x)); set("eyeLookInRight", Math.max(0, -x)); set("eyeLookOutRight", Math.max(0, x));
      set("eyeLookUpLeft", Math.max(0, -y)); set("eyeLookUpRight", Math.max(0, -y)); set("eyeLookDownLeft", Math.max(0, y)); set("eyeLookDownRight", Math.max(0, y));
    }
  }
  if (rig.kind === "vrm") {
    if (rig.vrmExpr.indexOf("blinkLeft") >= 0) { set("blinkLeft", c.blinkL); set("blinkRight", c.blinkR); } else set("blink", (c.blinkL + c.blinkR) / 2);
    set("happy", c.happy * 0.8 + sm * 0.15); set("angry", c.anger * 0.75); set("sad", c.sad * 0.8); set("relaxed", c.relaxed * 0.8); set("surprised", c.surprised * 0.7);
  }
  if (rig.lip === "generic") rig.generic.open.forEach(k => set("@" + k, c.open));
  if (!rig.arkit.length && rig.kind !== "vrm") {
    rig.generic.blink.forEach(k => set("@" + k, (c.blinkL + c.blinkR) / 2));
    rig.generic.smile.forEach(k => set("@" + k, c.happy * 0.7 + sm * 0.2));
  }
  return W;
}
function applyWeights(rig, W) {
  const em = rig.vrm && rig.vrm.expressionManager;
  /* anything driven last frame but not this one goes back to 0 (no stuck visemes) */
  for (const k in rig.lastW) if (!(k in W)) W[k] = 0;
  rig.lastW = W;
  for (const k in W) {
    if (em && VRM_EXPR.indexOf(k) >= 0) { try { em.setValue(k, W[k]); } catch (e) {} continue; }
    const list = rig.morph[k.charAt(0) === "@" ? k.slice(1) : NK[k] || normMorph(k)];
    if (list) list.forEach(b => { if (b.mesh.morphTargetInfluences) b.mesh.morphTargetInfluences[b.i] = W[k]; });
  }
}
const _q = new THREE.Quaternion(), _e = new THREE.Euler();
/* put our bones back to rest before the mixer runs, so our offsets never pile up frame after frame */
export function restoreBones(rig) { if (rig && rig.rest) rig.rest.forEach((q, b) => b.quaternion.copy(q)); }
export function driveCustom(rig, D, t, dt) {
  D = D || {};
  const c = channels(D), st = rig.st || (rig.st = { yaw: 0, pitch: 0, roll: 0 });
  applyWeights(rig, weights(rig, c));
  const am = actMotion(D, t);
  st.yaw = damp(st.yaw, am.yaw + (D.hx || 0) / 16 * 0.28, 90, dt);
  st.pitch = damp(st.pitch, am.pitch + (D.ty || 0) / 60 * 0.12, 90, dt);
  st.roll = damp(st.roll, -(D.rot || 0) * PI / 180, 60, dt);
  const add = (bone, x, y, z) => { if (bone) bone.quaternion.multiply(_q.setFromEuler(_e.set(x, y, z))); };
  if (rig.head) { add(rig.neck, st.pitch * 0.35, st.yaw * 0.35, st.roll * 0.35); add(rig.head, st.pitch * 0.65, st.yaw * 0.65, st.roll * 0.65); }
  else if (rig.model) rig.model.rotation.set(st.pitch * 0.4, st.yaw * 0.6, st.roll * 0.6);
  if (rig.jaw && rig.lip === "jawbone") add(rig.jaw, c.open * 0.35, 0, 0);
  /* breathing when no idle clip is playing */
  if (rig.spine && !(rig.clips && rig.clips.idle) && !D.calm) add(rig.spine, Math.sin(t / 5000 * PI * 2) * 0.02, 0, 0);
  /* gaze */
  if (rig.vrm && rig.vrm.lookAt) { try { rig.vrm.lookAt.autoUpdate = false; rig.vrm.lookAt.yaw = c.lookX * 18; rig.vrm.lookAt.pitch = -c.lookY * 12; } catch (e) {} }
  else if (rig.eyeL || rig.eyeR) { add(rig.eyeL, c.lookY * 0.3, c.lookX * 0.4, 0); add(rig.eyeR, c.lookY * 0.3, c.lookX * 0.4, 0); }
  return c;
}

/* where on the head did a ray land, in the 2D face coordinates */
export function headFrame(rig) {
  /* center + half-sizes of the head in world space, for picking on custom models */
  const box = new THREE.Box3();
  box.setFromObject(rig.model || rig.root);
  if (rig.eyeL && rig.eyeR) {
    /* eyes are 64 face units apart on a 256-unit-tall head, 21 units above its middle */
    const a = rig.eyeL.getWorldPosition(new THREE.Vector3()), b = rig.eyeR.getWorldPosition(new THREE.Vector3());
    let hh = Math.max(1e-3, a.distanceTo(b) * 2);
    const mid = a.add(b).multiplyScalar(0.5);
    /* stylized (anime) eyes sit close together; the head bone to the top of the model is a second opinion */
    if (rig.head && !box.isEmpty()) { const hb = (box.max.y - rig.head.getWorldPosition(new THREE.Vector3()).y) / 2 * 1.05; if (hb > hh) hh = Math.min(hb, hh * 2.2); }
    return { c: mid.add(new THREE.Vector3(0, -hh * 21 / 128, 0)), hw: hh * 0.77, hh };
  }
  if (rig.head) {
    const hp = rig.head.getWorldPosition(new THREE.Vector3());
    const top = box.isEmpty() ? hp.y + 0.2 : box.max.y, hh = Math.max(1e-3, (top - hp.y) / 2 * 1.05);
    return { c: new THREE.Vector3(hp.x, hp.y + hh * 0.95, hp.z), hw: hh * 0.8, hh };
  }
  const s = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const tall = s.y > s.x * 1.6;
  const hh = tall ? s.y * 0.07 : s.y / 2, cy = tall ? box.max.y - hh : c.y;
  return { c: new THREE.Vector3(c.x, cy, c.z), hw: tall ? hh * 0.77 : s.x / 2, hh };
}
export function hitTo2D(rig, worldPt) {
  if (rig.kind === "builtin") return from3D(rig.head.worldToLocal(worldPt.clone()));
  const f = rig.frame || headFrame(rig), d = worldPt.clone().sub(f.c);
  if (rig.model) { const inv = new THREE.Quaternion(); rig.model.getWorldQuaternion(inv); d.applyQuaternion(inv.invert()); }
  return { x: 100 + d.x / f.hw * 98, y: 105 - d.y / f.hh * 128 };
}

/* ---------- the engine: renderer, camera, framing, gestures, loop ---------- */
export async function create(o) {
  const host = o.host, svg = o.svg;
  const canvas = document.createElement("canvas");
  canvas.className = "x-3d"; canvas.setAttribute("aria-hidden", "true");
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: !o.lowPower, alpha: true, stencil: true, powerPreference: o.lowPower ? "low-power" : "high-performance" });
  } catch (e) { throw new Error("WebGL isn't available"); }
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);
  host.insertBefore(canvas, host.firstChild);
  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose();
  scene.environmentIntensity = 0.45;
  scene.add(new THREE.HemisphereLight(0xCFE8FF, 0x1A2A3A, 0.9));
  const key = new THREE.DirectionalLight(0xFFF1DC, 2.1); key.position.set(2.5, 3, 4); scene.add(key);
  const rim = new THREE.DirectionalLight(0x8FD0FF, 1.8); rim.position.set(-3, 2, -3); scene.add(rim);
  const fill = new THREE.DirectionalLight(0x6AA8FF, 0.5); fill.position.set(-3, -1, 2); scene.add(fill);
  const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
  const view = { target: new THREE.Vector3(0, 0, 0), dist: 6, yaw: 0, pitch: 0, zoom: 1, fitH: 2.8 };
  let rig = null, mixer = null, actions = {}, animated = null, lastAct = "", cur = null, low = !!o.lowPower, dead = false, raf = 0, last = 0, lastDraw = 0, check = null;
  const E = { canvas, renderer, scene, camera, view, get rig() { return rig; }, get check() { return check; } };

  let needSize = false;
  function size() {
    if (dead) return;
    const bl = document.getElementById("blarf");
    if (bl && bl.classList.contains("is-up")) { needSize = true; return; }
    needSize = false;
    const r = (svg || host).getBoundingClientRect(), hr = host.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    canvas.style.left = (r.left - hr.left) + "px"; canvas.style.top = (r.top - hr.top) + "px";
    canvas.style.width = w + "px"; canvas.style.height = h + "px";
    renderer.setPixelRatio(low ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix(); place();
  }
  function place() {
    /* fit the framed height (head + shoulders) in portrait, or its width if the box is narrow */
    const fov = camera.fov * PI / 180, hFit = view.fitH / 2 / Math.tan(fov / 2), wFit = view.fitH * 0.82 / 2 / Math.tan(fov / 2) / Math.max(0.3, camera.aspect);
    view.dist = Math.max(hFit, wFit) * 1.08;
    const d = view.dist / view.zoom;
    camera.position.set(view.target.x + d * Math.sin(view.yaw) * Math.cos(view.pitch), view.target.y + d * Math.sin(view.pitch), view.target.z + d * Math.cos(view.yaw) * Math.cos(view.pitch));
    camera.lookAt(view.target);
  }
  function frameModel() {
    if (rig.kind === "builtin") { view.target.set(0, 0.02, 0); view.fitH = 3.35; place(); return; }
    rig.frame = headFrame(rig);
    const f = rig.frame;
    view.target.copy(f.c).add(new THREE.Vector3(0, -f.hh * 0.9, 0));
    view.fitH = f.hh * 5.2; place();
  }
  const ro = window.ResizeObserver ? new ResizeObserver(size) : null;
  if (ro) ro.observe(svg || host); else window.addEventListener("resize", size);

  function clear() {
    if (mixer) { mixer.stopAllAction(); mixer = null; } actions = {}; animated = null; lastAct = "";
    if (rig) {
      scene.remove(rig.root);
      rig.root.traverse(x => { if (x.geometry) x.geometry.dispose(); [].concat(x.material || []).forEach(m => { for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose && m.dispose(); }); });
      if (rig.vrm) { try { const V = E.VRM; V && V.VRMUtils && V.VRMUtils.deepDispose && V.VRMUtils.deepDispose(rig.root); } catch (e) {} }
    }
    rig = null;
  }
  E.loadBuiltin = function () {
    clear(); rig = buildBlarf(); scene.add(rig.root); frameModel();
    check = { lines: ["Built-in 3D Blarf · procedural, nothing to download", "Lip sync: full (8 visemes from the 2D engine)", "Blink, brows, emotions, cigarette, outfits: yes"], warn: [], lip: "builtin" };
    return check;
  };
  E.loadBuffer = async function (buf, name) {
    const info = inspect(buf);
    if (info.outside.length) throw new Error("This .gltf needs separate files (" + info.outside.slice(0, 2).join(", ") + "). Export it as a single .glb instead.");
    const loader = new GLTFLoader();
    let V = null;
    if (info.vrm) { V = E.VRM = await import("@pixiv/three-vrm"); loader.register(p => new V.VRMLoaderPlugin(p)); }
    const gltf = await loader.parseAsync(buf, "");
    const vrm = gltf.userData && gltf.userData.vrm || null;
    const model = vrm ? vrm.scene : gltf.scene || (gltf.scenes && gltf.scenes[0]);
    if (!model) throw new Error("No scene in that file");
    if (vrm && V) {
      try { V.VRMUtils.removeUnnecessaryVertices(gltf.scene); } catch (e) {}
      try { (V.VRMUtils.combineSkeletons || V.VRMUtils.removeUnnecessaryJoints).call(V.VRMUtils, gltf.scene); } catch (e) {}
      try { if (info.vrm === "0.x") V.VRMUtils.rotateVRM0(vrm); } catch (e) {}
    }
    model.traverse(x => { if (x.isMesh) { x.frustumCulled = false; } });
    clear();
    const root = new THREE.Group(); root.add(model); scene.add(root);
    rig = detectRig(model, { vrm, clips: gltf.animations || [] }); rig.root = root; rig.model = model;
    /* a model with no bones but a head-sized box: that box is the head */
    if (gltf.animations && gltf.animations.length) {
      mixer = new THREE.AnimationMixer(model); animated = new Set();
      gltf.animations.forEach(cl => cl.tracks.forEach(tr => animated.add(tr.name.split(".")[0])));
      for (const k in rig.clips) if (rig.clips[k]) actions[k] = mixer.clipAction(rig.clips[k]);
      if (actions.idle) { actions.idle.setLoop(THREE.LoopRepeat, Infinity).play(); cur = actions.idle; }
      if (actions.wave) playOnce("wave");
    }
    if (vrm) vrm.update(0);
    model.updateMatrixWorld(true);
    frameModel();
    check = report(rig, { vrm: info.vrm, mb: buf.byteLength / 1048576 });
    check.lines.unshift((name || "Custom avatar") + (info.vrm ? " (VRM " + info.vrm + ")" : info.glb ? " (GLB)" : " (glTF)"));
    return check;
  };
  function playOnce(k) {
    const a = actions[k]; if (!a || !mixer) return false;
    a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = false; a.fadeIn(0.2).play();
    if (cur && cur !== a) cur.fadeOut(0.2);
    const back = () => { mixer && mixer.removeEventListener("finished", back); if (actions.idle && a !== actions.idle) { actions.idle.reset().fadeIn(0.3).play(); a.fadeOut(0.3); cur = actions.idle; } };
    mixer.addEventListener("finished", back); cur = a; return true;
  }
  function clipDrive(D) {
    if (!mixer) return;
    const a = D.act || "";
    if (a && a !== lastAct) { const k = a === "proud" ? (actions.proud ? "proud" : "wave") : a; if (actions[k]) playOnce(k); }
    lastAct = a;
    if (actions.talk && actions.idle) {
      const want = D.talking ? actions.talk : actions.idle;
      if (want !== cur && (cur === actions.talk || cur === actions.idle)) { want.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.25).play(); cur.fadeOut(0.25); cur = want; }
    }
  }
  function outfit() { const m = /\bx-out-([a-z]+)\b/.exec(document.documentElement.className || ""); return m ? m[1] : ""; }
  function active() {
    if (document.hidden || dead) return false;
    const bl = document.getElementById("blarf"), top = document.getElementById("top");
    if (bl && bl.classList.contains("is-up")) return false;
    if (top && (top.getAttribute("data-tab") || "chat") !== "chat") return false;
    return canvas.isConnected;
  }
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!active() || !rig) { last = 0; return; }
    if (needSize) size();
    if (low && now - lastDraw < 31) return;
    const dt = last ? Math.min(64, now - last) : 16; last = now; lastDraw = now;
    const D = window.blarfFace3 || {};
    try {
      if (rig.kind === "builtin") driveBuiltin(rig, D, now, dt, { cig: !document.documentElement.classList.contains("x-nocig"), outfit: outfit() });
      else {
        clipDrive(D);
        restoreBones(rig);
        if (mixer) mixer.update(dt / 1000);
        driveCustom(rig, D, now, dt);
        if (rig.vrm) rig.vrm.update(dt / 1000);
      }
      renderer.render(scene, camera);
    } catch (e) { fail(e); }
  }
  function fail(e) { if (dead) return; const f = o.onFail; E.dispose(); if (f) f(e && e.message ? e.message : String(e)); }
  canvas.addEventListener("webglcontextlost", ev => { ev.preventDefault(); fail(new Error("the iPhone dropped the 3D context")); });

  /* picking: a ray through the finger, back to 2D face coordinates (null = missed the head) */
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  E.pick = function (x, y) {
    if (!rig || dead) return null;
    const r = canvas.getBoundingClientRect(); if (!r.width) return null;
    ndc.set((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const targets = rig.kind === "builtin" ? rig.picks : [rig.model];
    const hit = ray.intersectObjects(targets, true)[0];
    if (!hit) return null;
    const p = hitTo2D(rig, hit.point);
    return p;
  };

  /* gestures: two fingers pinch to zoom (and turn); one finger dragged sideways off the head turns him */
  const P = new Map(); let G = null, used = false;
  const blarfEl = document.getElementById("blarf") || host;
  function pd(e) {
    if (dead || !active()) return;
    if (e.target.closest && e.target.closest("button, .x-sheet")) return;
    if (!P.size) used = false;
    P.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (P.size === 2) {
      const [a, b] = [...P.values()];
      G = { m: "pinch", d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: view.zoom, yaw: view.yaw, mx: (a.x + b.x) / 2 }; used = true;
    } else if (P.size === 1) G = { m: "maybe", x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch, onHead: !!E.pick(e.clientX, e.clientY) };
  }
  function pmv(e) {
    if (!P.has(e.pointerId) || !G) return;
    P.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (G.m === "pinch" && P.size >= 2) {
      const [a, b] = [...P.values()];
      view.zoom = cl(G.z * Math.hypot(a.x - b.x, a.y - b.y) / G.d, 0.6, 2.6);
      view.yaw = cl(G.yaw - ((a.x + b.x) / 2 - G.mx) * 0.006, -1.2, 1.2); place(); showReset();
    } else if (G.m === "maybe" || G.m === "turn") {
      const dx = e.clientX - G.x, dy = e.clientY - G.y;
      if (G.m === "maybe" && !G.onHead && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.4) { G.m = "turn"; used = true; }
      if (G.m === "turn") { view.yaw = cl(G.yaw - dx * 0.008, -1.2, 1.2); view.pitch = cl(G.pitch + dy * 0.004, -0.45, 0.45); place(); showReset(); }
    }
  }
  function pu(e) { P.delete(e.pointerId); if (!P.size) G = null; else if (G && G.m === "pinch") G = null; }
  blarfEl.addEventListener("pointerdown", pd, true); blarfEl.addEventListener("pointermove", pmv, true);
  blarfEl.addEventListener("pointerup", pu, true); blarfEl.addEventListener("pointercancel", pu, true);
  E.gesturing = function (consume) { const u = used || P.size >= 2; if (consume && !P.size) used = false; return u; };
  const reset = document.createElement("button");
  reset.type = "button"; reset.className = "x-3dreset"; reset.hidden = true; reset.setAttribute("aria-label", "Reset 3D view"); reset.textContent = "⟲";
  reset.addEventListener("click", () => E.resetView());
  host.appendChild(reset);
  function showReset() { reset.hidden = Math.abs(view.yaw) < 0.02 && Math.abs(view.pitch) < 0.02 && Math.abs(view.zoom - 1) < 0.02; }
  E.resetView = function () {
    const from = { y: view.yaw, p: view.pitch, z: view.zoom }, t0 = performance.now();
    (function step() {
      if (dead) return;
      const k = ss((performance.now() - t0) / 350);
      view.yaw = from.y * (1 - k); view.pitch = from.p * (1 - k); view.zoom = from.z + (1 - from.z) * k; place();
      if (k < 1) requestAnimationFrame(step); else showReset();
    })();
  };
  E.setLowPower = function (b) { low = !!b; size(); };
  E.dispose = function () {
    if (dead) return; dead = true; cancelAnimationFrame(raf);
    try { clear(); } catch (e) {}
    if (ro) ro.disconnect();
    blarfEl.removeEventListener("pointerdown", pd, true); blarfEl.removeEventListener("pointermove", pmv, true);
    blarfEl.removeEventListener("pointerup", pu, true); blarfEl.removeEventListener("pointercancel", pu, true);
    try { renderer.dispose(); renderer.forceContextLoss && renderer.forceContextLoss(); } catch (e) {}
    canvas.remove(); reset.remove();
  };
  E.alive = () => !dead;
  size();
  raf = requestAnimationFrame(tick);
  return E;
}
