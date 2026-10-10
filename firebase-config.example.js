/* =========================================================================
   firebase-config.example.js  →  copy this file to  firebase-config.js
   -------------------------------------------------------------------------
   Put your Firebase web app config here (it is public by design — every
   Firebase web app ships its config to the browser; security is enforced
   by Firestore rules, not by hiding this).

   How to get these values: see SETUP.md (step 2).
   ========================================================================= */
window.FIREBASE_CONFIG = {
  apiKey: "AIza...-REPLACE-ME",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef1234567890"
};

/* VAPID key ("Web Push certificate") — Firebase console → Cloud Messaging
   → Web configuration → Web Push certificates. Needed only for push
   notifications (admin alerts when the app is closed). */
window.VAPID_KEY = "REPLACE-ME";

/* Optional features (see SETUP.md):
   - askFireAfterScan: after scanning the roster photo, if the shared
     fire-system status is defective, the app asks "is it back in business?"
     and lets the user mark it fixed for everyone. Default: false (off). */
window.SYNC_OPTIONS = { askFireAfterScan: false };
