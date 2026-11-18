# Apex Camera

A viewfinder, a shutter and a recorder for the Apex suite. One static folder,
no build step, no dependencies, and every path relative (`./`) so the same
files work served on their own, installed as a PWA, or mounted by ApexOS at
`/apps/camera/`.

Captures are written into the **shared Apex Gallery IndexedDB**, not into
CacheStorage and not into a second store of their own.

```
index.html      viewfinder, mode switch, shutter, review sheet
styles.css      dark glass layout, thumb-first on phones
app.js          getUserMedia, canvas snapshots, MediaRecorder, gallery writes
manifest.json   relative start_url and scope, standalone display
sw.js           offline shell, scoped to this folder
icons/          192, 512 and maskable 512
```

## What it does

- **Live viewfinder** from
  `getUserMedia({ video: { facingMode: 'environment' }, audio: false })`.
- **Switch camera** toggles rear (`environment`) and front (`user`). If a device
  has only one camera and rejects `facingMode`, it retries with any camera
  instead of failing.
- **Photo** draws the current frame into a `<canvas>`, encodes JPEG at 0.92,
  saves it to Apex Gallery, then shows the shot with a **Download** button.
  The front camera preview and the saved photo are both mirrored, so what you
  see is what you get.
- **Video** records the same stream with `MediaRecorder`, shows a `mm:ss` timer
  while it runs, and saves a `.webm` (or `.mp4` where that is all the browser
  supports) with a Download button. Stop with the same button; Escape also
  stops. Recordings stop automatically at 5:00 so a long take cannot eat the
  tab's memory. The stream is video-only: no microphone is requested.
- **Permission fallback** replaces the preview with a plain explanation for
  `NotAllowedError`, `NotFoundError`, `NotReadableError`, `OverconstrainedError`
  and insecure pages, plus a **Retry Camera** button that re-requests the
  stream without a reload.
- The footer counts what is in Apex Gallery, so a save is visible immediately.

## The shared gallery database

Apex Gallery does not exist yet. This is the contract it should read; it is
declared by `app.js` and created on the first save.

```
IndexedDB   apex-gallery   version 1
store       photos         keyPath 'id'
indexes     createdAt      kind
record      {
              id:        string   (uuid)
              kind:      'photo' | 'video'
              name:      string   ('apex-camera-20261118-150412.jpg')
              type:      string   ('image/jpeg' | 'video/webm')
              size:      number   bytes
              width:     number
              height:    number
              duration:  number   seconds, 0 for photos
              createdAt: string   ISO timestamp
              source:    'apex-camera'
              blob:      Blob     the file itself
            }
```

Only a small helper trio touches it: `db()`, `saveRecord()` and `readCounts()`.
A gallery view needs `indexedDB.open('apex-gallery', 1)`, then
`store('photos').index('createdAt')` in reverse for the timeline.

## Permissions

- The camera only works on `https://` or `localhost`. `sw.js` and the manifest
  change nothing about that.
- Inside ApexOS the app runs in an `<iframe>` whose `allow` list includes
  `camera`, so the permission prompt reaches the frame. Opening the app in its
  own tab works the same way.
- Denying once is remembered per origin: allow it from the padlock in the
  address bar, then press **Retry Camera**.

## Running it

```bash
python3 -m http.server 3000
# then open http://localhost:3000/
```

Service workers and `getUserMedia` need `localhost` or https; opening
`index.html` from `file://` will show the insecure-page fallback.

## Deploying

The folder is static. Any static host works. Inside the suite it is bundled by
`Apex/.github/workflows/bundle-apex.yml` into `dist/apps/camera/`, and that
workflow deploys the whole tree to Cloudflare Pages.

## State of this repo

Verified in headless Chrome against a synthetic `MediaStream` (there is no
camera in the build machine): live preview and resolution chip, a JPEG photo
saved into `apex-gallery` with its review sheet and Download button, a lens
switch from `environment` to `user`, a `video/webm;codecs=vp9` recording with
the running timer, the permission-denied panel and Retry recovering to a live
preview, and a full reload with the network off served by `sw.js`.

Also verified from the shell: ApexOS opens the app window with
`allow="camera; microphone; geolocation; clipboard-read; clipboard-write;
fullscreen"`, the camera runs live inside that frame, and Close blanks the
iframe (which releases the camera). Apex Store lists the card as Ready / Offline
ready.

Not verified: real camera hardware on Android or iOS, a device with no front
camera, `.mp4` recording on Safari, and a genuine permission prompt (the tests
stub `getUserMedia`, so the browser-level allow-list itself was set but not
clicked through). The gallery schema is a proposal because Apex Gallery has no
implementation yet.
