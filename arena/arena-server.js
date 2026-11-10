// ---------- 梗图大乱斗 · 服务端 ----------
// 方向与表情包工厂不同：题库/答案/判分全在服务端，前端拿不到正确答案，
// 排行榜分数由服务端持有（前端只上报选择与用时），天然防刷。
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { BANK, shuffledQuestion } = require("./quiz-bank.js");

const PORT = process.env.PORT || 3100;
const HOST = "0.0.0.0";
const ROOT = __dirname;

// ---------- 会话闸（与工厂同模式：sid + HMAC 令牌） ----------
const SECRET_FILE = path.join(ROOT, "arena-secret.key");
let SESSION_SECRET = "";
try { SESSION_SECRET = fs.readFileSync(SECRET_FILE, "utf8").trim(); } catch (e) { }
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  try { fs.writeFileSync(SECRET_FILE, SESSION_SECRET); } catch (e) { }
}
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000;
function newSession() {
  const sid = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  if (sessions.size > 12000) {
    const cutoff = now - SESSION_TTL;
    for (const k of sessions.keys()) {
      if (sessions.get(k).ts < cutoff) sessions.delete(k);
      if (sessions.size <= 9000) break;
    }
  }
  sessions.set(sid, { ts: now });
  return sid;
}
function tokenFor(sid) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(String(sid)).digest("hex").slice(0, 32);
}
function sessionOk(ip, sid, token) {
  if (isLoopback(ip)) return true;
  if (!sid || !sessions.has(sid)) return false;
  if (Date.now() - sessions.get(sid).ts > SESSION_TTL) { sessions.delete(sid); return false; }
  return token === tokenFor(sid);
}
function touchSession(sid) {
  const s = sessions.get(sid);
  if (s) s.ts = Date.now();
}
function handleSession(res) {
  const sid = newSession();
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ sid: sid, t: tokenFor(sid) }));
}

// ---------- 限流 ----------
const hits = new Map();
function rateOkKeyed(key, limit, windowMs) {
  const now = Date.now();
  let arr = hits.get(key) || [];
  arr = arr.filter(function (t) { return now - t < windowMs; });
  if (arr.length >= limit) { hits.set(key, arr); return false; }
  arr.push(now);
  hits.set(key, arr);
  return true;
}
function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
function clientIp(req) {
  const raw = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?");
  const parts = raw.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  return parts[0] || "?";
}
function readBody(req, maxBytes, cb) {
  let chunks = [];
  let size = 0;
  req.on("data", function (c) {
    size += c.length;
    if (size > maxBytes) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", function () {
    let j = null;
    try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { }
    cb(j);
  });
}

