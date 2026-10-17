// Screen page: shows what one of the master's cameras sees.
// The scene is rendered here, locally, from camera/object positions the
// master sends — so the picture is always full resolution and lag-free.

import * as THREE from 'three';
import { CONFIG, PARAMS, ROOM } from './config.js';
import { ViewerLink } from './link.js';
import * as C from './common.js';

const $ = (s) => document.querySelector(s);
const SCREEN = Math.max(1, parseInt((window.S3D && window.S3D.screen) || PARAMS.get('screen') || '1', 10) || 1);
const FIT_WINDOW = PARAMS.get('fit') === 'window'; // ?fit=window → use the window's shape instead of 16:9
document.title = `Screen ${SCREEN} · Scene3D`;
$('#screenNo').textContent = SCREEN;

const canvas = $('#c');
const renderer = C.createRenderer(canvas);
const world = C.createWorld(renderer);
const { scene, content } = world;
const cam = new THREE.PerspectiveCamera(50, CONFIG.aspect, 0.01, 2000);
cam.position.set(0, 1.5, 5);
cam.lookAt(0, 1, 0);

// ---------------------------------------------------------------------------
//  Scene mirror
// ---------------------------------------------------------------------------
let state = null;
let myCamId = null;
const items = new Map();   // id -> { wrapper, pivot, kind, src, model, mixer, action, clips, clip }
const incoming = new Map(); // id -> { main, files:[{name,size,buf,got}], got, total }

function applyState(s) {
  state = s;
  world.apply(s.world || {});

  const c = (s.cams || []).find((x) => x.screen === SCREEN);
  myCamId = c ? c.id : null;
  if (c) { C.applyCamPose(cam, c.pose); cam.fov = c.fov; cam.updateProjectionMatrix(); }

  const wanted = new Set((s.objs || []).map((o) => o.id));
  for (const [id, it] of items) {
    if (!wanted.has(id)) {
      content.remove(it.wrapper);
      if (it.model) C.disposeObject(it.model);
      items.delete(id);
      incoming.delete(id);
    }
  }
  for (const o of s.objs || []) {
    let it = items.get(o.id);
    if (!it) {
      const { wrapper, pivot } = C.makeWrapper(o.id);
      it = { wrapper, pivot, kind: o.kind, clip: o.clip || 0 };
      items.set(o.id, it);
      content.add(wrapper);
      if (o.kind === 'demo') attachModel(it, C.buildDemo());
      else if (o.kind === 'url') load(it, { url: o.url }, o.name);
      // 'file' models arrive as 'asset' + 'chunk' messages
    }
    if (o.pivot) it.pivot.position.fromArray(o.pivot);
    C.applyObjPose(it.wrapper, o.xform);
    it.anim = o.anim;
    if (it.clip !== o.clip) { it.clip = o.clip; playClip(it); }
  }
  updateOverlay();
}

async function load(it, src, name) {
  it.loading = true;
  updateOverlay();
  try {
    const res = await C.loadModel(src);
    if (![...items.values()].includes(it)) { C.disposeObject(res.object); return; }
    attachModel(it, res);
  } catch (e) {
    console.error(e);
    flash(`Could not load ${name || 'a model'}: ${e.message}`);
  } finally {
    it.loading = false;
    updateOverlay();
  }
}

function attachModel(it, res) {
  it.model = res.object;
  it.clips = res.animations || [];
  it.pivot.add(res.object);
  if (it.clips.length) {
    it.mixer = new THREE.AnimationMixer(res.object);
    playClip(it);
  }
}

function playClip(it) {
  if (!it.mixer) return;
  it.mixer.stopAllAction();
  const clip = it.clips[it.clip] || it.clips[0];
  if (clip) { it.action = it.mixer.clipAction(clip); it.action.play(); }
}

function applyPose(p) {
  if (myCamId && p.c && p.c[myCamId]) C.applyCamPose(cam, p.c[myCamId]);
  if (p.o) {
    for (const id in p.o) {
      const it = items.get(id);
      if (!it) continue;
      const a = p.o[id];
      C.applyObjPose(it.wrapper, a);
      if (it.action && a[10] >= 0) { it.action.time = a[10]; it.mixer.update(0); }
    }
  }
}

// ---- model files streamed from the master ---------------------------------
function onAsset(m) {
  incoming.set(m.id, {
    main: m.main,
    files: m.files.map((f) => ({ name: f.name, size: f.size, buf: new Uint8Array(f.size), got: 0 })),
    got: 0,
    total: m.files.reduce((s, f) => s + f.size, 0),
  });
  checkAssetDone(m.id);
  updateOverlay();
}

function onChunk(m) {
  const inc = incoming.get(m.id);
  if (!inc) return;
  const f = inc.files[m.f];
  const data = new Uint8Array(m.data);
  f.buf.set(data, m.off);
  f.got += data.byteLength;
  inc.got += data.byteLength;
  checkAssetDone(m.id);
  updateOverlay();
}

