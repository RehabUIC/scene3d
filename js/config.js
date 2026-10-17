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

export const DEFAULT_ROOM = slug(CONFIG.defaultRoom || (location.hostname + BASE));
export const ROOM = slug(params.get('room') || DEFAULT_ROOM);

export function peerOptions() {
  const o = { ...CONFIG.peer };
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
  for (const k of ['room', 'peerhost', 'peerport', 'peerpath', 'peersecure', 'local', 'net']) {
    if (params.has(k)) q.set(k, params.get(k));
  }
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  const s = q.toString();
  return s ? '?' + s : '';
}

// Pretty links (site/3) rely on GitHub Pages serving 404.html for unknown
// paths. Anywhere else (e.g. a local test server) use view.html?screen=3.
export const PRETTY_LINKS = location.hostname.endsWith('github.io') || params.get('pretty') === '1';

export function screenUrl(n) {
  if (PRETTY_LINKS) return location.origin + BASE + n + carriedQuery();
  return location.origin + BASE + 'view.html' + carriedQuery({ screen: n });
}

export function resolveUrl(u) {
  return new URL(u, location.origin + BASE).href;
}
