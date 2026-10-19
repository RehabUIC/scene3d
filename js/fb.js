// Firebase Realtime Database transport.
//
// Everything for one room lives under  scene3d/<room key>/ :
//   presence   { on: 1|0, s: session }   master online? (set to 0 automatically on disconnect)
//   state      { j: "<scene JSON>" }      cameras, models, world settings
//   pose       { j: "<pose JSON>" }       latest camera/object positions (~30×/s while moving)
//   joins/<id> { screen }                 screens currently watching (removed automatically on disconnect)
//   assets/<id>/meta, assets/<id>/c/*     imported model files, in base64 pieces
//   assetIndex/<id>: true                 list of uploaded models (for cleanup)
// Values are stored as JSON strings so arrays and odd keys survive unchanged.

import { CONFIG, PARAMS, BASE } from './config.js';
import { P } from './relay.js';

export function fbConfig() {
  const c = { ...(CONFIG.firebase || {}) };
  if (!c.databaseURL && c.projectId) c.databaseURL = `https://${c.projectId}-default-rtdb.firebaseio.com`;
  if (PARAMS.get('fbdb')) c.databaseURL = PARAMS.get('fbdb');
  return c;
}
export const FB_OFF = PARAMS.get('firebase') === 'off' || !fbConfig().databaseURL;
export const FB_ROOT = 'scene3d/' + P.split('/').pop();
export const FB_MAX_MODEL = 25 * 1024 * 1024; // bigger models: put them in models/ instead
const PIECE = CONFIG.chunkSize; // same piece size as direct transfers, so pieces line up if a screen switches link mid-way

let dbPromise = null;
export function openDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const A = await import(BASE + 'lib/firebase/firebase-app.js');
      const D = await import(BASE + 'lib/firebase/firebase-database.js');
      const cfg = fbConfig();
      const app = A.initializeApp({
        apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId,
        appId: cfg.appId, databaseURL: cfg.databaseURL,
      }, 'scene3d');
      const db = D.getDatabase(app);
      const emu = PARAMS.get('fbemu'); // testing only: ?fbemu=127.0.0.1:9000
      if (emu) { const [h, p] = emu.split(':'); D.connectDatabaseEmulator(db, h, +p); }
      const r = (path) => D.ref(db, path ? `${FB_ROOT}/${path}` : FB_ROOT);
      return { D, db, r };
    })();
  }
  return dbPromise;
}

// Read a value once (like get(), but served from the live connection).
function once(D, ref) {
  return new Promise((resolve, reject) => D.onValue(ref, resolve, reject, { onlyOnce: true }));
}

// ---- base64 helpers --------------------------------------------------------
export function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ===========================================================================
//  Master side
// ===========================================================================
export class FbMaster {
  constructor(hub) {
    this.hub = hub;
    this.up = false;
    this.error = '';
    this.lastState = '';
    this.uploaded = new Map(); // asset id -> 'uploading' | 'done' | 'too-big' | 'error'
    this.onAssetStatus = () => {};
  }

  async start() {
    let fb;
    try { fb = await openDb(); }
    catch (e) { console.warn('Firebase failed to load', e); this.error = 'Firebase library failed to load'; this.hub.onStatus(); return; }
    const { D, db, r } = (this.fb = fb);
    D.onValue(D.ref(db, '.info/connected'), (s) => {
      this.up = !!s.val();
      if (this.up) {
        this.error = '';
        D.onDisconnect(r('presence')).set({ on: 0 });
        D.set(r('presence'), { on: 1, s: this.hub.sessionId, t: D.serverTimestamp() })
          .catch((e) => { this.error = permissionHint(e); this.hub.onStatus(); });
        if (!this._pruned) { this._pruned = true; setTimeout(() => this._pruneStale(), 15000); }
      }
      this.hub.onStatus();
    });
    const joins = r('joins');
    const add = (s) => {
      const v = s.val() || {};
      this.hub._register(s.key, 'fb', { screen: v.screen, have: v.have || [] }, (msg) => this._send(msg), null);
    };
    D.onChildAdded(joins, add, (e) => { this.error = permissionHint(e); this.hub.onStatus(); });
    D.onChildChanged(joins, add);
    D.onChildRemoved(joins, (s) => this.hub._drop(s.key, 'fb'));
    addEventListener('pagehide', () => { try { D.set(r('presence'), { on: 0 }); } catch {} });
  }

