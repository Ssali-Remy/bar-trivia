/* =============================================================
   TAMADUNI TRIVIA — PLAYER / TEAM INTERFACE
   Mobile-first. Registers a team, renders questions with 4 big
   tap targets, enforces the anti-cheat lockout, and mirrors the
   game state driven by the Quiz Master in real time.
   ============================================================= */

(() => {
  "use strict";

  /* ---------- local team identity ---------------------------- */
  // The team lives in localStorage so a page refresh (or a re-scan
  // of the QR after re-admission) picks the same team back up.
  // ?team=<id> lets the QM hand a team a rejoin link for a new phone.
  const LS_KEY = "bt_team_id";
  const urlTeam = new URLSearchParams(location.search).get("team");
  if (urlTeam) localStorage.setItem(LS_KEY, urlTeam);
  let teamId  = localStorage.getItem(LS_KEY);
  let game    = null;   // latest game doc
  let team    = null;   // latest own team doc
  let picked  = null;   // locally picked choice for instant UI feedback
  let dqFiredForKey = null; // avoid duplicate DQ writes per incident

  const views = ["register", "lobby", "question", "answered", "result", "sd", "over", "locked", "dq"];
  function show(name) {
    views.forEach(v => $("#view-" + v).classList.toggle("hidden", v !== name));
  }

  /* ============================================================
     ANTI-CHEAT — Page Visibility API + blur/focus
     Leaving the app during an armed phase = instant DQ.
     ============================================================ */

  function antiCheatArmed() {
    return teamId && team && team.status === "active" &&
           game && ANTI_CHEAT_PHASES.includes(game.status);
  }

  function disqualify(reason) {
    if (!antiCheatArmed()) return;
    const incident = qKey(game.round ?? 0, game.q ?? 0) + ":" + reason;
    if (dqFiredForKey === incident) return;
    dqFiredForKey = incident;

    // Lock the local UI immediately — don't wait for the network.
    show("dq");

    // Fire-and-forget writes; Firestore queues them even if the tab
    // is being backgrounded, and flushes as soon as it can.
    teamsRef.doc(teamId).update({
      status: "disqualified",
      dqAt: FV.serverTimestamp(),
      dqReason: reason,
      dqCount: FV.increment(1),
    }).catch(() => {});
    dqLogRef.add({
      teamId, teamName: team.name, reason,
      at: FV.serverTimestamp(),
    }).catch(() => {});
  }

  // Primary detector: tab hidden / app switched / phone locked.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") disqualify("Left the app (tab hidden / phone locked)");
  });

  // Secondary detector: window lost focus but page still "visible"
  // (e.g. split screen, another window on desktop). Small delay so
  // taps on selects/inputs don't false-positive.
  window.addEventListener("blur", () => {
    setTimeout(() => {
      if (!document.hasFocus() && document.visibilityState === "visible") {
        disqualify("Window lost focus (app switch / split screen)");
      }
    }, 400);
  });

  // Catch outright navigation away / browser close.
  window.addEventListener("pagehide", () => disqualify("Closed or navigated away"));

  /* ============================================================
     REGISTRATION
     ============================================================ */

  $("#btn-join").addEventListener("click", async () => {
    const name = $("#team-name-input").value.trim();
    const err = $("#register-error");
    err.classList.add("hidden");
    if (name.length < 2) {
      err.textContent = "Team name needs at least 2 characters.";
      err.classList.remove("hidden");
      return;
    }
    try {
      // Reject duplicate names so the leaderboard stays readable.
      const clash = await teamsRef.where("name", "==", name).get();
      if (!clash.empty) {
        err.textContent = "That name's taken — be more original. 🍺";
        err.classList.remove("hidden");
        return;
      }
      const doc = await teamsRef.add({
        name, score: 0, streak: 0, status: "active",
        ddUsed: {}, joinedAt: FV.serverTimestamp(),
      });
      teamId = doc.id;
      localStorage.setItem(LS_KEY, teamId);
      subscribeTeam();
    } catch (e) {
      err.textContent = "Couldn't join — check your connection.";
      err.classList.remove("hidden");
    }
  });

  /* ============================================================
     ANSWER SUBMISSION
     ============================================================ */

  function renderAnswerButtons(question, key) {
    const wrap = $("#answers");
    wrap.innerHTML = "";
    question.options.forEach((opt, i) => {
      const btn = document.createElement("button");
      btn.className = "answer-btn p-5 text-left flex items-center gap-4";
      btn.innerHTML =
        `<span class="text-2xl font-black neon-blue">${CHOICE_LETTERS[i]}</span>
         <span class="text-lg font-bold">${escapeHtml(opt)}</span>`;
      btn.addEventListener("click", () => submitAnswer(i, key));
      wrap.appendChild(btn);
    });
  }

  async function submitAnswer(choice, key) {
    if (!game || game.status !== "question") return;
    const elapsed = elapsedMs(game);
    if (elapsed >= QUESTION_SECONDS * 1000) return;              // too late
    if (team?.answer?.key === key) return;                        // already answered
    if (team?.status !== "active") return;

    const dd = $("#dd-check").checked;
    picked = choice;

    // Instant local feedback, then persist.
    [...$("#answers").children].forEach((b, i) => {
      b.disabled = true;
      if (i === choice) b.classList.add("picked");
    });

    const update = {
      answer: { key, choice, dd, elapsedMs: elapsed, at: FV.serverTimestamp() },
    };
    if (dd) update[`ddUsed.r${game.round}`] = true;              // burn the round's Double Down
    await teamsRef.doc(teamId).update(update).catch(() => {});
  }

  /* ============================================================
     SUDDEN DEATH SUBMISSION
     ============================================================ */

  $("#btn-sd-submit").addEventListener("click", async () => {
    const val = parseFloat($("#sd-input").value);
    if (Number.isNaN(val)) return;
    await teamsRef.doc(teamId).update({
      sdAnswer: val, sdAt: FV.serverTimestamp(),
    }).catch(() => {});
    $("#sd-input").disabled = true;
    $("#btn-sd-submit").disabled = true;
    $("#sd-done").classList.remove("hidden");
  });

  /* ============================================================
     RENDER LOOP — react to game + team snapshots
     ============================================================ */

  let renderedKey = null; // which question the answer buttons belong to

  function render() {
    if (!teamId) { show("register"); return; }
    if (!team || !game) return; // still loading snapshots

    // Hard lockouts win over everything else.
    if (team.status === "disqualified") { show("dq"); return; }
    if (team.status === "locked")       { show("locked"); return; }
    dqFiredForKey = null; // re-admitted / active again

    const key = qKey(game.round ?? 0, game.q ?? 0);
    const answeredThis = team.answer?.key === key;

    switch (game.status) {
      case "lobby":
        lobby(`Waiting for the Quiz Master to start the mayhem…`);
        break;

      case "question": {
        if (answeredThis || remainingSecs(game) <= 0) { answeredView(answeredThis, key); break; }
        const question = getQuestion(game.round, game.q);
        if (!question) break;
        if (renderedKey !== key) {           // fresh question — rebuild buttons
          renderedKey = key;
          picked = null;
          renderAnswerButtons(question, key);
          $("#q-text").textContent = question.text;
          $("#q-meta").textContent = `${ROUNDS[game.round].title} · Q${game.q + 1}/${QUESTIONS_PER_ROUND}`;
          const ddSpent = !!team.ddUsed?.[`r${game.round}`];
          $("#dd-check").checked = false;
          $("#dd-check").disabled = ddSpent;
          $("#dd-wrap").style.opacity = ddSpent ? .4 : 1;
        }
        show("question");
        break;
      }

      case "locked":
        answeredView(answeredThis, key);
        break;

      case "reveal": {
        const r = team.lastResult;
        if (r && r.key === key && r.answered) {
          $("#result-emoji").textContent = r.correct ? "🎉" : "💀";
          $("#result-title").textContent = r.correct ? "CORRECT!" : "WRONG!";
          $("#result-title").className = "text-4xl font-black mb-2 " + (r.correct ? "neon-green anim-pop" : "neon-red anim-shake");
          $("#result-points").textContent = `${r.points >= 0 ? "+" : ""}${r.points} points` + (r.dd ? " (DOUBLE DOWN!)" : "");
          $("#result-streak").textContent = (team.streak >= 3) ? `🔥 ${team.streak} IN A ROW — ON FIRE!` : "";
        } else {
          $("#result-emoji").textContent = "😴";
          $("#result-title").textContent = "NO ANSWER";
          $("#result-title").className = "text-4xl font-black mb-2 neon-gold";
          $("#result-points").textContent = "0 points — too busy drinking?";
          $("#result-streak").textContent = "";
        }
        $("#result-score").textContent = team.score;
        show("result");
        break;
      }

      case "leaderboard":
        lobby(`Round over! Check the big screen for the damage. Your score: ${team.score}`);
        break;

      case "sudden_death": {
        const inSd = (game.sdTeamIds || []).includes(teamId);
        if (!inSd) { lobby("SUDDEN DEATH in progress — watch the big screen! 🍿"); break; }
        $("#sd-text").textContent = SUDDEN_DEATH.text;
        show("sd");
        break;
      }

      case "finished": {
        $("#over-score").textContent = team.score;
        $("#over-rank").textContent = team.finalRank ? ordinal(team.finalRank) : "—";
        show("over");
        break;
      }

      default:
        lobby("Hang tight…");
    }
  }

  function lobby(msg) {
    $("#lobby-team-name").textContent = team.name;
    $("#lobby-msg").textContent = msg;
    show("lobby");
  }

  function answeredView(answered, key) {
    $("#answered-detail").innerHTML = answered
      ? `You picked <span class="neon-pink">${CHOICE_LETTERS[team.answer.choice]}</span>` +
        (team.answer.dd ? ` <span class="neon-gold">· 🎲 DOUBLED DOWN</span>` : "")
      : `<span class="neon-red">Time's up — no answer this round.</span>`;
    show("answered");
  }

  const ordinal = n => n + (["th","st","nd","rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || "th");

  /* ---------- countdown ticker -------------------------------- */
  setInterval(() => {
    if (!game || game.status !== "question") return;
    const s = remainingSecs(game);
    const el = $("#q-timer");
    el.textContent = s;
    el.classList.toggle("timer-danger", s <= 10);
    if (s <= 0) render(); // flips to the locked/answered view
  }, 250);

  /* ---------- Firestore subscriptions ------------------------- */

  gameRef.onSnapshot(snap => {
    game = snap.exists ? snap.data() : null;
    if (!game) { game = { status: "lobby" }; }
    render();
  });

  function subscribeTeam() {
    teamsRef.doc(teamId).onSnapshot(snap => {
      if (!snap.exists) {
        // Team was wiped (game reset) — back to registration.
        localStorage.removeItem(LS_KEY);
        teamId = null; team = null;
        show("register");
        return;
      }
      team = { id: snap.id, ...snap.data() };
      render();
    });
  }

  if (teamId) subscribeTeam(); else show("register");
})();
