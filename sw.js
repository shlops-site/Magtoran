/* Service Worker — שומר את האפליקציה במכשיר כדי שתעבוד גם בלי אינטרנט */
/* שים לב: שם המטמון מוחלף אוטומטית ע"י tools/publish.sh לפי תוכן index.html,
   כדי שכל גרסה חדשה תוריד את עצמה מחדש ולא תיתקע על העתק ישן. */
const CACHE = "mag-toran-4ed171571f";
const ASSETS = ["./", "./index.html", "./manifest.json",
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
