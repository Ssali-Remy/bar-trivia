/* =============================================================
   BAR TRIVIA — GLOBAL CONFIG
   1. Create a Firebase project (see README.md).
   2. Paste your web-app config object below.
   3. Deploy to GitHub Pages. Done.
   ============================================================= */

// ---- PASTE YOUR FIREBASE CONFIG HERE -------------------------
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDaroIv1ur9aVTgoFsDWaIcMYmE2jHDSoM",
  authDomain:        "bar-trivia-a01fc.firebaseapp.com",
  projectId:         "bar-trivia-a01fc",
  storageBucket:     "bar-trivia-a01fc.firebasestorage.app",
  messagingSenderId: "747330478531",
  appId:             "1:747330478531:web:fcd35c702c7a0a6cab1d76"
};

// ---- GAME TUNING ---------------------------------------------
const GAME_ID          = "live";   // one document = one running pub quiz
const QM_PIN           = "4712";   // Quiz Master PIN (casual gate, not bank-grade security)
const QUESTION_SECONDS = 30;       // strict per-question countdown
const SD_SECONDS       = 60;       // sudden-death answer window
const BASE_POINTS      = 10;       // points for a correct answer

// Speed bonus tiers: answer faster => more points on top of BASE_POINTS.
// [maxElapsedMs, bonusPoints] — first matching tier wins.
const SPEED_TIERS = [
  [5000,  5],   // under 5s  : +5
  [10000, 3],   // under 10s : +3
  [15000, 1],   // under 15s : +1
];

// Anti-cheat is armed during these game phases. 'question' and 'locked'
// are the strict minimum; add 'reveal' / 'leaderboard' to punish
// tab-swapping between questions too.
const ANTI_CHEAT_PHASES = ["question", "locked"];
