# Live status sync across all devices — no servers to run

> **Your project is already wired up:** `firebase-config.js` contains your
> `mag-toran` project config. Remaining TODOs are marked below.

**Your Firebase console links (project `mag-toran`):**
- Console: https://console.firebase.google.com/project/mag-toran/overview
- Firestore: https://console.firebase.google.com/project/mag-toran/firestore
- Cloud Messaging (VAPID key): https://console.firebase.google.com/project/mag-toran/settings/cloudmessaging
- Enable Firestore API: https://console.developers.google.com/apis/api/firestore.googleapis.com/overview?project=mag-toran

**Still TODO:**
1. ⚠️ **Enable Firestore** (not enabled yet — verified): console → Firestore Database → Create database → location `me-west1` (Tel Aviv) → production mode → paste the rules from Step 3 below.
2. ⚠️ **VAPID key**: `firebase-config.js` currently has `REPLACE-ME-WITH-YOUR-VAPID-KEY` — console → Cloud Messaging → Web configuration → Web Push certificates → Generate key pair → paste it there. (Only needed for push notifications.)
3. Upload the files (Step 4).

---

---

## What's new in this update (v2)

1. **Fixed the "only works from the admin panel" bug (the one you hit).**
   The sync engine only pushed changes during a device's *first ever* session;
   from the second day on, phones only received but never sent — so only the
   admin panel (which writes directly) seemed to work. Now every session
   pushes, every day, for every user.
