// Shared by the master page and the screen pages: renderer, world, model
// loading and the compact pose format sent over the wire.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { CONFIG, resolveUrl } from './config.js';

export const MODEL_EXTS = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply'];
export const DEFAULT_WORLD = { bg: '#15171c', floor: true, grid: false, light: 1 };

export const extOf = (name) => (name.split(/[?#]/)[0].split('.').pop() || '').toLowerCase();
export const baseName = (p) => decodeURIComponent(p.split(/[?#]/)[0].split('/').pop()).toLowerCase();

// ---------------------------------------------------------------------------
//  Renderer + world
// ---------------------------------------------------------------------------
export function createRenderer(canvas) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.0;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap;
  return r;
}

export function createWorld(renderer) {
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x2a2622, 0.6);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(5, 10, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = sun.shadow.camera;
  s.left = s.bottom = -8; s.right = s.top = 8; s.near = 0.5; s.far = 40;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.ShadowMaterial({ opacity: 0.28 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = 'floor';
  scene.add(floor);

  const grid = new THREE.GridHelper(20, 20, 0x5a6270, 0x30353f);
  grid.material.transparent = true;
  grid.material.opacity = 0.7;
  grid.position.y = 0.001;
  scene.add(grid);

  const content = new THREE.Group();
  content.name = 'content';
  scene.add(content);

  function apply(w) {
    w = { ...DEFAULT_WORLD, ...w };
    scene.background = new THREE.Color(w.bg);
    floor.visible = !!w.floor;
    grid.visible = !!w.grid;
    sun.intensity = 2.2 * w.light;
    hemi.intensity = 0.6 * w.light;
    scene.environmentIntensity = 0.55 * w.light;
  }
  apply(DEFAULT_WORLD);

  return { scene, floor, grid, sun, content, apply };
}

// ---------------------------------------------------------------------------
//  Built-in demo object (so the scene is never empty)
// ---------------------------------------------------------------------------
export function buildDemo() {
  const g = new THREE.Group();
  const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.42, 0.14, 220, 32),
    new THREE.MeshStandardMaterial({ color: 0x4cc2ff, metalness: 0.65, roughness: 0.22 })
  );
  knot.position.y = 1.15;
  g.add(knot);

  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.62, 0.5, 64),
    new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.55 })
  );
  plinth.position.y = 0.25;
  g.add(plinth);

  const colors = [0xff6b6b, 0xffd166, 0x06d6a0, 0xc77dff, 0xff9f1c, 0xf15bb5];
  colors.forEach((c, i) => {
    const a = (i / colors.length) * Math.PI * 2;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.28 + (i % 3) * 0.22, 0.28),
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.4 })
    );
    m.geometry.translate(0, m.geometry.parameters.height / 2, 0);
    m.position.set(Math.cos(a) * 1.45, 0, Math.sin(a) * 1.45);
    m.rotation.y = -a;
    g.add(m);
  });
  enableShadows(g);
  return { object: g, animations: [] };
}

export function enableShadows(obj) {
  obj.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
}

// ---------------------------------------------------------------------------
//  Model loading
//    src = { url }                              → load from a web address
//    src = { main, files: [{ name, data }] }    → load from in-memory files
// ---------------------------------------------------------------------------
let draco = null;
function getDraco() {
  if (!draco) {
    draco = new DRACOLoader();
    draco.setDecoderPath(CONFIG.dracoDecoderPath);
  }
  return draco;
}

