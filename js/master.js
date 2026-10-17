// Master page: owns the 3D scene, the cameras and the models, and streams
// camera/object positions to every connected screen.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CONFIG, ROOM, BASE, PARAMS, screenUrl, LOCAL_ONLY, resolveUrl } from './config.js';
import { MasterHub } from './link.js';
import * as C from './common.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9);
const ASPECT = CONFIG.aspect;
const LS_KEY = 's3d:scene:' + ROOM;

// ===========================================================================
//  Three.js setup
// ===========================================================================
const stage = $('#stage');
const canvas = $('#c');
const renderer = C.createRenderer(canvas);
renderer.autoClear = true;
const world = C.createWorld(renderer);
const { scene, content } = world;
let worldState = { ...C.DEFAULT_WORLD };

const editorCam = new THREE.PerspectiveCamera(50, 1, 0.01, 2000);
editorCam.position.set(5.8, 3.8, 6.8);
const orbit = new OrbitControls(editorCam, canvas);
orbit.target.set(0, 0.8, 0);
orbit.enableDamping = true;
orbit.dampingFactor = 0.12;
orbit.update();

const tc = new TransformControls(editorCam, canvas);
const tcHelper = tc.getHelper();
scene.add(tcHelper);
let tcMode = 'translate';
tc.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
  if (!e.value) saveDirty = true;
});
tc.addEventListener('objectChange', () => { saveDirty = true; });

const selBox = new THREE.BoxHelper(new THREE.Object3D(), 0x4cc2ff);
selBox.material.depthTest = false;
selBox.material.transparent = true;
selBox.renderOrder = 999;
selBox.visible = false;
scene.add(selBox);

const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.03;

// ===========================================================================
//  State
// ===========================================================================
const cams = [];   // { id, screen, name, color, obj, gizmo }
const objs = [];   // { id, name, kind, url, main, files, pivot, wrapper, pivotGroup, model, mixer, action, clips, clip, anim, status }
let sel = null;    // { type: 'camera'|'object', id }
let pilot = null;  // id of camera being looked through
let savedEditor = null;

let structDirty = true, panelDirty = true, saveDirty = false;
let lastPoseStr = '';

const camById = (id) => cams.find((c) => c.id === id);
const objById = (id) => objs.find((o) => o.id === id);

function structural() { structDirty = true; panelDirty = true; saveDirty = true; }

