/* =============================================================
   BAR TRIVIA — BIG SCREEN DISPLAY
   Projected view: giant QR to join, live countdown + question,
   FLIP-animated leaderboard, sudden death drama, winner podium.
   Never shows the correct answer until the QM reveals it.
   ============================================================= */

(() => {
  "use strict";

  let game = null;
  let teams = [];

  const views = ["lobby", "question", "leaderboard", "sd", "winner"];
  function show(name) {
    views.forEach(v => $("#view-" + v).classList.toggle("hidden", v !== name));
  }

  /* ---------- QR code to the player page ---------------------- */
  const joinUrl = location.href.replace(/display\.html.*$/, "play.html");
  $("#join-url").textContent = joinUrl.replace(/^https?:\/\//, "");
  new QRCode($("#qrcode"), { text: joinUrl, width: 260, height: 260, correctLevel: QRCode.CorrectLevel.M });

  /* ---------- render dispatch --------------------------------- */

  function render() {
    if (!game) return;
    switch (game.status) {
      case "lobby":        renderLobby(); break;
      case "question":
      case "locked":
      case "reveal":       renderQuestion(); break;
      case "leaderboard":  renderLeaderboard(`ROUND ${game.round + 1} STANDINGS`); break;
      case "sudden_death": renderSuddenDeath(); break;
      case "sd_reveal":
      case "finished":     renderWinner(); break;
      default:             renderLobby();
    }
  }

  function renderLobby() {
    const roster = $("#lobby-roster");
    roster.innerHTML = teams.map(t =>
      `<span class="panel panel-green px-4 py-2 font-bold text-lg anim-pop">🍻 ${escapeHtml(t.name)}</span>`
    ).join("");
    show("lobby");
  }

  /* ---------- question / reveal -------------------------------- */

  let renderedKey = null;

  function renderQuestion() {
    const question = getQuestion(game.round, game.q);
    if (!question) return;
    const key = qKey(game.round, game.q);
    const isReveal = game.status === "reveal";

    if (renderedKey !== key + game.status) { // re-render on phase change too
      renderedKey = key + game.status;
      $("#dq-round").textContent = ROUNDS[game.round].title;
      $("#dq-meta").textContent  = `Question ${game.q + 1} of ${QUESTIONS_PER_ROUND}`;
      $("#dq-text").textContent  = question.text;

      $("#dq-options").innerHTML = question.options.map((opt, i) => {
        // Correct answer is ONLY highlighted once the QM reveals.
        const cls = isReveal
          ? (i === question.correct ? "answer-btn correct-reveal" : "answer-btn wrong-reveal")
          : "answer-btn";
        return `<div class="${cls} p-6 flex items-center gap-5">
                  <span class="text-4xl font-black neon-blue">${CHOICE_LETTERS[i]}</span>
                  <span class="text-2xl xl:text-3xl font-bold">${escapeHtml(opt)}</span>
                  ${isReveal && i === question.correct ? '<span class="text-4xl ml-auto">✅</span>' : ""}
                </div>`;
      }).join("");
    }

    const status = $("#dq-status");
    if (isReveal)                       status.innerHTML = `<span class="neon-green anim-pop">✔ ANSWER REVEALED</span>`;
    else if (game.status === "locked")  status.innerHTML = `<span class="neon-red anim-pulse">🔒 ANSWERS LOCKED</span>`;
    else if (game.paused)               status.innerHTML = `<span class="neon-gold anim-pulse">⏸ PAUSED</span>`;
    else                                status.textContent = "";

    // Live "X teams answered" — builds pressure without leaking picks.
    const answered = teams.filter(t => t.answer?.key === key).length;
    const active   = teams.filter(t => t.status === "active").length;
    $("#dq-answercount").textContent = active ? `${answered} of ${active} teams locked in` : "";

    show("question");
  }

  /* ---------- FLIP-animated leaderboard ------------------------ */
  // First render lays rows out in order; subsequent renders measure
  // old positions, reorder the DOM, then transform-from-old-to-new,
  // producing dramatic sliding rank changes.

  function renderLeaderboard(title) {
    $("#lb-title").textContent = title;
    const wrap = $("#lb-rows");
    const sorted = sortTeams(teams);

    // 1) measure existing row positions (keyed by team id)
    const oldTops = new Map();
    [...wrap.children].forEach(el => oldTops.set(el.dataset.id, el.getBoundingClientRect().top));

    // 2) rebuild in new order
    wrap.innerHTML = sorted.map((t, i) => {
      const medal = ["🥇", "🥈", "🥉"][i] || `<span class="neon-blue">#${i + 1}</span>`;
      const fire  = t.streak >= 3 ? '<span class="anim-fire">🔥</span>' : "";
      const dq    = t.status === "disqualified" ? '<span class="neon-red text-lg">🚨 DQ</span>' : "";
      return `<div class="lb-row panel ${i < 3 ? "top-" + (i + 1) : ""} flex items-center gap-6 px-8 py-5" data-id="${t.id}">
                <span class="text-4xl w-14">${medal}</span>
                <span class="text-3xl font-black flex-1">${escapeHtml(t.name)} ${fire} ${dq}</span>
                <span class="text-4xl font-black neon-green tabular-nums">${t.score}</span>
              </div>`;
    }).join("");

    // 3) FLIP: invert to old position, then release to animate
    [...wrap.children].forEach(el => {
      const oldTop = oldTops.get(el.dataset.id);
      if (oldTop === undefined) { el.classList.add("anim-slide-up"); return; }
      const delta = oldTop - el.getBoundingClientRect().top;
      if (!delta) return;
      el.style.transition = "none";
      el.style.transform = `translateY(${delta}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "";
        el.style.transform = "";
      });
    });

    show("leaderboard");
  }

  /* ---------- sudden death & winner ----------------------------- */

  function renderSuddenDeath() {
    $("#sd-display-text").textContent = SUDDEN_DEATH.text;
    const tied = teams.filter(t => (game.sdTeamIds || []).includes(t.id));
    const answered = tied.filter(t => typeof t.sdAnswer === "number").length;
    $("#sd-display-status").textContent =
      `${tied.map(t => t.name).join("  ⚔️  ")} — ${answered}/${tied.length} answers in`;
    show("sd");
  }

  function renderWinner() {
    const sorted = sortTeams(teams);
    const winner = game.sdWinnerName
      ? sorted.find(t => t.id === game.sdWinnerId) || sorted[0]
      : sorted[0];
    if (!winner) { show("lobby"); return; }

    $("#winner-name").textContent = winner.name;
    $("#winner-score").textContent = game.sdWinnerName
      ? `Sudden-death victory! ⚡ (${winner.score} pts)`
      : `${winner.score} points`;

    $("#winner-podium").innerHTML = sorted.slice(0, 5).map((t, i) =>
      `<div class="panel flex items-center gap-4 px-6 py-3 anim-slide-up" style="animation-delay:${i * .15}s">
         <span class="text-2xl w-10">${["🥇","🥈","🥉","4.","5."][i]}</span>
         <span class="text-xl font-bold flex-1 text-left">${escapeHtml(t.name)}</span>
         <span class="text-xl font-black neon-green">${t.score}</span>
       </div>`).join("");
    show("winner");
  }

  /* ---------- countdown ticker ---------------------------------- */
  setInterval(() => {
    if (!game) return;
    if (game.status === "question") {
      const s = remainingSecs(game);
      const el = $("#dq-timer");
      el.textContent = s;
      el.classList.toggle("timer-danger", s <= 10);
    } else if (game.status === "sudden_death") {
      $("#sd-display-timer").textContent = remainingSecs(game, SD_SECONDS);
    }
  }, 250);

  /* ---------- Firestore subscriptions --------------------------- */

  gameRef.onSnapshot(snap => {
    game = snap.exists ? snap.data() : { status: "lobby" };
    renderedKey = null; // force question re-render on any state change
    render();
  });

  teamsRef.onSnapshot(snap => {
    teams = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  });
})();
