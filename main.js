import * as shared from "./server.js";
import * as render from "./render.js";
import { createMap } from "./map.js";

const { normalizeLevel, makePlayer, step, coinList } = shared;
const { drawWorld, drawPlayer, mixHex } = render;

const $ = (id) => document.getElementById(id);
const cv = $("game"), ctx = cv.getContext("2d");
const STEP = 1 / 120;

const sfx = Object.fromEntries(["jump", "die", "win", "coin"].map((n) => {
  const a = new Audio(`./sfx/${n}.wav`);
  a.volume = n === "jump" ? 0.35 : 0.6;
  return [n, a];
}));
const play = (n) => { const a = sfx[n].cloneNode(); a.volume = sfx[n].volume; a.play().catch(() => {}); };

const S = {
  me: null, myId: null, levels: [], archived: [], progress: {}, myRatings: {}, levelId: null, lv: null,
  p: null, rid: 0, attempt: 0, runStart: 0, mode: "loading", paused: false,
  others: new Map(), offset: 0, room: null, cam: null, bg: "#3b2a8c",
  particles: [], test: null, levelCache: new Map(),
};
const serverNow = () => Date.now() + S.offset;
const enemyTime = () => (S.lv.settings.clock === "run" ? (serverNow() - S.runStart) / 1000 : serverNow() / 1000);

// ---------------------------------------------------------------- canvas
let W = 0, H = 0;
function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  W = innerWidth; H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------- input
const keys = new Set();
const inp = { x: 0, y: 0, jump: false, jumpPressed: false };
const touch = { x: 0, y: 0, stickJump: false, tapJump: 0 };
const isTop = () => S.lv?.settings.view === "top";
const isTyping = (e) => /INPUT|TEXTAREA|SELECT/.test(e.target?.tagName) || e.target?.isContentEditable;
const JUMP_KEYS = ["ArrowUp", "KeyW", "Space"];

addEventListener("keydown", (e) => {
  if (S.paused || isTyping(e)) return;
  if (e.code === "Escape" && S.test) return endTest();
  if (JUMP_KEYS.includes(e.code) || e.code.startsWith("Arrow")) e.preventDefault();
  if (JUMP_KEYS.includes(e.code) && !e.repeat) inp.jumpPressed = true;
  keys.add(e.code);
});
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => keys.clear());

function readInput() {
  let x = 0;
  if (keys.has("ArrowLeft") || keys.has("KeyA")) x -= 1;
  if (keys.has("ArrowRight") || keys.has("KeyD")) x += 1;
  if (!x) x = touch.x;
  inp.x = x;
  let y = 0;
  if (keys.has("ArrowUp") || keys.has("KeyW")) y -= 1;
  if (keys.has("ArrowDown") || keys.has("KeyS")) y += 1;
  inp.y = y || touch.y;
  inp.jump = JUMP_KEYS.some((k) => keys.has(k)) || touch.stickJump || touch.tapJump > 0;
}

// joystick (touch devices)
const stick = $("stick"), knob = $("knob");
if (matchMedia("(pointer: coarse)").matches) stick.hidden = false;
let stickId = null;
function stickMove(e) {
  const r = stick.getBoundingClientRect();
  const R = r.width / 2;
  let dx = e.clientX - (r.left + R), dy = e.clientY - (r.top + R);
  const d = Math.hypot(dx, dy);
  if (d > R) { dx *= R / d; dy *= R / d; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  const nx = dx / R, ny = dy / R;
  touch.x = Math.abs(nx) < 0.15 ? 0 : nx;
  touch.y = Math.abs(ny) < 0.15 ? 0 : ny;
  const j = ny < -0.5;
  if (j && !touch.stickJump) inp.jumpPressed = true;
  touch.stickJump = j;
}
stick.addEventListener("pointerdown", (e) => { stickId = e.pointerId; stick.setPointerCapture(e.pointerId); stickMove(e); });
stick.addEventListener("pointermove", (e) => { if (e.pointerId === stickId) stickMove(e); });
const stickEnd = (e) => {
  if (e.pointerId !== stickId) return;
  stickId = null; touch.x = 0; touch.y = 0; touch.stickJump = false; knob.style.transform = "";
};
stick.addEventListener("pointerup", stickEnd);
stick.addEventListener("pointercancel", stickEnd);
// tapping the right half of the screen also jumps
cv.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" || e.clientX < W / 2 || isTop()) return;
  inp.jumpPressed = true; touch.tapJump++;
});
const tapUp = (e) => { if (e.pointerType !== "mouse" && e.clientX >= W / 2) touch.tapJump = Math.max(0, touch.tapJump - 1); };
cv.addEventListener("pointerup", tapUp);
cv.addEventListener("pointercancel", () => (touch.tapJump = 0));

