/* =========================================================================
   sync.js — סנכרון מצב הרכבים, מערכת כיבוי האש וציר התקלות בין כל המכשירים
   -------------------------------------------------------------------------
   Live sync across all devices — serverless (Firebase Firestore).
   NO server for you to run, host, or maintain.

   What it syncs (shared collection "dutyStatus" + "faultTimeline"):
   1. Vehicle status — when a vehicle is marked תקול (defective) in the app
      OR in the admin panel, every device shows it within ~1–3 seconds.
   2. Fire system (מערכת כיבוי אש) status — same live sync. When it becomes
      תקול, an alert document is created in "alerts" (admin page + push).
   3. Fault timeline (ציר תקלות) — the per-vehicle fault history is shared
      too, so the admin panel (and every app) shows the same timeline.

   ORDERING IS DONE BY SERVER TIME (Firestore serverTimestamp), not by the
   device clock — a phone with a wrong clock can no longer be ignored.

   Offline behaviour: the app works exactly as before; sync resumes
   automatically when the connection is back.

   Optional feature (window.SYNC_OPTIONS in firebase-config.js):
   - askFireAfterScan: after scanning the roster photo, if the shared fire
     status is תקול, the app asks whether it is back in business.

   Load order (already wired in index.html):
     1. firebase-config.js   (your Firebase config + SYNC_OPTIONS)
     2. the app's inline script
     3. sync.js              (this file)
   ========================================================================= */
