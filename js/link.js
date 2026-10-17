// Connection layer between the master page and the screen pages.
//
// Two transports run side by side:
//   • local – BroadcastChannel. Screens opened in the same browser on the same
//             computer as the master (e.g. one PC driving several monitors).
//             Zero latency, works with no internet at all.
//   • net   – PeerJS / WebRTC data channels. Screens on any other computer.
//             A free public signalling server introduces the browsers, then
//             data flows directly between them.

import { ROOM, BASE, peerOptions, LOCAL_ONLY, NET_ONLY } from './config.js';

const MASTER_PEER_ID = `s3d-${ROOM}-master`;
const CHANNEL_NAME = `s3d:${ROOM}`;
const ALIVE_MS = 2000;
const TIMEOUT_MS = 7000;

let peerLibPromise = null;
function loadPeerJS() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (!peerLibPromise) {
    peerLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = BASE + 'lib/peerjs/peerjs.min.js';
      s.onload = () => resolve(window.Peer);
      s.onerror = () => reject(new Error('Could not load PeerJS'));
      document.head.appendChild(s);
    });
  }
  return peerLibPromise;
}

const rid = () => Math.random().toString(36).slice(2, 10);

// ===========================================================================
//  Master side
// ===========================================================================
export class MasterHub {
  constructor() {
    this.viewers = new Map(); // key -> { key, screen, kind, send, last, info }
    this.onJoin = () => {};
    this.onLeave = () => {};
    this.onStatus = () => {};
    this.netStatus = LOCAL_ONLY ? 'off' : 'connecting';
    this.netError = '';
  }

  start() {
    if (!NET_ONLY) this._startLocal();
    if (!LOCAL_ONLY) this._startNet();
    setInterval(() => this._tick(), ALIVE_MS);
    addEventListener('pagehide', () => {
      this.broadcast({ t: 'bye' });
      if (this.peer) this.peer.destroy();
    });
  }

  // ---- local ------------------------------------------------------------
  _startLocal() {
    if (!('BroadcastChannel' in window)) return;
    const ch = (this.channel = new BroadcastChannel(CHANNEL_NAME));
    ch.onmessage = (ev) => {
      const { from, to, m } = ev.data || {};
      if (to !== 'master' || !m) return;
      const key = 'local:' + from;
      if (m.t === 'probe') {
        ch.postMessage({ from: 'master', to: from, m: { t: 'probe-ok' } });
      } else if (m.t === 'join') {
        this._register(key, 'local', m, (msg) => ch.postMessage({ from: 'master', to: from, m: msg }));
      } else if (m.t === 'leave') {
        this._drop(key);
      } else {
        const v = this.viewers.get(key);
        if (v) v.last = performance.now();
      }
    };
    ch.postMessage({ from: 'master', to: '*', m: { t: 'master-up' } });
  }

  // ---- net --------------------------------------------------------------
  async _startNet() {
    let Peer;
    try { Peer = await loadPeerJS(); }
    catch (e) { this._setNet('error', 'PeerJS library failed to load'); return; }

    const open = () => {
      this._setNet('connecting');
      const peer = (this.peer = new Peer(MASTER_PEER_ID, peerOptions()));
      peer.on('open', () => this._setNet('online'));
      peer.on('connection', (conn) => this._acceptConn(conn));
      peer.on('disconnected', () => {
        if (peer.destroyed) return;
        this._setNet('connecting', 'lost signalling server, reconnecting…');
        setTimeout(() => { if (!peer.destroyed) peer.reconnect(); }, 2000);
      });
      peer.on('error', (err) => {
        const type = err && err.type;
        if (type === 'unavailable-id') {
          this._setNet('error', 'Another master is already open for this room. Retrying…');
          peer.destroy();
          setTimeout(open, 5000);
        } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(type)) {
          this._setNet('error', 'Signalling server unreachable. Retrying…');
          peer.destroy();
          setTimeout(open, 5000);
        } else if (type === 'browser-incompatible') {
          this._setNet('error', 'This browser does not support WebRTC');
        } else {
          console.warn('[peer]', type, err);
        }
      });
    };
    open();
  }

  _acceptConn(conn) {
    const key = 'net:' + conn.peer + ':' + conn.connectionId;
    conn.on('data', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'join') {
        this._register(key, 'net', m, (msg) => { if (conn.open) conn.send(msg); });
      } else {
        const v = this.viewers.get(key);
        if (v) v.last = performance.now();
      }
    });
    conn.on('close', () => this._drop(key));
    conn.on('error', () => this._drop(key));
    const v = { conn };
    this._pendingConns = this._pendingConns || new Map();
    this._pendingConns.set(key, v);
  }

  // ---- bookkeeping ------------------------------------------------------
  _register(key, kind, m, send) {
    const existing = this.viewers.get(key);
    const v = { key, kind, screen: +m.screen || 0, send, last: performance.now(), info: m.info || '' };
    this.viewers.set(key, v);
    if (existing) this.onLeave(existing, true);
    this.onJoin(v);
  }

  _drop(key) {
    const v = this.viewers.get(key);
    if (!v) return;
    this.viewers.delete(key);
    if (v.kind === 'net' && this._pendingConns) {
      const p = this._pendingConns.get(key);
      if (p) { try { p.conn.close(); } catch {} this._pendingConns.delete(key); }
    }
    this.onLeave(v, false);
  }

  _tick() {
    const now = performance.now();
    for (const v of [...this.viewers.values()]) {
      if (now - v.last > TIMEOUT_MS) this._drop(v.key);
    }
    this.broadcast({ t: 'alive' });
  }

  _setNet(status, err = '') {
    this.netStatus = status;
    this.netError = err;
    this.onStatus();
  }

  broadcast(msg) {
    for (const v of this.viewers.values()) v.send(msg);
    if (msg.t === 'bye' && this.channel) this.channel.postMessage({ from: 'master', to: '*', m: msg });
  }
}