  // Per-screen sends from the master app. State/pose are shared documents.
  _send(msg) {
    if (msg.t === 'state') this.writeState(msg.state);
    else if (msg.t === 'pose') this.writePose(msg);
  }

  writeState(state) {
    if (!this.up) return;
    const j = JSON.stringify(state);
    if (j === this.lastState) return;
    this.lastState = j;
    const { D, r } = this.fb;
    D.set(r('state'), { j, s: this.hub.sessionId });
  }

  writePose(pose) {
    if (!this.up) return;
    const { D, r } = this.fb;
    D.set(r('pose'), { j: JSON.stringify({ ...pose, s: this.hub.sessionId }) });
  }

  // Upload an imported model once so Firebase screens can download it.
  async uploadAsset(id, main, files) {
    if (!this.up || this.uploaded.has(id)) return;
    const total = files.reduce((s, f) => s + f.data.byteLength, 0);
    if (total > FB_MAX_MODEL) { this.uploaded.set(id, 'too-big'); this.onAssetStatus(id, 'too-big', total); return; }
    this.uploaded.set(id, 'uploading');
    const { D, r } = this.fb;
    try {
      const meta = { main, ready: false, files: files.map((f) => ({ name: f.name, size: f.data.byteLength, n: Math.ceil(f.data.byteLength / PIECE) })) };
      await D.set(r(`assets/${id}/meta`), meta);
      await D.set(r(`assetIndex/${id}`), true);
      const jobs = [];
      files.forEach((f, fi) => {
        const u8 = new Uint8Array(f.data);
        for (let k = 0; k * PIECE < u8.length; k++) jobs.push([fi, k, u8.subarray(k * PIECE, (k + 1) * PIECE)]);
      });
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) {
          const [fi, k, part] = jobs[next++];
          await D.set(r(`assets/${id}/c/${fi}_${k}`), toB64(part));
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      await D.set(r(`assets/${id}/meta/ready`), true);
      this.uploaded.set(id, 'done');
      this.onAssetStatus(id, 'done', total);
    } catch (e) {
      console.warn('model upload failed', e);
      this.uploaded.set(id, 'error');
      this.onAssetStatus(id, 'error', total);
    }
  }

  removeAsset(id) {
    if (!this.fb) return;
    const { D, r } = this.fb;
    this.uploaded.delete(id);
    D.remove(r(`assets/${id}`));
    D.remove(r(`assetIndex/${id}`));
  }

  // Remove models left over from earlier sessions that are no longer in the scene.
  async _pruneStale() {
    const { D, r } = this.fb;
    try {
      const idx = (await once(D, r('assetIndex'))).val() || {};
      const keep = new Set(this.hub.keepAssetIds ? this.hub.keepAssetIds() : []);
      for (const id of Object.keys(idx)) if (!keep.has(id)) this.removeAsset(id);
    } catch {}
  }
}

function permissionHint(e) {
  const msg = String(e && (e.message || e.code) || e);
  return /permission/i.test(msg)
    ? 'Firebase refused access: check the database rules (see README)'
    : 'Firebase error: ' + msg.slice(0, 80);
}

// ===========================================================================
//  Screen side
// ===========================================================================
export class FbViewer {
  constructor(link) {
    this.link = link;
    this.up = false;
    this.masterOn = false;
    this.state = null;
    this.fetching = new Set();
    this.listening = false;
  }

