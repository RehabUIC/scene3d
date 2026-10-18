# Scene3D

A free, static 3D "master + screens" website for GitHub Pages.

- **Master** (`…/scene3d/`) holds the 3D world. Import models, place as many cameras as you like, and move everything around.
- **Screens** (`…/scene3d/1`, `…/scene3d/2`, `…/scene3d/3`, … any number) each show one camera's view in 16:9, live, on any browser.

The master does not stream video. It sends camera and object positions (a few hundred bytes per frame), and every screen renders the scene itself. Screens stay full resolution and lag-free however many you open.

## Put it online (5 minutes)

1. On GitHub, create a new **public** repository named `scene3d`. Keep it separate from your `RehabUIC.github.io` repo.
2. Upload everything in this folder to it, including the hidden `.nojekyll` file. Either drag the files into "Add file → Upload files", or use git:
   ```bash
   git init && git add . && git commit -m "Scene3D"
   git branch -M main
   git remote add origin https://github.com/RehabUIC/scene3d.git
   git push -u origin main
   ```
3. Go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then **main** and **/ (root)**, and click **Save**.
4. After a minute or two it is live:
   - Master: `https://rehabuic.github.io/scene3d/`
   - Screens: `https://rehabuic.github.io/scene3d/1`, `/2`, `/3`, …

## Using it

| Do this | How |
|---|---|
| Import a model | Drag a file (or a whole folder with textures) onto the master, or click **Import file…**. Supports `.glb .gltf .fbx .obj(+.mtl) .stl .ply` (meshes and point clouds). |
| Add a camera | Move the view to where you want it, then press **C** or click **+ Camera**. Camera *n* feeds screen *n*. |
| Aim a camera precisely | Press its number key (or the 👁 button, or double-click its preview) to look through it. You see exactly what its screen sees; drag or scroll to aim, then press **Esc**. |
| Move, rotate, scale | Click an object, then **W / E / R**. |
| Open a screen | Click ↗ next to a camera, or **Copy all links** and open them on other machines. |
| Fullscreen on a screen | Double-click, or press **F**. |

Screen numbers don't need to exist in advance. If you open `/7` before camera 7 exists, the screen waits and the master offers **Create camera 7**.

### How screens connect

A screen picks the best available link by itself, so there is nothing to set up:

1. **Same computer** (other tabs or windows of the master's browser): instant, works with no internet. This is ideal for one PC driving several monitors.
2. **Relay** (any device, any network: mobile data, campus Wi-Fi, another city). The master and the screens exchange data through free public MQTT servers over secure WebSockets. The first server uses port 443, the same as normal HTTPS, so it gets through almost any firewall. There's no account and nothing to configure. A screen connects this way within a few seconds.
3. **Direct** (WebRTC): in the background, every relay screen also tries a direct browser-to-browser link. If the network allows it, the screen switches to it automatically for the lowest latency.

The master panel shows how many screens use each link, and each screen shows its link at the bottom-left.

**Rooms and privacy:** master and screens find each other by the **room** name shown in the panel. By default it comes from your site address. The relay servers are public, so anyone who knew your room name could watch the camera data and models. For anything private, add a secret room to every link, for example `…/scene3d/?room=lab-k39x7` and `…/scene3d/1?room=lab-k39x7`. **Copy all links** keeps the room in the links for you.

Imported models are copied to each screen automatically, with a progress bar. They are also kept in the master browser's storage, so a page reload doesn't lose them. Over the relay, big models take longer, so put large files in `models/` (see below) and screens download them directly.

### Models that live in the repo

For permanent or shared scenes, put model files in `models/` and list them in `models/models.json`:

```json
["robot.glb", "brain.ply", { "name": "Lab room", "url": "models/lab/scene.gltf" }]
```

They show up as one-click buttons on the master. You can also type any web address of a model, as long as the server allows cross-origin access. Screens download these themselves.

### Useful URL options

| Option | Effect |
|---|---|
| `?room=name` | Use a separate room (put it on master and screens). |
| `?local=1` | Same-computer only, no internet at all. |
| `?relay=off` / `?direct=off` | Turn off the relay or the direct link. |
| `?relay=wss://host/mqtt` | Use your own MQTT relay server(s) (repeat for several). |
| `?fit=window` (screens) | Fill a non-16:9 display instead of letterboxing. |
| `?model=models/x.glb` (master) | Load a model on start. |
| `?scene=models/myscene.json` (master) | Start from a saved scene file. |

## Troubleshooting

Read the message on the screen under "Waiting for the master":

- **"No master is open in room …"**: open the master page first. Check that the room name at the bottom-left of the screen matches the one in the master's panel, and use **Copy all links** to get matching links.
- **"Cannot reach any relay server"**: this device has no internet access, or the network blocks even secure WebSockets (very rare). Try another network.
- **Testing from a phone against a server on your laptop:** `localhost` on the phone means the phone itself. Open `http://<your-laptop-IP>:8000/view.html?screen=1` instead. Find the IP with `ipconfig`.

**Optional, for the lowest latency on strict networks:** add a TURN server so the *direct* link works there too. Sign up at https://www.metered.ca/tools/openrelay/ (free) and paste your credentials URL into `turnCredentialsUrl` in `js/config.js`. Everything works without this; it only makes the direct link possible in more places.

## Limits worth knowing

- The master page must stay open. If it closes, screens freeze and reconnect automatically when it comes back.
- The public relay and signalling servers are free community services with no uptime guarantee. Several relay servers are listed in `js/config.js`, and screens use whichever works. For a permanent installation, you can run your own (any MQTT broker with WebSockets, e.g. Mosquitto).
- The free public PeerJS server is fine for lab and demo use but has no uptime guarantee. To run your own, deploy the open-source `peer` server (free tier on Render.com works) and set `peer: { host, port: 443, path: '/', secure: true }` in `js/config.js`.
- Over the relay, a screen in another city sees changes a fraction of a second later than a screen on the same network.
- `/1`, `/2` work because GitHub Pages serves `404.html` for unknown paths. The pages work normally, but technically they return a 404 status. On other hosts, use `view.html?screen=1`.

## Files

```
index.html          master page
404.html, view.html screen page (identical copies)
js/master.js        editor, cameras, models, sync
js/viewer.js        screen renderer
js/link.js          connections (same computer, direct WebRTC, relay)
js/relay.js         relay over public MQTT servers
js/common.js        shared scene, loaders, pose format
js/config.js        settings
lib/                three.js r186, PeerJS 1.5.5, MQTT.js 5.16 (bundled, no CDN needed)
models/             your own models (optional)
```

## Test locally

`python3 -m http.server` in this folder, then open `http://localhost:8000/` (master) and `http://localhost:8000/view.html?screen=1` (screen). A plain local server has no 404 fallback, so use `view.html?screen=N` there.
