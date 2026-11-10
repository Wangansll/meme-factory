const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const arenaHandler = require("./arena/arena-server.js");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const PROVIDER_HOST = "api.lk888.ai";
const PROVIDER_PATH = "/v1/media/generate";
// 只读环境变量：源码里不再保留任何 key（旧 key 已随源码泄露，请尽快到上游平台重置）。
// 启动方式：PROVIDER_API_KEY=xxx node server.js
const PROVIDER_KEY = String(process.env.PROVIDER_API_KEY || "").trim();
if (!PROVIDER_KEY) {
  console.warn("[warn] 未设置 PROVIDER_API_KEY：生成接口会直接失败（missing_provider_key），其余功能正常。");
}
const IMAGE_MODEL = "tt-image-2.6";

// ---------- 会话令牌（防伪造请求头刷额度）----------
// 服务端签发不可猜的 sid（128 位随机），令牌 = HMAC(sid)；sid 存内存 TTL 24h。
// 不绑 IP：平台网关多实例会导致服务端看到的 XFF 不稳定。滥用兜底 = 全局日闸 + 限流。
const SECRET_FILE = path.join(__dirname, "session-secret.key");
let SESSION_SECRET = "";
try { SESSION_SECRET = fs.readFileSync(SECRET_FILE, "utf8").trim(); } catch (e) { }
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  try { fs.writeFileSync(SECRET_FILE, SESSION_SECRET); } catch (e) { }
}
function clientIp(req) {
  const raw = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?");
  const parts = raw.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  return parts[0] || "?";
}
function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000;
function newSession() {
  const sid = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  if (sessions.size > 12000) {
    const cutoff = now - SESSION_TTL;
    for (const k of sessions.keys()) {
      if (sessions.get(k) < cutoff) sessions.delete(k);
      if (sessions.size <= 9000) break;
    }
  }
  sessions.set(sid, now);
  return sid;
}
function tokenFor(sid) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(String(sid)).digest("hex").slice(0, 32);
}
function sessionOk(ip, sid, token) {
  if (isLoopback(ip)) return true;
  if (!sid || !sessions.has(sid)) return false;
  if (Date.now() - sessions.get(sid) > SESSION_TTL) { sessions.delete(sid); return false; }
  return token === tokenFor(sid);
}
function handleSession(res) {
  const sid = newSession();
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ sid: sid, t: tokenFor(sid) }));
}

const ROOT = __dirname;
const SHARE_FILE = path.join(ROOT, "share-store.json");
let shareMap = {};
try { shareMap = JSON.parse(fs.readFileSync(SHARE_FILE, "utf8")) || {}; } catch (e) { }
let sharePersistTimer = null;
function persistShares() {
  // 合并写盘并放到响应之后，避免同步 JSON.stringify + writeFileSync 卡住接口返回
  if (sharePersistTimer) return;
  sharePersistTimer = setTimeout(function () {
    sharePersistTimer = null;
    try { fs.writeFile(SHARE_FILE, JSON.stringify(shareMap), function () { }); } catch (e) { }
  }, 150);
}
process.on("exit", function () {
  try { fs.writeFileSync(SHARE_FILE, JSON.stringify(shareMap)); } catch (e) { }
});
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const RATE_LIMIT = 90;
const RATE_WINDOW = 60 * 60 * 1000;
const hits = new Map();
// 全局每日出图总闸：即使被刷也封顶
const GLOBAL_DAY_CAP = 3000;
let globalDay = { day: new Date().getDate(), count: 0 };
function globalCapOk() {
  const today = new Date().getDate();
  if (globalDay.day !== today) { globalDay = { day: today, count: 0 }; }
  globalDay.count++;
  return globalDay.count <= GLOBAL_DAY_CAP;
}

function rateOk(ip) {
  const now = Date.now();
  let arr = hits.get(ip) || [];
  arr = arr.filter(function (t) { return now - t < RATE_WINDOW; });
  if (arr.length >= RATE_LIMIT) { hits.set(ip, arr); return false; }
  arr.push(now);
  hits.set(ip, arr);
  return true;
}

let activeJobs = 0;
const MAX_CONCURRENT = 9;

