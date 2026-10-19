// Connection layer between the master page and the screen pages.
//
// Transports, from fastest to most robust:
//   • local    – BroadcastChannel. Screens in the same browser on the same
//                computer as the master (one PC driving several monitors).
//                Instant, works with no internet.
//   • direct   – PeerJS / WebRTC. A browser-to-browser link; lowest latency
//                across computers, but some networks block it.
//   • firebase – Firebase Realtime Database (fb.js). Works on any network,
//                real-time (~50–150 ms). Your own free Firebase project.
//   • relay    – Public MQTT servers (relay.js). Off by default; optional
//                no-account fallback.
// A screen connects through Firebase right away (if no local master) and
// upgrades to a direct link in the background when one can be made.

import { ROOM, BASE, PARAMS, peerOptions, hasOwnTurn, LOCAL_ONLY, NET_ONLY } from './config.js';
import { P, RELAY_OFF, relayBrokers, loadMqtt, connectBroker, pack, unpack, PacedSender } from './relay.js';
import { FB_OFF, FbMaster, FbViewer } from './fb.js';

const MASTER_PEER_ID = `s3d-${ROOM}-master`;
const CHANNEL_NAME = `s3d:${ROOM}`;
const ALIVE_MS = 2000;
const TIMEOUT_MS = 8000;
const RELAY_TIMEOUT_MS = 12000;
export const DIRECT_OFF = PARAMS.get('direct') === 'off';
const RELAY_POSE_MS = 33; // ≈30 pose updates per second through the relay

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
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return u; } };

// ===========================================================================
//  Master side
// ===========================================================================
export class MasterHub {
  constructor() {
    this.viewers = new Map(); // viewer id -> { id, kind, screen, send, last, have }
    this.onJoin = () => {};
    this.onLeave = () => {};
    this.onStatus = () => {};
    this.onRequest = () => {};
    this.netStatus = LOCAL_ONLY || DIRECT_OFF ? 'off' : 'connecting';
    this.netError = '';
    this.relays = []; // { url, client, up }
    this.sessionId = rid();
    this._seq = 0;
    this.fb = null;
  }

  start() {
    if (!NET_ONLY) this._startLocal();
    if (!LOCAL_ONLY && !DIRECT_OFF) this._startNet();
    if (!LOCAL_ONLY && !RELAY_OFF) this._startRelay();
    if (!LOCAL_ONLY && !FB_OFF) { this.fb = new FbMaster(this); this.fb.start(); }
    setInterval(() => this._tick(), ALIVE_MS);
    addEventListener('pagehide', () => {
      this.broadcast({ t: 'bye' });
      for (const r of this.relays) {
        try { r.client.publish(P + '/p', JSON.stringify({ on: 0 }), { qos: 0, retain: true }); } catch {}
      }
      if (this.peer) this.peer.destroy();
    });
  }

  get relayUp() { return this.relays.filter((r) => r.up).length; }

  // ---- local ------------------------------------------------------------
  _startLocal() {
    if (!('BroadcastChannel' in window)) return;
    const ch = (this.channel = new BroadcastChannel(CHANNEL_NAME));
    ch.onmessage = (ev) => {
      const { from, to, m } = ev.data || {};
      if (to !== 'master' || !m) return;
      if (m.t === 'probe') {
        ch.postMessage({ from: 'master', to: from, m: { t: 'probe-ok' } });
        return;
      }
      this._incoming(from, 'local', m, (msg) => ch.postMessage({ from: 'master', to: from, m: msg }));
    };
    ch.postMessage({ from: 'master', to: '*', m: { t: 'master-up' } });
  }