  async join() {
    if (!this.fb) {
      try { this.fb = await openDb(); }
      catch (e) { console.warn('Firebase failed to load', e); return; }
      const { D, db, r } = this.fb;
      D.onValue(D.ref(db, '.info/connected'), (s) => {
        this.up = !!s.val();
        if (this.up && this.wantJoin) this._writeJoin();
        if (!this.up && this.link.mode === 'fb') this.link._fbLost('Lost connection to Firebase');
      });
      D.onValue(r('presence'), (s) => {
        const p = s.val();
        const on = !!(p && p.on === 1);
        const newSession = on && p.s !== this.masterSession;
        this.masterOn = on;
        if (on) this.masterSession = p.s;
        if ((!on || newSession) && this.link.mode === 'fb') this.link._fbLost(on ? 'Master restarted' : 'Master closed');
        else if (on) this._maybeActivate();
        else this.link._note(`No master is open in room “${this.link.roomName}”. Is the master page open?`, 'no-master');
      }, (e) => this.link._note(permissionHint(e), 'fb-denied'));
      D.onValue(r('state'), (s) => {
        const v = s.val();
        if (!v || !v.j) return;
        try { this.state = JSON.parse(v.j); } catch { return; }
        this._maybeActivate();
        if (this.link.mode === 'fb') this._deliverState();
      });
    }
    this.wantJoin = true;
    if (this.up) this._writeJoin();
    this._listenPose(true);
  }

  _writeJoin() {
    const { D, r } = this.fb;
    const me = r(`joins/${this.link.id}`);
    D.onDisconnect(me).remove();
    D.set(me, { screen: this.link.screen, have: this.link.have(), t: D.serverTimestamp() });
  }

  // Stop using Firebase (e.g. upgraded to a direct link) to save the free quota.
  leave() {
    this.wantJoin = false;
    this._listenPose(false);
    if (this.fb && this.up) {
      const { D, r } = this.fb;
      D.remove(r(`joins/${this.link.id}`));
    }
  }

  _listenPose(on) {
    if (!this.fb || on === this.listening) return;
    const { D, r } = this.fb;
    this.listening = on;
    if (on) {
      this._unPose = D.onValue(r('pose'), (s) => {
        const v = s.val();
        if (!v || !v.j || this.link.mode !== 'fb') return;
        let m; try { m = JSON.parse(v.j); } catch { return; }
        if (m.s && m.s !== this.masterSession) return;
        this.link._deliver(m);
      });
    } else if (this._unPose) {
      this._unPose();
      this._unPose = null;
    }
  }

  _maybeActivate() {
    if (!this.wantJoin || !this.masterOn || !this.state) return;
    if (this.link.connected) return;
    this.link._activate('fb', 'Connected through Firebase');
    this._deliverState();
  }

  _deliverState() {
    this.link._deliver({ t: 'state', state: this.state });
    this._fetchAssets();
  }

  async _fetchAssets() {
    const have = new Set(this.link.have());
    for (const o of (this.state && this.state.objs) || []) {
      if (o.kind !== 'file' || have.has(o.id) || this.fetching.has(o.id)) continue;
      this.fetching.add(o.id);
      this._fetchOne(o.id).finally(() => this.fetching.delete(o.id));
    }
  }

  async _fetchOne(id) {
    const { D, r } = this.fb;
    // wait until the master has finished uploading it
    const meta = await new Promise((resolve) => {
      const un = D.onValue(r(`assets/${id}/meta`), (s) => {
        const m = s.val();
        if (m && m.ready) { un(); resolve(m); }
      });
      setTimeout(() => { un(); resolve(null); }, 180000);
    });
    if (!meta || this.link.mode !== 'fb') return;
    this.link._deliver({ t: 'asset', id, main: meta.main, files: meta.files.map((f) => ({ name: f.name, size: f.size })) });
    for (let fi = 0; fi < meta.files.length; fi++) {
      for (let k = 0; k < meta.files[fi].n; k++) {
        if (this.link.mode !== 'fb') return;
        const b64 = (await once(D, r(`assets/${id}/c/${fi}_${k}`))).val();
        if (!b64) return;
        const data = fromB64(b64);
        this.link._deliver({ t: 'chunk', id, f: fi, off: k * PIECE, data: data.buffer });
      }
    }
  }
}