export async function loadModel(src) {
  const manager = new THREE.LoadingManager();
  const blobUrls = new Map();
  let url, ext;

  if (src.files) {
    for (const f of src.files) {
      blobUrls.set(f.name.toLowerCase(), URL.createObjectURL(new Blob([f.data])));
    }
    manager.setURLModifier((u) => {
      if (u.startsWith('data:')) return u;
      const hit = blobUrls.get(baseName(u));
      return hit || u;
    });
    url = blobUrls.get(src.main.toLowerCase());
    ext = extOf(src.main);
  } else {
    url = resolveUrl(src.url);
    ext = extOf(src.url);
  }

  try {
    let object, animations = [];
    switch (ext) {
      case 'glb':
      case 'gltf': {
        const l = new GLTFLoader(manager);
        l.setDRACOLoader(getDraco());
        l.setMeshoptDecoder(MeshoptDecoder);
        const g = await l.loadAsync(url);
        object = g.scene;
        animations = g.animations || [];
        break;
      }
      case 'fbx': {
        object = await new FBXLoader(manager).loadAsync(url);
        animations = object.animations || [];
        break;
      }
      case 'obj': {
        const l = new OBJLoader(manager);
        const mtl = src.files && src.files.find((f) => extOf(f.name) === 'mtl');
        if (mtl) {
          const mats = await new MTLLoader(manager).loadAsync(blobUrls.get(mtl.name.toLowerCase()));
          mats.preload();
          l.setMaterials(mats);
        }
        object = await l.loadAsync(url);
        if (!mtl) {
          object.traverse((o) => {
            if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ color: 0xc9ced6, roughness: 0.55, metalness: 0.05 });
          });
        }
        break;
      }
      case 'stl': {
        const geo = await new STLLoader(manager).loadAsync(url);
        if (!geo.attributes.normal) geo.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({
          color: geo.hasColors ? 0xffffff : 0xc9ced6, roughness: 0.5, metalness: 0.1,
          vertexColors: !!geo.hasColors,
        });
        object = new THREE.Mesh(geo, mat);
        break;
      }
      case 'ply': {
        const geo = await new PLYLoader(manager).loadAsync(url);
        const hasColor = !!geo.attributes.color;
        if (geo.index) {
          if (!geo.attributes.normal) geo.computeVertexNormals();
          object = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
            color: hasColor ? 0xffffff : 0xc9ced6, vertexColors: hasColor, roughness: 0.6,
          }));
        } else {
          // No faces → point cloud. Point size is set after normalisation.
          object = new THREE.Points(geo, new THREE.PointsMaterial({
            color: hasColor ? 0xffffff : 0xc9ced6, vertexColors: hasColor, size: 0.012, sizeAttenuation: true,
          }));
        }
        break;
      }
      default:
        throw new Error(`Unsupported file type ".${ext}" (use ${MODEL_EXTS.join(', ')})`);
    }
    enableShadows(object);
    return { object, animations };
  } finally {
    // Textures are decoded by now; give the browser a moment, then free memory.
    setTimeout(() => blobUrls.forEach((u) => URL.revokeObjectURL(u)), 5000);
  }
}

// Offset that puts the model's centre at the origin, plus a scale that makes
// its largest side 2 units. Computed once on the master and sent to screens.
export function measureModel(object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return { pivot: [0, 0, 0], scale: 1, lift: 0 };
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 2 / maxDim;
  return { pivot: [-center.x, -center.y, -center.z], scale, lift: (size.y / 2) * scale };
}

// wrapper (synced transform) → pivot (centering offset) → model
export function makeWrapper(id) {
  const wrapper = new THREE.Group();
  wrapper.userData.s3dId = id;
  const pivot = new THREE.Group();
  wrapper.add(pivot);
  return { wrapper, pivot };
}

// ---------------------------------------------------------------------------
//  Compact pose arrays
// ---------------------------------------------------------------------------
const r5 = (x) => Math.round(x * 1e5) / 1e5;

export function camPose(cam) {
  const p = cam.position, q = cam.quaternion;
  return [r5(p.x), r5(p.y), r5(p.z), r5(q.x), r5(q.y), r5(q.z), r5(q.w), r5(cam.fov)];
}
export function applyCamPose(cam, a) {
  cam.position.set(a[0], a[1], a[2]);
  cam.quaternion.set(a[3], a[4], a[5], a[6]);
  if (a[7] && cam.fov !== a[7]) { cam.fov = a[7]; cam.updateProjectionMatrix(); }
}

export function objPose(o, animTime = -1) {
  const p = o.position, q = o.quaternion, s = o.scale;
  return [r5(p.x), r5(p.y), r5(p.z), r5(q.x), r5(q.y), r5(q.z), r5(q.w), r5(s.x), r5(s.y), r5(s.z), r5(animTime)];
}
export function applyObjPose(o, a) {
  o.position.set(a[0], a[1], a[2]);
  o.quaternion.set(a[3], a[4], a[5], a[6]);
  o.scale.set(a[7], a[8], a[9]);
}

export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
      m.dispose();
    }
  });
}

export const CAMERA_COLORS = ['#ff6b6b', '#4cc2ff', '#ffd166', '#06d6a0', '#c77dff', '#ff9f1c', '#2ec4b6', '#f15bb5'];
export const colorForScreen = (n) => CAMERA_COLORS[(n - 1) % CAMERA_COLORS.length];
