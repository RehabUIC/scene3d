// CAVE / "fish-tank VR" for three monitors.
//
// Physical layout (all in METRES, in "rig space"):
//   • The centre monitor's screen surface is the plane z = 0, centred at the
//     origin, facing +z (towards the viewer).
//   • The left and right monitors meet it at its edges, turned inward so the
//     angle between neighbouring screen surfaces is `angle` (120° = each side
//     monitor turned 60° towards you).
//   • The viewer's head is in front, by default at (0, 0, dist).
//   • x = right, y = up, z = towards the viewer.
// Screens 1, 2, 3 = left, centre, right monitor.
//
// The rig (an object in the 3D world) places this little room in the scene.
// Moving the rig moves all three views together; its scale = scene units per
// metre (bigger scale → the scene looks smaller / you "shrink" into it).
// Each eye gets an off-axis (asymmetric) projection through its monitor, so
// the monitors behave like windows into the scene: when your head moves, the
// view shifts with correct parallax.

import * as THREE from 'three';

export const DEFAULT_CAVE = {
  on: false,
  diag: 27,          // monitor diagonal, inches (visible area)
  aw: 16, ah: 9,     // monitor aspect ratio
  bezel: 1.0,        // bezel width, cm (gap between visible areas = 2 × bezel)
  angle: 120,        // degrees between neighbouring screen surfaces
  dist: 65,          // default eye distance from the centre screen, cm
  ipd: 63,           // eye separation, mm
  stereo: 'rows',    // 'rows' | 'sbs' | 'tb' | 'anaglyph' | 'off'
  swap: false,       // swap left/right eye
  scale: 1,          // scene units per metre
  near: 5,           // near clip, cm from the eye
  camFov: 60,        // webcam horizontal field of view, degrees
  camUp: 1.5,        // webcam lens above the top edge of the centre screen, cm
  smooth: 0.5,       // head-tracking smoothing 0…1
  depthMul: 1,       // head-tracking depth fine-tune
};

export const STEREO_MODES = [
  ['rows', 'Row-interleaved (passive 3D)'],
  ['sbs', 'Side-by-side'],
  ['tb', 'Top-bottom'],
  ['anaglyph', 'Anaglyph red/cyan'],
  ['off', 'Off (2D)'],
];

export const caveCfg = (c) => ({ ...DEFAULT_CAVE, ...(c || {}) });

export function screenSize(cfg) {
  const d = cfg.diag * 0.0254;
  const k = Math.hypot(cfg.aw, cfg.ah);
  return { w: (d * cfg.aw) / k, h: (d * cfg.ah) / k };
}

// Corners of the three visible screen areas in rig space:
// pa = bottom-left, pb = bottom-right, pc = top-left (as seen by the viewer).
export function screenCorners(cfg) {
  const { w, h } = screenSize(cfg);
  const b = cfg.bezel / 100;
  const turn = THREE.MathUtils.degToRad(180 - cfg.angle); // how far each side screen is turned inward
  const dirL = new THREE.Vector3(-Math.cos(turn), 0, Math.sin(turn)); // from left joint outwards
  const dirR = new THREE.Vector3(Math.cos(turn), 0, Math.sin(turn));  // from right joint outwards
  const y0 = -h / 2, y1 = h / 2;

  const centre = {
    pa: new THREE.Vector3(-w / 2, y0, 0),
    pb: new THREE.Vector3(w / 2, y0, 0),
    pc: new THREE.Vector3(-w / 2, y1, 0),
  };
  // joints sit in the middle of the two bezels
  const jl = new THREE.Vector3(-w / 2 - b, 0, 0);
  const jr = new THREE.Vector3(w / 2 + b, 0, 0);
  const lInner = jl.clone().addScaledVector(dirL, b);
  const lOuter = jl.clone().addScaledVector(dirL, b + w);
  const left = {
    pa: new THREE.Vector3(lOuter.x, y0, lOuter.z),
    pb: new THREE.Vector3(lInner.x, y0, lInner.z),
    pc: new THREE.Vector3(lOuter.x, y1, lOuter.z),
  };
  const rInner = jr.clone().addScaledVector(dirR, b);
  const rOuter = jr.clone().addScaledVector(dirR, b + w);
  const right = {
    pa: new THREE.Vector3(rInner.x, y0, rInner.z),
    pb: new THREE.Vector3(rOuter.x, y0, rOuter.z),
    pc: new THREE.Vector3(rInner.x, y1, rInner.z),
  };
  return [left, centre, right];
}

