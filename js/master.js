/* =============================================================
   BAR TRIVIA — QUIZ MASTER DASHBOARD
   The single source of authority: starts/pauses the game,
   advances questions, reveals + scores answers, manages teams
   (lock / re-admit / score overrides), and runs Sudden Death.
   ============================================================= */

(() => {
  "use strict";

  let game = null;
  let teams = [];
  let autoLockedKey = null; // guard: auto-lock each question only once

  /* ============================================================
     PIN GATE (casual security — see README for the trust model)
     ============================================================ */

  function unlock() {
    $("#view-pin").classList.add("hidden");
    $("#view-dash").classList.remove("hidden");
    subscribe();
  }

  if (sessionStorage.getItem("bt_qm") === "1") unlock();
  else $("#view-pin").classList.remove("hidden");

  $("#btn-pin").addEventListener("click", () => {
    if ($("#pin-input").value === QM_PIN) {
      sessionStorage.setItem("bt_qm", "1");
      unlock();
    } else {
      $("#pin-error").classList.remove("hidden");
    }
  });

  /* ============================================================
     GAME FLOW ACTIONS
     ============================================================ */

  const freshQuestionFields = () => ({
    questionStartAt: FV.serverTimestamp(),
    paused: false, pauseStartedAt: null, pausedMs: 0,
  });

  // ▶ START — creates/overwrites the game doc and fires question 1.
  $("#btn-start").addEventListener("click", async () => {
    if (game && game.status !== "lobby" &&
        !confirm("Game already in progress. Restart from Round 1, Question 1? (Scores are kept)")) return;
    await gameRef.set({
      status: "question", round: 0, q: 0, scored: null,
      sdTeamIds: [], sdWinnerId: null, sdWinnerName: null,
      createdAt: FV.serverTimestamp(),
      ...freshQuestionFields(),
    }, { merge: true });
  });

  // ⏸ / ⏵ — pause math lives in core.js (pausedMs accumulator).
  $("#btn-pause").addEventListener("click", () =>
    gameRef.update({ paused: true, pauseStartedAt: FV.serverTimestamp() }));

  $("#btn-resume").addEventListener("click", () => {
    if (!game?.pauseStartedAt) return;
    gameRef.update({
      paused: false, pauseStartedAt: null,
      pausedMs: FV.increment(Date.now() - game.pauseStartedAt.toMillis()),
    });
  });

  /* 👁 REVEAL & SCORE — the scoring moment. Reads every team,
     applies base + speed bonus + double-down math, updates scores
     and streaks in one batch. Guarded against double-scoring. */
  $("#btn-reveal").addEventListener("click", async () => {
    if (!game || !["question", "locked"].includes(game.status)) return;
    const key = qKey(game.round, game.q);
    const question = getQuestion(game.round, game.q);

    if (game.scored === key) {                 // already scored — just re-show
      await gameRef.update({ status: "reveal" });
      return;
    }

    const snap = await teamsRef.get();
    const batch = db.batch();
    snap.forEach(doc => {
      const t = doc.data();
      const a = t.answer;
      let result = { key, answered: false, correct: false, points: 0, dd: false };
      let streak = 0;

      if (t.status === "active" && a && a.key === key &&
          a.elapsedMs <= QUESTION_SECONDS * 1000 + 500) { // reject late-clock answers
        const { correct, points } = scoreAnswer(a, question);
        result = { key, answered: true, correct, points, dd: !!a.dd };
        streak = correct ? (t.streak || 0) + 1 : 0;
      }
      batch.update(doc.ref, {
        score: FV.increment(result.points),
        streak,
        lastResult: result,
      });
    });
    batch.update(gameRef, { status: "reveal", scored: key });
    await batch.commit();
  });

  /* ⏭ NEXT — advances q -> leaderboard -> next round -> finished. */
  $("#btn-next").addEventListener("click", async () => {
    if (!game) return;

    if (game.status === "leaderboard") {              // leaderboard -> next round
      await gameRef.update({
        status: "question", round: game.round + 1, q: 0, ...freshQuestionFields(),
      });
      return;
    }

    if (!["reveal", "locked", "question"].includes(game.status)) return;
    if (game.scored !== qKey(game.round, game.q) &&
        !confirm("This question hasn't been scored (Reveal & Score). Skip it anyway?")) return;

    if (game.q < QUESTIONS_PER_ROUND - 1) {           // next question in round
      await gameRef.update({ status: "question", q: game.q + 1, ...freshQuestionFields() });
    } else if (game.round < TOTAL_ROUNDS - 1) {       // round complete -> leaderboard
      await gameRef.update({ status: "leaderboard" });
    } else {                                          // final round done -> finish
      await finishGame();
    }
  });

  // Writes final ranks onto each team, flags a top-score tie.
  async function finishGame() {
    const sorted = sortTeams(teams.filter(t => t.status !== "disqualified"));
    const batch = db.batch();
    sortTeams(teams).forEach(t => {
      const rank = sorted.findIndex(s => s.id === t.id) + 1;
      batch.update(teamsRef.doc(t.id), { finalRank: rank || sorted.length + 1 });
    });
    batch.update(gameRef, { status: "finished" });
    await batch.commit();

    const tied = sorted.filter(t => sorted[0] && t.score === sorted[0].score);
    if (tied.length > 1) {
      alert(`TIE ALERT: ${tied.map(t => t.name).join(" & ")} are level on ${tied[0].score} pts.\nHit ⚡ SUDDEN DEATH to settle it.`);
    }
  }

  /* ⚡ SUDDEN DEATH — hidden round 6, numeric, closest wins. */
  $("#btn-sd").addEventListener("click", async () => {
    const sorted = sortTeams(teams.filter(t => t.status !== "disqualified"));
    if (!sorted.length) return;
    const tied = sorted.filter(t => t.score === sorted[0].score);
    const ids = (tied.length > 1 ? tied : sorted.slice(0, 2)).map(t => t.id); // fallback: top 2
    if (!confirm(`Send ${ids.length} team(s) into Sudden Death?`)) return;

    const batch = db.batch();
    ids.forEach(id => batch.update(teamsRef.doc(id), { sdAnswer: FV.delete(), sdAt: FV.delete() }));
    batch.set(gameRef, {
      status: "sudden_death", sdTeamIds: ids, ...freshQuestionFields(),
    }, { merge: true });
    await batch.commit();
  });

  $("#btn-sd-reveal").addEventListener("click", async () => {
    if (game?.status !== "sudden_death") return;
    const contenders = teams.filter(t => (game.sdTeamIds || []).includes(t.id));
    const withAnswers = contenders.filter(t => typeof t.sdAnswer === "number");
    if (!withAnswers.length) { alert("No sudden-death answers submitted yet."); return; }

    // Closest to the truth wins; earlier submission breaks a dead heat.
    withAnswers.sort((a, b) =>
      Math.abs(a.sdAnswer - SUDDEN_DEATH.answer) - Math.abs(b.sdAnswer - SUDDEN_DEATH.answer) ||
      (a.sdAt?.toMillis() || 0) - (b.sdAt?.toMillis() || 0));
    const winner = withAnswers[0];

    await gameRef.update({
      status: "finished", sdWinnerId: winner.id, sdWinnerName: winner.name,
    });
    alert(`⚡ Winner: ${winner.name} (guessed ${winner.sdAnswer.toLocaleString()}, truth: ${SUDDEN_DEATH.answerLabel})`);
  });

  /* 🗑 RESET — wipe teams + DQ log for a fresh night. */
  $("#btn-reset").addEventListener("click", async () => {
    if (!confirm("Reset EVERYTHING? All teams and scores will be deleted.")) return;
    if (!confirm("Seriously — this can't be undone. Reset?")) return;
    const [teamSnap, dqSnap] = await Promise.all([teamsRef.get(), dqLogRef.get()]);
    const batch = db.batch();
    teamSnap.forEach(d => batch.delete(d.ref));
    dqSnap.forEach(d => batch.delete(d.ref));
    batch.set(gameRef, {
      status: "lobby", round: 0, q: 0, scored: null, paused: false,
      pausedMs: 0, pauseStartedAt: null, questionStartAt: null,
      sdTeamIds: [], sdWinnerId: null, sdWinnerName: null,
    });
    await batch.commit();
  });

  /* ============================================================
     TEAM MANAGEMENT (roster actions delegate through data-attrs)
     ============================================================ */

  $("#m-roster").addEventListener("click", async e => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const ref = teamsRef.doc(btn.dataset.id);
    const team = teams.find(t => t.id === btn.dataset.id);
    switch (btn.dataset.act) {
      case "plus":  ref.update({ score: FV.increment(5) }); break;
      case "minus": ref.update({ score: FV.increment(-5) }); break;
      case "set": {
        const v = prompt(`Set score for "${team.name}":`, team.score);
        if (v !== null && !Number.isNaN(+v)) ref.update({ score: +v });
        break;
      }
      case "lock":    ref.update({ status: "locked" }); break;
      case "unlock":  ref.update({ status: "active" }); break;
      case "readmit": ref.update({ status: "active" }); break;
      case "kick":
        if (confirm(`Remove team "${team.name}" completely?`)) ref.delete();
        break;
    }
  });

  $("#m-dqlog").addEventListener("click", e => {
    const btn = e.target.closest("[data-readmit]");
    if (btn) teamsRef.doc(btn.dataset.readmit).update({ status: "active" });
  });

  /* ============================================================
     RENDERING
     ============================================================ */

  const PHASE_LABELS = {
    lobby: "Lobby", question: "LIVE QUESTION", locked: "Locked — reveal when ready",
    reveal: "Answer revealed", leaderboard: "Leaderboard", sudden_death: "SUDDEN DEATH",
    finished: "Finished",
  };

  function render() {
    const status = game?.status || "lobby";
    $("#m-phase").textContent = PHASE_LABELS[status] || status;

    // Button enablement per phase
    const en = (id, on) => $(id).disabled = !on;
    en("#btn-pause",  status === "question" && !game?.paused);
    en("#btn-resume", status === "question" && !!game?.paused);
    en("#btn-reveal", ["question", "locked"].includes(status));
    en("#btn-next",   ["question", "locked", "reveal", "leaderboard"].includes(status));
    en("#btn-sd",     status === "finished" && !game?.sdWinnerId);
    en("#btn-sd-reveal", status === "sudden_death");
    $("#btn-next").textContent =
      status === "leaderboard" ? `⏭ START ROUND ${(game?.round ?? 0) + 2}` :
      (game && game.q === QUESTIONS_PER_ROUND - 1 && ["reveal","locked","question"].includes(status))
        ? (game.round === TOTAL_ROUNDS - 1 ? "🏁 FINISH GAME" : "📊 SHOW LEADERBOARD")
        : "⏭ NEXT QUESTION";

    renderQuestionPanel(status);
    renderRoster(status);
    renderDqLog();
    renderSdPanel(status);
  }

  function renderQuestionPanel(status) {
    if (!game || ["lobby", "finished", "sudden_death"].includes(status)) {
      $("#m-qmeta").textContent = ""; $("#m-qtext").textContent = "—";
      $("#m-qopts").innerHTML = ""; $("#m-answercount").textContent = "";
      return;
    }
    const question = getQuestion(game.round, game.q);
    if (!question) return;
    const key = qKey(game.round, game.q);

    $("#m-qmeta").textContent = `${ROUNDS[game.round].title} · Q${game.q + 1}/${QUESTIONS_PER_ROUND}`;
    $("#m-qtext").textContent = question.text;

    // QM sees the correct answer AND a live tally per option.
    const tally = [0, 0, 0, 0];
    teams.forEach(t => { if (t.answer?.key === key) tally[t.answer.choice]++; });
    $("#m-qopts").innerHTML = question.options.map((opt, i) =>
      `<li class="${i === question.correct ? "neon-green font-bold" : ""}">
         ${CHOICE_LETTERS[i]}. ${escapeHtml(opt)} ${i === question.correct ? "✔" : ""}
         <span class="float-right neon-blue">${tally[i]}</span>
       </li>`).join("");

    const answered = tally.reduce((a, b) => a + b, 0);
    const active = teams.filter(t => t.status === "active").length;
    $("#m-answercount").textContent = `${answered}/${active} active teams have answered`;
  }

  function renderRoster(status) {
    $("#m-teamcount").textContent = `(${teams.length})`;
    const key = game ? qKey(game.round ?? 0, game.q ?? 0) : "";
    $("#m-roster").innerHTML = sortTeams(teams).map(t => {
      const chip =
        t.status === "disqualified" ? '<span class="neon-red text-xs font-bold">🚨 DQ</span>' :
        t.status === "locked"       ? '<span class="neon-gold text-xs font-bold">⛔ LOCKED</span>' :
        '<span class="neon-green text-xs font-bold">● ACTIVE</span>';
      const answered = t.answer?.key === key
        ? `<span class="text-xs neon-blue">answered ${CHOICE_LETTERS[t.answer.choice]}${t.answer.dd ? " 🎲" : ""}</span>`
        : (status === "question" ? '<span class="text-xs" style="color:var(--ink-dim)">thinking…</span>' : "");
      return `
        <div class="panel p-3">
          <div class="flex items-center justify-between mb-1">
            <span class="font-bold">${escapeHtml(t.name)} ${t.streak >= 3 ? "🔥" : ""}</span>
            <span class="font-black neon-green text-lg tabular-nums">${t.score}</span>
          </div>
          <div class="flex items-center justify-between mb-2">${chip}${answered}</div>
          <div class="flex flex-wrap gap-1 text-xs">
            <button data-act="minus" data-id="${t.id}" class="btn btn-ghost px-2 py-1">−5</button>
            <button data-act="plus"  data-id="${t.id}" class="btn btn-ghost px-2 py-1">+5</button>
            <button data-act="set"   data-id="${t.id}" class="btn btn-ghost px-2 py-1">set</button>
            ${t.status === "locked"
              ? `<button data-act="unlock" data-id="${t.id}" class="btn btn-blue px-2 py-1">unlock</button>`
              : `<button data-act="lock" data-id="${t.id}" class="btn btn-ghost px-2 py-1">lock</button>`}
            ${t.status === "disqualified"
              ? `<button data-act="readmit" data-id="${t.id}" class="btn btn-green px-2 py-1 font-bold">✔ RE-ADMIT</button>` : ""}
            <button data-act="kick" data-id="${t.id}" class="btn btn-ghost px-2 py-1 ml-auto">✕</button>
          </div>
        </div>`;
    }).join("") || '<p class="text-sm" style="color:var(--ink-dim)">No teams yet — get them scanning that QR.</p>';
  }

  let dqEvents = [];
  function renderDqLog() {
    $("#m-dqlog").innerHTML = dqEvents.map(ev => {
      const team = teams.find(t => t.id === ev.teamId);
      const stillDq = team?.status === "disqualified";
      return `<div class="panel p-3 ${stillDq ? "" : "opacity-50"}">
          <div class="flex justify-between items-center">
            <span class="font-bold neon-red">${escapeHtml(ev.teamName)}</span>
            <span class="text-xs" style="color:var(--ink-dim)">${fmtTime(ev.at)}</span>
          </div>
          <p class="text-xs mb-2" style="color:var(--ink-dim)">${escapeHtml(ev.reason)}</p>
          ${stillDq ? `<button data-readmit="${ev.teamId}" class="btn btn-green px-3 py-1 text-xs font-bold">✔ RE-ADMIT</button>`
                    : '<span class="text-xs neon-green">re-admitted</span>'}
        </div>`;
    }).join("") || '<p class="text-sm" style="color:var(--ink-dim)">All clean. Nobody has rage-quit… yet.</p>';
  }

  function renderSdPanel(status) {
    const panel = $("#m-sd-panel");
    if (status !== "sudden_death") { panel.classList.add("hidden"); return; }
    panel.classList.remove("hidden");
    $("#m-sd-answer").textContent = SUDDEN_DEATH.answerLabel;
    const contenders = teams.filter(t => (game.sdTeamIds || []).includes(t.id));
    $("#m-sd-answers").innerHTML = contenders.map(t =>
      `<div class="flex justify-between">
         <span class="font-bold">${escapeHtml(t.name)}</span>
         <span class="${typeof t.sdAnswer === "number" ? "neon-green font-bold" : ""}">
           ${typeof t.sdAnswer === "number" ? t.sdAnswer.toLocaleString() : "waiting…"}
         </span>
       </div>`).join("");
  }

  /* ---------- timer tick + authoritative auto-lock ------------- */
  setInterval(() => {
    if (!game) return;
    const el = $("#m-timer");
    if (game.status === "question") {
      const s = remainingSecs(game);
      el.textContent = s + "s";
      el.classList.toggle("timer-danger", s <= 10);
      // The QM tab is the authority that flips 'question' -> 'locked'
      // when time expires (guarded so it fires once per question).
      const key = qKey(game.round, game.q);
      if (s <= 0 && !game.paused && autoLockedKey !== key) {
        autoLockedKey = key;
        gameRef.update({ status: "locked" }).catch(() => {});
      }
    } else if (game.status === "sudden_death") {
      el.textContent = remainingSecs(game, SD_SECONDS) + "s";
    } else {
      el.textContent = "—";
      el.classList.remove("timer-danger");
    }
  }, 250);

  /* ---------- Firestore subscriptions --------------------------- */

  function subscribe() {
    gameRef.onSnapshot(snap => {
      game = snap.exists ? snap.data() : null;
      render();
    });
    teamsRef.onSnapshot(snap => {
      teams = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      render();
    });
    dqLogRef.orderBy("at", "desc").limit(25).onSnapshot(snap => {
      dqEvents = snap.docs.map(d => d.data());
      renderDqLog();
    });
  }
})();
