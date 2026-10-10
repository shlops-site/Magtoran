/* Service Worker — שומר את האפליקציה במכשיר כדי שתעבוד גם בלי אינטרנט */
/* שים לב: שם המטמון מוחלף אוטומטית ע"י tools/publish.sh לפי תוכן index.html,
   כדי שכל גרסה חדשה תוריד את עצמה מחדש ולא תיתקע על העתק ישן. */
const CACHE = "mag-toran-sync-v2";
const ASSETS = ["./", "./index.html", "./admin.html", "./manifest.json",
                "./sync.js", "./firebase-config.js",
                "./icon-180.png", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];

/* התקנה עמידה: כל נכס נשמר בנפרד, וכשל של קובץ בודד (למשל אייקון חסר)
   לא מפיל את כל מצב אופליין — האפליקציה עצמה תמיד תישמר */
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(ASSETS.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

/* cache-first: מהמכשיר קודם, ואם אין — מהרשת (ונשמר להמשך) */
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  /* בדיקת העדכון העצמי חייבת להגיע לרשת — לא מהמטמון */
  try { if (new URL(e.request.url).searchParams.has("_fresh")) return; } catch (err) {}
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        const copy = res.clone();
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match("./index.html"));
    })
  );
});


/* ---------- push notifications ----------
   The SW shows the notification even when the app is closed. The message
   arrives as a data message from the Cloud Function (see SETUP.md) -
   no Firebase SDK is needed inside the SW.
   If a window is open and visible, we postMessage the page instead,
   so it can show an in-app toast. */
self.addEventListener("push", e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = {}; }
  if (!data || typeof data !== "object") data = {};
  const payload = {
    title: data.title || "צ׳ק ליסט מ״ג תורן",
    body: data.body || "",
    url: data.url || "./index.html",
    tag: data.tag || "duty-alert"
  };
  e.waitUntil((async () => {
    const list = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const visible = list.find(c => c.visibilityState === "visible");
    if (visible) {
      /* app is open - let the page show a toast instead of a system notification */
      visible.postMessage({ type: "magSyncPush", data: payload });
    } else {
      await self.registration.showNotification(payload.title, {
        body: payload.body,
        icon: "./icon-192.png",
        badge: "./icon-192.png",
        tag: payload.tag,
        renotify: true,
        data: { url: payload.url }
      });
    }
  })());
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./index.html";
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      return clients.openWindow(url);
    })
  );
});