// ---------------------------------------------------------------- UI helpers
const center = $("center"), attemptEl = $("attempt"), timerEl = $("timer");
let centerTimer = 0;
function say(html, ms = 0) {
  clearTimeout(centerTimer);
  center.innerHTML = html;
  center.hidden = !html;
  if (ms) centerTimer = setTimeout(() => (center.hidden = true), ms);
}
const fmt = (ms) => (ms == null ? "—" : (ms / 1000).toFixed(2) + "s");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function showAttempt() {
  attemptEl.textContent = `Attempt ${S.attempt}`;
  attemptEl.classList.add("show");
  requestAnimationFrame(() => setTimeout(() => attemptEl.classList.remove("show"), 700));
}

function updateOnline() {
  const n = S.others.size + 1;
  $("online").hidden = n < 2;
  $("online").textContent = `● ${n} online`;
}

// ---------------------------------------------------------------- progression
// A level is open if: it's first in the stack, you unlocked it before (unlocks
// are permanent even when the stack reshuffles), the level right before it is
// beaten, or it's yours. The server applies the same rule.
const beaten = (id) => (S.progress[id]?.completions || 0) > 0;
function isOpen(i) {
  const l = S.levels[i];
  if (!l) return false;
  return !!(S.me?.isOwner || l.mine || i === 0 || S.progress[l.id] || (i > 0 && beaten(S.levels[i - 1].id)));
}
function levelState(i) {
  const l = S.levels[i];
  if (beaten(l.id)) return "beaten";
  return isOpen(i) ? "open" : "locked";
}
function continueIndex() {
  return S.levels.findIndex((l, i) => !beaten(l.id) && isOpen(i));
}

function mergeProgress(src) {
  for (const [id, p] of Object.entries(src || {})) {
    const cur = S.progress[id];
    if (!cur) { S.progress[id] = { ...p }; continue; }
    cur.completions = Math.max(cur.completions || 0, p.completions || 0);
    if (p.best != null) cur.best = cur.best == null ? p.best : Math.min(cur.best, p.best);
  }
}

const mapBtn = $("mapBtn");
function updateLevelUI() {
  const i = S.levels.findIndex((l) => l.id === S.levelId);
  mapBtn.hidden = !S.levels.length && !S.archived.length;
  mapBtn.textContent = i >= 0 ? `Map · #${i + 1} ${S.levels[i].name}` : "Level map";
  map.refresh();
}

// ---------------------------------------------------------------- levels
async function refreshLevels() {
  let d;
  try { d = await (await fetch("/api/levels")).json(); } catch { return; }
  S.levels = d.levels || [];
  S.archived = d.archived || [];
  S.myRatings = d.myRatings || {};
  mergeProgress(d.progress);
  updateLevelUI();
  if ((S.mode === "empty" || S.mode === "done") && !S.test) pickStartLevel();
}

async function fetchLevel(id) {
  const meta = S.levels.find((l) => l.id === id);
  const c = S.levelCache.get(id);
  if (c && meta && c.updated_at === meta.updated_at) return c.data;
  const r = await fetch(`/api/level/${id}`);
  if (!r.ok) return null;
  const d = await r.json();
  S.levelCache.set(id, d);
  return d.data;
}

function pickStartLevel() {
  if (!S.levels.length) {
    S.mode = "empty"; S.lv = null; S.levelId = null;
    timerEl.hidden = true;
    say(S.me?.signedIn ? "No levels yet<small>Be the first — tap + Create</small>" : "No levels yet");
    updateLevelUI();
    return;
  }
  const i = continueIndex();
  if (i >= 0) return loadLevel(S.levels[i].id);
  S.mode = "done";
  updateLevelUI();
  say("You beat every level!<small>New levels appear as players make them</small>");
}

