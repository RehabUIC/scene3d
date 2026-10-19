// ---------------------------------------------------------------------------
//  Scene3D settings. Most people never need to touch this file.
// ---------------------------------------------------------------------------

export const CONFIG = {
  // Signalling server that lets browsers find each other (they then talk
  // directly). {} = the free public PeerJS cloud server.
  // To run your own (free on Render/Glitch/fly.io, see README):
  //   peer: { host: 'my-peer-server.onrender.com', port: 443, path: '/', secure: true },
  peer: {},

  // Room name shared by the master and its screens. null = derived from the
  // site address (e.g. "rehabuic-github-io-scene3d"), which is unique to you.
  // Can also be overridden per page with ?room=something
  defaultRoom: null,

  // ---- Optional: TURN server for the *direct* link ------------------------
  // Not needed: screens fall back to the relay below on networks that block
  // direct links. A TURN server just lets the faster direct link work there
  // too. Free option: https://www.metered.ca/tools/openrelay/ — paste your
  // credentials URL here, e.g.
  //   turnCredentialsUrl: 'https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=YOUR_KEY',
  turnCredentialsUrl: '',
  // …or list ICE servers yourself (used in addition to the defaults):
  //   iceServers: [{ urls: 'turn:my.turn.server:3478', username: 'u', credential: 'p' }],
  iceServers: [],

  // ---- Firebase (real-time on ANY network) --------------------------------
  // Screens that aren't on the master's computer connect through this
  // Firebase Realtime Database (free Spark plan). The database address is
  // derived from projectId (a database created in the US, us-central1).
  // If yours is elsewhere, add  databaseURL: 'https://…firebasedatabase.app'
  firebase: {
    apiKey: 'AIzaSyC_pAQGCNAauFAjm58ce788xm41MUTv51E',
    authDomain: 'scene3d-95bf0.firebaseapp.com',
    projectId: 'scene3d-95bf0',
    appId: '1:22859739639:web:456dbed02130b81081fef2',
    // databaseURL: 'https://scene3d-95bf0-default-rtdb.firebaseio.com',
  },

  // ---- Public relay (optional, no account) ---------------------------------
  // Free public MQTT servers as an extra fallback. Off by default because
  // public servers can be slow or throttled. To turn on, list servers, e.g.
  //   'wss://mqtt.eclipseprojects.io:443/mqtt', 'wss://broker.emqx.io:8084/mqtt'
  relayBrokers: [],

  // Output aspect ratio of every screen.
  aspect: 16 / 9,

  // Size of each piece when sending a model file to a screen.
  chunkSize: 64 * 1024,

  // Draco-compressed .glb files need a decoder; it is fetched from here.
  dracoDecoderPath: 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/',
};

// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
export const PARAMS = params;
export const BASE = (window.S3D && window.S3D.base) || '/';

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'scene';
}

// On GitHub Pages the room comes from the site address (unique to you).
// Elsewhere (a test server on your laptop) the hostname differs between the
// laptop ("localhost") and a phone ("192.168.x.x"), so leave it out there.
const ON_GITHUB = location.hostname.endsWith('github.io');
export const DEFAULT_ROOM = slug(CONFIG.defaultRoom ||
  (ON_GITHUB ? location.hostname + BASE : 'local-' + (location.port || '80') + BASE));
export const ROOM = slug(params.get('room') || DEFAULT_ROOM);

const DEFAULT_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
];
let icePromise = null;
function getIceServers() {
  if (!icePromise) {
    icePromise = (async () => {
      let extra = [...(CONFIG.iceServers || [])];
      const url = params.get('turn') || CONFIG.turnCredentialsUrl;
      if (url) {
        try {
          const r = await fetch(url);
          const list = await r.json();
          if (Array.isArray(list)) extra = extra.concat(list);
        } catch (e) { console.warn('TURN credentials could not be fetched', e); }
      }
      return { servers: [...extra, ...DEFAULT_ICE], hasOwnTurn: extra.some((s) => String(s.urls).includes('turn')) };
    })();
  }
  return icePromise;
}
export async function hasOwnTurn() { return (await getIceServers()).hasOwnTurn; }

export async function peerOptions() {
  const o = { ...CONFIG.peer };
  o.config = { iceServers: (await getIceServers()).servers };
  if (params.get('peerhost')) o.host = params.get('peerhost');
  if (params.get('peerport')) o.port = +params.get('peerport');
  if (params.get('peerpath')) o.path = params.get('peerpath');
  if (params.has('peersecure')) o.secure = params.get('peersecure') !== '0';
  o.debug = 0;
  return o;
}

// Which transports to use. ?local=1 → same-computer only (works offline).
export const LOCAL_ONLY = params.get('local') === '1';
export const NET_ONLY = params.get('net') === '1';

// Keep the room / server overrides when building links to other pages.
function carriedQuery(extra = {}) {
  const q = new URLSearchParams();
  for (const k of ['room', 'peerhost', 'peerport', 'peerpath', 'peersecure', 'local', 'net', 'turn']) {
    if (params.has(k)) q.set(k, params.get(k));
  }
  for (const r of params.getAll('relay')) q.append('relay', r);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  const s = q.toString();
  return s ? '?' + s : '';
}

// Pretty links (site/3) rely on GitHub Pages serving 404.html for unknown
// paths. Anywhere else (e.g. a local test server) use view.html?screen=3.
export const PRETTY_LINKS = ON_GITHUB || params.get('pretty') === '1';

export function screenUrl(n) {
  if (PRETTY_LINKS) return location.origin + BASE + n + carriedQuery();
  return location.origin + BASE + 'view.html' + carriedQuery({ screen: n });
}

export function resolveUrl(u) {
  return new URL(u, location.origin + BASE).href;
}