  // ---- direct (WebRTC) --------------------------------------------------
  async _startNet() {
    let Peer;
    try { Peer = await loadPeerJS(); }
    catch (e) { this._setNet('error', 'PeerJS library failed to load'); return; }

    const opts = await peerOptions();
    this.hasTurn = await hasOwnTurn();
    const open = () => {
      this._setNet('connecting');
      const peer = (this.peer = new Peer(MASTER_PEER_ID, opts));
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
    let id = null;
    const send = (msg) => { if (conn.open) conn.send(msg); };
    conn.on('data', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'join') id = m.id;
      if (id) this._incoming(id, 'net', m, send);
    });
    const gone = () => { if (id) this._drop(id, 'net'); };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  // ---- relay (MQTT) -----------------------------------------------------
  async _startRelay() {
    let mqtt;
    try { mqtt = await loadMqtt(); }
    catch (e) { console.warn('relay library failed to load', e); return; }
    for (const url of relayBrokers()) {
      const r = { url, up: false, client: null, senders: new Map() };
      this.relays.push(r);
      const client = (r.client = connectBroker(mqtt, url, {
        will: { topic: P + '/p', payload: JSON.stringify({ on: 0 }), qos: 0, retain: true },
      }));
      client.on('connect', () => {
        r.up = true;
        client.subscribe(P + '/u', { qos: 1 });
        client.publish(P + '/p', JSON.stringify({ on: 1, s: this.sessionId }), { qos: 0, retain: true });
        this.onStatus();
      });
      client.on('close', () => { if (r.up) { r.up = false; this.onStatus(); } });
      client.on('error', () => {});
      client.on('message', (topic, payload) => {
        let m;
        try { m = unpack(payload); } catch { return; }
        if (!m || !m.from) return;
        const id = m.from;
        if (m.t === 'leave') { this._drop(id, 'relay'); return; }
        let sender = r.senders.get(id);
        if (!sender) { sender = new PacedSender(client, `${P}/v/${id}`); r.senders.set(id, sender); }
        const send = (msg) => {
          if (msg.t === 'chunk') sender.push(pack(msg));
          else client.publish(`${P}/v/${id}`, pack(msg), { qos: msg.t === 'pose' ? 0 : 1 });
        };
        this._incoming(id, 'relay', m, send, r);
      });
    }
  }

  // ---- bookkeeping ------------------------------------------------------
  _incoming(id, kind, m, send, relay = null) {
    if (m.t === 'join') {
      this._register(id, kind, m, send, relay);
      return;
    }
    const v = this.viewers.get(id);
    if (!v) {
      // A screen we don't know (e.g. after the master reloaded): ask it to join.
      if (m.t === 'ping') send({ t: 'rejoin' });
      return;
    }
    if (v.kind !== kind) return;
    v.last = performance.now();
    if (m.t === 'leave') this._drop(id, kind);
    else if (m.t === 'resend') this.onRequest(v, m);
  }

  _register(id, kind, m, send, relay) {
    const existing = this.viewers.get(id);
    const v = {
      id, key: id, kind, relay, screen: +m.screen || 0, send,
      last: performance.now(), have: new Set(m.have || []),
    };
    this.viewers.set(id, v);
    if (existing) {
      if (existing.kind === 'relay' && existing.relay && existing !== v) {
        const s = existing.relay.senders.get(id);
        if (s && kind !== 'relay') { s.close(); existing.relay.senders.delete(id); }
      }
      this.onLeave(existing, true);
    }
    this.onJoin(v);
  }

  _drop(id, kind) {
    const v = this.viewers.get(id);
    if (!v || (kind && v.kind !== kind)) return;
    this.viewers.delete(id);
    if (v.relay) {
      const s = v.relay.senders.get(id);
      if (s) { s.close(); v.relay.senders.delete(id); }
    }
    this.onLeave(v, false);
  }

  _tick() {
    const now = performance.now();
    for (const v of [...this.viewers.values()]) {
      if (v.kind === 'fb') continue; // Firebase removes screens itself when they disconnect
      if (now - v.last > (v.kind === 'relay' ? RELAY_TIMEOUT_MS : TIMEOUT_MS)) this._drop(v.id);
    }
    this.broadcast({ t: 'alive' });
    // refresh presence now and then (public servers may drop retained messages)
    if (!this._presenceN || ++this._presenceN % 15 === 0) {
      this._presenceN = this._presenceN || 1;
      for (const r of this.relays) if (r.up) r.client.publish(P + '/p', JSON.stringify({ on: 1, s: this.sessionId }), { qos: 0, retain: true });
    }
  }

  // Firebase: one shared document for all Firebase screens; poses ≤30×/s.
  _fbBroadcast(msg) {
    if (msg.t === 'state') { this.fb.writeState(msg.state); return; }
    if (msg.t !== 'pose') return;
    this._fbPending = msg;
    if (this._fbTimer) return;
    const wait = Math.max(0, RELAY_POSE_MS - (performance.now() - (this._fbLast || 0)));
    this._fbTimer = setTimeout(() => {
      this._fbTimer = null;
      this._fbLast = performance.now();
      this.fb.writePose(this._fbPending);
    }, wait);
  }

  _setNet(status, err = '') {
    this.netStatus = status;
    this.netError = err;
    this.onStatus();
  }