function httpsJson(method, reqPath, bodyObj, cb) {
  const doReq = function (headers, payload) {
    const req = https.request({
      hostname: PROVIDER_HOST,
      path: reqPath,
      method: method,
      headers: headers
    }, function (res) {
      let data = "";
      res.on("data", function (c) { data += c; });
      res.on("end", function () {
        if (res.statusCode !== 200) {
          cb(new Error("provider_" + res.statusCode + ":" + data.slice(0, 300)));
          return;
        }
        try { cb(null, JSON.parse(data)); }
        catch (e) { cb(new Error("provider_bad_json:" + data.slice(0, 300))); }
      });
    });
    req.on("error", cb);
    req.setTimeout(60000, function () { req.destroy(new Error("provider_req_timeout")); });
    if (payload) req.write(payload);
    req.end();
  };
  if (bodyObj) {
    const body = JSON.stringify(bodyObj);
    doReq({
      "Authorization": "Bearer " + PROVIDER_KEY,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    }, body);
  } else {
    doReq({ "Authorization": "Bearer " + PROVIDER_KEY });
  }
}

function httpsDownload(url, cb) {
  https.get(url, function (res) {
    if (res.statusCode !== 200) {
      cb(new Error("download_" + res.statusCode));
      return;
    }
    const mime = res.headers["content-type"] || "image/png";
    const chunks = [];
    res.on("data", function (c) { chunks.push(c); });
    res.on("end", function () { cb(null, Buffer.concat(chunks), String(mime).split(";")[0]); });
  }).on("error", cb).setTimeout(60000, function () { this.destroy(new Error("download_timeout")); });
}

function providerGenerate(prompt, gp, cb) {
  if (!PROVIDER_KEY) return cb(new Error("missing_provider_key"));
  const startedAt = Date.now();
  const DEADLINE = 480000;
  let finished = false;
  const done = function (err, b64, mime) {
    if (finished) return;
    finished = true;
    cb(err, b64, mime);
  };
  const submitBody = buildProviderBody(prompt, gp);
  const run = function (body, isFallback) {
    httpsJson("POST", PROVIDER_PATH, body, function (err, j) {
      if (err) return done(err);
      const d = j && j.data;
      const taskId = d && (d.task_id || (d.task_ids && d.task_ids[0]));
      if (!taskId) return done(new Error("provider_no_task:" + JSON.stringify(j).slice(0, 300)));
      const poll = function () {
        if (finished) return;
        if (Date.now() - startedAt > DEADLINE) return done(new Error("provider_task_timeout"));
        httpsJson("GET", "/v1/media/status?task_id=" + taskId, null, function (perr, st) {
          if (perr) return done(perr);
          if (st && st.is_final) {
            if (st.state === "success" && (st.result_url || (st.result_urls && st.result_urls[0]))) {
              const url = st.result_url || st.result_urls[0];
              httpsDownload(url, function (derr, buf, mime) {
                if (derr) return done(derr);
                done(null, buf.toString("base64"), mime || "image/png");
              });
            } else {
              const failMsg = String(st && (st.error || st.status) || "");
              if (!isFallback && body.background === "transparent" && /透明|transparent|alpha/i.test(failMsg)) {
                run(Object.assign({}, body, { background: "opaque" }), true);
                return;
              }
              done(new Error("provider_task_failed:" + failMsg.slice(0, 200)));
            }
          } else {
            setTimeout(poll, 3000);
          }
        });
      };
      setTimeout(poll, 2000);
    });
  };
  run(submitBody, false);
}

function pump() {
  while (activeJobs < MAX_CONCURRENT && jobQueue.length > 0) {
    const job = jobQueue.shift();
    activeJobs++;
    providerGenerate(job.prompt, job.gp, function (err, b64, mime) {
      activeJobs--;
      job.cb(err, b64, mime);
      pump();
    });
  }
}
const jobQueue = [];