// ===========================================================================
//  Cameras
// ===========================================================================
function labelTexture(n, color) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = color;
  g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#0d0f13';
  g.font = `bold ${n > 9 ? 56 : 70}px system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(n), 64, 68);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildGizmo(c) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: c.color });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 0.18), mat);
  body.position.z = 0.1;
  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.07, 0.09, 24).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x1a1d23 })
  );
  lens.position.z = -0.03;
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Array(20 * 3).fill(0), 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: c.color, transparent: true, opacity: 0.85 }));
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(c.screen, c.color), depthTest: false }));
  label.scale.setScalar(0.2);
  label.position.set(0, 0.2, 0.1);
  label.renderOrder = 998;
  for (const m of [body, lens, label]) m.userData.camId = c.id;
  group.add(body, lens, lines, label);
  c.obj.add(group);
  c.gizmo = { group, body, lens, lines, label, mat };
  updateFrustum(c);
}

function updateFrustum(c) {
  const d = 0.65;
  const h = Math.tan(THREE.MathUtils.degToRad(c.obj.fov) / 2) * d;
  const w = h * ASPECT;
  const P = [[-w, -h, -d], [w, -h, -d], [w, h, -d], [-w, h, -d]];
  const pts = [];
  for (const p of P) pts.push(0, 0, 0, ...p);
  for (let i = 0; i < 4; i++) pts.push(...P[i], ...P[(i + 1) % 4]);
  // little "up" triangle on top edge
  pts.push(-w * 0.3, h * 1.08, -d, 0, h * 1.35, -d, 0, h * 1.35, -d, w * 0.3, h * 1.08, -d);
  const attr = c.gizmo.lines.geometry.attributes.position;
  attr.array.set(pts);
  attr.needsUpdate = true;
  c.gizmo.lines.geometry.computeBoundingSphere();
}

function recolor(c) {
  c.color = C.colorForScreen(c.screen);
  c.gizmo.mat.color.set(c.color);
  c.gizmo.lines.material.color.set(c.color);
  c.gizmo.label.material.map.dispose();
  c.gizmo.label.material.map = labelTexture(c.screen, c.color);
  c.gizmo.label.material.needsUpdate = true;
}

function nextFreeScreen() {
  let n = 1;
  while (cams.some((c) => c.screen === n)) n++;
  return n;
}

function addCamera({ id = uid(), screen, name, fov = 50, pose, lookAt } = {}) {
  screen = screen && !cams.some((c) => c.screen === screen) ? screen : nextFreeScreen();
  const obj = new THREE.PerspectiveCamera(fov, ASPECT, 0.01, 2000);
  if (pose) C.applyCamPose(obj, pose);
  else {
    obj.position.copy(editorCam.position);
    obj.quaternion.copy(editorCam.quaternion);
  }
  if (lookAt) obj.lookAt(...lookAt);
  const c = { id, screen, name: name || `Camera ${screen}`, color: C.colorForScreen(screen), obj };
  buildGizmo(c);
  scene.add(obj);
  cams.push(c);
  cams.sort((a, b) => a.screen - b.screen);
  structural();
  return c;
}

function removeCamera(id) {
  const c = camById(id);
  if (!c) return;
  if (pilot === id) setPilot(null);
  if (sel && sel.id === id) select(null);
  scene.remove(c.obj);
  c.obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { o.material.map && o.material.map.dispose(); o.material.dispose(); } });
  cams.splice(cams.indexOf(c), 1);
  structural();
}

function setScreenNumber(c, n) {
  n = Math.max(1, Math.floor(n) || 1);
  if (n === c.screen) return;
  const other = cams.find((x) => x.screen === n);
  if (other) { other.screen = c.screen; recolor(other); }
  c.screen = n;
  recolor(c);
  cams.sort((a, b) => a.screen - b.screen);
  structural();
}

// ===========================================================================
//  Models
// ===========================================================================
async function addObject(o) {
  const item = {
    id: o.id || uid(),
    name: o.name || 'Model',
    kind: o.kind,
    url: o.url || null,
    main: o.main || null,
    files: o.files || null,
    pivot: o.pivot || (o.kind === 'demo' ? [0, 0, 0] : null),
    anim: o.anim ?? true,
    clip: o.clip || 0,
    clips: [],
    status: 'loading',
  };
  const { wrapper, pivot } = C.makeWrapper(item.id);
  item.wrapper = wrapper;
  item.pivotGroup = pivot;
  if (o.xform) C.applyObjPose(wrapper, o.xform);
  content.add(wrapper);
  objs.push(item);
  structural();

  try {
    let res;
    if (item.kind === 'demo') res = C.buildDemo();
    else if (item.kind === 'url') res = await C.loadModel({ url: item.url });
    else res = await C.loadModel({ main: item.main, files: item.files });

    if (!objs.includes(item)) { C.disposeObject(res.object); return; } // removed meanwhile
    item.model = res.object;
    item.clips = res.animations || [];
    const m = C.measureModel(res.object);
    item.fit = m;
    if (!item.pivot) {
      item.pivot = m.pivot;
      if (!o.xform) {
        wrapper.scale.setScalar(m.scale);
        const spot = freeSpot(item);
        wrapper.position.set(spot.x, m.lift, spot.z);
      }
    }
    pivot.position.fromArray(item.pivot);
    pivot.add(res.object);
    if (item.clips.length) {
      item.mixer = new THREE.AnimationMixer(res.object);
      playClip(item);
    }
    item.status = 'ready';
    if (item.kind === 'file' && !o.fromStore) storeAsset(item);
  } catch (e) {
    console.error(e);
    item.status = 'error';
    item.err = e.message || String(e);
    toast(`Could not load “${item.name}”: ${item.err}`, 'error');
  }
  structural();
  if (sel && sel.id === item.id) select('object', item.id);
}

// First spot on a ring around the origin that no other model is standing on.
function freeSpot(self) {
  const taken = objs.filter((o) => o !== self && o.model).map((o) => o.wrapper.position);
  for (let ring = 0; ring < 6; ring++) {
    const n = ring === 0 ? 1 : ring * 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = Math.cos(a) * ring * 3.2, z = Math.sin(a) * ring * 3.2;
      if (taken.every((p) => Math.hypot(p.x - x, p.z - z) > 2.8)) return { x, z };
    }
  }
  return { x: 0, z: 0 };
}

function playClip(item) {
  if (!item.mixer) return;
  item.mixer.stopAllAction();
  const clip = item.clips[item.clip] || item.clips[0];
  if (!clip) return;
  item.action = item.mixer.clipAction(clip);
  item.action.play();
}

function removeObject(id) {
  const o = objById(id);
  if (!o) return;
  if (sel && sel.id === id) select(null);
  content.remove(o.wrapper);
  if (o.model) C.disposeObject(o.model);
  objs.splice(objs.indexOf(o), 1);
  if (o.kind === 'file') assetStore.del(o.id);
  structural();
}

function resetObject(o) {
  if (!o.model) return;
  if (o.kind === 'demo') { o.wrapper.position.set(0, 0, 0); o.wrapper.quaternion.identity(); o.wrapper.scale.setScalar(1); }
  else {
    const m = o.fit || { scale: 1, lift: 0 };
    o.wrapper.position.set(0, m.lift, 0);
    o.wrapper.quaternion.identity();
    o.wrapper.scale.setScalar(m.scale);
  }
  saveDirty = true;
}

function dropToFloor(o) {
  o.wrapper.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(o.wrapper);
  if (box.isEmpty()) return;
  o.wrapper.position.y -= box.min.y;
  saveDirty = true;
}

// ---- persistent storage for imported files (IndexedDB) -------------------
const assetStore = {
  _db: null,
  open() {
    if (this._db) return this._db;
    this._db = new Promise((resolve) => {
      try {
        const req = indexedDB.open('scene3d', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('assets', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    return this._db;
  },
  async tx(mode, fn) {
    const db = await this.open();
    if (!db) return null;
    return new Promise((resolve) => {
      const t = db.transaction('assets', mode);
      const r = fn(t.objectStore('assets'));
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = t.onabort = () => resolve(null);
    });
  },
  put(rec) { return this.tx('readwrite', (s) => s.put(rec)); },
  get(id) { return this.tx('readonly', (s) => s.get(id)); },
  del(id) { return this.tx('readwrite', (s) => s.delete(id)); },
};

function storeAsset(item) {
  assetStore.put({ id: item.id, name: item.name, main: item.main, files: item.files }).then((r) => {
    if (r === null) toast('Browser storage is full or blocked: this model will not survive a page reload.', 'warn');
  });
}

// ---- importing files ------------------------------------------------------
async function filesFromDrop(dt) {
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  async function walk(entry) {
    if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  }
  for (const e of entries) await walk(e);
  return out;
}

async function importFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const mains = files.filter((f) => C.MODEL_EXTS.includes(C.extOf(f.name)));
  if (!mains.length) {
    toast(`No 3D model in what you dropped. Supported: ${C.MODEL_EXTS.map((e) => '.' + e).join(' ')}`, 'error');
    return;
  }
  const extras = files.filter((f) => !mains.includes(f));
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > 300e6) toast('That is a big model; screens will take a while to receive it.', 'warn');
  const read = async (f) => ({ name: f.name, data: await f.arrayBuffer() });
  const extraData = await Promise.all(extras.map(read));
  for (const m of mains) {
    const mainData = await read(m);
    addObject({
      kind: 'file',
      name: m.name.replace(/\.[^.]+$/, ''),
      main: m.name,
      files: [mainData, ...extraData],
    });
  }
}

// ===========================================================================
//  Selection, transform tool, look-through ("pilot") mode
// ===========================================================================
function select(type, id) {
  sel = type ? { type, id } : null;
  tc.detach();
  selBox.visible = false;
  if (sel && sel.type === 'camera') {
    const c = camById(id);
    if (c && pilot !== id) tc.attach(c.obj);
  } else if (sel && sel.type === 'object') {
    const o = objById(id);
    if (o) {
      tc.attach(o.wrapper);
      selBox.setFromObject(o.wrapper);
      selBox.visible = true;
    }
  }
  applyTcMode();
  panelDirty = true;
  renderProps();
}

function applyTcMode() {
  const isCam = sel && sel.type === 'camera';
  tc.setMode(tcMode === 'scale' && isCam ? 'translate' : tcMode);
  tc.setSpace(tcMode === 'rotate' && isCam ? 'local' : 'world');
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === tcMode));
}

function setMode(m) { tcMode = m; applyTcMode(); }

function sceneCenter() {
  const box = new THREE.Box3().setFromObject(content);
  return box.isEmpty() ? new THREE.Vector3(0, 0.8, 0) : box.getCenter(new THREE.Vector3());
}

function setPilot(id) {
  if (id && pilot === id) return;
  if (!id) {
    if (pilot && savedEditor) {
      editorCam.position.copy(savedEditor.pos);
      editorCam.quaternion.copy(savedEditor.quat);
      orbit.target.copy(savedEditor.target);
      editorCam.fov = savedEditor.fov;
      editorCam.updateProjectionMatrix();
    }
    const was = pilot;
    pilot = null;
    if (was && sel && sel.id === was) select('camera', was);
  } else {
    const c = camById(id);
    if (!c) return;
    if (!pilot) {
      savedEditor = { pos: editorCam.position.clone(), quat: editorCam.quaternion.clone(), target: orbit.target.clone(), fov: editorCam.fov };
    }
    pilot = id;
    editorCam.position.copy(c.obj.position);
    editorCam.quaternion.copy(c.obj.quaternion);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(c.obj.quaternion);
    const d = Math.max(0.5, c.obj.position.distanceTo(sceneCenter()));
    orbit.target.copy(c.obj.position).addScaledVector(fwd, d);
    if (tc.object === c.obj) tc.detach();
    select('camera', id);
  }
  orbit.update();
  $('#pilotBanner').hidden = !pilot;
  if (pilot) {
    const c = camById(pilot);
    $('#pilotName').textContent = `${c.screen} · ${c.name}`;
    $('#pilotName').style.color = c.color;
  }
  panelDirty = true;
}

function snapToView(c) {
  c.obj.position.copy(editorCam.position);
  c.obj.quaternion.copy(editorCam.quaternion);
  saveDirty = true;
}

function focusSelection() {
  let target;
  if (sel && sel.type === 'object') {
    const o = objById(sel.id);
    const box = new THREE.Box3().setFromObject(o.wrapper);
    if (!box.isEmpty()) target = box.getCenter(new THREE.Vector3());
  } else if (sel && sel.type === 'camera') {
    target = camById(sel.id).obj.position.clone();
  }
  if (!target) target = sceneCenter();
  const off = editorCam.position.clone().sub(orbit.target);
  orbit.target.copy(target);
  editorCam.position.copy(target).add(off);
}

// ---- picking with the mouse ----------------------------------------------
let downAt = null;
let mainRect = { x: 0, y: 0, w: 1, h: 1 };
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 4 || tc.dragging || tc.axis) return;
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, yTop = e.clientY - r.top;
  const y = r.height - yTop; // bottom-left origin like the viewport
  const nx = ((x - mainRect.x) / mainRect.w) * 2 - 1;
  const ny = ((y - mainRect.y) / mainRect.h) * 2 - 1;
  if (Math.abs(nx) > 1 || Math.abs(ny) > 1) return;
  raycaster.setFromCamera(new THREE.Vector2(nx, ny), editorCam);
  const pickables = [];
  for (const c of cams) if (c.id !== pilot) pickables.push(c.gizmo.body, c.gizmo.lens, c.gizmo.label);
  for (const o of objs) pickables.push(o.wrapper);
  const hit = raycaster.intersectObjects(pickables, true)[0];
  if (!hit) { select(null); return; }
  let n = hit.object;
  while (n) {
    if (n.userData.camId) { select('camera', n.userData.camId); return; }
    if (n.userData.s3dId) { select('object', n.userData.s3dId); return; }
    n = n.parent;
  }
});

// ===========================================================================
//  Networking
// ===========================================================================
const hub = new MasterHub();

function serialize() {
  return {
    world: { ...worldState },
    cams: cams.map((c) => ({ id: c.id, screen: c.screen, name: c.name, color: c.color, fov: c.obj.fov, pose: C.camPose(c.obj) })),
    objs: objs.map((o) => ({
      id: o.id, name: o.name, kind: o.kind, url: o.url, main: o.main,
      pivot: o.pivot, xform: C.objPose(o.wrapper), anim: o.anim, clip: o.clip, status: o.status,
    })),
  };
}

function posePacket() {
  const c = {}, o = {};
  for (const cam of cams) c[cam.id] = C.camPose(cam.obj);
  for (const it of objs) o[it.id] = C.objPose(it.wrapper, it.action && it.anim !== undefined ? it.action.time : -1);
  return { t: 'pose', c, o };
}

function sendAssets(v) {
  v.sent = v.sent || new Set();
  for (const o of objs) {
    if (o.kind !== 'file' || o.status !== 'ready' || v.sent.has(o.id)) continue;
    v.sent.add(o.id);
    v.send({ t: 'asset', id: o.id, main: o.main, files: o.files.map((f) => ({ name: f.name, size: f.data.byteLength })) });
    o.files.forEach((f, fi) => {
      for (let off = 0; off < f.data.byteLength; off += CONFIG.chunkSize) {
        v.send({ t: 'chunk', id: o.id, f: fi, off, data: f.data.slice(off, off + CONFIG.chunkSize) });
      }
    });
  }
}

hub.onJoin = (v) => {
  v.sent = new Set();
  v.send({ t: 'state', state: serialize() });
  v.send(posePacket());
  sendAssets(v);
  panelDirty = true;
  const cam = cams.find((c) => c.screen === v.screen);
  toast(`Screen ${v.screen} connected${v.kind === 'local' ? ' (this computer)' : ''}${cam ? '' : ' — it has no camera yet'}`);
};
hub.onLeave = (v, replaced) => {
  panelDirty = true;
  if (!replaced) toast(`Screen ${v.screen} disconnected`, 'muted');
};
hub.onStatus = () => { panelDirty = true; };
hub.start();

function syncTick() {
  if (structDirty) {
    structDirty = false;
    const st = { t: 'state', state: serialize() };
    hub.broadcast(st);
    for (const v of hub.viewers.values()) sendAssets(v);
    lastPoseStr = '';
  }
  if (!hub.viewers.size) return;
  const pkt = posePacket();
  const s = JSON.stringify(pkt);
  if (s !== lastPoseStr) {
    lastPoseStr = s;
    hub.broadcast(pkt);
  }
}

// ===========================================================================
//  Save / load
// ===========================================================================
let lastSave = 0;
function saveTick(now) {
  if (!saveDirty || now - lastSave < 700) return;
  saveDirty = false;
  lastSave = now;
  try { localStorage.setItem(LS_KEY, JSON.stringify(serialize())); } catch {}
}

function clearScene() {
  setPilot(null);
  select(null);
  for (const c of [...cams]) removeCamera(c.id);
  for (const o of [...objs]) {
    content.remove(o.wrapper);
    if (o.model) C.disposeObject(o.model);
  }
  objs.length = 0;
  structural();
}

async function applyScene(s) {
  clearScene();
  worldState = { ...C.DEFAULT_WORLD, ...(s.world || {}) };
  world.apply(worldState);
  for (const c of s.cams || []) addCamera({ id: c.id, screen: c.screen, name: c.name, fov: c.fov, pose: c.pose });
  for (const o of s.objs || []) {
    if (o.kind === 'file') {
      const rec = await assetStore.get(o.id);
      if (rec) addObject({ ...o, main: rec.main, files: rec.files, fromStore: true });
      else toast(`“${o.name}” was imported from a file on another browser/computer — import it again here.`, 'warn');
    } else {
      addObject(o);
    }
  }
  refreshWorldInputs();
  structural();
}

function defaultScene() {
  clearScene();
  worldState = { ...C.DEFAULT_WORLD };
  world.apply(worldState);
  addObject({ kind: 'demo', name: 'Demo sculpture' });
  addCamera({ name: 'Front', pose: [0, 1.5, 5.2, 0, 0, 0, 1, 45], lookAt: [0, 0.9, 0] });
  addCamera({ name: 'Left', pose: [-4.6, 2.3, 2.6, 0, 0, 0, 1, 45], lookAt: [0, 0.8, 0] });
  addCamera({ name: 'Right high', pose: [4.0, 3.6, -3.2, 0, 0, 0, 1, 45], lookAt: [0, 0.6, 0] });
  refreshWorldInputs();
  structural();
}

function downloadScene() {
  const data = { format: 'scene3d', version: 1, room: ROOM, ...serialize() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'scene3d-scene.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  if (objs.some((o) => o.kind === 'file')) {
    toast('Saved. Models you imported from files are kept in this browser, not in the scene file — put them in the site’s models/ folder to share them.', 'muted');
  }
}

// ===========================================================================
//  Render loop
// ===========================================================================
const timer = new THREE.Timer();
const strip = $('#previews');

function setEditorOnlyVisible(v) {
  for (const c of cams) c.gizmo.group.visible = v && c.id !== pilot;
  tcHelper.visible = v && !!tc.object;
  selBox.visible = v && !!sel && sel.type === 'object';
  world.grid.visible = v ? true : !!worldState.grid;
}

function loop() {
  const now = performance.now();
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1);
  const W = stage.clientWidth, H = stage.clientHeight;
  const size = renderer.getSize(new THREE.Vector2());
  if (size.x !== W || size.y !== H) renderer.setSize(W, H);

  orbit.update();
  if (pilot) {
    const c = camById(pilot);
    if (c) {
      c.obj.position.copy(editorCam.position);
      c.obj.quaternion.copy(editorCam.quaternion);
      if (editorCam.fov !== c.obj.fov) editorCam.fov = c.obj.fov;
    }
  }
  for (const o of objs) if (o.mixer && o.anim) o.mixer.update(dt);
  if (sel && sel.type === 'object') { const o = objById(sel.id); if (o) selBox.setFromObject(o.wrapper); }

  syncTick();
  saveTick(now);
  if (panelDirty) { panelDirty = false; renderPanel(); }

  // ---- main view
  renderer.setScissorTest(true);
  if (pilot) {
    const top = 100, bottom = strip.offsetHeight + 12;
    const aw = W - 24, ah = Math.max(50, H - top - bottom);
    let w = aw, h = w / ASPECT;
    if (h > ah) { h = ah; w = h * ASPECT; }
    mainRect = { x: (W - w) / 2, y: bottom + (ah - h) / 2, w, h };
    renderer.setViewport(0, 0, W, H);
    renderer.setScissor(0, 0, W, H);
    renderer.setClearColor(0x07080a, 1);
    renderer.clear();
    editorCam.aspect = ASPECT;
  } else {
    mainRect = { x: 0, y: 0, w: W, h: H };
    editorCam.aspect = W / H;
  }
  editorCam.updateProjectionMatrix();
  renderer.setViewport(mainRect.x, mainRect.y, mainRect.w, mainRect.h);
  renderer.setScissor(mainRect.x, mainRect.y, mainRect.w, mainRect.h);
  // While looking through a camera, show exactly what its screen shows.
  setEditorOnlyVisible(!pilot);
  renderer.render(scene, editorCam);

  const frame = $('#pilotFrame');
  frame.hidden = !pilot;
  if (pilot) {
    Object.assign(frame.style, { left: mainRect.x + 'px', bottom: mainRect.y + 'px', width: mainRect.w + 'px', height: mainRect.h + 'px', borderColor: camById(pilot)?.color });
  }

  // ---- camera previews (exactly what each screen shows)
  setEditorOnlyVisible(false);
  const cr = canvas.getBoundingClientRect();
  const sr = strip.getBoundingClientRect();
  for (const el of strip.querySelectorAll('.pv-frame')) {
    const c = camById(el.dataset.id);
    if (!c) continue;
    const r = el.getBoundingClientRect();
    const l = Math.max(r.left, sr.left), rr = Math.min(r.right, sr.right);
    if (rr <= l || r.width < 2) continue;
    const vx = r.left - cr.left, vy = cr.bottom - r.bottom;
    renderer.setViewport(vx, vy, r.width, r.height);
    renderer.setScissor(l - cr.left, vy, rr - l, r.height);
    renderer.render(scene, c.obj);
  }
  setEditorOnlyVisible(true);
  renderer.setScissorTest(false);
}
renderer.setAnimationLoop(loop);

// ===========================================================================
//  Panel UI
// ===========================================================================
function viewersByScreen() {
  const m = new Map();
  for (const v of hub.viewers.values()) {
    if (!m.has(v.screen)) m.set(v.screen, []);
    m.get(v.screen).push(v);
  }
  return m;
}

const ICON = {
  open: '<svg viewBox="0 0 16 16"><path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  eye: '<svg viewBox="0 0 16 16"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
  x: '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  copy: '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 10.5V4a1 1 0 0 1 1-1h6.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
};

function renderPanel() {
  // ---- status
  const st = $('#status');
  const net = LOCAL_ONLY ? 'off' : hub.netStatus;
  const netLabel = { online: 'Online — screens anywhere can join', connecting: 'Connecting…', error: hub.netError || 'Offline', off: 'Off (?local=1)' }[net];
  st.innerHTML = `
    <div class="st-row"><span class="dot ${net}"></span><span>Internet</span><span class="st-val">${esc(netLabel)}</span></div>
    <div class="st-row"><span class="dot online"></span><span>This computer</span><span class="st-val">Ready (other tabs/windows)</span></div>
    <div class="st-row"><span class="dot none"></span><span>Room</span><span class="st-val mono">${esc(ROOM)}</span></div>
    ${LOCAL_ONLY ? '' : `<div class="st-row" title="Needed for phones on mobile data or strict networks — see README"><span class="dot ${hub.hasTurn ? 'online' : 'none'}"></span><span>Mobile relay</span><span class="st-val">${hub.hasTurn ? 'TURN relay set up' : 'Not set up (mobile data may fail)'}</span></div>`}`;
  $('#chip').innerHTML = `<span class="dot ${net}"></span>${hub.viewers.size} screen${hub.viewers.size === 1 ? '' : 's'} connected`;

  // ---- cameras / screens
  const vbs = viewersByScreen();
  $('#camList').innerHTML = cams.map((c) => {
    const n = (vbs.get(c.screen) || []).length;
    const on = sel && sel.id === c.id;
    return `<div class="row ${on ? 'sel' : ''}" data-cam="${c.id}">
      <span class="badge" style="--c:${c.color}">${c.screen}</span>
      <span class="name">${esc(c.name)}</span>
      <span class="conn ${n ? 'live' : ''}" title="${n} display${n === 1 ? '' : 's'} showing this camera">${n ? `● ${n}` : '○'}</span>
      <a class="ib" href="${esc(screenUrl(c.screen))}" target="_blank" title="Open screen ${c.screen} in a new tab" data-stop>${ICON.open}</a>
      <button class="ib ${pilot === c.id ? 'on' : ''}" data-pilot="${c.id}" title="Look through this camera">${ICON.eye}</button>
      <button class="ib" data-delcam="${c.id}" title="Delete camera">${ICON.x}</button>
    </div>`;
  }).join('') || '<div class="empty">No cameras yet.</div>';

  const orphan = [...vbs.keys()].filter((n) => !cams.some((c) => c.screen === n)).sort((a, b) => a - b);
  $('#orphans').innerHTML = orphan.map((n) =>
    `<div class="orphan">Screen ${n} is open but has no camera <button class="btn small" data-mkcam="${n}">Create camera ${n}</button></div>`).join('');

  // ---- models
  $('#objList').innerHTML = objs.map((o) => {
    const on = sel && sel.id === o.id;
    const tag = o.status === 'loading' ? '<span class="tag">loading…</span>'
      : o.status === 'error' ? `<span class="tag err" title="${esc(o.err)}">error</span>`
      : `<span class="tag">${o.kind === 'demo' ? 'built-in' : o.kind === 'url' ? 'web' : 'file'}</span>`;
    return `<div class="row ${on ? 'sel' : ''}" data-obj="${o.id}">
      <span class="name">${esc(o.name)}</span>${tag}
      <button class="ib" data-delobj="${o.id}" title="Remove">${ICON.x}</button>
    </div>`;
  }).join('') || '<div class="empty">No models. Drop a file anywhere on the page.</div>';

  // ---- preview strip
  syncPreviews(vbs);
}

function syncPreviews(vbs) {
  const want = cams.map((c) => c.id).join(',');
  if (strip.dataset.ids !== want) {
    strip.dataset.ids = want;
    strip.innerHTML = cams.map((c) => `
      <div class="pv" data-pv="${c.id}">
        <div class="pv-frame" data-id="${c.id}"></div>
        <div class="pv-label"><span class="badge" style="--c:${c.color}">${c.screen}</span><span class="pv-name"></span><span class="pv-conn"></span></div>
      </div>`).join('');
  }
  for (const c of cams) {
    const el = strip.querySelector(`[data-pv="${c.id}"]`);
    if (!el) continue;
    el.classList.toggle('sel', !!(sel && sel.id === c.id));
    el.classList.toggle('piloting', pilot === c.id);
    el.style.setProperty('--c', c.color);
    el.querySelector('.badge').textContent = c.screen;
    el.querySelector('.badge').style.setProperty('--c', c.color);
    el.querySelector('.pv-name').textContent = c.name;
    const n = (vbs.get(c.screen) || []).length;
    el.querySelector('.pv-conn').textContent = n ? `● ${n}` : '';
  }
  strip.hidden = !cams.length;
}

function renderProps() {
  const box = $('#props');
  if (!sel) { box.innerHTML = '<div class="hint">Click a camera or model (in the view or the lists) to edit it.</div>'; return; }
  if (sel.type === 'camera') {
    const c = camById(sel.id);
    if (!c) return;
    box.innerHTML = `
      <div class="ptitle"><span class="badge" style="--c:${c.color}">${c.screen}</span> Camera</div>
      <label class="field"><span>Name</span><input id="pName" value="${esc(c.name)}"></label>
      <label class="field"><span>Screen #</span><input id="pScreen" type="number" min="1" step="1" value="${c.screen}"></label>
      <label class="field"><span>Zoom (FOV)</span><input id="pFov" type="range" min="10" max="120" step="1" value="${Math.round(c.obj.fov)}"><output id="pFovOut" class="mono">${Math.round(c.obj.fov)}°</output></label>
      <div class="btns">
        <button class="btn" id="pPilot">${pilot === c.id ? 'Stop looking through' : 'Look through'}</button>
        <button class="btn" id="pSnap" ${pilot ? 'disabled' : ''}>Move to my view</button>
      </div>
      <div class="link"><input readonly class="mono" value="${esc(screenUrl(c.screen))}"><button class="ib" id="pCopy" title="Copy link">${ICON.copy}</button></div>`;
    $('#pName').oninput = (e) => { c.name = e.target.value || `Camera ${c.screen}`; structural(); };
    $('#pScreen').onchange = (e) => { setScreenNumber(c, +e.target.value); renderProps(); };
    $('#pFov').oninput = (e) => {
      c.obj.fov = +e.target.value; c.obj.updateProjectionMatrix(); updateFrustum(c);
      $('#pFovOut').textContent = `${c.obj.fov}°`; saveDirty = true;
    };
    $('#pPilot').onclick = () => { setPilot(pilot === c.id ? null : c.id); renderProps(); };
    $('#pSnap').onclick = () => snapToView(c);
    $('#pCopy').onclick = () => copyText(screenUrl(c.screen), 'Link copied');
  } else {
    const o = objById(sel.id);
    if (!o) return;
    const clips = o.clips || [];
    box.innerHTML = `
      <div class="ptitle">Model</div>
      <label class="field"><span>Name</span><input id="pName" value="${esc(o.name)}"></label>
      <div class="btns">
        <button class="btn" id="pReset">Reset size &amp; place</button>
        <button class="btn" id="pFloor">Drop to floor</button>
      </div>
      ${clips.length ? `
      <label class="field"><span>Animation</span>
        <select id="pClip">${clips.map((k, i) => `<option value="${i}" ${i === o.clip ? 'selected' : ''}>${esc(k.name || 'Clip ' + (i + 1))}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" id="pAnim" ${o.anim ? 'checked' : ''}> Play animation</label>` : ''}
      <div class="hint">Use the Move / Rotate / Scale tools at the top of the view.</div>`;
    $('#pName').oninput = (e) => { o.name = e.target.value || 'Model'; structural(); };
    $('#pReset').onclick = () => resetObject(o);
    $('#pFloor').onclick = () => dropToFloor(o);
    if (clips.length) {
      $('#pClip').onchange = (e) => { o.clip = +e.target.value; playClip(o); structural(); };
      $('#pAnim').onchange = (e) => { o.anim = e.target.checked; structural(); };
    }
  }
}

function refreshWorldInputs() {
  $('#wBg').value = worldState.bg;
  $('#wFloor').checked = !!worldState.floor;
  $('#wGrid').checked = !!worldState.grid;
  $('#wLight').value = worldState.light;
}

function setWorld(patch) {
  Object.assign(worldState, patch);
  world.apply(worldState);
  structural();
}

// ---- toasts & clipboard
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), kind === 'error' || kind === 'warn' ? 7000 : 3200);
  setTimeout(() => el.remove(), kind === 'error' || kind === 'warn' ? 7600 : 3800);
}

async function copyText(text, ok) {
  try { await navigator.clipboard.writeText(text); toast(ok); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(ok); } catch { toast('Copy failed', 'error'); }
    ta.remove();
  }
}

// ---- wire up static controls
document.addEventListener('click', (e) => {
  const t = e.target.closest('button, a, .row, .pv');
  if (!t) return;
  if (t.dataset.stop !== undefined) return; // plain links
  const d = t.dataset;
  if (d.pilot) { setPilot(pilot === d.pilot ? null : d.pilot); renderProps(); return; }
  if (d.delcam) { removeCamera(d.delcam); return; }
  if (d.delobj) { removeObject(d.delobj); return; }
  if (d.mkcam) { addCamera({ screen: +d.mkcam }); select('camera', cams.find((c) => c.screen === +d.mkcam).id); return; }
  if (d.mode) { setMode(d.mode); return; }
  if (d.cam) { select('camera', d.cam); return; }
  if (d.obj) { select('object', d.obj); return; }
  if (d.pv) { select('camera', d.pv); return; }
});
strip.addEventListener('dblclick', (e) => {
  const pv = e.target.closest('.pv');
  if (pv) setPilot(pilot === pv.dataset.pv ? null : pv.dataset.pv);
});

$('#addCam').onclick = () => { const c = addCamera(); select('camera', c.id); toast(`Camera ${c.screen} added at your current view`); };
$('#addCam2').onclick = $('#addCam').onclick;
$('#exitPilot').onclick = () => setPilot(null);
$('#focus').onclick = focusSelection;
$('#copyLinks').onclick = () => copyText(
  cams.map((c) => `Screen ${c.screen} (${c.name}): ${screenUrl(c.screen)}`).join('\n') || 'No cameras yet',
  'All screen links copied');

const fileInput = $('#fileInput');
$('#importBtn').onclick = () => fileInput.click();
fileInput.onchange = () => { importFiles(fileInput.files); fileInput.value = ''; };

$('#urlForm').onsubmit = (e) => {
  e.preventDefault();
  const u = $('#urlInput').value.trim();
  if (!u) return;
  if (!C.MODEL_EXTS.includes(C.extOf(u))) { toast(`The address must end in ${C.MODEL_EXTS.map((x) => '.' + x).join(', ')}`, 'error'); return; }
  addObject({ kind: 'url', url: u, name: C.baseName(u).replace(/\.[^.]+$/, '') });
  $('#urlInput').value = '';
};

$('#wBg').oninput = (e) => setWorld({ bg: e.target.value });
$('#wFloor').onchange = (e) => setWorld({ floor: e.target.checked });
$('#wGrid').onchange = (e) => setWorld({ grid: e.target.checked });
$('#wLight').oninput = (e) => setWorld({ light: +e.target.value });

$('#saveScene').onclick = downloadScene;
const sceneInput = $('#sceneInput');
$('#openScene').onclick = () => sceneInput.click();
sceneInput.onchange = async () => {
  const f = sceneInput.files[0];
  sceneInput.value = '';
  if (!f) return;
  try { await applyScene(JSON.parse(await f.text())); toast('Scene loaded'); }
  catch (e) { toast('That is not a Scene3D scene file', 'error'); }
};
$('#resetScene').onclick = () => {
  if (confirm('Replace everything with the default demo scene?')) defaultScene();
};

$('#helpBtn').onclick = () => { $('#help').hidden = false; };
$('#help').onclick = (e) => { if (e.target.id === 'help' || e.target.closest('[data-close]')) $('#help').hidden = true; };

// ---- drag & drop anywhere
let dragDepth = 0;
addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; $('#dropHint').hidden = false; e.preventDefault(); } });
addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropHint').hidden = true; });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropHint').hidden = true;
  importFiles(await filesFromDrop(e.dataTransfer));
});

// ---- keyboard
addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'w') setMode('translate');
  else if (k === 'e') setMode('rotate');
  else if (k === 'r') setMode('scale');
  else if (k === 'c') $('#addCam').click();
  else if (k === 'f') focusSelection();
  else if (k === 'escape') { if (pilot) setPilot(null); else select(null); $('#help').hidden = true; }
  else if (k === 'delete' || k === 'backspace') {
    if (!sel) return;
    if (sel.type === 'camera') removeCamera(sel.id); else removeObject(sel.id);
  } else if (/^[1-9]$/.test(k)) {
    const c = cams.find((x) => x.screen === +k);
    if (c) setPilot(pilot === c.id ? null : c.id);
  } else if (k === '0') setPilot(null);
  else return;
  e.preventDefault();
});

// ---- models that live in the site's models/ folder
async function loadSiteModels() {
  try {
    const r = await fetch(BASE + 'models/models.json', { cache: 'no-cache' });
    if (!r.ok) return;
    const list = (await r.json()).map((m) => (typeof m === 'string' ? { url: 'models/' + m, name: m.replace(/\.[^.]+$/, '') } : m));
    if (!list.length) return;
    $('#siteModels').hidden = false;
    $('#siteModelList').innerHTML = list.map((m, i) => `<button class="chip" data-site="${i}">+ ${esc(m.name || m.url)}</button>`).join('');
    $('#siteModelList').onclick = (e) => {
      const b = e.target.closest('[data-site]');
      if (!b) return;
      const m = list[+b.dataset.site];
      addObject({ kind: 'url', url: m.url, name: m.name || C.baseName(m.url) });
    };
  } catch {}
}

// ===========================================================================
//  Start
// ===========================================================================
(async function start() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch {}
  if (PARAMS.get('scene')) {
    try { await applyScene(await (await fetch(resolveUrl(PARAMS.get('scene')))).json()); }
    catch { toast('Could not load the scene from ?scene=', 'error'); defaultScene(); }
  } else if (saved && (saved.cams || saved.objs)) {
    await applyScene(saved);
  } else {
    defaultScene();
  }
  if (PARAMS.get('model')) addObject({ kind: 'url', url: PARAMS.get('model'), name: C.baseName(PARAMS.get('model')).replace(/\.[^.]+$/, '') });
  setMode('translate');
  renderProps();
  loadSiteModels();
})();

// Expose for debugging / tests.
window.scene3d = { cams, objs, hub, addCamera, addObject, select, setPilot, serialize };