export const defaultHead = (cfg) => new THREE.Vector3(0, 0, cfg.dist / 100);

// Where the webcam lens is (top centre of the middle monitor), rig space.
export function webcamPos(cfg) {
  const { h } = screenSize(cfg);
  return new THREE.Vector3(0, h / 2 + cfg.bezel / 100 + cfg.camUp / 100, 0);
}

// Eye positions (rig space) for a head position: eyes lie along rig x.
export function eyes(cfg, head) {
  const half = cfg.ipd / 2000;
  let l = head.clone().add(new THREE.Vector3(-half, 0, 0));
  let r = head.clone().add(new THREE.Vector3(half, 0, 0));
  if (cfg.swap) [l, r] = [r, l];
  return { l, r, c: head.clone() };
}

const _vr = new THREE.Vector3(), _vu = new THREE.Vector3(), _vn = new THREE.Vector3();
const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vc = new THREE.Vector3();
const _basis = new THREE.Matrix4(), _local = new THREE.Matrix4();

// Generalised perspective projection (Kooima). Sets the camera's matrices so
// it looks from `eye` through the screen rectangle (pa, pb, pc), with the rig
// placing everything in the world. near/far are in metres.
export function setOffAxis(camera, rigMatrix, scr, eye, near, far) {
  _vr.subVectors(scr.pb, scr.pa).normalize();
  _vu.subVectors(scr.pc, scr.pa).normalize();
  _vn.crossVectors(_vr, _vu).normalize();
  _va.subVectors(scr.pa, eye);
  _vb.subVectors(scr.pb, eye);
  _vc.subVectors(scr.pc, eye);
  let d = -_va.dot(_vn);
  if (d < 1e-4) d = 1e-4; // eye behind/inside the screen plane: keep it sane
  const k = near / d;
  const l = _vr.dot(_va) * k, r = _vr.dot(_vb) * k;
  const b = _vu.dot(_va) * k, t = _vu.dot(_vc) * k;
  camera.projectionMatrix.makePerspective(l, r, t, b, near, far);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

  _basis.makeBasis(_vr, _vu, _vn);
  _local.makeTranslation(eye.x, eye.y, eye.z).multiply(_basis);
  camera.matrixWorld.multiplyMatrices(rigMatrix, _local);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  camera.matrixWorld.decompose(camera.position, camera.quaternion, camera.scale);
}

export function makeCaveCamera() {
  const cam = new THREE.PerspectiveCamera();
  cam.matrixAutoUpdate = false;
  cam.matrixWorldAutoUpdate = false;
  return cam;
}

// Rig pose array: [px,py,pz, qx,qy,qz,qw, scale, headX,headY,headZ]
export function rigMatrixFrom(k, out = new THREE.Matrix4()) {
  return out.compose(
    new THREE.Vector3(k[0], k[1], k[2]),
    new THREE.Quaternion(k[3], k[4], k[5], k[6]),
    new THREE.Vector3(k[7], k[7], k[7]),
  );
}

