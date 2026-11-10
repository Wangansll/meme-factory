(function () {
  "use strict";

  // 挂载自适应：独立部署为根路径，被工厂挂载时在 /arena/ 下
  var BASE = location.pathname.indexOf("/arena") === 0 ? "/arena" : "";

  // ---------- state ----------
  var S = {
    sid: null, tok: null,
    quizId: null, qs: [], idx: 0,
    t0: 0, timer: null, locked: false,
    lastResult: null
  };
  var LOCAL_KEY = "ma_stats";
  function localStats() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}") || {}; } catch (e) { return {}; }
  }
  function saveLocal(s) {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(s)); } catch (e) { }
  }
  function $(id) { return document.getElementById(id); }
  function show(view) {
    ["homeView", "playView", "resultView"].forEach(function (v) { $(v).hidden = (v !== view); });
  }

  // ---------- session ----------
  function refreshSession() {
    return fetch(BASE + "/api/session").then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.sid) { S.sid = j.sid; S.tok = j.t; } })
      .catch(function () { });
  }
  function api(path, body, retried) {
    var opt = {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" }
    };
    if (body) opt.body = JSON.stringify(Object.assign({ sid: S.sid, t: S.tok }, body));
    return fetch(BASE + path, opt).then(function (r) {
      if (r.status === 403 && !retried) {
        return refreshSession().then(function () { return api(path, body, true); });
      }
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    });
  }

  // ---------- 排行榜 ----------
  function renderRank(list, target) {
    var ol = $(target);
    ol.innerHTML = "";
    if (!list || !list.length) { $("rankEmpty").hidden = false; return; }
    $("rankEmpty").hidden = true;
    list.forEach(function (r, i) {
      var li = document.createElement("li");
      if (i < 3) li.className = "rk-" + (i + 1);
      var no = document.createElement("span");
      no.className = "rk-no";
      no.textContent = i + 1;
      var nm = document.createElement("span");
      nm.className = "rk-name";
      nm.textContent = r.name;
      var meta = document.createElement("span");
      meta.className = "rk-meta";
      meta.textContent = "对" + r.correct + " · 连" + r.combo;
      var sc = document.createElement("span");
      sc.className = "rk-score";
      sc.textContent = r.score;
      li.appendChild(no); li.appendChild(nm); li.appendChild(meta); li.appendChild(sc);
      ol.appendChild(li);
    });
  }
  function loadRank(target) {
    fetch(BASE + "/api/rank").then(function (r) { return r.json(); }).then(function (j) {
      renderRank(j.top, target || "rankList");
    }).catch(function () { });
  }

  // ---------- 首页 ----------
  function renderHome() {
    show("homeView");
    var s = localStats();
    $("myBest").textContent = s.best || 0;
    $("myRounds").textContent = s.rounds || 0;
    loadRank("rankList");
  }

  // ---------- 开局 ----------
  function startQuiz() {
    var btn = $("startBtn");
    btn.disabled = true;
    api("/api/quiz/start", {}).then(function (r) {
      btn.disabled = false;
      if (!r.ok || !r.j || !r.j.questions) {
        toast(r.j && r.j.error || "开局失败，稍后再试");
        return;
      }
      S.quizId = r.j.quizId;
      S.qs = r.j.questions;
      S.idx = 0;
      show("playView");
      $("hudScore").textContent = "0";
      $("hudCombo").textContent = "";
      showQuestion();
    }).catch(function () {
      btn.disabled = false;
      toast("网络开小差了，再试一次");
    });
  }

  // ---------- 答题 ----------
  var CAT_NAME = { ai: "AI 圈热梗", hot: "网络热梗" };
  function showQuestion() {
    var q = S.qs[S.idx];
    $("hudIdx").textContent = S.idx + 1;
    $("qTag").textContent = CAT_NAME[q.c] || "热梗";
    $("qText").textContent = q.q;
    $("fbBox").hidden = true;
    S.locked = false;
    var box = $("optBox");
    box.innerHTML = "";
    q.o.forEach(function (t, k) {
      var b = document.createElement("button");
      b.className = "opt";
      b.setAttribute("data-k", k);
      b.innerHTML = '<span class="no">' + (k + 1) + '</span>' + escapeHtml(t);
      b.addEventListener("click", function () { choose(k); });
      box.appendChild(b);
    });
    startTimer();
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function startTimer() {
    S.t0 = Date.now();
    var fill = $("timerFill");
    fill.classList.remove("danger");
    fill.style.transition = "none";
    fill.style.width = "100%";
    void fill.offsetWidth;
    fill.style.transition = "width 0.95s linear";
    var DUR = 10000;
    var t1 = setInterval(function () {
      var left = DUR - (Date.now() - S.t0);
      fill.style.width = Math.max(0, left / DUR * 100) + "%";
      if (left < 3000) fill.classList.add("danger");
      if (left <= 0) {
        clearInterval(t1);
        if (!S.locked) choose(-1);   // 超时自动判
      }
    }, 100);
    S.timer = t1;
  }
  function stopTimer() {
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
  }
  function choose(k) {
    if (S.locked) return;
    S.locked = true;
    stopTimer();
    var msUsed = Math.max(0, Date.now() - S.t0);
    var q = S.qs[S.idx];
    var isTimeout = k === -1;
    if (isTimeout) msUsed = 10200;
    api("/api/quiz/guess", {
      quizId: S.quizId, qid: q.id, choice: k, msUsed: msUsed, timeout: isTimeout ? 1 : 0
    }).then(function (r) {
      if (!r.ok || !r.j || r.j.error) {
        toast((r.j && r.j.error) || "提交失败");
        S.locked = false;
        return;
      }
      highlight(r.j.answer, k);
      $("hudScore").textContent = r.j.score;
      $("hudCombo").textContent = r.j.combo > 1 ? "🔥 " + r.j.combo + " 连击" : "";
      showFeedback(r.j, q);
      setTimeout(function () {
        if (r.j.finished) showResult(r.j);
        else { S.idx++; showQuestion(); }
      }, 2600);
    }).catch(function () {
      S.locked = false;
      toast("网络开小差了，再点一次");
    });
  }
  function highlight(answer, chosen) {
    var box = $("optBox");
    Array.prototype.forEach.call(box.children, function (b) {
      var k = Number(b.getAttribute("data-k"));
      b.disabled = true;
      if (k === answer) b.classList.add("correct");
      else if (k === chosen) b.classList.add("wrong");
      else b.classList.add("dim");
    });
  }
  function showFeedback(j, q) {
    var v = $("fbVerdict");
    if (j.correct) {
      v.textContent = "✔ 答对 +" + j.gain + (j.combo > 1 ? "（连击 x" + j.combo + "）" : "");
      v.className = "fb-verdict good";
    } else {
      v.textContent = q.o[j.answer] ? "✘ 正确答案：" + q.o[j.answer] : "✘ 超时了";
      v.className = "fb-verdict bad";
    }
    $("fbWiki").textContent = j.wiki || "";
    $("fbBox").hidden = false;
    void $("fbBox").offsetWidth;
  }

  // ---------- 结算 ----------
  var TITLES = [
    [0, "梗新兵 · 才入门"], [400, "梗学徒 · 每天冲浪"], [800, "梗学士 · 冲浪健将"],
    [1200, "梗硕士 · 梗图活化石"], [1600, "梗王 · 全场最懂梗"], [2000, "梗祖师爷 · 梗都认识你"]
  ];
  function titleFor(score) {
    var t = TITLES[0][1];
    TITLES.forEach(function (seg) { if (score >= seg[0]) t = seg[1]; });
    return t;
  }
  function showResult(j) {
    var s = localStats();
    s.rounds = (s.rounds || 0) + 1;
    s.best = Math.max(s.best || 0, j.score);
    saveLocal(s);
    show("resultView");
    countUp($("resScore"), j.score);
    $("resTitle").textContent = titleFor(j.score);
    $("resCorrect").textContent = j.correct + "/10";
    $("resCombo").textContent = j.maxCombo;
    $("resBest").textContent = s.best;
    S.lastResult = { quizId: S.quizId, score: j.score };
    var sub = $("rankSubmitBox"), done = $("rankDone");
    sub.hidden = false; done.hidden = true;
    $("submitRankBtn").disabled = false;
    try { $("nameInput").value = localStorage.getItem("ma_name") || ""; } catch (e) { }
    loadRank("rankList2");
  }
  function countUp(el, target) {
    var cur = 0;
    var step = Math.max(1, Math.round(target / 30));
    var t = setInterval(function () {
      cur = Math.min(target, cur + step);
      el.textContent = cur;
      if (cur >= target) clearInterval(t);
    }, 40);
  }
  function submitRank() {
    if (!S.lastResult) return;
    var name = $("nameInput").value.trim();
    if (!name) { toast("先留下你的名号"); return; }
    try { localStorage.setItem("ma_name", name); } catch (e) { }
    $("submitRankBtn").disabled = true;
    api("/api/rank", { quizId: S.lastResult.quizId, name: name }).then(function (r) {
      $("submitRankBtn").disabled = false;
      if (!r.ok || !r.j || r.j.error) {
        toast((r.j && r.j.error) || "上榜失败");
        return;
      }
      $("rankSubmitBox").hidden = true;
      $("rankDone").hidden = false;
      renderRank(r.j.top, "rankList2");
      if (r.j.myRank) toast("本周第 " + r.j.myRank + " 名！");
    }).catch(function () { toast("网络开小差了"); });
  }

  function toast(msg) {
    var t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add("on"); }, 10);
    setTimeout(function () { t.remove(); }, 2400);
  }

  // ---------- 键盘 ----------
  document.addEventListener("keydown", function (e) {
    if ($("playView").hidden) return;
    if ($("fbBox").hidden && ["1", "2", "3", "4"].indexOf(e.key) >= 0) choose(Number(e.key) - 1);
  });

  // ---------- init ----------
  $("startBtn").addEventListener("click", startQuiz);
  $("againBtn").addEventListener("click", startQuiz);
  $("homeBtn").addEventListener("click", renderHome);
  $("refreshRankBtn").addEventListener("click", function () { loadRank("rankList"); });
  $("submitRankBtn").addEventListener("click", submitRank);
  $("nameInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") submitRank();
  });
  refreshSession().then(function () { renderHome(); });
})();
