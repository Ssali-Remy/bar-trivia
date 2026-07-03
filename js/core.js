/* =============================================================
   TAMADUNI TRIVIA — SHARED CORE
   Firebase bootstrap + helpers used by all three interfaces.
   Load order on every page:
     firebase-app-compat.js -> firebase-firestore-compat.js
     -> config.js -> questions.js -> core.js -> <role>.js
   ============================================================= */

firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.firestore();

// Firestore handles: one game doc, a teams subcollection, a DQ event log.
const gameRef   = db.collection("games").doc(GAME_ID);
const teamsRef  = gameRef.collection("teams");
const dqLogRef  = gameRef.collection("dq_events");
const FV        = firebase.firestore.FieldValue;

/* ---------- question helpers -------------------------------- */

// Unique key for a question, e.g. "r2q7" — used to guard against
// double-scoring and stale answers from a previous question.
const qKey = (round, q) => `r${round}q${q}`;

const getQuestion = (round, q) => ROUNDS[round]?.questions[q] ?? null;
const CHOICE_LETTERS = ["A", "B", "C", "D"];

/* ---------- timer math --------------------------------------- */
// The QM writes a server timestamp when a question starts; every
// device derives the countdown from it locally. Pauses accumulate
// into `pausedMs` so the clock survives pause/resume.

function elapsedMs(g) {
  if (!g || !g.questionStartAt) return 0;
  const start  = g.questionStartAt.toMillis();
  const paused = g.pausedMs || 0;
  const now    = (g.paused && g.pauseStartedAt) ? g.pauseStartedAt.toMillis() : Date.now();
  return Math.max(0, now - start - paused);
}

function remainingSecs(g, totalSecs = QUESTION_SECONDS) {
  return Math.max(0, Math.ceil(totalSecs - elapsedMs(g) / 1000));
}

/* ---------- scoring ------------------------------------------ */

function speedBonus(ms) {
  for (const [maxMs, bonus] of SPEED_TIERS) if (ms <= maxMs) return bonus;
  return 0;
}

// Pure scoring function — given a team's answer record and the
// question, return {points, correct}. Double Down doubles a win
// and turns a loss into -BASE_POINTS.
function scoreAnswer(answer, question) {
  const correct = answer.choice === question.correct;
  if (!correct) return { correct, points: answer.dd ? -BASE_POINTS : 0 };
  const pts = BASE_POINTS + speedBonus(answer.elapsedMs || QUESTION_SECONDS * 1000);
  return { correct, points: answer.dd ? pts * 2 : pts };
}

/* ---------- misc UI helpers ---------------------------------- */

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(ts) {
  if (!ts || !ts.toDate) return "—";
  return ts.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Sort teams for leaderboards: score desc, then name for stability.
function sortTeams(teams) {
  return [...teams].sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
}

const $ = (sel, root = document) => root.querySelector(sel);