  broadcast(msg) {
    const relayUsed = new Set();
    let fbUsed = false;
    for (const v of this.viewers.values()) {
      if (v.kind === 'relay') relayUsed.add(v.relay);
      else if (v.kind === 'fb') fbUsed = true;
      else v.send(msg);
    }
    if (fbUsed && this.fb) this._fbBroadcast(msg);
    if (msg.t === 'bye' && this.channel) this.channel.postMessage({ from: 'master', to: '*', m: msg });
    if (!relayUsed.size && msg.t !== 'bye') return;

    // One publish per relay server reaches every relay screen on it.
    if (msg.t === 'pose') {
      this._pendingPose = msg;
      this._pendingRelays = relayUsed;
      if (this._poseTimer) return;
      const wait = Math.max(0, RELAY_POSE_MS - (performance.now() - (this._lastRelayPose || 0)));
      this._poseTimer = setTimeout(() => {
        this._poseTimer = null;
        this._lastRelayPose = performance.now();
        const p = pack({ ...this._pendingPose, q: ++this._seq, s: this.sessionId });
        // Sent through every relay server: screens use whichever copy arrives first.
        for (const r of this.relays) if (r.up) r.client.publish(P + '/m', p, { qos: 0 });
      }, wait);
      return;
    }
    const p = pack({ ...msg, q: ++this._seq, s: this.sessionId });
    for (const r of this.relays) if (r.up) r.client.publish(P + '/m', p, { qos: msg.t === 'alive' ? 0 : 1 });
  }
}

// ===========================================================================
//  Screen (viewer) side
// ===========================================================================
export class ViewerLink {
  constructor(screen) {
    this.screen = screen;
    this.id = rid();
    this.mode = null; // 'local' | 'net' | 'relay' | null
    this.connected = false;
    this.onMessage = () => {};
    this.onStatus = () => {};
    this.status = 'Looking for the master…';
    this.lastHeard = 0;
    this.have = () => [];
    this.relayHost = '';
    this.problem = null;
    this.extraRelays = new Set();
    this.fbv = null;
    this.roomName = ROOM;
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

  _set(mode, status) {
    this.mode = mode;
    this.connected = !!mode;
    if (mode) this.problem = null;
    this.status = status;
    this.onStatus();
  }
  _note(status, problem) {
    if (this.connected) return;
    if (problem !== undefined) this.problem = problem;
    this.status = status;
    this.onStatus();
  }

  _joinMsg() { return { t: 'join', id: this.id, screen: this.screen, have: this.have(), info: navigator.userAgent }; }

  // Same computer first (instant), otherwise relay + direct in parallel.
  async _attempt() {
    if (this.connected || this._attempting) return;
    this._attempting = true;
    try {
      if (this.channel && await this._probeLocal()) { this._joinLocal(); return; }
      if (LOCAL_ONLY) { this._note('Waiting for the master on this computer…'); this._retry(2000); return; }
      if (!FB_OFF) this._fbJoin();
      if (!RELAY_OFF) this._relayJoin();
      if (!DIRECT_OFF) this._tryDirect();
      this._retry(this.relay ? 3000 : 6000);
    } finally {
      this._attempting = false;
    }
  }

  _retry(ms = 3000) {
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._attempt(), ms);
  }

  _activate(mode, status) {
    // Switching to the relay keeps a pending direct attempt alive (to upgrade later).
    if (mode === 'local' && this.net) this._closeNet();
    this.lastHeard = performance.now();
    this._set(mode, status);
    // On a faster link, stop using Firebase so its free quota isn't spent.
    if ((mode === 'local' || mode === 'net') && this.fbv) this.fbv.leave();
  }

  // ---- Firebase ---------------------------------------------------------
  _fbJoin() {
    if (!this.fbv) this.fbv = new FbViewer(this);
    this.fbv.join();
  }
  _fbLost(why) { if (this.mode === 'fb') this._lost(why); }

  _lost(why) {
    const was = this.mode;
    if (was === 'net') this._closeNet();
    this._set(null, why + ' — reconnecting…');
    this._retry(was === 'relay' ? 500 : 1500);
  }