// ---------- 对局管理 ----------
const QUIZ_ROUND = 10;
const QUESTION_SECONDS = 10;   // 每题答题时限
const MAX_SCORE = 2000;        // 理论单局上限（10 × 200）
const quizzes = new Map();     // quizId -> {sid, questions:[{a, w}], answered:[bool], baseTs, score, combo, maxCombo, correct, wallStart}
const QUIZ_TTL = 40 * 60 * 1000;
function newQuizId() {
  return crypto.randomBytes(12).toString("hex");
}
function purgeQuizzes() {
  const now = Date.now();
  for (const k of quizzes.keys()) {
    if (now - quizzes.get(k).wallStart > QUIZ_TTL) quizzes.delete(k);
  }
}
function pickQuestions() {
  // AI 圈与热梗混着出，乱序、选项乱序
  const idx = BANK.map(function (_, i) { return i; });
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  // 均衡：尽量一半 AI 圈一半热梗
  const ai = idx.filter(i => BANK[i].c === "ai");
  const hot = idx.filter(i => BANK[i].c === "hot");
  const picked = [];
  while (picked.length < QUIZ_ROUND && (ai.length || hot.length)) {
    const wantAi = picked.filter(p => BANK[p].c === "ai").length;
    const wantHot = picked.filter(p => BANK[p].c === "hot").length;
    if (wantAi <= wantHot && ai.length) picked.push(ai.shift());
    else if (hot.length) picked.push(hot.shift());
    else if (ai.length) picked.push(ai.shift());
  }
  return picked.map(i => shuffledQuestion(BANK[i]));
}
function handleQuizStart(req, res, ip, sid, token) {
  if (!sessionOk(ip, sid, token)) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "会话无效，请刷新页面重试" }));
    return;
  }
  touchSession(sid);
  if (!rateOkKeyed("start:" + ip, 30, 60 * 60 * 1000)) {
    res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "开局太频繁，一小时后再来" }));
    return;
  }
  purgeQuizzes();
  const qs = pickQuestions();
  const quizId = newQuizId();
  quizzes.set(quizId, {
    sid: sid,
    questions: qs,
    answered: qs.map(() => false),
    wallStart: Date.now(),
    wallUsed: 0,          // 前端上报的累计用时（ms）
    score: 0,
    combo: 0,
    maxCombo: 0,
    correct: 0,
    done: false
  });
  // 下发不含答案的题目
  const public_ = qs.map(function (q, i) {
    return { id: i, q: q.q, o: q.o, c: q.c };
  });
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ quizId: quizId, seconds: QUESTION_SECONDS, questions: public_ }));
}
// 计分：答对 = 100 + 时间加成（剩余秒 ×5，上限50） + 连击加成（10×n，上限50）；答错/超时 0 且断连
function scoreFor(msLeft, comboAfter) {
  const left = Math.max(0, Math.min(QUESTION_SECONDS, Math.round((QUESTION_SECONDS * 1000 - msLeft) / 1000)));
  let s = 100 + left * 5;
  if (comboAfter > 1) s += Math.min(50, (comboAfter - 1) * 10);
  return s;
}
function handleQuizGuess(req, res, ip, sid, token, body) {
  if (!sessionOk(ip, sid, token)) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "会话无效，请刷新页面重试" }));
    return;
  }
  touchSession(sid);
  const quizId = String((body && body.quizId) || "");
  const qid = Number(body && body.qid);
  const choice = Number(body && body.choice);
  const msUsed = Number(body && body.msUsed);
  const G = quizzes.get(quizId);
  if (!G || G.sid !== sid) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "对局不存在或已过期" }));
    return;
  }
  if (G.done) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "本局已结束" }));
    return;
  }
  if (!(qid >= 0 && qid < G.questions.length) || G.answered[qid]) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "题目状态异常" }));
    return;
  }
  if (!(choice >= 0 && choice < 4)) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "选项无效" }));
    return;
  }
  // 时间合理性：上报累计用时不得超过墙钟流逝 + 3s 容差；单题不超时限+2s
  const wallNow = Date.now();
  const wallElapsed = wallNow - G.wallStart;
  const newUsed = G.wallUsed + (msUsed > 0 ? msUsed : 0);
  if (msUsed < 0 || msUsed > (QUESTION_SECONDS + 2) * 1000 || newUsed > wallElapsed + 3000) {
    // 时间造假或超时：判超时，扣本题为 0
  }
  const timedOut = (body && body.timeout === 1) || msUsed > (QUESTION_SECONDS + 2) * 1000 || newUsed > wallElapsed + 3000;
  G.answered[qid] = true;
  G.wallUsed = newUsed;
  const q = G.questions[qid];
  const correct = !timedOut && choice === q.a;
  let gain = 0;
  if (correct) {
    G.correct++;
    G.combo++;
    G.maxCombo = Math.max(G.maxCombo, G.combo);
    gain = scoreFor(timedOut ? QUESTION_SECONDS * 1000 : msUsed, G.combo);
    G.score += gain;
  } else {
    G.combo = 0;
  }
  const allAnswered = G.answered.every(Boolean);
  if (allAnswered) {
    G.done = true;
    G.wallEnd = wallNow;
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({
    correct: correct,
    answer: q.a,
    wiki: q.w,
    gain: gain,
    score: G.score,
    combo: G.combo,
    finished: allAnswered
  }));
}