function checkAssetDone(id) {
  const inc = incoming.get(id);
  if (!inc || inc.got < inc.total) return;
  incoming.delete(id);
  const it = items.get(id);
  if (!it || it.model) return;
  const name = (state && state.objs.find((o) => o.id === id) || {}).name;
  load(it, { main: inc.main, files: inc.files.map((f) => ({ name: f.name, data: f.buf.buffer })) }, name);
}

// ---------------------------------------------------------------------------
//  Connection
// ---------------------------------------------------------------------------
const link = new ViewerLink(SCREEN);
link.onMessage = (m) => {
  switch (m.t) {
    case 'state': applyState(m.state); break;
    case 'pose': applyPose(m); break;
    case 'asset': onAsset(m); break;
    case 'chunk': onChunk(m); break;
  }
};
link.onStatus = () => {
  if (!link.connected) { state = null; myCamId = null; }
  updateOverlay();
  pokeHud();
};
link.start();

// ---------------------------------------------------------------------------
//  Overlay / HUD
// ---------------------------------------------------------------------------
const overlay = $('#overlay'), msg = $('#msg'), sub = $('#sub'), bar = $('#bar'), barFill = $('#barFill');

function updateOverlay() {
  $('#hudStatus').textContent = `${link.status} · room ${ROOM}`;
  $('#hudDot').className = 'dot ' + (link.connected ? 'online' : 'connecting');

  let big = '', small = '', progress = null;
  if (!link.connected) {
    big = 'Waiting for the master';
    const hint = {
      'no-master': `No master is open in room “${ROOM}”. Open the master page, and if it shows a different room name, use the link from its “Copy all links” button.`,
      'no-server': 'This device cannot reach the internet signalling server.',
      blocked: 'The master was found, but this network blocks the direct link between the two devices (typical on mobile data or guest Wi-Fi). Try the same Wi-Fi as the master, or set up the free TURN relay (README → “Phones / mobile data”).',
    }[link.problem];
    small = hint || link.status;
  } else if (!state) {
    big = 'Connected'; small = 'Receiving the scene…';
  } else if (!myCamId) {
    big = `No camera for screen ${SCREEN}`;
    const used = (state.cams || []).map((c) => c.screen).sort((a, b) => a - b);
    small = used.length ? `The master has cameras for screen ${used.join(', ')}. Add one for screen ${SCREEN} there.` : 'Add a camera on the master page.';
  }
  if (incoming.size) {
    let got = 0, total = 0;
    for (const i of incoming.values()) { got += i.got; total += i.total; }
    progress = total ? got / total : 0;
  }
  const loading = [...items.values()].some((i) => i.loading);

  overlay.hidden = !big && progress === null && !loading;
  overlay.classList.toggle('solid', !!big);
  msg.textContent = big || (progress !== null ? 'Receiving model' : 'Loading model');
  sub.textContent = progress !== null ? `${Math.round(progress * 100)}%` : small;
  bar.hidden = progress === null;
  if (progress !== null) barFill.style.width = (progress * 100).toFixed(1) + '%';
}

let flashTimer;
function flash(t) {
  const el = $('#flash');
  el.textContent = t;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// HUD + cursor hide after a few seconds of no mouse movement.
let hudTimer;
function pokeHud() {
  document.body.classList.remove('idle');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => { if (link.connected) document.body.classList.add('idle'); }, 3000);
}
addEventListener('mousemove', pokeHud);
addEventListener('pointerdown', pokeHud);

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
addEventListener('dblclick', toggleFullscreen);
$('#fsBtn').onclick = toggleFullscreen;
addEventListener('keydown', (e) => { if (e.key === 'f' || e.key === 'F') toggleFullscreen(); });

// ---------------------------------------------------------------------------
//  Render loop
// ---------------------------------------------------------------------------
const timer = new THREE.Timer();
function frame() {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1);
  for (const it of items.values()) {
    // The master sends animation time with every pose; only free-run between packets.
    if (it.mixer && it.anim) it.mixer.update(dt);
  }

  const W = innerWidth, H = innerHeight;
  let w = W, h = H;
  if (!FIT_WINDOW) { w = Math.min(W, H * CONFIG.aspect); h = w / CONFIG.aspect; }
  w = Math.floor(w); h = Math.floor(h);
  const s = renderer.getSize(new THREE.Vector2());
  if (s.x !== w || s.y !== h) {
    renderer.setSize(w, h);
    canvas.style.left = Math.floor((W - w) / 2) + 'px';
    canvas.style.top = Math.floor((H - h) / 2) + 'px';
  }
  const aspect = w / h;
  if (cam.aspect !== aspect) { cam.aspect = aspect; cam.updateProjectionMatrix(); }
  renderer.render(scene, cam);
}
renderer.setAnimationLoop(frame);
addEventListener('resize', () => frame());
updateOverlay();
pokeHud();

window.scene3dScreen = { items, get state() { return state; }, link, cam };