  // ---- local ------------------------------------------------------------
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
    if (m.t === 'master-up' && this.mode !== 'local') {
      // A master just opened on this computer: always prefer it.
      this._probeLocal().then((ok) => ok && this._joinLocal());
      return;
    }
    if (this.mode !== 'local') return;
    if (m.t === 'bye') { this._lost('Master closed'); return; }
    this._deliver(m);
  }

  _joinLocal() {
    this._activate('local', 'Connected (same computer)');
    this.channel.postMessage({ from: this.id, to: 'master', m: this._joinMsg() });
  }

  // ---- relay ------------------------------------------------------------
  async _relayJoin() {
    if (this.relay && this.relay.client.connected) {
      this._relayPublish(this._joinMsg());
      return;
    }
    if (this._relayConnecting) return;
    this._relayConnecting = true;
    try {
      const mqtt = await loadMqtt();
      // Try every relay server at once; the first one where the master is found wins.
      this._note('Connecting through the relay servers…');
      const results = await Promise.all(relayBrokers().map((url) => this._tryBroker(mqtt, url)));
      if (results.some(Boolean)) return;
      this._note(this.problem === 'no-master-relay'
        ? `No master answered in room “${ROOM}”. Is the master page open?`
        : 'Could not reach any relay server from this network. Retrying…',
      this.problem === 'no-master-relay' ? 'no-master' : 'no-relay');
    } catch (e) {
      console.warn('relay failed', e);
    } finally {
      this._relayConnecting = false;
    }
  }

  // Connect to one broker and ask the master for the scene. Resolves with the
  // relay handle if the master answered (or we are already connected another
  // way and just keep this one on standby), or null.
  _tryBroker(mqtt, url) {
    return new Promise((resolve) => {
      const client = connectBroker(mqtt, url, { reconnectPeriod: 3000 });
      const r = { url, client };
      const mineTopic = `${P}/v/${this.id}`;
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok && this.relay && this.relay !== r && this.relay.client.connected) {
          // Another server won. Keep this one too: broadcasts (camera moves)
          // come through every server and we use whichever copy is first.
          this.extraRelays.add(r);
          resolve(null);
          return;
        }
        if (ok) {
          this.relay = r; this.extraRelays.delete(r); this.relayHost = hostOf(url); resolve(r);
          if (!this.connected) this._relayPublish(this._joinMsg(), client); // make sure the master answers here
        }
        else { this.extraRelays.delete(r); client.end(true); resolve(null); }
      };
      let timer = setTimeout(() => finish(false), 11000);
      client.on('error', () => {});
      client.on('connect', () => {
        client.subscribe([P + '/m', P + '/p', mineTopic], { qos: 1 }, () => {
          const otherwise = this.connected && this.mode !== 'relay';
          if (!settled && otherwise) { finish(true); return; } // standby
          if (settled && this.relay !== r) return; // extra receiver: just listen
          if (settled && this.mode !== 'relay' && this.connected) return;
          this._relayPublish(this._joinMsg(), client);
          if (!settled) {
            // The master's presence (a retained message) tells us it uses this
            // server too. No presence within a few seconds → try the next one.
            if (!this.relay) this._note(`Relay server ${hostOf(url)} reached, looking for the master…`);
            clearTimeout(timer);
            timer = setTimeout(() => { this.problem = 'no-master-relay'; finish(false); }, 5000);
          }
        });
      });
      client.on('message', (topic, payload) => {
        if (topic === P + '/p') {
          let pr; try { pr = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
          if (pr && pr.on === 1 && !settled && this.relay && this.relay !== r) { finish(true); return; } // becomes an extra receiver
          if (pr && pr.on === 1 && !settled) {
            finish(true); // master is on this server; the join (re-sent until answered) will get a reply
            if (this.relay === r) this._note(`Master found via ${hostOf(url)}, waiting for its answer…`);
          }
          if (pr && pr.on === 0 && this.mode === 'relay' && this.relay === r) this._lost('Master closed');
          return;
        }
        const mine = topic === mineTopic;
        if (topic !== P + '/m' && !mine) return;
        let m; try { m = unpack(payload); } catch { return; }
        if (mine && !settled) finish(true);
        if (mine && this.relay !== r && this.extraRelays.has(r)) {
          // The master answers through this server: make it the main one.
          if (this.relay) this.extraRelays.add(this.relay);
          this.extraRelays.delete(r);
          this.relay = r;
          this.relayHost = hostOf(url);
        }
        const primary = this.relay === r;
        if (!primary && !(this.extraRelays.has(r) && !mine)) return;
        if (mine && !this.connected) this._activate('relay', `Connected through relay (${this.relayHost})`);
        if (this.mode !== 'relay') return;
        if (m.q != null) {
          // de-duplicate broadcasts that arrive through several servers
          if (m.s !== this._bcSession) { this._bcSession = m.s; this._bcSeq = 0; }
          if (m.q <= this._bcSeq) return;
          this._bcSeq = m.q;
          this.bcVia = hostOf(url);
        }
        if (m.t === 'bye') { this._lost('Master closed'); return; }
        this._deliver(m);
      });
    });
  }

  _relayPublish(msg, client = this.relay && this.relay.client) {
    if (!client) return;
    client.publish(P + '/u', pack({ ...msg, from: this.id }), { qos: msg.t === 'ping' ? 0 : 1 });
  }

  // ---- direct (WebRTC) --------------------------------------------------
  async _tryDirect() {
    if (this._directBusy || this.mode === 'net' || this.mode === 'local') return;
    if (this._directBlockedUntil && performance.now() < this._directBlockedUntil) return;
    this._directBusy = true;
    let Peer;
    try { Peer = await loadPeerJS(); }
    catch { this._directBusy = false; return; }
    const opts = await peerOptions();
    if (!this.peer || this.peer.destroyed) {
      await new Promise((resolve) => {
        const peer = (this.peer = new Peer(undefined, opts));
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        peer.on('open', finish);
        peer.on('error', (err) => {
          const type = err && err.type;
          if (type === 'peer-unavailable') {
            if (RELAY_OFF && FB_OFF) this._note(`No master found in room “${ROOM}”. Is the master page open (with the same room)?`, 'no-master');
            this._directBlockedUntil = performance.now() + 5000;
            this._directBusy = false;
          } else if (['network', 'server-error', 'socket-error', 'socket-closed', 'unavailable-id'].includes(type)) {
            peer.destroy();
            this._directBlockedUntil = performance.now() + 15000;
            this._directBusy = false;
          } else {
            console.warn('[peer]', type, err);
          }
          finish();
        });
        peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 2000); });
        setTimeout(finish, 10000);
      });
    }
    if (!this.peer || this.peer.destroyed || !this.peer.open) { this._directBusy = false; return; }

    const conn = this.peer.connect(MASTER_PEER_ID, { reliable: true });
    this.net = conn;
    conn.on('open', () => {
      if (this.net !== conn) return;
      this._directBusy = false;
      if (this.mode === 'local') { conn.close(); return; }
      const upgraded = this.mode === 'relay' || this.mode === 'fb';
      this._activate('net', 'Connected directly' + (upgraded ? ' (upgraded)' : ''));
      conn.send(this._joinMsg());
    });
    conn.on('data', (m) => {
      if (this.net !== conn || !m || this.mode !== 'net') return;
      if (m.t === 'bye') { this._lost('Master closed'); return; }
      this._deliver(m);
    });
    const fail = () => {
      if (this.net !== conn) return;
      this._directBusy = false;
      if (this.mode === 'net') this._lost('Direct link closed');
      else this._closeNet();
    };
    conn.on('close', fail);
    conn.on('error', fail);
    setTimeout(() => {
      if (this.net === conn && conn.open !== true) {
        // Blocked by the network. Fine if the relay is working; try again later.
        this._directBusy = false;
        this._directBlockedUntil = performance.now() + 60000;
        this._closeNet();
        if (RELAY_OFF && FB_OFF) this._note('Found the master, but this network blocks the direct link.', 'blocked');
      }
    }, 12000);
  }

  _closeNet() {
    const c = this.net;
    this.net = null;
    this._directBusy = false;
    if (c) try { c.close(); } catch {}
  }

  // ---- common -------------------------------------------------------------
  _deliver(m) {
    this.lastHeard = performance.now();
    if (m.t === 'alive' || m.t === 'rejoin') {
      if (m.t === 'rejoin') this.send(this._joinMsg());
      return;
    }
    this.onMessage(m);
  }

  _tick() {
    if (!this.connected) return;
    const limit = this.mode === 'relay' ? RELAY_TIMEOUT_MS : TIMEOUT_MS;
    // (Firebase tells us itself when the master goes away.)
    if (this.mode !== 'fb' && performance.now() - this.lastHeard > limit) { this._lost('Master not responding'); return; }
    this.send({ t: 'ping' });
    // While on Firebase or the relay, keep trying to upgrade to a direct link.
    if ((this.mode === 'relay' || this.mode === 'fb') && !DIRECT_OFF) this._tryDirect();
  }

  send(msg) {
    if (this.mode === 'local') this.channel.postMessage({ from: this.id, to: 'master', m: msg });
    else if (this.mode === 'net' && this.net && this.net.open) this.net.send(msg);
    else if (this.mode === 'relay') this._relayPublish(msg);
  }

  _leave() {
    if (this.mode === 'local' || this.mode === 'relay') this.send({ t: 'leave' });
    if (this.fbv) this.fbv.leave();
    if (this.peer) this.peer.destroy();
  }
}
