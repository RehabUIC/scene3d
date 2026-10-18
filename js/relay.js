// Relay transport: master and screens exchange messages through free public
// MQTT servers over secure WebSockets (normal HTTPS-style traffic). It needs
// no account and works on networks that block direct browser-to-browser
// links (mobile data, campus / guest Wi-Fi, strict firewalls).
//
// Topics (P = s3d/2/<hash of room>):
//   P/m       master → every relay screen   (state, poses, keep-alive)
//   P/v/<id>  master → one screen           (initial state, model files)
//   P/u       screens → master              (join, ping, resend requests)
//   P/p       master presence (retained; "last will" says offline)

import { CONFIG, ROOM, BASE, PARAMS } from './config.js';

export function relayBrokers() {
  const fromUrl = PARAMS.getAll('relay').filter(Boolean);
  return fromUrl.length ? fromUrl : CONFIG.relayBrokers || [];
}
export const RELAY_OFF = PARAMS.get('relay') === 'off' || !relayBrokers().length;

// Short stable hash so the room name isn't sent in the clear as a topic.
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
export const P = `s3d/2/${cyrb53('scene3d:' + ROOM)}${cyrb53(ROOM, 7)}`;

let libPromise = null;
export function loadMqtt() {
  if (!libPromise) {
    libPromise = import(BASE + 'lib/mqtt/mqtt.esm.js').then((m) => {
      const lib = m.default && m.default.connect ? m.default : m.default.default || m;
      return lib;
    });
  }
  return libPromise;
}

// ---- message encoding: [u32 header length][header JSON][optional binary] ---
const enc = new TextEncoder(), dec = new TextDecoder();
export function pack(msg) {
  let data = null;
  let head = msg;
  if (msg.data instanceof ArrayBuffer || ArrayBuffer.isView(msg.data)) {
    data = msg.data instanceof ArrayBuffer ? new Uint8Array(msg.data) : new Uint8Array(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength);
    head = { ...msg, data: undefined };
  }
  const h = enc.encode(JSON.stringify(head));
  const out = new Uint8Array(4 + h.length + (data ? data.length : 0));
  new DataView(out.buffer).setUint32(0, h.length);
  out.set(h, 4);
  if (data) out.set(data, 4 + h.length);
  return out;
}
export function unpack(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint32(0);
  const msg = JSON.parse(dec.decode(u8.subarray(4, 4 + n)));
  if (u8.length > 4 + n) {
    // copy: the MQTT library hands us views into a shared buffer pool
    const out = new Uint8Array(u8.length - 4 - n);
    out.set(u8.subarray(4 + n));
    msg.data = out.buffer;
  }
  return msg;
}

export function connectBroker(mqtt, url, opts = {}) {
  return mqtt.connect(url, {
    clientId: 's3d_' + Math.random().toString(36).slice(2, 12),
    clean: true,
    keepalive: 20,
    connectTimeout: 10000,
    reconnectPeriod: 3000,
    protocolVersion: 4,
    ...opts,
  });
}

// Sends model chunks with a small window of unacknowledged messages so a big
// file doesn't flood the public server.
export class PacedSender {
  constructor(client, topic, windowSize = 4) {
    this.client = client;
    this.topic = topic;
    this.windowSize = windowSize;
    this.queue = [];
    this.inflight = 0;
    this.closed = false;
  }
  push(payload) {
    this.queue.push(payload);
    this._pump();
  }
  _pump() {
    while (!this.closed && this.inflight < this.windowSize && this.queue.length) {
      const p = this.queue.shift();
      this.inflight++;
      this.client.publish(this.topic, p, { qos: 1 }, () => { this.inflight--; this._pump(); });
    }
  }
  close() { this.closed = true; this.queue.length = 0; }
}