// ---------- 周榜 ----------
const RANK_FILE = path.join(ROOT, "rank-store.json");
let rankMap = {};  // id -> {name, score, combo, correct, ts, week}
try { rankMap = JSON.parse(fs.readFileSync(RANK_FILE, "utf8")) || {}; } catch (e) { }
let rankTimer = null;
function persistRanks() {
  if (rankTimer) return;
  rankTimer = setTimeout(function () {
    rankTimer = null;
    try { fs.writeFileSync(RANK_FILE, JSON.stringify(rankMap)); } catch (e) { }
  }, 500);
}
function weekKey(ts) {
  const d = new Date(ts);
  const day = (d.getDay() + 6) % 7; // 周一=0
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day).getTime();
  return String(monday);
}
function purgeRanks() {
  const wk = weekKey(Date.now());
  for (const k in rankMap) {
    if (rankMap[k].week !== wk) delete rankMap[k];
  }
  const keys = Object.keys(rankMap);
  if (keys.length > 2000) {
    keys.sort(function (a, b) { return rankMap[a].ts - rankMap[b].ts; });
    for (let i = 0; i < keys.length - 2000; i++) delete rankMap[keys[i]];
  }
}
const BAD_NAME = /(管理|官方|客服|机器人|bot|admin|系统)/i;
function cleanName(n) {
  let s = String(n || "").replace(/\s+/g, "").slice(0, 8);
  if (!s || BAD_NAME.test(s)) s = "无名梗友";
  return s;
}
function handleRankPost(req, res, ip, sid, token, body) {
  if (!sessionOk(ip, sid, token)) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "会话无效，请刷新页面重试" }));
    return;
  }
  touchSession(sid);
  if (!rateOkKeyed("rank:" + ip, 20, 60 * 60 * 1000)) {
    res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "上榜太频繁，稍后再试" }));
    return;
  }
  const quizId = String((body && body.quizId) || "");
  const G = quizzes.get(quizId);
  if (!G || G.sid !== sid || !G.done) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "对局不存在或未完成" }));
    return;
  }
  // 上榜后即从内存删除，防止同一局反复上榜
  quizzes.delete(quizId);
  purgeRanks();
  const rec = {
    name: cleanName(body && body.name),
    score: Math.min(MAX_SCORE, G.score),
    combo: G.maxCombo,
    correct: G.correct,
    ts: Date.now(),
    week: weekKey(Date.now())
  };
  const id = crypto.randomBytes(8).toString("hex");
  rankMap[id] = rec;
  persistRanks();
  const top = topRanks();
  const myRank = top.findIndex(r => r.ts === rec.ts && r.name === rec.name) + 1;
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: 1, top: top, myRank: myRank || null }));
}
function topRanks() {
  purgeRanks();
  return Object.values(rankMap)
    .sort(function (a, b) { return b.score - a.score || a.ts - b.ts; })
    .slice(0, 20);
}
function handleRankGet(res) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ top: topRanks() }));
}

// ---------- 静态服务 ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};
function serveStatic(req, res, urlPath) {
  let p = urlPath.split("?")[0].split("#")[0];
  if (p === "/" || p === "") p = "/index.html";
  const filePath = path.join(ROOT, path.normalize(p).replace(/^(\.\.[\/\\])+/, ""));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end("Forbidden");
    return;
  }
  const base = path.basename(filePath);
  if (/\.key$|\.json$|^(\.|_)/.test(base) || base === "server.js" || base === "quiz-bank.js" || base === "arena-server.js") {
    res.writeHead(403); res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, function (err, buf) {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  });
}

// ---------- 路由（独立运行与被工厂挂载共用） ----------
function handler(req, res) {
  const ip = clientIp(req);
  if (req.method === "GET" && req.url === "/api/session") {
    handleSession(res);
  } else if (req.method === "POST" && req.url === "/api/quiz/start") {
    readBody(req, 4096, function (body) {
      handleQuizStart(req, res, ip, body && body.sid, body && body.t);
    });
  } else if (req.method === "POST" && req.url === "/api/quiz/guess") {
    readBody(req, 4096, function (body) {
      handleQuizGuess(req, res, ip, body && body.sid, body && body.t, body);
    });
  } else if (req.method === "POST" && req.url === "/api/rank") {
    readBody(req, 4096, function (body) {
      handleRankPost(req, res, ip, body && body.sid, body && body.t, body);
    });
  } else if (req.method === "GET" && req.url === "/api/rank") {
    handleRankGet(res);
  } else if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res, req.url);
  } else {
    res.writeHead(405); res.end("Method Not Allowed");
  }
}
module.exports = handler;

if (require.main === module) {
  const server = http.createServer(handler);
  server.listen(PORT, HOST, function () {
    console.log("meme-arena server listening on " + HOST + ":" + PORT);
  });
}