// ===========================================================================
//  Screen (viewer) side
// ===========================================================================
export class ViewerLink {
  constructor(screen) {
    this.screen = screen;
    this.id = rid();
    this.mode = null; // 'local' | 'net' | null
    this.connected = false;
    this.onMessage = () => {};
    this.onStatus = () => {};
    this.status = 'Looking for the master…';
    this.lastHeard = 0;
  }

  start() {
    if (!NET_ONLY && 'BroadcastChannel' in window) {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (ev) => this._onLocal(ev.data || {});
    }
    addEventListener('pagehide', () => this._leave());
    setInterval(() => this._tick(), ALIVE_MS);
    this._attempt();
  }

  _set(connected, mode, status) {
    this.connected = connected;
    this.mode = mode;
    this.status = status;
    this.onStatus();
  }

  // Try same-computer first (instant), then the network.
  async _attempt() {
    if (this.connected || this._attempting) return;
    this._attempting = true;
    try {
      if (this.channel && await this._probeLocal()) {
        this._joinLocal();
        return;
      }
      if (!LOCAL_ONLY) await this._connectNet();
      else { this._set(false, null, 'Waiting for the master on this computer…'); this._retry(2000); }
    } finally {
      this._attempting = false;
    }
  }

  _probeLocal() {
    return new Promise((resolve) => {
      this._probeResolve = resolve;
      this.channel.postMessage({ from: this.id, to: 'master', m: { t: 'probe' } });
      setTimeout(() => { if (this._probeResolve === resolve) { this._probeResolve = null; resolve(false); } }, 400);
    });
  }

  _onLocal({ from, to, m }) {
    if (from !== 'master' || !m) return;
    if (to !== this.id && to !== '*') return;
    if (m.t === 'probe-ok' && this._probeResolve) {
      const r = this._probeResolve; this._probeResolve = null; r(true); return;
    }
    if (m.t === 'master-up' && !this.connected) {
      if (this._attempting) this._retry(450); else this._attempt();
      return;
    }
    if (this.mode !== 'local') return;
    if (m.t === 'bye') { this._lost('Master closed'); return; }
    this.lastHeard = performance.now();
    this.onMessage(m);
  }

  _joinLocal() {
    if (this.net) this._closeNet();
    this.lastHeard = performance.now();
    this._set(true, 'local', 'Connected (same computer)');
    this.channel.postMessage({ from: this.id, to: 'master', m: { t: 'join', screen: this.screen, info: navigator.userAgent } });
  }

  async _connectNet() {
    let Peer;
    try { Peer = await loadPeerJS(); }
    catch { this._set(false, null, 'Could not load the networking library'); this._retry(); return; }

    this._set(false, null, 'Connecting over the internet…');
    if (!this.peer || this.peer.destroyed) {
      await new Promise((resolve) => {
        const peer = (this.peer = new Peer(undefined, peerOptions()));
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        peer.on('open', finish);
        peer.on('error', (err) => {
          const type = err && err.type;
          if (type === 'peer-unavailable') {
            this._set(false, null, 'Waiting for the master page to open…');
            this._retry();
          } else if (['network', 'server-error', 'socket-error', 'socket-closed', 'unavailable-id'].includes(type)) {
            this._set(false, null, 'Signalling server unreachable, retrying…');
            peer.destroy();
            this._retry();
          } else {
            console.warn('[peer]', type, err);
          }
          finish();
        });
        peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 2000); });
        setTimeout(finish, 10000);
      });
    }
    if (!this.peer || this.peer.destroyed || !this.peer.open) { this._retry(); return; }

    const conn = this.peer.connect(MASTER_PEER_ID, { reliable: true });
    this.net = conn;
    conn.on('open', () => {
      if (this.net !== conn) return;
      if (this.mode === 'local') { conn.close(); return; }
      this.lastHeard = performance.now();
      this._set(true, 'net', 'Connected over the internet');
      conn.send({ t: 'join', screen: this.screen, info: navigator.userAgent });
    });
    conn.on('data', (m) => {
      if (this.net !== conn || !m) return;
      if (m.t === 'bye') { this._lost('Master closed'); return; }
      this.lastHeard = performance.now();
      this.onMessage(m);
    });
    conn.on('close', () => { if (this.net === conn) this._lost('Connection closed'); });
    conn.on('error', () => { if (this.net === conn) this._lost('Connection error'); });
    setTimeout(() => {
      if (this.net === conn && !this.connected) this._lost('Could not reach the master');
    }, 15000);
  }

  _closeNet() {
    const c = this.net;
    this.net = null;
    if (c) try { c.close(); } catch {}
  }

  _lost(why) {
    if (this.mode === 'net') this._closeNet();
    this._set(false, null, why + ' — reconnecting…');
    this._retry(1500);
  }

  _retry(ms = 3000) {
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._attempt(), ms);
  }

  _tick() {
    if (!this.connected) return;
    if (performance.now() - this.lastHeard > TIMEOUT_MS) { this._lost('Master not responding'); return; }
    this.send({ t: 'ping' });
  }

  send(msg) {
    if (this.mode === 'local') this.channel.postMessage({ from: this.id, to: 'master', m: msg });
    else if (this.mode === 'net' && this.net && this.net.open) this.net.send(msg);
  }

  _leave() {
    if (this.mode === 'local') this.send({ t: 'leave' });
    if (this.peer) this.peer.destroy();
  }
}
