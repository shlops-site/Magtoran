/* =========================================================================
   firebase-config.js — YOUR Firebase project config (mag-toran)
   -------------------------------------------------------------------------
   This file is public by design (every Firebase web app ships its config to
   the browser). Security is enforced by Firestore rules, not by hiding this.

   STILL TODO: replace window.VAPID_KEY below with your "Web Push certificate"
   key — Firebase console → Cloud Messaging → Web configuration →
   Web Push certificates → Generate key pair. (Needed only for push
   notifications; everything else works without it.)
   ========================================================================= */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyA1waMyxTqKNvZqNlGz2CgFIzk6zVzAhEE",
  authDomain: "mag-toran.firebaseapp.com",
  projectId: "mag-toran",
  storageBucket: "mag-toran.firebasestorage.app",
  messagingSenderId: "286223527702",
  appId: "1:286223527702:web:056f408ade25d973ce6a37"
};

/* Web Push certificate (VAPID) — Firebase console → Cloud Messaging →
   Web configuration → Web Push certificates → Generate key pair. */
window.VAPID_KEY = "REPLACE-ME-WITH-YOUR-VAPID-KEY";