// ===========================================================================
//  Stereo output: draws the two eye views in the monitor's 3D format.
// ===========================================================================
export class StereoOutput {
  constructor(renderer) {
    this.renderer = renderer;
    const opt = { type: THREE.HalfFloatType, samples: 4, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true };
    this.rtL = new THREE.WebGLRenderTarget(1, 1, opt);
    this.rtR = new THREE.WebGLRenderTarget(1, 1, opt);
    // The eye images are rendered without the scene background (transparent),
    // then tone-mapped here; the background colour is added untouched so it
    // matches the normal (non-stereo) look exactly.
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tL: { value: this.rtL.texture }, tR: { value: this.rtR.texture },
        mode: { value: 0 }, H: { value: 1 }, bg: { value: new THREE.Vector3() },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D tL; uniform sampler2D tR; uniform int mode; uniform float H; uniform vec3 bg; varying vec2 vUv;
        vec3 shade(vec4 c) {
          vec3 col = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
          #ifdef TONE_MAPPING
            col = toneMapping(col);
          #endif
          col = linearToOutputTexel(vec4(col, 1.0)).rgb;
          return mix(bg, col, clamp(c.a, 0.0, 1.0));
        }
        void main() {
          vec3 c;
          if (mode == 0) {
            // row-interleaved: even rows (counted from the top) = left eye
            float row = floor(H - gl_FragCoord.y);
            c = mod(row, 2.0) < 0.5 ? shade(texture2D(tL, vUv)) : shade(texture2D(tR, vUv));
          } else {
            // anaglyph: left eye → red, right eye → cyan
            vec3 l = shade(texture2D(tL, vUv)), r = shade(texture2D(tR, vUv));
            c = vec3(dot(l, vec3(0.299, 0.587, 0.114)), r.g, r.b);
          }
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthTest: false, depthWrite: false, toneMapped: true,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.qscene = new THREE.Scene();
    this.qscene.add(this.quad);
    this.qcam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  // w, h: drawing-buffer size in device pixels
  render(scene, camL, camR, camC, mode, w, h) {
    const r = this.renderer;
    if (mode === 'off') { r.setRenderTarget(null); r.setViewport(0, 0, w, h); r.render(scene, camC); return; }
    if (mode === 'sbs' || mode === 'tb') {
      r.setRenderTarget(null);
      r.setScissorTest(true);
      const halves = mode === 'sbs'
        ? [[0, 0, w / 2, h, camL], [w / 2, 0, w / 2, h, camR]]
        : [[0, h / 2, w, h / 2, camL], [0, 0, w, h / 2, camR]];
      for (const [x, y, ww, hh, cam] of halves) {
        r.setViewport(x, y, ww, hh); r.setScissor(x, y, ww, hh); r.render(scene, cam);
      }
      r.setScissorTest(false);
      r.setViewport(0, 0, w, h);
      return;
    }
    if (this.rtL.width !== w || this.rtL.height !== h) { this.rtL.setSize(w, h); this.rtR.setSize(w, h); }
    const bgCol = scene.background && scene.background.isColor ? scene.background : null;
    const saved = scene.background;
    const savedClear = r.getClearColor(new THREE.Color()), savedAlpha = r.getClearAlpha();
    if (bgCol) { const t = {}; bgCol.getRGB(t, THREE.SRGBColorSpace); this.mat.uniforms.bg.value.set(t.r, t.g, t.b); scene.background = null; }
    else this.mat.uniforms.bg.value.set(0, 0, 0);
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.rtL); r.clear(); r.render(scene, camL);
    r.setRenderTarget(this.rtR); r.clear(); r.render(scene, camR);
    r.setRenderTarget(null);
    scene.background = saved;
    r.setClearColor(savedClear, savedAlpha);
    r.setViewport(0, 0, w, h);
    this.mat.uniforms.mode.value = mode === 'rows' ? 0 : 1;
    this.mat.uniforms.H.value = h;
    r.render(this.qscene, this.qcam);
  }
}

// ===========================================================================
//  Head-position smoothing: One Euro filter (low lag when moving fast,
//  steady when still).
// ===========================================================================
class LowPass { constructor() { this.y = null; } f(x, a) { this.y = this.y === null ? x : a * x + (1 - a) * this.y; return this.y; } }
export class OneEuro {
  constructor(minCutoff = 1, beta = 0.02, dCutoff = 1) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.x = new LowPass(); this.dx = new LowPass(); this.t = null; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(v, t) {
    if (this.t === null) { this.t = t; this.dx.f(0, 1); return this.x.f(v, 1); }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    const prev = this.x.y;
    const dv = this.dx.f((v - prev) / dt, OneEuro.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(dv);
    return this.x.f(v, OneEuro.alpha(cutoff, dt));
  }
}
