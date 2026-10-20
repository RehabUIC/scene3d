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

A screen picks the best available link by itself:

1. **Same computer** (other tabs or windows of the master's browser): instant, works with no internet. This is ideal for one PC driving several monitors.
2. **Firebase** (any device, any network: mobile data, campus Wi-Fi, another city): real-time through your own free Firebase Realtime Database, typically 50–150 ms. The screen connects this way within a second or two.
3. **Direct** (WebRTC): in the background, every Firebase screen also tries a direct browser-to-browser link. If the network allows it, the screen switches over automatically. This is the fastest link, and it saves Firebase quota.

The master panel shows how many screens use each link. Each screen shows its link, updates per second and buffer at the bottom-left; tap the screen to see it.

### Firebase setup (one time)

The project in `js/config.js` (`scene3d-95bf0`) needs a Realtime Database with open rules for the `scene3d` path:

1. Go to https://console.firebase.google.com, open the project, then **Build → Realtime Database → Create database**.
2. For the location, pick **United States (us-central1)**, and for the security rules, start in **locked mode**.
3. Open the **Rules** tab, replace everything with the rules below, and click **Publish**:
   ```json
   {
     "rules": {
       "scene3d": {
         "$room": { ".read": true, ".write": true }
       }
     }
   }
   ```
If you picked another location, copy the database address shown at the top of the Data tab into `databaseURL` in `js/config.js`.

**Free plan limits (Spark):** 100 simultaneous connections, 1 GB stored, 10 GB downloaded per month. Camera updates use about 45 MB per hour of nonstop movement per Firebase screen; a still scene uses almost nothing. Screens on the same computer or on a direct link don't use Firebase at all. If the monthly limit is reached, Firebase pauses until the next month; nothing is charged.

**Rooms and privacy:** master and screens find each other by the **room** name shown in the panel. By default it comes from your site address. Anyone who knew your room name could watch the scene, so for anything private, add a secret room to every link, for example `…/scene3d/?room=lab-k39x7` and `…/scene3d/1?room=lab-k39x7`. **Copy all links** keeps the room in the links for you.

Imported models are copied to each screen automatically, with a progress bar. They are also kept in the master browser's storage, so a page reload doesn't lose them. Models you import are uploaded to Firebase once (up to 25 MB each) for screens on other networks; each such screen's download counts toward the 10 GB. For large models, put the files in `models/` (see below) and screens download them from GitHub instead.

### CAVE mode (3 monitors, stereo 3D, head-tracked)

Screens 1, 2 and 3 become one wrap-around stereo window. Screen 1 is the left monitor, 2 the centre and 3 the right; the side monitors are turned inward (120° between neighbouring screens by default). Each monitor shows an off-axis view for each eye, so when your head moves, the scene shifts with correct parallax, like looking through a real window ("fish-tank VR").

1. In the master panel, tick **CAVE · 3 monitors → On**.
2. Set **3D format** (Row-interleaved for passive polarized 3D monitors), **monitor size**, **angle between** screens, **bezel** width and your **eye distance** from the centre screen. Measuring these accurately makes the 3D look right.
3. Open `…/1`, `…/2`, `…/3` in three browser windows, drag one to each monitor, and press **F** in each for fullscreen. Row-interleaved 3D needs the window fullscreen so its pixel rows line up with the monitor's.
4. If depth looks inside-out on a screen, press **S** on that screen (or tick **Swap left/right eye** for all).
5. **The rig:** the three screen outlines and the white ball (your head) in the master's 3D view. Select it (click it or **Select rig**) to move or rotate all three views together, or click **Put rig at my view**. **World scale** shrinks or enlarges the world relative to you.

**Head tracking:** choose **Head → Webcam** in the master (the webcam must sit on top of the centre monitor), or press **T** on one of the screen pages to track from that window. The screen-page option keeps working when the master window is hidden behind the screens, which is usually the case in a 3-monitor setup. Depth is measured from the distance between your pupils, so no calibration is needed; use **Webcam FOV** and **Depth adjust** if distances look off, and **Smoothing** to trade jitter for lag. **Head → Mouse** lets you test parallax by dragging a pad.

The face tracker (MediaPipe) loads from the internet the first time (about 10 MB) and then runs entirely in the browser; no video leaves the computer.

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
| `?firebase=off` / `?direct=off` | Turn off Firebase or the direct link. |
| `?relay=wss://host/mqtt` | Also use a public or own MQTT relay server (repeat for several). |
| `?fit=window` (screens) | Fill a non-16:9 display instead of letterboxing. |
| `?model=models/x.glb` (master) | Load a model on start. |
| `?scene=models/myscene.json` (master) | Start from a saved scene file. |

## Troubleshooting

Read the message on the screen under "Waiting for the master":

- **"No master is open in room …"**: open the master page first. Check that the room name at the bottom-left of the screen matches the one in the master's panel, and use **Copy all links** to get matching links.
- **"Firebase refused access"**, or the master's Firebase line is red: the database rules aren't published, or the database doesn't exist yet. See Firebase setup above.
- **Firebase line stuck on "Connecting…"**: the database isn't in us-central1. Set `databaseURL` in `js/config.js`.
- **Testing from a phone against a server on your laptop:** `localhost` on the phone means the phone itself. Open `http://<your-laptop-IP>:8000/view.html?screen=1` instead. Find the IP with `ipconfig`.

## Limits worth knowing

- The master page must stay open. If it closes, screens freeze and reconnect automatically when it comes back.
- The free public PeerJS server is fine for lab and demo use but has no uptime guarantee. To run your own, deploy the open-source `peer` server (free tier on Render.com works) and set `peer: { host, port: 443, path: '/', secure: true }` in `js/config.js`.
- Through Firebase, a screen sees changes about 0.05–0.15 s after the master; on the same computer or a direct link it's near-instant.
- `/1`, `/2` work because GitHub Pages serves `404.html` for unknown paths. The pages work normally, but technically they return a 404 status. On other hosts, use `view.html?screen=1`.

## Files

```
index.html          master page
404.html, view.html screen page (identical copies)
js/master.js        editor, cameras, models, sync
js/viewer.js        screen renderer
js/link.js          connections (same computer, direct WebRTC, Firebase, relay)
js/fb.js            Firebase Realtime Database link
js/cave.js          CAVE geometry, off-axis projection, stereo output
js/cave-master.js   the CAVE rig in the master's scene
js/headtrack.js     webcam head tracking (MediaPipe Face Landmarker)
js/relay.js         optional relay over MQTT servers
js/common.js        shared scene, loaders, pose format
js/config.js        settings
lib/                three.js r186, PeerJS 1.5.5, Firebase JS SDK 13.0.0, MQTT.js 5.16 (bundled)
models/             your own models (optional)
```

## Test locally

`python3 -m http.server` in this folder, then open `http://localhost:8000/` (master) and `http://localhost:8000/view.html?screen=1` (screen). A plain local server has no 404 fallback, so use `view.html?screen=N` there.