const jobs = new Map();
const GEN_ALLOW = {
  version: ["flare", "sunburst"],
  size: ["auto", "1024x1024", "1536x1024", "1024x1536"],
  quality: ["auto", "low", "medium", "high", "xhigh", "max"],
  complexity: ["low", "medium", "high"],
  output_format: ["png", "jpeg", "webp", "svg", "gif"],
  background: ["auto", "opaque", "transparent"],
  frame_count: ["4", "6", "9", "12", "16"],
  frame_duration_ms: ["100", "200", "300", "500", "1000"]
};
function buildProviderBody(prompt, gp) {
  const g = (gp && typeof gp === "object") ? gp : {};
  const pick = function (k, dflt) {
    return (g[k] && GEN_ALLOW[k].indexOf(g[k]) >= 0) ? g[k] : dflt;
  };
  const pbody = {
    model: IMAGE_MODEL,
    prompt: prompt,
    n: 1,
    size: pick("size", "1024x1024"),
    version: pick("version", "flare"),
    quality: pick("quality", "auto"),
    background: pick("background", "auto"),
    output_format: pick("output_format", "png")
  };
  if (pbody.background === "transparent" && ["png", "webp"].indexOf(pbody.output_format) < 0) {
    pbody.output_format = "png";
  }
  if (g.complexity && GEN_ALLOW.complexity.indexOf(g.complexity) >= 0) pbody.complexity = g.complexity;
  if (pbody.output_format === "gif") {
    pbody.frame_count = pick("frame_count", "9");
    pbody.frame_duration_ms = pick("frame_duration_ms", "200");
  }
  return pbody;
}
function trimJobs() {
  const now = Date.now();
  jobs.forEach(function (j, id) {
    if (j.state !== "running" && now - (j.ts || 0) > 10 * 60 * 1000) jobs.delete(id);
  });
  if (jobs.size <= 80) return;
  const entries = Array.from(jobs.entries());
  entries.sort(function (a, b) { return (a[1].ts || 0) - (b[1].ts || 0); });
  for (let i = 0; i < entries.length - 60; i++) {
    if (entries[i][1].state !== "running") jobs.delete(entries[i][0]);
  }
}

function handleImageStart(req, res, ip) {
  let chunks = [];
  let size = 0;
  req.on("data", function (c) {
    size += c.length;
    if (size > 65536) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", function () {
    let prompt = "";
    let gp = {};
    let token = "";
    let sid = "";
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      prompt = String(body.prompt || "").slice(0, 1200);
      gp = (body.gp && typeof body.gp === "object") ? body.gp : {};
      token = String(body.t || "");
      sid = String(body.sid || "");
    } catch (e) { /* ignore */ }
    if (!sessionOk(ip, sid, token)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "会话无效，请刷新页面重试" }));
      return;
    }
    if (!globalCapOk()) {
      res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "今日生图总量已达上限，明天再来" }));
      return;
    }
    if (!rateOk(ip)) {
      res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "生成太频繁，请一小时后再试" }));
      return;
    }
    if (!prompt) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "缺少 prompt" }));
      return;
    }
    const jobId = "j" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    jobs.set(jobId, { state: "running", ts: Date.now() });
    trimJobs();
    jobQueue.push({
      prompt: prompt,
      gp: gp,
      cb: function (err, b64, mime) {
        const job = jobs.get(jobId);
        if (!job) return;
        if (err) {
          job.state = "error";
          job.error = String(err.message || err).slice(0, 200);
        } else {
          job.state = "done";
          job.b64 = b64;
          job.mime = mime || "image/png";
        }
      }
    });
    pump();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ jobId: jobId }));
  });
}

function handleImageStatus(res, id) {
  const job = jobs.get(id);
  if (!job) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ state: "error", error: "任务不存在或已过期" }));
    return;
  }
  if (job.state === "done") {
    const b64 = job.b64;
    jobs.delete(id);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ state: "done", b64: b64, mime: (job && job.mime) || "image/png" }));
  } else if (job.state === "error") {
    jobs.delete(id);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ state: "error", error: job.error || "生成失败" }));
  } else {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ state: "running" }));
  }
}

function serveStatic(req, res, urlPath) {
  let p = urlPath.split("?")[0].split("#")[0];
  if (p === "/" || p === "") p = "/index.html";
  const filePath = path.join(ROOT, path.normalize(p).replace(/^(\.\.[\/\\])+/, ""));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end("Forbidden");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  // 敏感文件黑名单：密钥/数据存储/临时文件一律不对外
  if (ext === ".key" || ext === ".json" || /^[._]/.test(path.basename(filePath))) {
    res.writeHead(403); res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, function (err, buf) {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(buf);
  });
}