async function loadLevel(id) {
  hideResult();
  const data = await fetchLevel(id);
  if (!data) return refreshLevels();
  S.levelId = id;
  S.lv = normalizeLevel(data);
  S.attempt = 0;
  S.cam = null;
  say("");
  updateLevelUI();
  respawn();
}

function respawn() {
  S.rid++;
  S.attempt++;
  S.p = makePlayer(S.lv);
  S.runStart = serverNow();
  S.bg = S.lv.settings.bg;
  S.mode = S.test && !S.test.verify ? "test" : "play";
  timerEl.hidden = false;
  updateCoins();
  showAttempt();
  if (S.mode === "play") {
    send(S.test ? { type: "spawn", level: S.test.levelId, rid: S.rid, verify: true } : { type: "spawn", level: S.levelId, rid: S.rid });
  }
}

function die() {
  if (S.mode !== "play" && S.mode !== "test") return;
  S.mode = "dead";
  play("die");
  burst(S.p.x, S.p.y);
  setTimeout(() => { if (S.mode === "dead") respawn(); }, 650);
}

function finish() {
  play("win");
  const t = serverNow() - S.runStart;
  S.mode = "finishing";
  if (S.test && !S.test.verify) {
    say(`Test complete<small>${fmt(t)}</small>`, 1400);
    setTimeout(() => { if (S.test) respawn(); }, 1500);
    return;
  }
  say(`${S.test ? "Verifying" : "Level complete!"}<small>checking run…</small>`);
  send({ type: "finish", rid: S.rid, x: S.p.x, y: S.p.y, t: serverNow() });
  const rid = S.rid;
  setTimeout(() => {
    if (S.mode === "finishing" && S.rid === rid && S.verified !== rid) { say("Couldn't verify run — not connected", 1800); respawn(); }
  }, 5000);
}

const coinsEl = $("coins");
function updateCoins() {
  const total = S.lv ? coinList(S.lv).length : 0;
  coinsEl.hidden = !total;
  if (total) coinsEl.textContent = `● ${S.p.coins.size}/${total}`;
}

function burst(x, y) {
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2, v = 3 + Math.random() * 7;
    S.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 3, life: 0.7, s: 0.08 + Math.random() * 0.14 });
  }
}

// ---------------------------------------------------------------- rating
async function rate(levelId, stars) {
  const r = await fetch("/api/rate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level_id: levelId, stars }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { say(esc(d.error || "Couldn't rate"), 1600); return false; }
  S.myRatings[levelId] = stars;
  map.refresh();
  setTimeout(refreshLevels, 300);
  return true;
}

function starPicker(current, onPick) {
  const wrap = document.createElement("div");
  wrap.className = "stars pick";
  const paint = (n) => [...wrap.children].forEach((b, i) => b.classList.toggle("on", i < n));
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement("button");
    b.textContent = "★";
    b.title = `${i} star${i > 1 ? "s" : ""}`;
    b.onmouseenter = () => paint(i);
    b.onmouseleave = () => paint(current || 0);
    b.onclick = async () => { if (await onPick(i)) { current = i; paint(i); } };
    wrap.append(b);
  }
  paint(current || 0);
  return wrap;
}

