/* =========================================================================
   sync.js — סנכרון מצב הרכבים ומערכת כיבוי האש בין כל המכשירים
   -------------------------------------------------------------------------
   Live status sync across all devices — serverless (Firebase Firestore).
   NO server for you to run, host, or maintain.

   What it does:
   1. Watches the app's saved state (localStorage key "magToran.state.v1")
      every 2 seconds. When a vehicle is marked תקול (defective) or the
      fire-extinguishing task is marked תקול, it writes the status to the
      shared Firestore collection "dutyStatus".
   2. Subscribes to "dutyStatus". When ANOTHER device changes a status,
      this device applies it to the running app instantly (renderAll) —
      no refresh needed.
   3. When the fire system becomes תקול, an alert document is created in
      the "alerts" collection (the admin page + optional push use it).
   4. If notification permission is granted, this device is registered in
      the "devices" collection so it can receive push alerts.

   Offline behaviour: the app works exactly as before; sync resumes
   automatically when the connection is back.

   Load order (already wired in index.html):
     1. firebase-config.js   (your Firebase config)
     2. the app's inline script
     3. sync.js              (this file)
   ========================================================================= */
(function () {
  "use strict";

  var CFG = window.FIREBASE_CONFIG;
  if (!CFG) {
    console.warn("[sync] firebase-config.js not loaded — live sync is OFF (the app still works normally).");
    return;
  }

  var K_STATE    = "magToran.state.v1";    // the app's own saved state
  var K_MIRROR   = "magToran.syncMirror.v1"; // last known shared state (loop guard)
  var COL_STATUS = "dutyStatus";
  var COL_ALERTS = "alerts";
  var COL_DEVICES = "devices";
  var POLL_MS = 2000;

  var app = null, db = null;
  var fsSdk = null, msgSdk = null;   // firebase modules
  var bootstrapped = false;          // first snapshot handled?
  var listenerFailed = false;
  var pushing = false;               // a push batch is in flight
  var pushBlockedUntil = 0;          // backoff after a failed push
  var lastVehNames = {};             // vehicle names seen in the last local extract

  /* ---------- small helpers ---------- */
  function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function nowISO() { return new Date().toISOString(); }
  function readJSON(k, def) { try { var r = localStorage.getItem(k); return r == null ? def : JSON.parse(r); } catch (e) { return def; } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function vehDocId(name) { return "veh_" + encodeURIComponent(name); }
  function vehNameFromDocId(id) { try { return decodeURIComponent(String(id).slice(4)); } catch (e) { return String(id).slice(4); } }
  function toast(msg) { try { if (typeof window.toast === "function") window.toast(msg); } catch (e) {} }

  // The app's live in-memory state (global `let state` in index.html).
  // Accessed lazily and guarded — if unavailable we fall back to localStorage + reload.
  function liveState() {
    try { return (typeof state !== "undefined") ? state : null; } catch (e) { return null; }
  }
  function readState() { return readJSON(K_STATE, null); }

  function isFireTask(t) { return /כיבוי\s*אש/.test(String((t && t.title) || "")); }
  function firstFireTask(st) {
    var tasks = (st && st.tasks) || [];
    for (var i = 0; i < tasks.length; i++) if (isFireTask(tasks[i])) return tasks[i];
    return null;
  }
  function currentUserName(st) {
    try { return norm(st.roster && st.roster[0] && st.roster[0].name); } catch (e) { return ""; }
  }

  /* ---------- extract shared statuses from the app state ---------- */
  function extract(st, mirror) {
    var out = { vehicles: {}, fire: null };
    var by = currentUserName(st);
    mirror = mirror || { vehicles: {}, fire: null };
    var prevVeh = mirror.vehicles || {};

    (st.vehicles || []).forEach(function (v) {
      var name = norm(v.name);
      if (!name) return;
      var f = {
        faulty: norm(v.fault) === "תקול",
        where: norm(v.faultWhere),
        whereText: norm(v.faultWhereText),
        note: norm(v.faultNote),
        by: by
      };
      var prev = prevVeh[name];
      /* NOTE: "by" is metadata (who changed it last) — NOT part of change detection,
         otherwise every remote apply would flip it back and cause a push ping-pong. */
      var changed = !prev || ["faulty", "where", "whereText", "note"].some(function (k) {
        return String(prev[k]) !== String(f[k]);
      });
      out.vehicles[name] = {
        faulty: f.faulty, where: f.where, whereText: f.whereText, note: f.note, by: f.by,
        at: changed ? nowISO() : (prev.at || nowISO())
      };
    });

    // a vehicle that was deleted locally → publish it as "not faulty" once
    Object.keys(lastVehNames).forEach(function (name) {
      var stillThere = (st.vehicles || []).some(function (v) { return norm(v.name) === name; });
      if (!stillThere) {
        out.vehicles[name] = { faulty: false, where: "", whereText: "", note: "", by: by, at: nowISO(), removed: true };
      }
    });

    var ft = firstFireTask(st);
    if (ft) {
      var ff = { status: norm(ft.status), fault: norm(ft.fault), note: norm(ft.note), by: by };
      var pf = mirror.fire;
      var fchanged = !pf || ["status", "fault", "note"].some(function (k) {
        return String(pf[k]) !== String(ff[k]);
      });
      out.fire = { status: ff.status, fault: ff.fault, note: ff.note, by: ff.by, at: fchanged ? nowISO() : (pf.at || nowISO()) };
    }

    lastVehNames = {};
    (st.vehicles || []).forEach(function (v) { var n = norm(v.name); if (n) lastVehNames[n] = true; });
    return out;
  }

  /* ---------- semantic equality (key-order independent) ---------- */
  function sameDoc(a, b, keys) {
    if (!a || !b) return false;
    return keys.every(function (k) { return String(a[k]) === String(b[k]); });
  }
  /* "by" is deliberately excluded from all comparisons — it is metadata, not state. */
  function sameVeh(a, b) { return sameDoc(a, b, ["faulty", "where", "whereText", "note", "at", "removed"]); }
  function sameFire(a, b) { return sameDoc(a, b, ["status", "fault", "note", "at"]); }
  /* content-only equality (ignores `at`) — used to detect "nothing actually changed" */
  function sameVehFields(a, b) { return sameDoc(a, b, ["faulty", "where", "whereText", "note", "removed"]); }
  function sameFireFields(a, b) { return sameDoc(a, b, ["status", "fault", "note"]); }

  /* ---------- apply shared statuses INTO the app state ---------- */
  function applyVehicleTo(st, name, r) {
    if (!st || !r) return false;
    var v = null;
    (st.vehicles || []).forEach(function (x) { if (!v && norm(x.name) === name) v = x; });
    if (!v) return false;
    if (r.faulty) {
      v.fault = "תקול";
      v.faultWhere = norm(r.where) || norm(v.faultWhere) || "בגף רכב";
      v.faultWhereText = norm(r.whereText) || "";
      v.faultNote = norm(r.note) || "";
    } else if (norm(v.fault) === "תקול") {
      v.fault = "";
      v.faultWhere = "";
      v.faultWhereText = "";
      v.faultNote = "";
    }
    return true;
  }

  function applyFireTo(st, r) {
    if (!st || !r) return false;
    var t = firstFireTask(st);
    if (!t) return false;
    var wasFaulty = norm(t.status) === "תקול";
    var willBeFaulty = norm(r.status) === "תקול";
    t.status = norm(r.status) || "";
    t.fault = norm(r.fault) || "";
    if (willBeFaulty || wasFaulty) t.note = norm(r.note) || "";
    return true;
  }

  /* ---------- UI refresh after applying remote changes ---------- */
  function refreshUI() {
    var done = false;
    try { if (typeof window.afterStruct === "function") { window.afterStruct(); done = true; } } catch (e) {}
    if (!done) {
      try { if (typeof window.renderAll === "function") window.renderAll(); } catch (e) {}
      try { if (typeof window.scheduleSave === "function") window.scheduleSave(); } catch (e) {}
    }
  }

  /* ---------- fallback: no live state access → patch localStorage + reload ---------- */
  function applyViaLocalStorage(toApply) {
    var st = readState();
    if (!st) return;
    var changed = false;
    (toApply.veh || []).forEach(function (e) { if (applyVehicleTo(st, e.name, e.doc)) changed = true; });
    if (toApply.fire && applyFireTo(st, toApply.fire)) changed = true;
    if (changed) {
      writeJSON(K_STATE, st);
      try { location.reload(); } catch (e) {}
    }
  }

  function applyRemote(toApply) {
    var st = liveState();
    if (!st) { applyViaLocalStorage(toApply); return; }
    var changed = false;
    (toApply.veh || []).forEach(function (e) { if (applyVehicleTo(st, e.name, e.doc)) changed = true; });
    var fireWasFaulty = false;
    if (toApply.fire) {
      var t0 = firstFireTask(st);
      fireWasFaulty = !!(t0 && norm(t0.status) === "תקול");
      if (applyFireTo(st, toApply.fire)) changed = true;
    }
    if (changed) {
      refreshUI();
      if (toApply.fire) {
        if (norm(toApply.fire.status) === "תקול") {
          toast("🔥 מערכת כיבוי האש סומנה כתקולה" + (toApply.fire.by ? " על ידי " + toApply.fire.by : ""));
        } else if (fireWasFaulty) {
          toast("✅ מערכת כיבוי האש תוקנה");
        }
      }
    }
  }

  /* ---------- incoming shared state ---------- */
  function handleSnapshot(snap) {
    var remote = { vehicles: {}, fire: null };
    snap.forEach(function (d) {
      var data = d.data() || {};
      if (d.id === "fire") remote.fire = data;
      else if (String(d.id).indexOf("veh_") === 0) remote.vehicles[vehNameFromDocId(d.id)] = data;
    });

    var mirror = readJSON(K_MIRROR, null);

    if (!mirror) {
      // First run ever: adopt the shared state as the mirror, then push
      // whatever the local app has on top of it (local seeds the cloud).
      mirror = { vehicles: remote.vehicles, fire: remote.fire };
      writeJSON(K_MIRROR, mirror);
      bootstrapped = true;
      poll();
      return;
    }

    mirror.vehicles = mirror.vehicles || {};
    var toApply = { veh: [], fire: null };
    var mirrorDirty = false;
    Object.keys(remote.vehicles).forEach(function (name) {
      var r = remote.vehicles[name], m = mirror.vehicles[name];
      if (!m) {
        toApply.veh.push({ name: name, doc: r });
        mirror.vehicles[name] = r;
        mirrorDirty = true;
      } else if (String(r.at || "") > String(m.at || "")) {
        mirror.vehicles[name] = r;
        mirrorDirty = true;
        if (!sameVehFields(m, r)) toApply.veh.push({ name: name, doc: r }); // skip no-op echoes
      }
    });
    if (remote.fire) {
      var rf = remote.fire, mf = mirror.fire;
      if (!mf) {
        toApply.fire = rf;
        mirror.fire = rf;
        mirrorDirty = true;
      } else if (String(rf.at || "") > String(mf.at || "")) {
        mirror.fire = rf;
        mirrorDirty = true;
        if (!sameFireFields(mf, rf)) toApply.fire = rf;
      }
    }
    if (mirrorDirty) writeJSON(K_MIRROR, mirror);   // mirror first — prevents echo/loop
    if (toApply.veh.length || toApply.fire) applyRemote(toApply);
  }

  /* ---------- outgoing local state ---------- */
  function poll() {
    if (!bootstrapped || pushing) return;
    if (Date.now() < pushBlockedUntil) return;
    var st = readState();
    if (!st) return;
    var mirror = readJSON(K_MIRROR, null) || { vehicles: {}, fire: null };
    var payload = extract(st, mirror);
    pushChanged(payload, mirror);
  }

  function pushChanged(payload, mirror) {
    mirror.vehicles = mirror.vehicles || {};
    var writes = []; // {id, doc, kind, name}
    Object.keys(payload.vehicles).forEach(function (name) {
      var doc = payload.vehicles[name];
      if (!sameVeh(mirror.vehicles[name], doc)) {
        writes.push({ id: vehDocId(name), doc: doc, kind: "veh", name: name });
      }
    });
    if (payload.fire && !sameFire(mirror.fire, payload.fire)) {
      writes.push({ id: "fire", doc: payload.fire, kind: "fire" });
    }
    if (!writes.length) return;

    pushing = true;
    var ops = writes.map(function (w) {
      return fsSdk.setDoc(fsSdk.doc(db, COL_STATUS, w.id), w.doc).then(function () { return w; });
    });
    Promise.allSettled(ops).then(function (results) {
      pushing = false;
      var ok = [];
      results.forEach(function (r) { if (r.status === "fulfilled") ok.push(r.value); });
      if (!ok.length) { pushBlockedUntil = Date.now() + 15000; return; }
      ok.forEach(function (w) {
        if (w.kind === "fire") {
          var wasDefect = mirror.fire && norm(mirror.fire.status) === "תקול";
          mirror.fire = w.doc;
          if (!wasDefect && norm(w.doc.status) === "תקול") {
            // fire system just became defective → alert the admin
            fsSdk.addDoc(fsSdk.collection(db, COL_ALERTS), {
              type: "fire_defect",
              title: "מערכת כיבוי האש סומנה כתקולה",
              body: [norm(w.doc.fault), norm(w.doc.note)].filter(Boolean).join(" — "),
              by: norm(w.doc.by),
              at: nowISO()
            }).catch(function () {});
          }
        } else {
          mirror.vehicles[w.name] = w.doc;
        }
      });
      writeJSON(K_MIRROR, mirror);
    });
  }

  /* ---------- push notifications (admin alerts) ---------- */
  function registerToken() {
    navigator.serviceWorker.ready.then(function (reg) {
      return msgSdk.getToken(msgSdk.getMessaging(app), {
        vapidKey: window.VAPID_KEY || (CFG && CFG.vapidKey),
        serviceWorkerRegistration: reg
      });
    }).then(function (token) {
      if (!token) return;
      return fsSdk.setDoc(fsSdk.doc(db, COL_DEVICES, token), {
        token: token,
        ua: String(navigator.userAgent || "").slice(0, 200),
        at: nowISO()
      }, { merge: true });
    }).catch(function (e) { console.warn("[sync] push registration failed", e); });
  }

  function showEnableButton() {
    try {
      if (document.getElementById("syncBell")) return;
      var b = document.createElement("button");
      b.id = "syncBell";
      b.type = "button";
      b.textContent = "🔔 הפעל התראות";
      b.title = "קבל התראה כאשר מערכת כיבוי האש מסומנת כתקולה — גם כשהאפליקציה סגורה";
      b.style.cssText = "position:fixed;bottom:16px;inset-inline-end:16px;z-index:99999;" +
        "padding:8px 14px;border:0;border-radius:999px;background:#2f6d4e;color:#fff;" +
        "font:inherit;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:pointer";
      b.addEventListener("click", function () {
        Notification.requestPermission().then(function (p) {
          if (p === "granted") { b.remove(); registerToken(); }
        });
      });
      (document.body || document.documentElement).appendChild(b);
    } catch (e) {}
  }

  function setupPush() {
    try {
      if (!("Notification" in window)) return;
      if (Notification.permission === "granted") registerToken();
      else if (Notification.permission === "default") showEnableButton();
    } catch (e) {}
  }

  // messages from the service worker (push arrived while the app is open)
  function listenSwMessages() {
    try {
      navigator.serviceWorker.addEventListener("message", function (e) {
        var d = e.data;
        if (d && d.type === "magSyncPush" && d.data && d.data.title) {
          toast("🔔 " + d.data.title + (d.data.body ? " — " + d.data.body : ""));
        }
      });
    } catch (e) {}
  }

  /* ---------- init ---------- */
  function start() {
    fsSdk.onSnapshot(
      fsSdk.query(fsSdk.collection(db, COL_STATUS)),
      handleSnapshot,
      function (e) { listenerFailed = true; console.warn("[sync] listener error", e); }
    );
    setInterval(poll, POLL_MS);
    listenSwMessages();
    if (msgSdk) setupPush();
    // safety net: if the listener never fires (SDK/config problem), still push local state
    setTimeout(function () {
      if (!bootstrapped && listenerFailed) {
        bootstrapped = true;
        if (!readJSON(K_MIRROR, null)) writeJSON(K_MIRROR, { vehicles: {}, fire: null });
        poll();
      }
    }, 10000);
  }

  async function loadAndStart() {
    var o = window.__MAG_SDK_OVERRIDE__;   // test hook (not used in production)
    if (o) {
      app = {}; db = {};
      fsSdk = o.firestore;
      msgSdk = o.messaging || null;
      start();
      return;
    }
    var appMod = await import("https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js");
    fsSdk = await import("https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js");
    app = appMod.initializeApp(CFG);
    db = fsSdk.getFirestore(app);
    try {
      msgSdk = await import("https://www.gstatic.com/firebasejs/13.0.0/firebase-messaging.js");
    } catch (e) { msgSdk = null; }
    start();
  }

  window.addEventListener("load", function () {
    setTimeout(function () {
      loadAndStart().catch(function (e) {
        console.warn("[sync] could not start (offline?) — the app still works normally.", e);
      });
    }, 0);
  });

  // debug/test handle
  window.__magSync = {
    extract: extract, applyVehicleTo: applyVehicleTo, applyFireTo: applyFireTo,
    norm: norm, vehDocId: vehDocId, sameVeh: sameVeh, sameFire: sameFire
  };
})();