function handleSharePost(req, res, ip) {
  let chunks = [];
  let size = 0;
  const SHARE_MAX = 4 * 1024 * 1024;
  req.on("data", function (c) {
    size += c.length;
    if (size > SHARE_MAX) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", function () {
    // 分享接口限流：30 次/小时/IP
    const skey = "share:" + ip;
    if (!rateOkKeyed(skey, 30, RATE_WINDOW)) {
      res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "分享太频繁，请一小时后再试" }));
      return;
    }
    try {
      const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!j || !Array.isArray(j.s) || !j.s.length) throw new Error("bad");
      if (!sessionOk(ip, String(j.sid || ""), String(j.k || ""))) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "会话无效，请刷新页面重试" }));
        return;
      }
      const id = Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5);
      shareMap[id] = {
        t: String(j.t || "").slice(0, 12),
        st: String(j.st || "").slice(0, 10),
        s: j.s.slice(0, 9).map(function (x) {
          if (x && typeof x.imgRawS === "string" && x.imgRawS.length > 120000) x.imgRawS = null;
          return x;
        }),
        ts: Date.now()
      };
      purgeAndCapShares();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ id: id }));
      persistShares();
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "分享数据无效" }));
    }
  });
}

function rateOkKeyed(key, limit, windowMs) {
  const now = Date.now();
  let arr = hits.get(key) || [];
  arr = arr.filter(function (t) { return now - t < windowMs; });
  if (arr.length >= limit) { hits.set(key, arr); return false; }
  arr.push(now);
  hits.set(key, arr);
  return true;
}

const SHARE_MAX_ENTRIES = 2000;
const SHARE_TTL = 30 * 24 * 60 * 60 * 1000;
function purgeAndCapShares() {
  const now = Date.now();
  for (const k in shareMap) {
    if (!shareMap[k].ts || now - shareMap[k].ts > SHARE_TTL) delete shareMap[k];
  }
  const keys = Object.keys(shareMap);
  if (keys.length > SHARE_MAX_ENTRIES) {
    keys.sort(function (a, b) { return (shareMap[a].ts || 0) - (shareMap[b].ts || 0); });
    for (let i = 0; i < keys.length - SHARE_MAX_ENTRIES; i++) delete shareMap[keys[i]];
  }
}

function handleShareGet(res, id) {
  const rec = shareMap[id];
  if (!rec) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "分享不存在或已过期" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(rec));
}

// ---------- 热梗联网释义（B站检索代理 + 磁盘缓存）----------
// 设计 LLM 训练数据旧，不认识新梗；这里代查 B 站（热梗主阵地）视频标题/简介，
// 交给前端低倍率模型提炼成词典释义。查过的梗磁盘缓存 30 天，一个梗终身只查一次。
const MEME_CACHE_FILE = path.join(ROOT, "meme-cache.json");
let memeCache = {};
try { memeCache = JSON.parse(fs.readFileSync(MEME_CACHE_FILE, "utf8")) || {}; } catch (e) { }
const MEME_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const MEME_NEG_TTL = 24 * 60 * 60 * 1000;
const MEME_CACHE_MAX = 800;
let memeCacheTimer = null;
function persistMemeCache() {
  if (memeCacheTimer) return;
  memeCacheTimer = setTimeout(function () {
    memeCacheTimer = null;
    try { fs.writeFileSync(MEME_CACHE_FILE, JSON.stringify(memeCache)); } catch (e) { }
  }, 800);
}
function purgeMemeCache() {
  const now = Date.now();
  for (const k in memeCache) {
    const rec = memeCache[k];
    if (!rec.ts || now - rec.ts > (rec.f ? MEME_CACHE_TTL : MEME_NEG_TTL)) delete memeCache[k];
  }
  const keys = Object.keys(memeCache);
  if (keys.length > MEME_CACHE_MAX) {
    keys.sort(function (a, b) { return (memeCache[a].ts || 0) - (memeCache[b].ts || 0); });
    for (let i = 0; i < keys.length - MEME_CACHE_MAX; i++) delete memeCache[keys[i]];
  }
}
const BILI_UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Accept-Language": "zh-CN,zh;q=0.9"
};
let biliCookie = { v: "", ts: 0 };
async function getBiliCookie() {
  if (biliCookie.v && Date.now() - biliCookie.ts < 60 * 60 * 1000) return biliCookie.v;
  const r = await fetch("https://www.bilibili.com", { headers: BILI_UA, redirect: "follow" });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const c = sc.map(function (s) { return s.split(";")[0]; }).filter(function (s) { return /buvid|b_nut|b_lsid/i.test(s); }).join("; ");
  if (!c) throw new Error("NO_COOKIE");
  biliCookie = { v: c, ts: Date.now() };
  return c;
}
function stripTags(s) { return String(s).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(); }
async function biliMemeLookup(q) {
  const cookie = await getBiliCookie();
  const r = await fetch("https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=" + encodeURIComponent(q + " 梗"), {
    headers: Object.assign({}, BILI_UA, { Referer: "https://www.bilibili.com/", Cookie: cookie })
  });
  if (!r.ok) throw new Error("HTTP_" + r.status);
  const j = await r.json();
  const list = (j.data && j.data.result) || [];
  const parts = [];
  for (let i = 0; i < list.length && parts.length < 5; i++) {
    const t = stripTags(list[i].title);
    const d = stripTags(list[i].description || "");
    if (t.length < 4) continue;
    parts.push((parts.length + 1) + ". " + t.slice(0, 60) + (d ? "：" + d.slice(0, 80) : ""));
  }
  if (!parts.length) return null;
  return "B站相关视频（标题与简介）：" + parts.join(" ");
}
function handleMemeLookup(res, q, ip, sid, token) {
  const term = stripTags(q).slice(0, 30);
  if (!term) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "缺少词条" }));
    return;
  }
  if (!isLoopback(ip)) {
    if (!sessionOk(ip, sid, token)) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "会话无效，请刷新页面重试" }));
      return;
    }
    if (!rateOkKeyed("meme:" + ip, 120, 60 * 60 * 1000)) {
      res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "查询太频繁，请稍后再试" }));
      return;
    }
  }
  const cached = memeCache[term];
  if (cached) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ found: !!cached.f, text: cached.f ? cached.t : "" }));
    return;
  }
  biliMemeLookup(term).then(function (text) {
    memeCache[term] = text ? { f: 1, t: text, ts: Date.now() } : { f: 0, ts: Date.now() };
    purgeMemeCache();
    persistMemeCache();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ found: !!text, text: text || "" }));
  }).catch(function () {
    // 网络抖动不缓存负面，下次再试
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ found: false, text: "" }));
  });
}