// ---------------------------------------------------------------- result panel
const resultEl = $("result");
let resultNext = null;
function showResult(m) {
  say("");
  const lvl = S.levels.find((l) => l.id === m.level);
  const pb = m.best === m.time ? "New best!" : `Best ${fmt(m.best)}`;
  resultEl.replaceChildren();
  const add = (tag, cls, html) => { const e = document.createElement(tag); e.className = cls; e.innerHTML = html; resultEl.append(e); return e; };
  add("div", "r-title", "Level complete!");
  add("div", "r-sub", `${esc(lvl?.name || "")}${lvl?.author ? ` <span class="muted">by @${esc(lvl.author)}</span>` : ""}`);
  add("div", "r-time", `${fmt(m.time)} <span class="muted">· ${pb} · beaten ${m.completions}×</span>`);
  if (m.canRate) {
    add("div", "r-label", S.myRatings[m.level] ? "Your rating" : "Rate this level");
    resultEl.append(starPicker(S.myRatings[m.level], (n) => rate(m.level, n)));
  } else if (!m.saved) {
    add("div", "r-label", "Sign in to save progress and rate levels");
  }
  const btns = add("div", "r-btns", "");
  const mapB = document.createElement("button");
  mapB.className = "chip"; mapB.textContent = "Level map";
  mapB.onclick = () => { hideResult(); openMap(); };
  const nextB = document.createElement("button");
  nextB.className = "chip pri";
  resultNext = () => {
    hideResult();
    const i = continueIndex();
    const nextIdx = S.levels.findIndex((l) => l.id === m.next);
    if (m.next && nextIdx >= 0 && !beaten(m.next)) loadLevel(m.next);
    else if (i >= 0) loadLevel(S.levels[i].id);
    else pickStartLevel();
  };
  nextB.textContent = "Next ▶";
  nextB.onclick = resultNext;
  const retry = document.createElement("button");
  retry.className = "chip"; retry.textContent = "Replay";
  retry.onclick = () => { hideResult(); loadLevel(m.level); };
  btns.append(mapB, retry, nextB);
  resultEl.hidden = false;
}
function hideResult() { resultEl.hidden = true; resultNext = null; }
addEventListener("keydown", (e) => {
  if (resultNext && !resultEl.hidden && (e.code === "Enter" || e.code === "Space") && !isTyping(e)) { e.preventDefault(); resultNext(); }
});

// ---------------------------------------------------------------- map
const map = createMap({
  get S() { return S; },
  levelState, isOpen, continueIndex, starPicker, rate, fmt, esc,
  play: (id) => { closeMap(); loadLevel(id); },
});
function openMap() { S.paused = true; keys.clear(); map.open(); }
function closeMap() { map.close(); S.paused = false; }
map.onClose = () => (S.paused = false);
mapBtn.onclick = openMap;

// ---------------------------------------------------------------- network
function onMessage(ev) {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.type === "welcome") {
    S.myId = m.id;
    S.offset = m.now - Date.now();
    mergeProgress(m.progress);
    S.others.clear();
    for (const p of m.players) S.others.set(p.id, { ...p, x: 0, y: 0, tx: 0, ty: 0, seen: false });
    updateOnline();
    updateLevelUI();
    if (S.mode === "loading") pickStartLevel();
    else if (S.lv && (S.mode === "play" || S.mode === "dead")) respawn();
  } else if (m.type === "join") {
    S.others.set(m.player.id, { ...m.player, x: 0, y: 0, tx: 0, ty: 0, seen: false });
    updateOnline();
  } else if (m.type === "left") {
    S.others.delete(m.id);
    updateOnline();
  } else if (m.type === "lvl") {
    const o = S.others.get(m.id);
    if (o) { o.level = m.level; o.seen = false; }
  } else if (m.type === "snap") {
    for (const [id, level, x, y] of m.p) {
      const o = S.others.get(id);
      if (!o) continue;
      o.level = level; o.tx = x; o.ty = y;
      if (!o.seen) { o.x = x; o.y = y; o.seen = true; }
      o.at = performance.now();
    }
  } else if (m.type === "kill") {
    if (m.rid === S.rid && S.mode === "play") {
      if (m.reason === "desync") say("Run reset", 1200);
      die();
    }
  } else if (m.type === "reject") {
    if (m.rid !== S.rid) return;
    say(esc(m.reason), 2200);
    if (/Locked|unavailable|Not your|Sign in|goal/.test(m.reason)) {
      S.mode = "idle";
      if (S.test) setTimeout(() => endTest(null), 1600);
      else setTimeout(() => refreshLevels().then(pickStartLevel), 1200);
    } else setTimeout(respawn, 900);
  } else if (m.type === "verified") {
    if (m.rid !== S.rid || !S.test) return;
    S.verified = m.rid;
    say(`Verified!<small>${fmt(m.time)} · your level is live</small>`);
    setTimeout(() => endTest({ ok: true, time: m.time }), 1800);
  } else if (m.type === "result") {
    if (m.rid !== S.rid) return;
    S.verified = m.rid;
    S.progress[m.level] = { best: m.best, completions: m.completions };
    if (m.next && !S.progress[m.next]) S.progress[m.next] = { best: null, completions: 0 };
    S.mode = "result";
    updateLevelUI();
    showResult(m);
    refreshLevels();
  }
}