2. **Fixed clock-skew conflicts.** Sync now orders changes by **Firestore
   server time** (not the device's clock). Previously a device whose clock was
   off (even by an hour) had its writes silently ignored by every other device.
3. **The fault timeline is now shared too** — every fault, when it was fixed,
   the note and the location sync to all devices, and the admin panel shows
   the full live timeline.
4. **A sync status badge** in the app corner so you can see at a glance
   whether live sync is working.
5. **Optional:** after scanning the roster photo, the app can ask "is the fire
   system back in business?" and mark it fixed for everyone with one tap.
   **Off by default** — see `window.SYNC_OPTIONS` in `firebase-config.js`.
7. **The roster-photo OCR is much more reliable.** The scan now runs three
   recognition passes (classic prep, downscaled to the optimal text size, and
   watermark-removing binarization) with different segmentation modes, and
   merges the results — on a real phone photo of the roster this went from
   ~2 of 7 names recognized to 7 of 7.
6. **The fault timeline is now an admin-only archive.** It no longer appears
   inside the app (the data still syncs in the background). The admin panel
   shows it as two lists — **open faults** and **archive (fixed)**, newest at
   the top — each showing 5 entries with a "see more" button. Every fixed
   fault — cars **and** the fire system — moves to the archive with **when it
   started, when it was fixed, and how long it took**. The timeline is fully
   editable by the admin: **edit** any point (✏️ — note, location, dates),
   **delete** archived points (🗑), or **export** everything to CSV (Excel).

Your app (צ׳ק ליסט מ״ג תורן) now syncs two things **live across every device**:

1. **Vehicle status** — when anyone marks a car as תקול (defective), every other
   device shows it within ~1–2 seconds. Same when it is cleared.
2. **Fire system (מערכת כיבוי אש) status** — when it is marked תקול, every
   device updates instantly **and** an alert is created for the admin
   (admin page + optional push notification, even when the app is closed).
3. **Fault timeline (ציר זמן תקלות)** — the per-vehicle fault history
   (what was broken, when, where, the note, when it was fixed) is shared and
   shown live on the admin panel.

You do **not** run, host, pay for, or maintain any server. This uses
**Firebase** — a serverless backend run by Google. The free tier (Spark plan)
includes 50,000 reads/day and 20,000 writes/day — far more than a duty
checklist with a handful of users will ever use.

---

## How it works (30 seconds)

```
 Device A (marks a car תקול)          Device B / C / ... (everyone else)
        │                                      ▲
        ▼                                      │
   sync.js watches the app's        onSnapshot (live subscription)
   saved state every 2 s                   │
        │                                  ▼
        ▼                          applies the change to the
   Firestore "dutyStatus"           running app + re-renders
   (Google's serverless DB)         instantly — no refresh needed
        │
        └─ when FIRE becomes תקול → also writes an "alerts" doc
                                          │
                                          ▼
                              admin.html shows it live +
                              optional push notification
```

- `sync.js` is a small drop-in script added to your `index.html`. It does not
  change your app's code or UI.
- `admin.html` is the **separate website** you asked about — an admin console
  that can change any status and see everything live (vehicles, fire system,
  **and the fault timeline**). It can live on the same host as `index.html`,
  or on a completely different free host (see step 4).
- **Server timestamps decide conflicts.** Each change is stamped by
  Firestore's servers, so a device with a wrong clock cannot make its writes
  get ignored (this was the "admin-only sync" bug).
- Everything degrades gracefully: **offline, the app works exactly as before**;
  sync resumes automatically when the connection is back.

---

## Files

| File | What it is |
|---|---|
| `index.html` | your app — **only 2 lines added** at the end (loads config + sync) |
| `sync.js` | NEW — the sync engine (drop-in, ~600 lines, commented) |
| `admin.html` | NEW — the separate admin website (Hebrew UI, shows the fault timeline too) |
| `firebase-config.example.js` | template — copy to `firebase-config.js` and fill in |
| `firebase-config.js` | NEW (you create) — your Firebase keys (public by design) |
| `sw.js` | updated — same offline caching as before, **plus** push-notification display |
| `manifest.json`, icons | unchanged |

Backups of your original `index.html` / `sw.js` are in `/backup-originals/`.

---

## Step 1 — Create a Firebase project (free, ~3 minutes)

1. Go to https://console.firebase.google.com → **Add project** → name it
   (e.g. `mag-toran`) → disable Google Analytics (not needed) → **Create**.
2. Click the **</> (Web)** icon → register the app (nickname: `mag-toran-web`)
   → you will get a `firebaseConfig` object. **Copy it.**

## Step 2 — Create `firebase-config.js`

1. Copy `firebase-config.example.js` → `firebase-config.js`.
2. Paste your `firebaseConfig` values into `window.FIREBASE_CONFIG`.
3. In the Firebase console: **Cloud Messaging** → scroll to **Web configuration**
   → **Web Push certificates** → **Generate key pair** → copy the key into
   `window.VAPID_KEY`.

## Step 3 — Enable Firestore + set rules

1. **Firestore Database** → **Create database** → location: **`me-west1`
   (Tel Aviv)** — closest to you → start in **production mode**.
2. Go to the **Rules** tab and paste:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // shared live status (vehicles + fire system)
    match /dutyStatus/{docId} {
      allow read, write: if true;
    }
    // shared fault timeline (per-vehicle history)
    match /faultTimeline/{docId} {
      allow read, write: if true;
    }
    // admin alerts (append-only)
    match /alerts/{docId} {
      allow read: if true;
      allow create: if true;
      allow update, delete: if false;
    }
    // devices registered for push notifications
    match /devices/{docId} {
      allow read: if true;
      allow create, update: if true;
      allow delete: if false;
    }
  }
}
```

3. **Publish** the rules.

> ⚠️ "allow write: if true" means anyone with your web config can change
> statuses. That is normal for Firebase web apps (the config is public by
> design) and fine for a closed team tool. If you ever want to lock it down,
> enable **Anonymous Authentication** and change the rules to
> `allow read, write: if request.auth != null;` — then only signed-in devices
> (every visitor gets an anonymous ID automatically) can write. See
> "Security" below.

## Step 4 — Upload the files

Upload **all** files from this folder to your web host (the same place where
`index.html` lives today). Any static host works. If you don't have one:

- **Cloudflare Pages** (pages.cloudflare.com) — free, drag & drop the folder.
- **Netlify** (netlify.com) — free, drag & drop.
- **GitHub Pages** — free (repo → Settings → Pages).

> The site must be served over **HTTPS** (Firebase and service workers
> require it). All hosts above do this automatically.

> **Every phone updates automatically.** This update also changes the app's
> offline-cache name (`sw.js`), so each device downloads the new sync engine
> by itself the next time it opens the app — no need to clear anything.
> (If a phone still misbehaves, open the app once and press Ctrl+Shift+R.)

`admin.html` can also be hosted somewhere else entirely (e.g. its own GitHub
Pages site) — it only needs `firebase-config.js` next to it. Firebase handles
cross-site requests (CORS) for you.

## Step 5 — Use it

1. Open the app on any device — sync starts automatically (watch the browser
   console for `[sync]` messages if you want to verify).
2. Mark a vehicle תקול on device A → open the app on device B → it is already
   תקול there.
3. Open **`admin.html`** on the admin's phone/computer:
   - see every vehicle + the fire system live,
   - see the **⚠️ ציר זמן תקלות** (fault timeline) — open faults first,
     with dates, notes and locations,
   - mark anything תקול / תקין (with location + note + your name),
   - see the alerts log,
   - click **"הפעל התראות push"** to allow notifications.
4. Watch the small **sync badge** in the app's corner — green
   (סנכרון: תקין) means live sync is on; grey (סנכרון: cbוי) means sync is
   off (no config); red (סנכרון: שגיאה) means the connection to Firebase
   failed (the app still works offline).
5. **The timeline is an archive (admin panel only).** When a car or the fire
   system is fixed, that point moves to the archive list automatically, showing
   when it started, when it was fixed, and how long it took. Both lists are
   sorted newest-first and show 5 entries with a "see more" button to see
   everything. In `admin.html` the timeline is fully editable: **edit** any
   point with the ✏️ button (note, location, start date, fix date), **delete**
   archived points (the 🗑 button), and **export** everything to CSV (the 💾
   button) — e.g. to print or keep a record. Open (not-yet-fixed) faults
   cannot be deleted from the timeline; mark the vehicle as fixed first.
4. Mark the fire system תקול (from the app or the admin page) → every device
   updates instantly; the admin page shows an alert.

A small **🔔 "הפעל התראות"** button appears in the app if notification
permission is not granted yet — tap it once on devices that should get alerts.

## Step 6 (OPTIONAL) — Push notification when the app is CLOSED

By default the admin sees alerts **instantly when the app/admin page is open**.
To get a phone notification even when everything is closed, add a tiny
serverless **Cloud Function** (10 lines — still no server for you to run;
it runs on Google's infrastructure only when an alert is created).

1. In the Firebase console: **Functions** → **Upgrade project** → choose the
   **Blaze (pay-as-you-go)** plan. **Don't worry about cost:** Cloud Functions
   include 2 million free invocations/month and FCM messages are free — at
   your scale this will be **$0.00/month**.
2. On your computer: `npm install -g firebase-tools` → `firebase login` →
   `firebase init functions` (use JavaScript, ESLint: no).
3. Replace `functions/index.js` with:

```js
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

