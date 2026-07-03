# 🍻 TAMADUNI TRIVIA — Bar Quiz Night

A real-time, multi-device trivia app built for **Tamaduni Hub**. Pure static frontend
(GitHub Pages) + Firebase Firestore free tier for real-time sync. No server, no build step.

Theme is sampled straight from the Tamaduni Hub logo: gold `#FDC733` on black `#060709`,
warm cream ink `#FFF8E7`, with green/red kept for correct/wrong and success/danger states.

| Interface | URL | Purpose |
|---|---|---|
| 🎙️ Quiz Master | `master.html` (or `?role=master`) | Control room: start/pause, advance, reveal & score, DQ log, score overrides |
| 📺 Big Screen | `display.html` (or `?role=display`) | Projector view: giant join-QR, countdown, questions, animated leaderboard |
| 🍻 Players | `play.html` (or `?role=play`) | Phones: register team, 4 big answer buttons, Double Down, lockouts |

---

## 1 · Firebase Setup (≈5 minutes)

### 1.1 Create the project
1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project** (any name, Analytics off is fine).
2. In the project: **Build → Firestore Database → Create database** → choose a region → **Start in production mode**.

### 1.2 Security rules
Firestore → **Rules** tab → paste and publish:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Open access to the game tree only. This is a casual pub game:
    // players are anonymous and the QM PIN is a social gate, not a
    // security boundary. Nothing sensitive is ever stored here.
    match /games/{gameId} {
      allow read, write: if true;
      match /{document=**} {
        allow read, write: if true;
      }
    }
  }
}
```

> **Trust model:** anyone with the URL can technically write to the game.
> For a bar quiz that's acceptable — the QM can fix any score in two taps.
> If you want to harden it later: enable Anonymous Auth, change `if true`
> to `if request.auth != null`, and add `firebase-auth-compat.js` +
> `firebase.auth().signInAnonymously()` to `js/core.js`.

### 1.3 Get your web config
1. Project settings (⚙️) → **Your apps** → **`</>` Web app** → register (no hosting needed).
2. Copy the `firebaseConfig` object into **`js/config.js`** (replace the placeholder).
3. While in `config.js`, change **`QM_PIN`** from the default.

### 1.4 Database schema (created automatically — nothing to do)
The app creates everything on first use. For reference:

```
games/live                          ← single game document (the whole game state)
  status: "lobby" | "question" | "locked" | "reveal" |
          "leaderboard" | "sudden_death" | "finished"
  round: 0-4          q: 0-9
  questionStartAt: <server timestamp>   ← all devices derive the countdown from this
  paused: bool   pauseStartedAt: ts   pausedMs: number   ← pause accumulator
  scored: "r2q7"                      ← double-scoring guard
  sdTeamIds: [ids]   sdWinnerId   sdWinnerName

games/live/teams/{teamId}           ← one doc per team
  name, score, streak, status: "active" | "locked" | "disqualified"
  ddUsed: { r0: true, ... }           ← Double Down burned per round
  answer: { key:"r2q7", choice:0-3, dd:bool, elapsedMs, at }
  lastResult: { key, answered, correct, points, dd }
  dqAt, dqReason, dqCount, finalRank, sdAnswer, sdAt, joinedAt

games/live/dq_events/{autoId}       ← Disqualification Alert Log
  teamId, teamName, reason, at
```

Questions live in **`js/questions.js`** as static data (50 witty questions across
5 themed rounds + the hidden Sudden Death tiebreaker). Edit that file to change content —
the engine only cares about the data shape.

---

## 2 · Deploy to GitHub Pages (≈2 minutes)

```bash
git init
git add .
git commit -m "Neon Trivia bar quiz"
git branch -M main
git remote add origin https://github.com/YOUR_USER/bar-trivia.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / root → Save.**

Your URLs (print these as QR codes, or just project the display page — it renders
the player QR automatically):

- `https://YOUR_USER.github.io/bar-trivia/master.html` ← keep this one to yourself
- `https://YOUR_USER.github.io/bar-trivia/display.html` ← on the projector
- `https://YOUR_USER.github.io/bar-trivia/play.html` ← players (embedded in the big-screen QR)

---

## 3 · Running a Quiz Night

1. Open **display.html** on the bar screen — it shows the join QR and live roster.
2. Open **master.html** on your phone/laptop, enter the PIN.
3. Teams scan, register a name, appear in the lobby.
4. **▶ START GAME** → 30-second countdown runs everywhere simultaneously.
5. When time expires the question auto-locks. Hit **👁 REVEAL & SCORE** for the
   dramatic reveal (scores base 10 + speed bonus, applies Double Downs), then **⏭ NEXT**.
6. After Q10 the animated leaderboard shows; **⏭ START ROUND N** continues.
7. After Round 5 → **🏁 FINISH**. If the top is tied you'll get a tie alert —
   hit **⚡ SUDDEN DEATH** (closest numeric guess wins).
8. **🗑 RESET** wipes teams/scores for the next night.

### Scoring
| Event | Points |
|---|---|
| Correct answer | +10 |
| …in under 5 s / 10 s / 15 s | +5 / +3 / +1 bonus |
| Correct **with Double Down** 🎲 | ×2 (bonus included) |
| Wrong with Double Down | **−10** |
| Wrong / no answer | 0 |
| 3+ correct streak | 🔥 flame on the leaderboard |

### Anti-cheat
The player page arms the **Page Visibility API + blur/focus listeners** during
live questions. Switching tabs, opening another app, or locking the phone
instantly writes `status: "disqualified"`, logs the incident to the
**Disqualification Alert Log** on the QM dashboard, and slams a red lockout
screen on the player's phone. The **✔ RE-ADMIT** button (in the log or on the
roster card) restores them. Tune which phases are armed via
`ANTI_CHEAT_PHASES` in `js/config.js`.

---

## 4 · File Map

```
bar-trivia/
├── index.html        landing page + ?role= router
├── master.html       QM dashboard shell
├── display.html      big-screen shell
├── play.html         player shell
├── css/theme.css     neon cyber-pub theme + all animations
└── js/
    ├── config.js     🔧 Firebase config + game tuning (EDIT THIS)
    ├── questions.js  question bank (5 rounds + sudden death)
    ├── core.js       Firebase bootstrap, timer math, scoring, helpers
    ├── master.js     QM logic: state machine, scoring batch, overrides
    ├── display.js    projector logic: QR, FLIP leaderboard animation
    └── play.js       player logic: answers, Double Down, anti-cheat
```

**Free-tier headroom:** a 20-team, 50-question night generates roughly a few
thousand Firestore reads/writes — far under the daily free quota (50k reads / 20k writes).