function send(msg) {
  try { S.room?.send(msg); } catch {}
}

async function connect() {
  if (typeof WebsimSocket === "undefined") return;
  try { S.room = await WebsimSocket.joinRoom(); } catch { return; }
  S.room.onmessage = onMessage;
  S.room.onclose = (e) => say(`Disconnected<small>${esc(e.reason || "")}</small>`);
}

// ---------------------------------------------------------------- editor / admin modules (code lives in the DB)
async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

const modules = {};
async function loadModule(name, path) {
  if (!modules[name]) {
    const r = await fetch(path);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    const url = URL.createObjectURL(new Blob([await r.text()], { type: "text/javascript" }));
    modules[name] = await import(url);
  }
  return modules[name];
}

function moduleCtx() {
  return { shared, render, api, playtest, verify, close: closeModules, openEditor, me: S.me };
}

async function openEditor(opts = {}) {
  let mod;
  try { mod = await loadModule("editor", "/api/editor/code"); }
  catch (err) { say(`Editor unavailable<small>${esc(err.message)}</small>`, 2500); return; }
  hideResult();
  S.paused = true;
  keys.clear();
  mod.default(moduleCtx(), opts);
}

$("createBtn").onclick = () => openEditor();
$("adminBtn").onclick = async () => {
  let mod;
  try { mod = await loadModule("admin", "/api/admin/code"); }
  catch (err) { say(`Admin unavailable<small>${esc(err.message)}</small>`, 2500); return; }
  hideResult();
  S.paused = true;
  keys.clear();
  mod.default(moduleCtx());
};

async function closeModules() {
  S.paused = false;
  S.levelCache.clear();
  await refreshLevels();
  if (S.levelId && S.levels.some((l) => l.id === S.levelId)) loadLevel(S.levelId);
  else pickStartLevel();
}

// Local practice run of unsaved editor data.
function playtest(data) {
  return startTest(data, { verify: false });
}
// Server-checked run of a saved level; resolves {ok,time} when the server verifies it.
function verify(levelId, data) {
  return startTest(data, { verify: true, levelId });
}
function startTest(data, opts) {
  return new Promise((resolve) => {
    S.test = { resolve, ...opts, prev: { lv: S.lv, levelId: S.levelId, attempt: S.attempt, p: S.p } };
    S.paused = false;
    S.lv = normalizeLevel(data);
    S.attempt = 0;
    S.cam = null;
    $("testLabel").textContent = opts.verify ? "Verification run — beat your level to publish it" : "Practice test (not recorded)";
    $("testBar").hidden = false;
    say("");
    respawn();
  });
}
function endTest(result = null) {
  if (!S.test) return;
  const { resolve, prev } = S.test;
  S.test = null;
  S.rid++; // drop any in-flight server run
  $("testBar").hidden = true;
  Object.assign(S, prev);
  S.cam = null;
  S.paused = true;
  S.mode = "idle";
  say("");
  resolve(result);
}
$("testExit").onclick = () => endTest(null);

// ---------------------------------------------------------------- loop
let last = performance.now(), acc = 0, sendAcc = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  readInput();
  if (!S.paused && (S.mode === "play" || S.mode === "test")) {
    acc += dt;
    while (acc >= STEP) {
      acc -= STEP;
      const ev = step(S.p, inp, STEP, S.lv, enemyTime());
      inp.jumpPressed = false;
      if (S.p.gotCoin) {
        S.p.gotCoin = false;
        play("coin");
        updateCoins();
        if (S.mode === "play") send({ type: "pos", rid: S.rid, x: +S.p.x.toFixed(3), y: +S.p.y.toFixed(3), t: serverNow() });
      }
      if (S.p.jumped) { S.p.jumped = false; play("jump"); }
      if (S.p.padded) { S.p.padded = false; play("jump"); }
      if (ev === "dead") { die(); break; }
      if (ev === "goal") { finish(); break; }
    }
    if (S.mode === "play") {
      sendAcc += dt;
      if (sendAcc >= 0.05) {
        sendAcc = 0;
        send({ type: "pos", rid: S.rid, x: +S.p.x.toFixed(3), y: +S.p.y.toFixed(3), t: serverNow() });
      }
    }
  } else acc = 0;
  if (S.mode === "play" || S.mode === "test") timerEl.textContent = ((serverNow() - S.runStart) / 1000).toFixed(2);
  draw(dt);
  requestAnimationFrame(frame);
}