// When a new alert is created → push it to every registered device.
exports.sendAlert = onDocumentCreated("alerts/{alertId}", async (event) => {
  const data = event.data.data();
  const snap = await getFirestore().collection("devices").get();
  let tokens = snap.docs.map(d => d.id).filter(Boolean);
  if (!tokens.length) return;

  // clean up dead tokens
  const res = await getMessaging().sendEachForMulticast({
    tokens,
    data: {
      title: data.title || "Alert",
      body: data.body || "",
      url: "./index.html",
      tag: "duty-alert"
    }
  });
  const dead = [];
  res.responses.forEach((r, i) => {
    if (!r.success) dead.push(tokens[i]);
  });
  await Promise.all(dead.map(t => getFirestore().collection("devices").doc(t).delete().catch(() => {})));
});
```

4. `functions/package.json` — make sure it includes:

```json
{
  "name": "functions",
  "engines": { "node": "20" },
  "dependencies": {
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^5.0.0"
  }
}
```

5. Deploy: `firebase deploy --only functions`.

> Note: iOS (iPhone/iPad) push works only on iOS 16.4+ and only when the app is
> installed to the home screen ("Add to Home Screen"). Android and desktop
> work everywhere.

---

## Data model (Firestore)

```
dutyStatus/veh_<vehicle-name>   { faulty, where, whereText, note, by, at }
dutyStatus/fire                 { status, fault, note, by, at }
faultTimeline/veh_<vehicle-name>{ name, entries[≤40], at }   ← fault history
faultTimeline/fire              { name, entries[≤40], at }   ← fire-system archive
alerts/{auto-id}                { type:"fire_defect", title, body, by, at }
devices/{fcm-token}             { token, ua, at }
```

`entries` = the vehicle's timeline rows
`{ at, status:"open"|"closed", note, where, whereText, source, closedAt? }`,
newest first, capped at 40 per vehicle. The app and the admin panel keep the
shared timeline merged (a fault recorded offline is not lost).

- `at` = **server** timestamp (Firestore `serverTimestamp()`), not the device
  clock. **Last write wins** per document, judged by server time — so a device
  with a wrong clock can no longer get its changes ignored.
- Each vehicle is its own document, so two devices marking *different* cars
  at the same time never overwrite each other.
- `sync.js` keeps a local "mirror" of the last shared state — this is what
  prevents update loops between devices.
- **Joining rule:** the very first device (empty cloud) seeds the shared state
  from its local app. A device that joins later **adopts** the shared state
  (the cloud wins) — it never overwrites everyone's newer changes with its own
  stale defaults.

## Security

- The Firebase web config is **public by design** (it ships to every browser).
  Security comes from Firestore rules, not from hiding the config.
- The rules above are open read/write — fine for a closed team. To restrict to
  "only people who opened the app once": enable **Authentication → Anonymous**
  in the console and use:

```
match /dutyStatus/{docId} { allow read, write: if request.auth != null; }
match /alerts/{docId}    { allow read: if request.auth != null; allow create: if request.auth != null; }
match /devices/{docId}   { allow read: if request.auth != null; allow create, update: if request.auth != null; }
```

  (Every visitor of your app is then automatically signed in anonymously.)

## Troubleshooting

| Symptom | Fix |
|---|---|
| Nothing syncs, console shows `[sync] firebase-config.js not loaded` | You didn't create `firebase-config.js` (step 2) |
| `[sync] listener error` / permission denied | Firestore rules not published (step 3) or wrong project in config |
| Sync works but a device shows stale data | That device is offline — it will catch up when back online; its own changes are kept locally and pushed on reconnect |
| Two devices "fight" over a status | Last write wins (by timestamp). If a device clock is wrong, fix the clock — timestamps decide conflicts |
| No push when app is closed | Step 6 (Cloud Function) not deployed, or notification permission not granted, or iOS < 16.4 / not installed as PWA |
| admin.html shows "חסר firebase-config.js" | `firebase-config.js` must sit next to `admin.html` |

## Alternatives I considered (and why not)

- **Supabase Realtime** — also serverless and free; a good choice if you later
  want a real SQL database with tables/history. Slightly more setup, and no
  built-in push notifications. Firebase was picked because it has both
  realtime sync **and** push (FCM) in one free package.
- **Ably / Pusher** — hosted pub/sub channels; very simple broadcasting, but
  **no persistence**: if everyone closes the app, the status is lost. Wrong
  for you — a car marked תקול must stay תקול until someone clears it.
- **Peer-to-peer (WebRTC / PeerJS)** — literally zero backend, but the status
  only lives while at least one peer is online; the person who marked the car
  closes the app → everyone loses the status, and the admin cannot be
  reliably alerted. Not acceptable for your use case.
- **BroadcastChannel / localStorage events** — only syncs tabs on the *same*
  device. Not across users.

## Optional features (`window.SYNC_OPTIONS` in `firebase-config.js`)

```js
window.SYNC_OPTIONS = {
  // After scanning the roster photo, if the shared fire-system status is
  // defective, ask "was it fixed?" — answering yes marks it fixed for EVERYONE.
  // Default: false (off). Set to true to enable.
  askFireAfterScan: false
};
```

## Notes & limits

- The first device ever (empty cloud) seeds the shared state from its local
  app; a device that joins later adopts the shared state (cloud wins).
- Deleting a vehicle from the app's list publishes it as "not faulty" once
  (so nobody sees a ghost תקול).
- Sync checks the saved state every 2 seconds — a change appears on other
  devices within ~1–3 seconds.
- The app's own offline behavior (service worker cache) is unchanged.
- Tested end-to-end with a simulated multi-device suite: unit tests
  (bootstrap, push, alerts, remote apply, loop prevention, joining device,
  returning device, timeline sync) plus a real-browser test that loads the
  actual app on three devices — including one with a clock 1 hour behind —
  and verifies every change reaches every device.
