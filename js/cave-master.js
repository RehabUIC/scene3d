// The CAVE rig as an object in the master's 3D world: three screen outlines,
// the viewer's head, and the sight lines through each screen. Moving or
// rotating this object moves all three CAVE views together.

import * as THREE from 'three';
import {
  caveCfg, screenCorners, defaultHead, eyes, setOffAxis, makeCaveCamera, webcamPos,
} from './cave.js';

const SCREEN_COLORS = [0xff6b6b, 0x4cc2ff, 0xffd166];
export const HEAD_CHANNEL = (room) => `s3d:${room}:head`;

export class CaveRig {
  constructor(scene) {
    this.cfg = caveCfg();
    this.group = new THREE.Group();
    this.group.name = 'caveRig';
    this.group.userData.cave = true;
    this.helper = new THREE.Group();
    this.group.add(this.helper);
    scene.add(this.group);
    this.head = defaultHead(this.cfg);
    this.headMode = 'fixed'; // 'fixed' | 'mouse' | 'webcam' | 'remote'
    this.pickables = [];
    this.previewCams = [makeCaveCamera(), makeCaveCamera(), makeCaveCamera()];
    this.reset();
    this._build();
  }

  reset() {
    this.group.position.set(0, 1.0, 3.2);
    this.group.quaternion.identity();
    this.setScale(this.cfg.scale);
    this.head = defaultHead(this.cfg);
  }

  setScale(s) {
    this.cfg.scale = s;
    this.group.scale.setScalar(s);
  }

  setCfg(patch) {
    const geomChanged = ['diag', 'aw', 'ah', 'bezel', 'angle', 'camUp'].some((k) => k in patch && patch[k] !== this.cfg[k]);
    const distChanged = 'dist' in patch && patch.dist !== this.cfg.dist;
    Object.assign(this.cfg, patch);
    if ('scale' in patch) this.setScale(patch.scale);
    if (distChanged && this.headMode === 'fixed') this.head = defaultHead(this.cfg);
    if (geomChanged) this._build();
  }

  toJSON() { return { ...this.cfg }; }

  poseArray() {
    const g = this.group, r = (x) => Math.round(x * 1e5) / 1e5;
    return [
      r(g.position.x), r(g.position.y), r(g.position.z),
      r(g.quaternion.x), r(g.quaternion.y), r(g.quaternion.z), r(g.quaternion.w),
      r(this.cfg.scale), r(this.head.x), r(this.head.y), r(this.head.z),
    ];
  }

  load(cfg, k) {
    this.cfg = caveCfg(cfg);
    if (k && k.length >= 8) {
      this.group.position.set(k[0], k[1], k[2]);
      this.group.quaternion.set(k[3], k[4], k[5], k[6]);
    }
    this.setScale(this.cfg.scale);
    this.head = defaultHead(this.cfg);
    this._build();
  }

  // Put the rig so the viewer's eye is where the editor camera is, looking the
  // same way (kept level).
  placeAtView(cam) {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    this.group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const eyeLocal = defaultHead(this.cfg).multiplyScalar(this.cfg.scale).applyQuaternion(this.group.quaternion);
    this.group.position.copy(cam.position).sub(eyeLocal);
  }

  _build() {
    for (const c of [...this.helper.children]) {
      this.helper.remove(c);
      c.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
    }
    this.pickables = [];
    const corners = screenCorners(this.cfg);
    corners.forEach((s, i) => {
      const pd = s.pb.clone().add(s.pc).sub(s.pa); // top-right = pb + (pc - pa)
      const geo = new THREE.BufferGeometry().setFromPoints([s.pa, s.pb, pd, s.pa, pd, s.pc]);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: SCREEN_COLORS[i], transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false,
      }));
      mesh.userData.cave = true;
      this.pickables.push(mesh);
      const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([s.pa, s.pb, pd, s.pc]),
        new THREE.LineBasicMaterial({ color: SCREEN_COLORS[i] }));
      const label = makeLabel(String(i + 1), SCREEN_COLORS[i]);
      label.position.copy(s.pa).add(pd).multiplyScalar(0.5);
      label.scale.setScalar(0.12);
      this.helper.add(mesh, edge, label);
    });
    // head + webcam markers and sight lines (updated every frame)
    this.headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.06, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.headMesh.userData.cave = true;
    this.pickables.push(this.headMesh);
    const cam = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.025, 0.025), new THREE.MeshBasicMaterial({ color: 0x8b93a3 }));
    cam.position.copy(webcamPos(this.cfg));
    const lines = new THREE.BufferGeometry();
    lines.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * 2 * 12), 3));
    this.sight = new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
    this.helper.add(this.headMesh, cam, this.sight);
    this._corners = corners;
  }

  // Called every frame on the master.
  update() {
    this.headMesh.position.copy(this.head);
    const arr = this.sight.geometry.attributes.position.array;
    let i = 0;
    for (const s of this._corners) {
      const pd = s.pb.clone().add(s.pc).sub(s.pa);
      for (const p of [s.pa, s.pb, s.pc, pd]) {
        arr[i++] = this.head.x; arr[i++] = this.head.y; arr[i++] = this.head.z;
        arr[i++] = p.x; arr[i++] = p.y; arr[i++] = p.z;
      }
    }
    this.sight.geometry.attributes.position.needsUpdate = true;
    this.sight.geometry.computeBoundingSphere();
  }

  // Mono (centre-eye) camera for screen index 0..2, for the master's previews.
  previewCamera(idx) {
    this.group.updateMatrixWorld(true);
    const cam = this.previewCams[idx];
    const e = eyes(this.cfg, this.head);
    setOffAxis(cam, this.group.matrixWorld, this._corners[idx], e.c, this.cfg.near / 100, 2000 / Math.max(0.01, this.cfg.scale));
    return cam;
  }
}

function makeLabel(text, color) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#' + color.toString(16).padStart(6, '0');
  g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#0d0f13';
  g.font = 'bold 72px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 64, 68);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.renderOrder = 998;
  return s;
}
