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

- **Same computer, same browser** (other tabs or windows): screens connect instantly through the browser itself and need no internet. This is ideal for one PC driving several monitors. Open each screen in its own window, drag it to a monitor, and press F.
- **Other computers**: screens connect over WebRTC. A free public PeerJS server introduces the browsers, then data flows directly between them. The panel shows the **room** name. It is derived from your site address, so it is unique to you. Use `?room=something` on the master *and* the screens to run several independent scenes.

Imported models are copied to each screen automatically, with a progress bar. They are also kept in the master browser's storage, so a page reload doesn't lose them.

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
| `?fit=window` (screens) | Fill a non-16:9 display instead of letterboxing. |
| `?model=models/x.glb` (master) | Load a model on start. |
| `?scene=models/myscene.json` (master) | Start from a saved scene file. |

## Phones / mobile data

A screen page always tells you what is wrong. Read the message under "Waiting for the master":

- **"No master is open in room …"**: the master isn't open, or it uses a different room. Compare the room name on the screen (bottom-left) with the one in the master's panel.
- **"…this network blocks the direct link…"**: the two devices found each other, but the network refuses a direct connection. This is typical on mobile data, hotspots and guest or campus Wi-Fi. Fix it with a free TURN relay:
  1. Sign up at https://www.metered.ca/tools/openrelay/ (free, 20 GB/month).
  2. In their dashboard, copy your TURN credentials URL. It looks like `https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=…`.
  3. Paste it into `turnCredentialsUrl` in `js/config.js` and commit. The master panel's "Mobile relay" line turns green.

**Testing from a phone against a server on your laptop:** `localhost` on the phone means the phone itself. Open `http://<your-laptop-IP>:8000/view.html?screen=1` instead (find the IP with `ipconfig` on Windows or `ipconfig getifaddr en0` on a Mac), with both devices on the same Wi-Fi. Allow Python through the firewall if Windows asks.

## Limits worth knowing

- The master page must stay open. If it closes, screens freeze and reconnect automatically when it comes back.
- The free public PeerJS server is fine for lab and demo use but has no uptime guarantee. To run your own, deploy the open-source `peer` server (free tier on Render.com works) and set `peer: { host, port: 443, path: '/', secure: true }` in `js/config.js`.
- Some strict networks (certain campus Wi-Fi) block direct browser-to-browser links. If a remote screen gets stuck on "Connecting", try another network or add a TURN server (see the PeerJS docs).
- `/1`, `/2` work because GitHub Pages serves `404.html` for unknown paths. The pages work normally, but technically they return a 404 status. On other hosts, use `view.html?screen=1`.

## Files

```
index.html          master page
404.html, view.html screen page (identical copies)
js/master.js        editor, cameras, models, sync
js/viewer.js        screen renderer
js/link.js          connections (same-computer + WebRTC)
js/common.js        shared scene, loaders, pose format
js/config.js        settings
lib/                three.js r186 + PeerJS 1.5.5 (bundled, no CDN needed)
models/             your own models (optional)
```

## Test locally

`python3 -m http.server` in this folder, then open `http://localhost:8000/` (master) and `http://localhost:8000/view.html?screen=1` (screen). A plain local server has no 404 fallback, so use `view.html?screen=N` there.