function draw(dt) {
  if (!S.lv || !S.p) {
    render.drawBackground(ctx, W, H, "#3b2a8c");
    return;
  }
  const lv = S.lv, p = S.p;
  const top = lv.settings.view === "top";
  // top-down: fit the whole maze when it reasonably can; side: fixed zoom that follows
  const ts = top
    ? Math.max(Math.min(H / 11, W / 16) * 0.45, Math.min(H / (lv.h + 1), W / (lv.w + 1), 64))
    : Math.max(18, Math.min(H / 11, W / 16));
  const vw = W / ts, vh = H / ts;
  let tx = p.x - (lv.settings.autorun && !top ? vw * 0.3 : vw * 0.5);
  tx = lv.w > vw ? Math.max(0, Math.min(lv.w - vw, tx)) : (lv.w - vw) / 2;
  let ty = p.y - vh * (top ? 0.5 : 0.55);
  ty = lv.h > vh ? Math.max(0, Math.min(lv.h - vh, ty)) : (lv.h - vh) / 2;
  if (!S.cam) S.cam = { x: tx, y: ty };
  const k = 1 - Math.exp(-dt * (S.mode === "dead" ? 3 : 10));
  S.cam.x = lv.settings.autorun && !top && S.mode !== "dead" ? tx : S.cam.x + (tx - S.cam.x) * k;
  S.cam.y += (ty - S.cam.y) * (1 - Math.exp(-dt * 6));

  let target = lv.settings.bg;
  if (!top) for (const c of lv.colors) if (c.x <= p.x) target = c.color;
  S.bg = mixHex(S.bg, target, 1 - Math.exp(-dt * 4));

  const cam = { ox: S.cam.x, oy: S.cam.y, ts, W, H };
  const t = performance.now() / 1000;
  drawWorld(ctx, lv, cam, t, enemyTime(), S.bg, p.coins);
  const floorY = (lv.h - cam.oy) * ts;
  if (floorY < H && !top) { ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fillRect(0, floorY, W, H - floorY); }

  // other players on this level
  if (!S.test) {
    const kk = 1 - Math.exp(-dt * 14);
    for (const o of S.others.values()) {
      if (o.level !== S.levelId || !o.seen || performance.now() - o.at > 3000) continue;
      o.x += (o.tx - o.x) * kk; o.y += (o.ty - o.y) * kk;
      drawPlayer(ctx, (o.x - cam.ox) * ts, (o.y - cam.oy) * ts, ts, o.username, { alpha: 0.45, ring: "#ffffff", label: o.username ? "@" + o.username : null });
    }
  }

  for (const q of S.particles) {
    q.life -= dt; q.vy += 30 * dt; q.x += q.vx * dt; q.y += q.vy * dt;
    ctx.fillStyle = `rgba(255,138,31,${Math.max(0, q.life / 0.7)})`;
    ctx.fillRect((q.x - cam.ox) * ts, (q.y - cam.oy) * ts, q.s * ts, q.s * ts);
  }
  S.particles = S.particles.filter((q) => q.life > 0);

  if (S.mode !== "dead") drawPlayer(ctx, (p.x - cam.ox) * ts, (p.y - cam.oy) * ts, ts, S.me?.username);
}

// ---------------------------------------------------------------- boot
(async function boot() {
  requestAnimationFrame(frame);
  try { S.me = await (await fetch("/api/me")).json(); } catch { S.me = {}; }
  $("adminBtn").hidden = !S.me.isOwner;
  $("createBtn").hidden = !S.me.signedIn;
  await refreshLevels();
  // don't make players stare at an empty screen if the room is slow to welcome us
  setTimeout(() => { if (S.mode === "loading") pickStartLevel(); }, 2500);
  await connect();
  setInterval(refreshLevels, 30000);
})();