(function () {
  "use strict";

  var CFG = window.FIREBASE_CONFIG;
  var OPTS = window.SYNC_OPTIONS || {};
  if (!CFG) {
    setSyncBadge("off");
    console.warn("[sync] firebase-config.js not loaded — live sync is OFF (the app still works normally).");
    return;
  }

  var K_STATE    = "magToran.state.v1";     // the app's own saved state
  var K_MIRROR   = "magToran.syncMirror.v1"; // last known shared state (loop guard)
  var K_FAULT_TL = "magToran.faultTimeline.v1"; // the app's fault timeline
  var COL_STATUS = "dutyStatus";
  var COL_TIMELINE = "faultTimeline";
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
  var pendingTimelineSnap = null;    // timeline snapshot that arrived too early

  /* ---------- small helpers ---------- */
  function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function nowISO() { return new Date().toISOString(); }
  function readJSON(k, def) { try { var r = localStorage.getItem(k); return r == null ? def : JSON.parse(r); } catch (e) { return def; } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function vehDocId(name) { return "veh_" + encodeURIComponent(name); }
  function vehNameFromDocId(id) { try { return decodeURIComponent(String(id).slice(4)); } catch (e) { return String(id).slice(4); } }
  function toast(msg) { try { if (typeof window.toast === "function") window.toast(msg); } catch (e) {} }

  /* Convert a Firestore Timestamp / ISO string / millis to epoch millis.
     Returns null for pending (unresolved) server timestamps. */
  function atMillis(v) {
    if (v == null) return null;
    if (typeof v.toMillis === "function") { try { return v.toMillis(); } catch (e) {} }
    if (typeof v.toDate === "function") { try { return v.toDate().getTime(); } catch (e) {} }
    if (typeof v === "number") return v;
    var t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  /* mirror entry -> atMs (backward compatible with v1 mirrors that stored `at`) */
  function mAtMs(m) { return m ? (m.atMs != null ? m.atMs : atMillis(m.at)) : null; }

  // The app's live in-memory state (global `let state` in index.html).
  // Accessed lazily and guarded — if unavailable we fall back to localStorage + reload.
  function liveState() {
    try { return (typeof state !== "undefined") ? state : null; } catch (e) { return null; }
  }
  /* Prefer the app's LIVE state (the app saves to localStorage with a debounce,
     so the saved copy can lag ~350ms behind what the user just did). */
  function readState() { return liveState() || readJSON(K_STATE, null); }

  function isFireTask(t) { return /כיבוי\s*אש/.test(String((t && t.title) || "")); }
  function firstFireTask(st) {
    var tasks = (st && st.tasks) || [];
    for (var i = 0; i < tasks.length; i++) if (isFireTask(tasks[i])) return tasks[i];
    return null;
  }
  function currentUserName(st) {
    try { return norm(st.roster && st.roster[0] && st.roster[0].name); } catch (e) { return ""; }
  }

  /* ---------- field shapes (content only — "by" and "at" are metadata) ---------- */
  function vehFieldsOf(o) {
    if (!o) return null;
    return { faulty: !!o.faulty, where: norm(o.where), whereText: norm(o.whereText), note: norm(o.note), removed: !!o.removed };
  }
  function fireFieldsOf(o) {
    if (!o) return null;
    return { status: norm(o.status), fault: norm(o.fault), note: norm(o.note) };
  }
  function sameDoc(a, b, keys) {
    if (!a || !b) return false;
    return keys.every(function (k) { return String(a[k]) === String(b[k]); });
  }
  /* "by" is deliberately excluded from all comparisons — it is metadata, not state. */
  function sameVehFields(a, b) { return sameDoc(a, b, ["faulty", "where", "whereText", "note", "removed"]); }
  function sameFireFields(a, b) { return sameDoc(a, b, ["status", "fault", "note"]); }

  /* mirror entries keep the content + atMs (null = our push, waiting for the echo) */
  function vehMirrorEntry(r) {
    return { faulty: !!r.faulty, where: norm(r.where), whereText: norm(r.whereText), note: norm(r.note), by: norm(r.by), atMs: atMillis(r.at) };
  }
  function fireMirrorEntry(r) {
    return { status: norm(r.status), fault: norm(r.fault), note: norm(r.note), by: norm(r.by), atMs: atMillis(r.at) };
  }

  /* ---------- fault timeline helpers ---------- */
  function entrySig(e) {
    if (!e) return "";
    return JSON.stringify([norm(e.at), norm(e.status), norm(e.note), norm(e.where), norm(e.whereText), norm(e.source), norm(e.closedAt)]);
  }
  /* The app keeps at most ONE open entry per vehicle (syncFaultTimelineFromState
     enforces it). When a remote echo and a local edit race, both versions of the
     open entry can appear — keep only the newest one, drop duplicate opens. */
  function dedupeOpenEntries(list) {
    var seenOpen = false, out = [];
    (Array.isArray(list) ? list : []).forEach(function (e) {
      if (e && norm(e.status) === "open") {
        if (seenOpen) return;
        seenOpen = true;
      }
      out.push(e);
    });
    return out;
  }
  function sameEntries(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (entrySig(a[i]) !== entrySig(b[i])) return false;
    return true;
  }

  /* ---------- extract shared statuses from the app state ---------- */
  function extract(st) {
    var out = { vehicles: {}, fire: null, timeline: {} };
    var by = currentUserName(st);

    (st.vehicles || []).forEach(function (v) {
      var name = norm(v.name);
      if (!name) return;
      out.vehicles[name] = {
        faulty: norm(v.fault) === "תקול",
        where: norm(v.faultWhere),
        whereText: norm(v.faultWhereText),
        note: norm(v.faultNote),
        by: by
      };
    });

    // a vehicle that was deleted locally → publish it as "not faulty" once
    Object.keys(lastVehNames).forEach(function (name) {
      var stillThere = (st.vehicles || []).some(function (v) { return norm(v.name) === name; });
      if (!stillThere) {
        out.vehicles[name] = { faulty: false, where: "", whereText: "", note: "", by: by, removed: true };
      }
    });

    var ft = firstFireTask(st);
    if (ft) {
      out.fire = { status: norm(ft.status), fault: norm(ft.fault), note: norm(ft.note), by: by };
    }

    lastVehNames = {};
    (st.vehicles || []).forEach(function (v) { var n = norm(v.name); if (n) lastVehNames[n] = true; });

    var tl = readJSON(K_FAULT_TL, {}) || {};
    Object.keys(tl).forEach(function (name) {
      if (Array.isArray(tl[name]) && tl[name].length) out.timeline[name] = tl[name];
    });
    return out;
  }

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
    var st = readJSON(K_STATE, null);   // saved copy only — this path runs when there is no live state
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

  /* ---------- incoming shared status (collection "dutyStatus") ---------- */
  function handleSnapshot(snap) {
    var remote = { vehicles: {}, fire: null };
    snap.forEach(function (d) {
      var data = d.data() || {};
      if (d.id === "fire") remote.fire = data;
      else if (String(d.id).indexOf("veh_") === 0) remote.vehicles[vehNameFromDocId(d.id)] = data;
    });

    var mirror = readJSON(K_MIRROR, null);

    if (!mirror) {
      // First run on this device. If the cloud already has shared state, the
      // cloud wins: adopt it as the mirror AND apply it into the app — a device
      // that joins later must not overwrite everyone's newer changes with its
      // own stale local defaults. Only a completely empty cloud is seeded from
      // the local app.
      mirror = { vehicles: {}, fire: null, timeline: {} };
      var toApply0 = { veh: [], fire: null };
      Object.keys(remote.vehicles).forEach(function (name) {
        mirror.vehicles[name] = vehMirrorEntry(remote.vehicles[name]);
        toApply0.veh.push({ name: name, doc: remote.vehicles[name] });
      });
      if (remote.fire) { mirror.fire = fireMirrorEntry(remote.fire); toApply0.fire = remote.fire; }
      writeJSON(K_MIRROR, mirror);
      bootstrapped = true;
      setSyncBadge("ok");
      if (toApply0.veh.length || toApply0.fire) applyRemote(toApply0);
      poll();
      if (pendingTimelineSnap) { var s = pendingTimelineSnap; pendingTimelineSnap = null; handleTimelineSnapshot(s); }
      return;
    }

    // A snapshot arrived and we already have a mirror (a returning device —
    // every user who opened the app before). The listener works, so polling
    // may push again. Without this line, only a first-ever session could push
    // and the app would appear to sync "only from the admin panel".
    bootstrapped = true;

    mirror.vehicles = mirror.vehicles || {};
    mirror.timeline = mirror.timeline || {};
    var toApply = { veh: [], fire: null };
    var mirrorDirty = false;
    Object.keys(remote.vehicles).forEach(function (name) {
      var r = remote.vehicles[name], m = mirror.vehicles[name];
      var rMs = atMillis(r.at), mMs = mAtMs(m);
      if (!m) {
        mirror.vehicles[name] = vehMirrorEntry(r);
        mirrorDirty = true;
        toApply.veh.push({ name: name, doc: r });
      } else if (rMs != null && (mMs == null || rMs > mMs)) {
        var contentChanged = !sameVehFields(vehFieldsOf(m), vehFieldsOf(r));
        mirror.vehicles[name] = vehMirrorEntry(r);
        mirrorDirty = true;
        if (contentChanged) toApply.veh.push({ name: name, doc: r }); // skip no-op echoes
      }
    });
    if (remote.fire) {
      var rf = remote.fire, mf = mirror.fire;
      var rMsF = atMillis(rf.at), mMsF = mAtMs(mf);
      if (!mf) {
        mirror.fire = fireMirrorEntry(rf);
        mirrorDirty = true;
        toApply.fire = rf;
      } else if (rMsF != null && (mMsF == null || rMsF > mMsF)) {
        var fChanged = !sameFireFields(fireFieldsOf(mf), fireFieldsOf(rf));
        mirror.fire = fireMirrorEntry(rf);
        mirrorDirty = true;
        if (fChanged) toApply.fire = rf;
      }
    }
    if (mirrorDirty) writeJSON(K_MIRROR, mirror);   // mirror first — prevents echo/loop
    if (toApply.veh.length || toApply.fire) applyRemote(toApply);
  }

  /* ---------- incoming fault timeline (collection "faultTimeline") ---------- */
  function handleTimelineSnapshot(snap) {
    var mirror = readJSON(K_MIRROR, null);
    if (!mirror || !bootstrapped) { pendingTimelineSnap = snap; return; }
    mirror.timeline = mirror.timeline || {};
    var local = readJSON(K_FAULT_TL, {}) || {};
    var dirty = false, mirrorDirty = false;
    snap.forEach(function (d) {
      if (String(d.id).indexOf("veh_") !== 0) return;
      var name = vehNameFromDocId(d.id);
      var data = d.data() || {};
      var entries = Array.isArray(data.entries) ? data.entries : [];
      var m = mirror.timeline[name];
      var rMs = atMillis(data.at), mMs = mAtMs(m);
      if (!m || (rMs != null && (mMs == null || rMs > mMs))) {
        // union: remote entries + local-only entries (keeps offline-created entries)
        var localList = Array.isArray(local[name]) ? local[name] : [];
        var seen = {};
        entries.forEach(function (e) { seen[entrySig(e)] = true; });
        var merged = dedupeOpenEntries(entries);
        localList.forEach(function (e) { if (!seen[entrySig(e)]) merged.push(e); });
        merged = dedupeOpenEntries(merged).slice(0, 40);
        local[name] = merged;
        mirror.timeline[name] = { entries: merged, atMs: rMs };
        dirty = true;
        mirrorDirty = true;
      }
    });
    if (mirrorDirty) writeJSON(K_MIRROR, mirror);
    if (dirty) {
      writeJSON(K_FAULT_TL, local);
      try { if (typeof window.renderFaultTimeline === "function") window.renderFaultTimeline(); } catch (e) {}
    }
  }

  /* ---------- outgoing local state ---------- */
  function poll() {
    if (!bootstrapped || pushing) return;
    if (Date.now() < pushBlockedUntil) return;
    var st = readState();
    if (!st) return;
    var mirror = readJSON(K_MIRROR, null) || { vehicles: {}, fire: null, timeline: {} };
    var payload = extract(st);
    pushChanged(payload, mirror);
  }

  function pushChanged(payload, mirror) {
    mirror.vehicles = mirror.vehicles || {};
    mirror.timeline = mirror.timeline || {};
    var writes = []; // {id, kind, name, fields|entries}
    Object.keys(payload.vehicles).forEach(function (name) {
      var f = payload.vehicles[name];
      if (!sameVehFields(vehFieldsOf(mirror.vehicles[name]), vehFieldsOf(f))) {
        writes.push({ id: vehDocId(name), kind: "veh", name: name, fields: f });
      }
    });
    if (payload.fire && !sameFireFields(fireFieldsOf(mirror.fire), fireFieldsOf(payload.fire))) {
      writes.push({ id: "fire", kind: "fire", fields: payload.fire });
    }
    Object.keys(payload.timeline).forEach(function (name) {
      var entries = payload.timeline[name];
      var m = mirror.timeline[name];
      if (!m || !sameEntries(m.entries, entries)) {
        writes.push({ id: vehDocId(name), kind: "timeline", name: name, entries: entries });
      }
    });
    if (!writes.length) return;

    pushing = true;
    var ops = writes.map(function (w) {
      var data;
      if (w.kind === "veh") {
        data = { faulty: !!w.fields.faulty, where: w.fields.where, whereText: w.fields.whereText, note: w.fields.note, by: w.fields.by, removed: !!w.fields.removed, at: fsSdk.serverTimestamp() };
      } else if (w.kind === "fire") {
        data = { status: w.fields.status, fault: w.fields.fault, note: w.fields.note, by: w.fields.by, at: fsSdk.serverTimestamp() };
      } else {
        data = { name: w.name, entries: w.entries, at: fsSdk.serverTimestamp() };
      }
      var col = w.kind === "timeline" ? COL_TIMELINE : COL_STATUS;
      return fsSdk.setDoc(fsSdk.doc(db, col, w.id), data).then(function () { return w; });
    });
    Promise.allSettled(ops).then(function (results) {
      pushing = false;
      var ok = [];
      results.forEach(function (r) { if (r.status === "fulfilled") ok.push(r.value); });
      if (!ok.length) { pushBlockedUntil = Date.now() + 15000; return; }
      ok.forEach(function (w) {
        if (w.kind === "fire") {
          var wasDefect = mirror.fire && norm(mirror.fire.status) === "תקול";
          mirror.fire = { status: norm(w.fields.status), fault: norm(w.fields.fault), note: norm(w.fields.note), by: norm(w.fields.by), atMs: null };
          if (!wasDefect && norm(w.fields.status) === "תקול") {
            // fire system just became defective → alert the admin
            fsSdk.addDoc(fsSdk.collection(db, COL_ALERTS), {
              type: "fire_defect",
              title: "מערכת כיבוי האש סומנה כתקולה",
              body: [norm(w.fields.fault), norm(w.fields.note)].filter(Boolean).join(" — "),
              by: norm(w.fields.by),
              at: nowISO()
            }).catch(function () {});
          }
        } else if (w.kind === "veh") {
          mirror.vehicles[w.name] = { faulty: !!w.fields.faulty, where: norm(w.fields.where), whereText: norm(w.fields.whereText), note: norm(w.fields.note), by: norm(w.fields.by), atMs: null };
        } else {
          mirror.timeline[w.name] = { entries: w.entries, atMs: null };
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
      b.textContent = "🔔 הפעל תראות";
      b.title = "קבל התראה כאשר מערכת כיבוי האש סומנה כתקולה — גם כשהאפליקציה סגורה";
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

  /* ---------- sync status badge (so you can SEE whether sync is on) ---------- */
  function setSyncBadge(state) {
    try {
      var el = document.getElementById("syncBadge");
      if (!el) {
        el = document.createElement("div");
        el.id = "syncBadge";
        el.style.cssText = "position:fixed;bottom:16px;inset-inline-start:16px;z-index:99998;" +
          "padding:4px 10px;border-radius:999px;font:inherit;font-size:12px;color:#fff;" +
          "background:#6b7a72;opacity:.9;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:default";
        (document.body || document.documentElement).appendChild(el);
      }
      var map = {
        ok:  { c: "#1e7a45", t: "סנכרון: תקין" },
        off: { c: "#6b7a72", t: "סנכרון: כבוי" },
        err: { c: "#b3372f", t: "סנכרון: שגיאה" }
      };
      var s = map[state] || map.off;
      el.style.background = s.c;
      el.textContent = s.t;
      el.title = "Live sync status across devices (Firebase) — green = active";
    } catch (e) {}
  }

  /* ---------- optional: after photo scan, ask about the fire system ---------- */
  function showFirePrompt() {
    try {
      if (document.getElementById("syncFirePrompt")) return;
      var overlay = document.createElement("div");
      overlay.id = "syncFirePrompt";
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;" +
        "display:flex;align-items:center;justify-content:center;padding:20px";
      var card = document.createElement("div");
      card.style.cssText = "background:#fff;color:#1d2b24;border-radius:16px;padding:20px;max-width:380px;" +
        "width:100%;box-shadow:0 10px 40px rgba(0,0,0,.4);text-align:center;font-family:inherit";
      card.innerHTML =
        '<div style="font-size:15px;font-weight:700;margin-bottom:6px">🔥 מערכת כיבוי האש סומנה כתקולה</div>' +
        '<div style="color:#6b7a72;margin-bottom:16px">המא בוצע?</div>' +
        '<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
        '<button type="button" data-yes style="font:inherit;cursor:pointer;border:0;border-radius:9px;padding:8px 16px;background:#2f6d4e;color:#fff">✔️ כן</button>' +
        '<button type="button" data-no style="font:inherit;cursor:pointer;border:1px solid #cfd8d2;border-radius:9px;padding:8px 16px;background:#fff;color:#1d2b24">❌ לא</button>' +
        '</div>';
      overlay.appendChild(card);
      overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.remove(); });
      card.querySelector("[data-yes]").addEventListener("click", function () {
        overlay.remove();
        var ok = window.__magSync.setFireStatus("בוצע", "", "");
        if (ok) toast("✅ מערכת כיבוי האש תוקנה");
      });
      card.querySelector("[data-no]").addEventListener("click", function () { overlay.remove(); });
      (document.body || document.documentElement).appendChild(overlay);
    } catch (e) {}
  }

  function maybeAskFireAfterScan() {
    if (!OPTS.askFireAfterScan) return;
    var mirror = readJSON(K_MIRROR, null);
    var fire = mirror && mirror.fire;
    if (!fire || norm(fire.status) !== "תקול") return;
    showFirePrompt();
  }

  function watchScanCompletion() {
    var card = document.getElementById("reviewCard");
    if (!card) { setTimeout(watchScanCompletion, 3000); return; } // retry until the app markup exists
    if (typeof MutationObserver !== "function") return;
    var visible = card.style.display !== "none";
    var check = function () {
      var nowVisible = card.style.display !== "none";
      if (nowVisible && !visible) { visible = true; maybeAskFireAfterScan(); }
      else if (!nowVisible) { visible = false; }
    };
    check();
    new MutationObserver(check).observe(card, { attributes: true, attributeFilter: ["style", "hidden", "class"] });
  }

  /* ---------- init ---------- */
  function start() {
    fsSdk.onSnapshot(
      fsSdk.query(fsSdk.collection(db, COL_STATUS)),
      handleSnapshot,
      function (e) { listenerFailed = true; setSyncBadge("err"); console.warn("[sync] listener error", e); }
    );
    fsSdk.onSnapshot(
      fsSdk.query(fsSdk.collection(db, COL_TIMELINE)),
      handleTimelineSnapshot,
      function (e) { console.warn("[sync] timeline listener error", e); }
    );
    setInterval(poll, POLL_MS);
    listenSwMessages();
    watchScanCompletion();
    if (msgSdk) setupPush();
    // safety net: if the listener never fires (SDK/config problem), still push local state
    setTimeout(function () {
      if (!bootstrapped && listenerFailed) {
        bootstrapped = true;
        if (!readJSON(K_MIRROR, null)) writeJSON(K_MIRROR, { vehicles: {}, fire: null, timeline: {} });
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

  function boot() {
    setTimeout(function () {
      loadAndStart().catch(function (e) {
        console.warn("[sync] could not start (offline?) — the app still works normally.", e);
        setSyncBadge("err");
      });
    }, 0);
  }
  // run as soon as the DOM is ready (this script sits at the end of <body>)
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // debug/test handle
  window.__magSync = {
    extract: extract,
    applyVehicleTo: applyVehicleTo,
    applyFireTo: applyFireTo,
    norm: norm,
    vehDocId: vehDocId,
    atMillis: atMillis,
    poll: poll,
    getSharedFire: function () { var m = readJSON(K_MIRROR, null); return m ? m.fire : null; },
    setFireStatus: function (status, fault, note) {
      var st = liveState();
      var t = st && firstFireTask(st);
      if (!t) return false;
      t.status = norm(status) || "";
      t.fault = norm(fault) || "";
      if (note != null) t.note = norm(note) || "";
      refreshUI();
      return true;
    }
  };
})();
