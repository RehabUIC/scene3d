// Webcam head tracking with MediaPipe Face Landmarker.
// Produces the viewer's head position in rig space (metres), see cave.js.
//
// Depth comes from the distance between the two pupils in the image
// (average adult ≈ 63 mm, uses the "eye separation" setting), so it needs no
// calibration. The webcam is assumed to sit on top of the centre monitor,
// looking straight ahead.

import * as THREE from 'three';
import { OneEuro, webcamPos } from './cave.js';

const MP_VER = '1.0.1';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let landmarkerPromise = null;
function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import(/* webpackIgnore: true */ `${MP_BASE}/vision_bundle.mjs`);
      const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      const make = (delegate) => vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
      });
      try { return await make('GPU'); } catch { return await make('CPU'); }
    })();
    landmarkerPromise.catch(() => { landmarkerPromise = null; });
  }
  return landmarkerPromise;
}

export class HeadTracker {
  // getCfg(): current CAVE settings; onHead(Vector3); onStatus(text, ok)
  constructor(getCfg, onHead, onStatus) {
    this.getCfg = getCfg;
    this.onHead = onHead;
    this.onStatus = onStatus;
    this.running = false;
    this.filters = [new OneEuro(), new OneEuro(), new OneEuro()];
    this.fps = 0;
    this.face = null; // last face position in the image (0..1), for the preview dot
  }

  async start(video) {
    if (this.running) return;
    this.running = true;
    try {
      this.onStatus('Starting webcam…');
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 }, facingMode: 'user' },
        audio: false,
      });
      this.video = video || document.createElement('video');
      this.video.srcObject = this.stream;
      this.video.muted = true;
      this.video.playsInline = true;
      await this.video.play();
      this.onStatus('Loading face tracker (first time ≈ 10 MB)…');
      this.lm = await getLandmarker();
      if (!this.running) return;
      this.onStatus('Tracking', true);
      this._lastVideoTime = -1;
      this._frames = 0;
      this._fpsT = performance.now();
      // A timer (not requestAnimationFrame) keeps tracking going even when
      // this window is behind others.
      this.timer = setInterval(() => this._step(), 1000 / 60);
    } catch (e) {
      this.running = false;
      this.stop();
      const msg = e && e.name === 'NotAllowedError' ? 'Webcam permission denied' :
        e && e.name === 'NotFoundError' ? 'No webcam found' : 'Could not start: ' + (e && e.message || e);
      this.onStatus(msg);
      throw e;
    }
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.face = null;
  }

  _step() {
    const v = this.video;
    if (!this.running || !v || v.readyState < 2 || v.currentTime === this._lastVideoTime) return;
    this._lastVideoTime = v.currentTime;
    const now = performance.now();
    let res;
    try { res = this.lm.detectForVideo(v, now); } catch { return; }
    this._frames++;
    if (now - this._fpsT > 1000) { this.fps = Math.round((this._frames * 1000) / (now - this._fpsT)); this._frames = 0; this._fpsT = now; }
    const lm = res && res.faceLandmarks && res.faceLandmarks[0];
    if (!lm) { this.face = null; this.onStatus('No face in view', false); return; }

    const cfg = this.getCfg();
    const W = v.videoWidth, H = v.videoHeight;
    // pupil centres (iris landmarks) if present, otherwise outer eye corners
    const a = lm.length > 473 ? lm[468] : lm[33];
    const b = lm.length > 473 ? lm[473] : lm[263];
    const px = ((a.x + b.x) / 2) * W, py = ((a.y + b.y) / 2) * H;
    const ipdPx = Math.hypot((a.x - b.x) * W, (a.y - b.y) * H);
    if (ipdPx < 4) return;
    const f = (W / 2) / Math.tan(THREE.MathUtils.degToRad(cfg.camFov) / 2);
    const z = ((f * (cfg.ipd / 1000)) / ipdPx) * cfg.depthMul;
    const x = (-(px - W / 2) * z) / f; // the webcam image is not mirrored
    const y = (-(py - H / 2) * z) / f;
    this.face = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    const cam = webcamPos(cfg);
    const raw = [cam.x + x, cam.y + y, cam.z + z];
    const minCutoff = THREE.MathUtils.lerp(4, 0.4, cfg.smooth);
    const t = now / 1000;
    const out = raw.map((val, i) => { const fl = this.filters[i]; fl.minCutoff = minCutoff; fl.beta = 3; return fl.filter(val, t); });
    this.onHead(new THREE.Vector3(out[0], out[1], out[2]));
    this.onStatus(`Tracking · ${this.fps} fps`, true);
  }
}