const server = http.createServer(function (req, res) {
  const ip = clientIp(req);
  if (req.method === "GET" && req.url === "/api/session") {
    handleSession(res);
  } else if (req.method === "POST" && req.url === "/api/image") {
    handleImageStart(req, res, ip);
  } else if (req.method === "GET" && req.url.indexOf("/api/image/status") === 0) {
    const q = req.url.split("?")[1] || "";
    const m = q.match(/(?:^|&)id=([^&]+)/);
    handleImageStatus(res, m ? decodeURIComponent(m[1]) : "");
  } else if (req.method === "POST" && req.url === "/api/share") {
    handleSharePost(req, res, ip);
  } else if (req.method === "GET" && req.url.indexOf("/api/meme") === 0) {
    const q = req.url.split("?")[1] || "";
    const qm = q.match(/(?:^|&)q=([^&]+)/);
    const sm = q.match(/(?:^|&)sid=([^&]+)/);
    const tm = q.match(/(?:^|&)t=([^&]+)/);
    handleMemeLookup(res, qm ? decodeURIComponent(qm[1]) : "", ip, sm ? decodeURIComponent(sm[1]) : "", tm ? decodeURIComponent(tm[1]) : "");
  } else if (req.method === "GET" && req.url.indexOf("/api/share/") === 0) {
    handleShareGet(res, decodeURIComponent(req.url.slice("/api/share/".length).split("?")[0]));
  } else if (req.method === "GET" && (req.url === "/fx" || req.url === "/fx/")) {
    if (req.url === "/fx") { res.writeHead(302, { Location: "/fx/" }); res.end(); return; }
    serveStatic(req, res, "/fx/index.html");
  } else if (req.url === "/arena" || req.url.indexOf("/arena/") === 0) {
    if (req.url === "/arena") { res.writeHead(302, { Location: "/arena/" }); res.end(); return; }
    req.url = req.url.slice("/arena".length) || "/";
    arenaHandler(req, res);
  } else if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res, req.url);
  } else {
    res.writeHead(405); res.end("Method Not Allowed");
  }
});

server.listen(PORT, HOST, function () {
  console.log("meme-factory server listening on " + HOST + ":" + PORT);
});
