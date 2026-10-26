// ============================================================
// Shared game rules — imported by the page as well (deterministic sim)
// ============================================================
export const TILE_CHARS = ".#_-^v<>oudG%c";
export const HB = 0.38;   // player half-box (tiles)
export const PR = 0.44;   // player draw radius
export const MAXV = 30;   // terminal velocity
export const PAD_MULT = 1.4;
const CLIENT_HAZ_R = 0.26;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, a, b, d) => (Number.isFinite(+v) && v !== null && v !== "" ? clamp(+v, a, b) : d);
const int = (v, a, b, d) => Math.round(num(v, a, b, d));
const color = (v, d) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : d);

export const DEFAULT_SETTINGS = { view: "side", speed: 8, jump: 2.4, gravity: 70, autorun: false, bg: "#3b2a8c", clock: "world" };
export const TOP_SPEED = 4; // default move speed for new top-down levels

export function normalizeLevel(d) {
  d = d && typeof d === "object" ? d : {};
  const w = int(d.w, 8, 2000, 80), h = int(d.h, 6, 60, 14);
  const rows = [];
  const src = Array.isArray(d.rows) ? d.rows : [];
  for (let y = 0; y < h; y++) {
    const r = String(src[y] ?? "").replace(/[^.#_\-^v<>oudG%c]/g, ".");
    rows.push(r.padEnd(w, ".").slice(0, w));
  }
  const s = d.settings || {};
  const settings = {
    view: s.view === "top" ? "top" : "side",
    speed: num(s.speed, 1, 40, DEFAULT_SETTINGS.speed),
    jump: num(s.jump, 0.5, 12, DEFAULT_SETTINGS.jump),
    gravity: num(s.gravity, 5, 300, DEFAULT_SETTINGS.gravity),
    autorun: !!s.autorun,
    bg: color(s.bg, DEFAULT_SETTINGS.bg),
    clock: s.clock === "run" ? "run" : "world",
  };
  const sp = d.spawn || {};
  const spawn = { x: int(sp.x, 0, w - 1, 2), y: int(sp.y, 0, h - 1, h - 3) };
  const enemies = (Array.isArray(d.enemies) ? d.enemies : []).slice(0, 400).map((e) => ({
    x1: num(e.x1, -5, w + 5, 0), y1: num(e.y1, -5, h + 5, 0),
    x2: num(e.x2, -5, w + 5, 0), y2: num(e.y2, -5, h + 5, 0),
    speed: num(e.speed, -40, 40, 3), wait: num(e.wait, 0, 30, 0.5),
    size: num(e.size, 0.15, 4, 0.45), phase: num(e.phase, -1000, 1000, 0),
    kind: e.kind === "block" || e.kind === "dot" ? e.kind : "saw",
    path: e.path === "circle" ? "circle" : "line",
  }));
  const colors = (Array.isArray(d.colors) ? d.colors : []).slice(0, 400)
    .map((c) => ({ x: num(c.x, 0, w, 0), color: color(c.color, "#000000") }))
    .sort((a, b) => a.x - b.x);
  return { v: 1, w, h, rows, spawn, enemies, colors, settings };
}

export function tileAt(lv, cx, cy) {
  if (cy < 0 || cy >= lv.h || cx < 0 || cx >= lv.w) return ".";
  return lv.rows[cy][cx];
}

// Solid rect for a tile, or null. One-way platforms flagged.
function solidRect(c, cx, cy) {
  if (c === "#") return [cx, cy, cx + 1, cy + 1, false];
  if (c === "_") return [cx, cy + 0.5, cx + 1, cy + 1, false];
  if (c === "-") return [cx, cy, cx + 1, cy + 0.2, true];
  return null;
}

export function spikeTri(c, cx, cy) {
  const a = 0.08, b = 0.92;
  if (c === "^") return [cx + a, cy + 1, cx + b, cy + 1, cx + 0.5, cy + a];
  if (c === "v") return [cx + a, cy, cx + b, cy, cx + 0.5, cy + b];
  if (c === "<") return [cx + 1, cy + a, cx + 1, cy + b, cx + a, cy + 0.5];
  if (c === ">") return [cx, cy + a, cx, cy + b, cx + b, cy + 0.5];
  return null;
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  const qx = ax + dx * t - px, qy = ay + dy * t - py;
  return qx * qx + qy * qy;
}
function circleTri(px, py, r, T) {
  const [x1, y1, x2, y2, x3, y3] = T;
  const s1 = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
  const s2 = (x3 - x2) * (py - y2) - (y3 - y2) * (px - x2);
  const s3 = (x1 - x3) * (py - y3) - (y1 - y3) * (px - x3);
  if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
  const r2 = r * r;
  return segDist2(px, py, x1, y1, x2, y2) < r2 || segDist2(px, py, x2, y2, x3, y3) < r2 || segDist2(px, py, x3, y3, x1, y1) < r2;
}

export function enemyPos(e, t) {
  const dx = e.x2 - e.x1, dy = e.y2 - e.y1, L = Math.hypot(dx, dy);
  if (L < 1e-6 || !e.speed) return { x: e.x1, y: e.y1 };
  if (e.path === "circle") {
    // orbit around (x1,y1) through (x2,y2); speed = tiles/s along the circle (negative = reverse)
    const a = Math.atan2(dy, dx) + (e.speed / L) * (t + e.phase);
    return { x: e.x1 + Math.cos(a) * L, y: e.y1 + Math.sin(a) * L };
  }
  const sp = Math.abs(e.speed);
  const mt = L / sp, cyc = 2 * (mt + e.wait);
  const u = (((t + e.phase) % cyc) + cyc) % cyc;
  let f;
  if (u < e.wait) f = 0;
  else if (u < e.wait + mt) f = (u - e.wait) / mt;
  else if (u < 2 * e.wait + mt) f = 1;
  else f = 1 - (u - 2 * e.wait - mt) / mt;
  return { x: e.x1 + dx * f, y: e.y1 + dy * f };
}

// Spike/enemy contact for a circle of radius r at (x,y); et = enemy clock seconds.
export function hazardAt(lv, x, y, r, et, enemyScale = 1) {
  const cx0 = Math.floor(x - r - 1), cx1 = Math.floor(x + r + 1);
  const cy0 = Math.floor(y - r - 1), cy1 = Math.floor(y + r + 1);
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
    const T = spikeTri(tileAt(lv, cx, cy), cx, cy);
    if (T && circleTri(x, y, r, T)) return true;
  }
  for (const e of lv.enemies) {
    const p = enemyPos(e, et);
    const s = e.size * enemyScale;
    if (e.kind === "block") {
      const qx = clamp(x, p.x - s, p.x + s), qy = clamp(y, p.y - s, p.y + s);
      if ((qx - x) ** 2 + (qy - y) ** 2 < r * r) return true;
    } else if ((p.x - x) ** 2 + (p.y - y) ** 2 < (s + r) ** 2) return true;
  }
  return false;
}

export function makePlayer(lv) {
  const top = lv.settings.view === "top";
  return { x: lv.spawn.x + 0.5, y: top ? lv.spawn.y + 0.5 : lv.spawn.y + 1 - HB, vx: 0, vy: 0, g: 1, ground: false, coyote: 0, buf: 0, coins: new Set() };
}

// Coin cells of a level: [{x, y, k}] (cached per level object)
const coinCache = new WeakMap();
export function coinList(lv) {
  let c = coinCache.get(lv);
  if (!c) {
    c = [];
    for (let y = 0; y < lv.h; y++) for (let x = 0; x < lv.w; x++) if (lv.rows[y][x] === "c") c.push({ x: x + 0.5, y: y + 0.5, k: x + "," + y });
    coinCache.set(lv, c);
  }
  return c;
}

// Coins, goal and hazards — shared by both views.
function contacts(p, lv, et) {
  for (const c of coinList(lv)) {
    if (!p.coins.has(c.k) && Math.abs(p.x - c.x) < 0.3 + HB && Math.abs(p.y - c.y) < 0.3 + HB) { p.coins.add(c.k); p.gotCoin = true; }
  }
  if (hazardAt(lv, p.x, p.y, CLIENT_HAZ_R, et)) return "dead";
  if (p.coins.size >= coinList(lv).length) {
    const cx = Math.floor(p.x), cy = Math.floor(p.y);
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++)
      if (tileAt(lv, x, y) === "G" && Math.abs(p.x - (x + 0.5)) < 0.5 + HB * 0.5 && Math.abs(p.y - (y + 0.5)) < 0.5 + HB * 0.5) return "goal";
  }
  return null;
}

function collideYTop(p, lv) {
  for (let cy = Math.floor(p.y - HB); cy <= Math.floor(p.y + HB - 1e-6); cy++)
    for (let cx = Math.floor(p.x - HB + 1e-4); cx <= Math.floor(p.x + HB - 1e-4); cx++) {
      const R = solidRect(tileAt(lv, cx, cy), cx, cy);
      if (!R) continue;
      if (p.x + HB <= R[0] + 1e-4 || p.x - HB >= R[2] - 1e-4) continue;
      if (p.y + HB <= R[1] || p.y - HB >= R[3]) continue;
      p.y = p.y < (R[1] + R[3]) / 2 ? R[1] - HB : R[3] + HB;
      p.vy = 0;
    }
}

// Top-down step: free 4-way movement, no gravity.
export function stepTop(p, inp, dt, lv, et) {
  const S = lv.settings;
  let ix = clamp(inp.x || 0, -1, 1), iy = clamp(inp.y || 0, -1, 1);
  const m = Math.hypot(ix, iy);
  if (m > 1) { ix /= m; iy /= m; }
  p.vx = ix * S.speed; p.vy = iy * S.speed;
  p.x = clamp(p.x + p.vx * dt, HB, lv.w - HB);
  collideX(p, lv, true);
  p.y = clamp(p.y + p.vy * dt, HB, lv.h - HB);
  collideYTop(p, lv);
  return contacts(p, lv, et);
}

export function step(p, inp, dt, lv, et) {
  return lv.settings.view === "top" ? stepTop(p, inp, dt, lv, et) : stepPlayer(p, inp, dt, lv, et);
}

function collideX(p, lv, top = false) {
  let hit = false;
  for (let cy = Math.floor(p.y - HB); cy <= Math.floor(p.y + HB - 1e-6); cy++)
    for (let cx = Math.floor(p.x - HB); cx <= Math.floor(p.x + HB - 1e-6); cx++) {
      const R = solidRect(tileAt(lv, cx, cy), cx, cy);
      if (!R || (R[4] && !top)) continue;
      if (p.y + HB <= R[1] + 1e-4 || p.y - HB >= R[3] - 1e-4) continue;
      if (p.x + HB <= R[0] || p.x - HB >= R[2]) continue;
      if (p.x < (R[0] + R[2]) / 2) p.x = R[0] - HB; else p.x = R[2] + HB;
      p.vx = 0; hit = true;
    }
  return hit;
}

function collideY(p, lv, prevY) {
  let landed = false;
  for (let cy = Math.floor(p.y - HB); cy <= Math.floor(p.y + HB - 1e-6); cy++)
    for (let cx = Math.floor(p.x - HB + 1e-4); cx <= Math.floor(p.x + HB - 1e-4); cx++) {
      const R = solidRect(tileAt(lv, cx, cy), cx, cy);
      if (!R) continue;
      if (p.x + HB <= R[0] + 1e-4 || p.x - HB >= R[2] - 1e-4) continue;
      if (p.y + HB <= R[1] || p.y - HB >= R[3]) continue;
      if (R[4]) {
        if (p.g > 0 && p.vy >= 0 && prevY + HB <= R[1] + 1e-3) { p.y = R[1] - HB; p.vy = 0; landed = true; }
        else if (p.g < 0 && p.vy <= 0 && prevY - HB >= R[3] - 1e-3) { p.y = R[3] + HB; p.vy = 0; landed = true; }
        continue;
      }
      if (p.y < (R[1] + R[3]) / 2) { p.y = R[1] - HB; if (p.g > 0) landed = true; }
      else { p.y = R[3] + HB; if (p.g < 0) landed = true; }
      p.vy = 0;
    }
  return landed;
}

// One fixed step. inp: {x:-1..1, jump:held, jumpPressed:edge}. Returns "dead" | "goal" | null.
export function stepPlayer(p, inp, dt, lv, et) {
  const S = lv.settings;
  const jv = Math.sqrt(2 * S.gravity * S.jump);
  if (S.autorun) p.vx = S.speed;
  else {
    const target = clamp(inp.x || 0, -1, 1) * S.speed;
    const a = (p.ground ? 90 : 60) * dt;
    p.vx += clamp(target - p.vx, -a, a);
  }
  if (inp.jumpPressed) p.buf = 0.12; else p.buf = Math.max(0, p.buf - dt);
  p.coyote = p.ground ? 0.08 : Math.max(0, p.coyote - dt);
  if ((p.buf > 0 || inp.jump) && p.coyote > 0) {
    p.vy = -p.g * jv; p.buf = 0; p.coyote = 0; p.ground = false; p.jumped = true;
  }
  p.vy = clamp(p.vy + p.g * S.gravity * dt, -MAXV, MAXV);

  p.x += p.vx * dt;
  if (p.x < HB) { p.x = HB; p.vx = 0; }
  if (collideX(p, lv) && S.autorun) return "dead";
  const prevY = p.y;
  p.y += p.vy * dt;
  p.ground = collideY(p, lv, prevY);

  // specials
  for (let cy = Math.floor(p.y - HB); cy <= Math.floor(p.y + HB); cy++)
    for (let cx = Math.floor(p.x - HB); cx <= Math.floor(p.x + HB); cx++) {
      const c = tileAt(lv, cx, cy);
      if (c === "o") {
        const top = p.g > 0 ? cy + 0.7 : cy, bot = p.g > 0 ? cy + 1 : cy + 0.3;
        if (p.x + HB > cx + 0.1 && p.x - HB < cx + 0.9 && p.y + HB > top && p.y - HB < bot) {
          p.vy = -p.g * jv * PAD_MULT; p.ground = false; p.coyote = 0; p.padded = true;
        }
      } else if (c === "u" || c === "d") {
        if (Math.abs(p.x - (cx + 0.5)) < 0.6 && Math.abs(p.y - (cy + 0.5)) < 0.8) p.g = c === "u" ? -1 : 1;
      }
    }
  if (p.y > lv.h + 2 || p.y < -3) return "dead";
  return contacts(p, lv, et);
}

// Straight-line distance spawn -> nearest goal tile (for min finish time).
export function goalDistance(lv) {
  let best = Infinity;
  for (let y = 0; y < lv.h; y++) for (let x = 0; x < lv.w; x++)
    if (lv.rows[y][x] === "G") {
      const dx = Math.abs(x - lv.spawn.x), dy = lv.settings.view === "top" ? Math.abs(y - lv.spawn.y) : 0;
      best = Math.min(best, Math.max(0, Math.hypot(dx, dy) - 1.5));
    }
  return best === Infinity ? 0 : best;
}

// ============================================================
// The level stack — community levels ordered by rating & time
// ============================================================
// Position in the stack: a Bayesian star rating (unrated levels start at 3★)
// minus a penalty that grows with the average finish time, so well-loved,
// quick levels come first and long, punishing ones sink further down.
export const STACK_RULES = { prior: 3, priorWeight: 3, timeWeight: 0.8, timeScaleSec: 20, archiveOnes: 5, archiveAvg: 2 };

export function rankScore(ratingSum, ratingCount, avgMs) {
  const R = STACK_RULES;
  const bayes = (ratingSum + R.prior * R.priorWeight) / (ratingCount + R.priorWeight);
  return bayes - R.timeWeight * Math.log(1 + (avgMs || 0) / 1000 / R.timeScaleSec);
}

let stackCache = { at: 0, data: null };
const invalidateStack = () => (stackCache.at = 0);

async function getStack(env) {
  if (stackCache.data && Date.now() - stackCache.at < 8000) return stackCache.data;
  const [lv, rt, tm] = await env.DB.batch([
    env.DB.prepare("SELECT id, user_id, username, name, view, perm_keep, verified_ms, created_at, updated_at FROM levels WHERE status = 'published'"),
    env.DB.prepare("SELECT level_id, COUNT(*) AS n, SUM(stars) AS s, SUM(CASE WHEN stars = 1 THEN 1 ELSE 0 END) AS ones FROM ratings GROUP BY level_id"),
    env.DB.prepare("SELECT level_id, AVG(time_ms) AS avg, COUNT(*) AS n FROM runs GROUP BY level_id"),
  ]);
  const ratings = new Map(rt.results.map((r) => [r.level_id, r]));
  const times = new Map(tm.results.map((r) => [r.level_id, r]));
  const all = lv.results.map((l) => {
    const r = ratings.get(l.id) || { n: 0, s: 0, ones: 0 };
    const t = times.get(l.id);
    const avgMs = Math.round(t?.avg ?? l.verified_ms ?? 0);
    const rating = r.n ? r.s / r.n : null;
    return {
      id: l.id, name: l.name, author: l.username, author_id: l.user_id, view: l.view,
      rating, ratings: r.n, ones: r.ones || 0, avgMs, finishes: t?.n || 0,
      keep: !!l.perm_keep, created_at: l.created_at, updated_at: l.updated_at,
      archived: !l.perm_keep && (r.ones || 0) >= STACK_RULES.archiveOnes && rating !== null && rating < STACK_RULES.archiveAvg,
      score: rankScore(r.s || 0, r.n, avgMs),
    };
  });
  const live = all.filter((l) => !l.archived).sort((a, b) => b.score - a.score || a.created_at - b.created_at);
  const data = { live, archived: all.filter((l) => l.archived), ids: live.map((l) => l.id), byId: new Map(all.map((l) => [l.id, l])) };
  stackCache = { at: Date.now(), data };
  return data;
}

// Public view of a stack entry (no user ids).
function pub(l, uid) {
  const { author_id, score, ...rest } = l;
  return { ...rest, mine: !!uid && author_id === uid };
}

// ============================================================
// Backend
// ============================================================
export const schema = `
  CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS levels (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT, name TEXT NOT NULL, view TEXT NOT NULL DEFAULT 'side', data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', perm_keep INTEGER NOT NULL DEFAULT 0, verified_ms INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS levels_user ON levels (user_id);
  CREATE INDEX IF NOT EXISTS levels_status ON levels (status);
  CREATE TABLE IF NOT EXISTS ratings (user_id TEXT NOT NULL, username TEXT, level_id INTEGER NOT NULL, stars INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, level_id));
  CREATE TABLE IF NOT EXISTS progress (user_id TEXT NOT NULL, username TEXT, level_id INTEGER NOT NULL, completions INTEGER NOT NULL DEFAULT 0, best_ms INTEGER, last_ms INTEGER, updated_at INTEGER, PRIMARY KEY (user_id, level_id));
  CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT, level_id INTEGER NOT NULL, time_ms INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS runs_user ON runs (user_id);
  CREATE INDEX IF NOT EXISTS runs_level ON runs (level_id);
  CREATE INDEX IF NOT EXISTS runs_created ON runs (created_at);
  CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS chat_created ON chat (created_at);
`;

const json = (d, status = 200) => Response.json(d, { status, headers: { "cache-control": "no-store" } });

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

async function deleteLevel(env, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM levels WHERE id = ?").bind(id),
    env.DB.prepare("DELETE FROM ratings WHERE level_id = ?").bind(id),
    env.DB.prepare("DELETE FROM progress WHERE level_id = ?").bind(id),
    env.DB.prepare("DELETE FROM runs WHERE level_id = ?").bind(id),
  ]);
  invalidateStack();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const m = request.method;
    const uid = request.headers.get("x-websim-user-id");
    const username = request.headers.get("x-websim-username");
    const signedIn = !!uid && !!username && request.headers.get("x-websim-user-is-anonymous") !== "true";
    const owner = !!uid && uid === request.headers.get("x-websim-project-owner-id");
    let mm;

    if (m === "GET" && path === "/api/me") return json({ userId: uid, username, signedIn, isOwner: owner });

    // The whole stack + this visitor's progress.
    if (m === "GET" && path === "/api/levels") {
      const st = await getStack(env);
      const progress = {}, myRatings = {};
      if (uid) {
        const [p, r] = await env.DB.batch([
          env.DB.prepare("SELECT level_id, completions, best_ms FROM progress WHERE user_id = ?").bind(uid),
          env.DB.prepare("SELECT level_id, stars FROM ratings WHERE user_id = ?").bind(uid),
        ]);
        for (const x of p.results) progress[x.level_id] = { completions: x.completions, best: x.best_ms };
        for (const x of r.results) myRatings[x.level_id] = x.stars;
      }
      return json({
        levels: st.live.map((l) => pub(l, uid)),
        archived: st.archived.filter((l) => progress[l.id] || l.author_id === uid).map((l) => pub(l, uid)),
        progress, myRatings, rules: STACK_RULES,
      });
    }

    if (m === "GET" && (mm = path.match(/^\/api\/level\/(\d+)$/))) {
      const row = await env.DB.prepare("SELECT id, user_id, username, name, data, status, updated_at FROM levels WHERE id = ?").bind(+mm[1]).first();
      if (!row || (row.status !== "published" && !owner && row.user_id !== uid)) return json({ error: "Not found" }, 404);
      return json({ id: row.id, name: row.name, author: row.username, status: row.status, updated_at: row.updated_at, data: normalizeLevel(JSON.parse(row.data)) });
    }

    // Rate a level you have beaten (server checks your verified progress).
    if (m === "POST" && path === "/api/rate") {
      if (!signedIn) return json({ error: "Sign in to rate levels" }, 401);
      const b = await readBody(request);
      const id = +b.level_id, stars = Math.round(+b.stars);
      if (!(stars >= 1 && stars <= 5)) return json({ error: "Stars must be 1-5" }, 400);
      const [lvl, pr] = await env.DB.batch([
        env.DB.prepare("SELECT user_id, status FROM levels WHERE id = ?").bind(id),
        env.DB.prepare("SELECT completions FROM progress WHERE user_id = ? AND level_id = ?").bind(uid, id),
      ]);
      const L = lvl.results[0];
      if (!L || L.status !== "published") return json({ error: "Level not found" }, 404);
      if (L.user_id === uid) return json({ error: "You can't rate your own level" }, 403);
      if (!(pr.results[0]?.completions > 0)) return json({ error: "Beat the level to rate it" }, 403);
      await env.DB.prepare(
        "INSERT INTO ratings (user_id, username, level_id, stars, created_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(user_id, level_id) DO UPDATE SET stars = excluded.stars, username = excluded.username, created_at = excluded.created_at"
      ).bind(uid, username, id, stars, Date.now()).run();
      invalidateStack();
      return json({ ok: true, stars });
    }

    // ---------------- creators (any signed-in user) ----------------
    if (path === "/api/editor/code" || path.startsWith("/api/my/")) {
      if (!signedIn) return json({ error: "Sign in to make levels" }, 401);

      if (m === "GET" && path === "/api/editor/code") {
        const code = await env.DB.prepare("SELECT value FROM secrets WHERE key = 'editor_code'").first("value");
        if (!code) return json({ error: "Editor missing" }, 404);
        return new Response(code, { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });
      }

      if (m === "GET" && path === "/api/my/levels") {
        const { results } = await env.DB.prepare("SELECT id, name, view, status, verified_ms, created_at, updated_at FROM levels WHERE user_id = ? ORDER BY updated_at DESC").bind(uid).all();
        const st = await getStack(env);
        return json(results.map((r) => {
          const s = st.byId.get(r.id);
          return { ...r, archived: !!s?.archived, position: s && !s.archived ? st.ids.indexOf(r.id) + 1 : null, rating: s?.rating ?? null, ratings: s?.ratings || 0, finishes: s?.finishes || 0 };
        }));
      }

      if (m === "POST" && path === "/api/my/levels") {
        const b = await readBody(request);
        const lvData = normalizeLevel(b.data);
        const data = JSON.stringify(lvData);
        const view = lvData.settings.view;
        if (data.length > 120000) return json({ error: "Level too big — make it smaller" }, 400);
        const name = String(b.name ?? "").trim().slice(0, 40) || "Untitled";
        const now = Date.now();
        if (b.id) {
          const row = await env.DB.prepare("SELECT user_id, data, status FROM levels WHERE id = ?").bind(+b.id).first();
          if (!row) return json({ error: "Not found" }, 404);
          if (row.user_id !== uid && !owner) return json({ error: "Not your level" }, 403);
          const changed = row.data !== data;
          // Any change to the map needs a fresh verified win before it is live again.
          await env.DB.prepare("UPDATE levels SET name = ?, view = ?, data = ?, updated_at = ?, status = ?, verified_ms = CASE WHEN ? THEN NULL ELSE verified_ms END WHERE id = ?")
            .bind(name, view, data, now, changed ? "draft" : row.status, changed ? 1 : 0, +b.id).run();
          invalidateStack();
          return json({ id: +b.id, updated_at: now, status: changed ? "draft" : row.status });
        }
        const r = await env.DB.prepare("INSERT INTO levels (user_id, username, name, view, data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)")
          .bind(uid, username, name, view, data, now, now).run();
        return json({ id: r.meta.last_row_id, updated_at: now, status: "draft" });
      }

      if (m === "DELETE" && (mm = path.match(/^\/api\/my\/levels\/(\d+)$/))) {
        const row = await env.DB.prepare("SELECT user_id FROM levels WHERE id = ?").bind(+mm[1]).first();
        if (!row) return json({ error: "Not found" }, 404);
        if (row.user_id !== uid && !owner) return json({ error: "Not your level" }, 403);
        await deleteLevel(env, +mm[1]);
        return json({ ok: true });
      }
    }

    // ---------------- owner-only ----------------
    if (path.startsWith("/api/admin/")) {
      if (!owner) return json({ error: "Forbidden" }, 403);

      if (m === "GET" && path === "/api/admin/code") {
        const code = await env.DB.prepare("SELECT value FROM secrets WHERE key = 'admin_code'").first("value");
        if (!code) return json({ error: "Admin code missing" }, 404);
        return new Response(code, { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });
      }

      if (m === "GET" && path === "/api/admin/levels") {
        const { results } = await env.DB.prepare("SELECT id, user_id, username, name, view, status, perm_keep, verified_ms, created_at, updated_at FROM levels ORDER BY updated_at DESC LIMIT 2000").all();
        const st = await getStack(env);
        return json(results.map((r) => {
          const s = st.byId.get(r.id);
          return { ...r, archived: !!s?.archived, position: s && !s.archived ? st.ids.indexOf(r.id) + 1 : null, rating: s?.rating ?? null, ratings: s?.ratings || 0, ones: s?.ones || 0, avgMs: s?.avgMs ?? null, finishes: s?.finishes || 0 };
        }));
      }

      if (m === "POST" && (mm = path.match(/^\/api\/admin\/levels\/(\d+)\/keep$/))) {
        const { keep } = await readBody(request);
        await env.DB.prepare("UPDATE levels SET perm_keep = ? WHERE id = ?").bind(keep ? 1 : 0, +mm[1]).run();
        invalidateStack();
        return json({ ok: true });
      }

      if (m === "POST" && (mm = path.match(/^\/api\/admin\/levels\/(\d+)\/unpublish$/))) {
        await env.DB.prepare("UPDATE levels SET status = 'draft' WHERE id = ?").bind(+mm[1]).run();
        invalidateStack();
        return json({ ok: true });
      }

      if (m === "DELETE" && (mm = path.match(/^\/api\/admin\/levels\/(\d+)$/))) {
        await deleteLevel(env, +mm[1]);
        return json({ ok: true });
      }

      if (m === "GET" && path === "/api/admin/players") {
        const [prog, runs, levels] = await env.DB.batch([
          env.DB.prepare("SELECT * FROM progress ORDER BY updated_at DESC LIMIT 3000"),
          env.DB.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT 300"),
          env.DB.prepare("SELECT id, name, username FROM levels"),
        ]);
        const st = await getStack(env);
        return json({ progress: prog.results, runs: runs.results, levels: levels.results, order: st.ids });
      }

      if (m === "PATCH" && path === "/api/admin/progress") {
        const b = await readBody(request);
        const toMs = (v) => (v === null || v === "" || v === undefined ? null : Math.max(0, Math.round(+v)));
        await env.DB.prepare("UPDATE progress SET completions = ?, best_ms = ?, last_ms = ?, updated_at = ? WHERE user_id = ? AND level_id = ?")
          .bind(Math.max(0, Math.round(+b.completions || 0)), toMs(b.best_ms), toMs(b.last_ms), Date.now(), String(b.user_id), +b.level_id).run();
        return json({ ok: true });
      }

      if (m === "DELETE" && path === "/api/admin/progress") {
        const u = url.searchParams.get("user_id");
        const lid = url.searchParams.get("level_id");
        if (!u) return json({ error: "user_id required" }, 400);
        const where = lid ? " AND level_id = ?" : "";
        const bind = lid ? [u, +lid] : [u];
        await env.DB.batch([
          env.DB.prepare("DELETE FROM progress WHERE user_id = ?" + where).bind(...bind),
          env.DB.prepare("DELETE FROM runs WHERE user_id = ?" + where).bind(...bind),
          env.DB.prepare("DELETE FROM ratings WHERE user_id = ?" + where).bind(...bind),
        ]);
        invalidateStack();
        return json({ ok: true });
      }

      if (m === "DELETE" && (mm = path.match(/^\/api\/admin\/runs\/(\d+)$/))) {
        await env.DB.prepare("DELETE FROM runs WHERE id = ?").bind(+mm[1]).run();
        invalidateStack();
        return json({ ok: true });
      }
    }

    return json({ error: "Not found" }, 404);
  },
};

// ============================================================
// Realtime room — server-authoritative runs
// ============================================================
const players = new Map(); // conn.id -> player record
const conns = new Map();
const memProgress = new Map(); // anonymous userId -> { [levelId]: {best, completions} }
const levelCache = new Map(); // id -> entry
const CHAT_KEEP = 60;
let chatLog = null; // recent messages, loaded once per room lifetime

async function getChat(env) {
  if (!chatLog) {
    const { results } = await env.DB.prepare("SELECT id, username, text, created_at FROM chat ORDER BY id DESC LIMIT ?").bind(CHAT_KEEP).all();
    chatLog = results.reverse().map((r) => ({ id: r.id, username: r.username, text: r.text, t: r.created_at }));
  }
  return chatLog;
}

function levelEntry(row) {
  const lv = normalizeLevel(JSON.parse(row.data));
  return {
    lv, updated_at: row.updated_at, author_id: row.user_id,
    minMs: (goalDistance(lv) / (lv.settings.speed * 1.12)) * 1000,
    portals: lv.rows.some((r) => /[ud]/.test(r)),
    top: lv.settings.view === "top",
    coins: coinList(lv),
    hasGoal: lv.rows.some((r) => r.includes("G")),
  };
}

async function getLevel(env, id, updatedAt) {
  const c = levelCache.get(id);
  if (c && c.updated_at === updatedAt) return c;
  const row = await env.DB.prepare("SELECT user_id, data, updated_at FROM levels WHERE id = ?").bind(id).first();
  if (!row) return null;
  const e = levelEntry(row);
  levelCache.set(id, e);
  return e;
}

const unlockStmt = (env, me, id) =>
  env.DB.prepare("INSERT OR IGNORE INTO progress (user_id, username, level_id, completions, updated_at) VALUES (?, ?, ?, 0, ?)").bind(me.uid, me.username, id, Date.now());

function nearGround(lv, x, y) {
  for (let cy = Math.floor(y); cy <= Math.floor(y + 1.1); cy++)
    for (let cx = Math.floor(x - 0.5); cx <= Math.floor(x + 0.5); cx++)
      if ("#_-o".includes(tileAt(lv, cx, cy))) return true;
  return false;
}

function kill(me, reason) {
  const conn = conns.get(me.id);
  me.run = null;
  conn?.send({ type: "kill", rid: me.rid, reason });
}

// Validate one reported sample. Returns "ok" | "dead" | "bad".
function checkSample(me, x, y, t, now) {
  const run = me.run, lv = run.lv, S = lv.settings;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) return "bad";
  if (t > now + 1200 || t < run.lt - 50) return "bad";
  const dt = Math.max(0, (t - run.lt) / 1000);
  if (x < 0 || x > lv.w + 1 || y < -4 || y > lv.h + 4) return "bad";
  let bad = false;
  if (Math.abs(x - run.lx) > S.speed * 1.2 * dt + 0.6) bad = true;
  if (Math.abs(y - run.ly) > (run.top ? S.speed * 1.2 : MAXV * 1.1) * dt + 0.6) bad = true;
  const cx = Math.floor(x), cy = Math.floor(y);
  if (tileAt(lv, cx, cy) === "#" && x - cx > 0.15 && x - cx < 0.85 && y - cy > 0.15 && y - cy < 0.85) bad = true;
  for (const c of run.coinsAll) if (Math.abs(x - c.x) < 1.05 && Math.abs(y - c.y) < 1.05) run.coins.add(c.k);
  if (!run.portals && !run.top) {
    if (nearGround(lv, x, y) || /o/.test(tileAt(lv, cx, cy + 1))) run.base = y;
    else if (run.base - y > S.jump * PAD_MULT * PAD_MULT * 1.15 + 1.2) { bad = true; run.base = y; }
  }
  const et = S.clock === "run" ? (t - run.start) / 1000 : t / 1000;
  run.lx = x; run.ly = y; run.lt = Math.max(run.lt, t);
  if (hazardAt(lv, x, y, 0.08, et, 0.55)) return "dead";
  return bad ? "bad" : "ok";
}

export const room = {
  tickMs: 60,
  async onConnect(conn, room, env) {
    const me = {
      id: conn.id, uid: conn.userId, username: conn.username || null,
      identity: conn.identity, owner: !!conn.isOwner,
      level: null, rid: 0, run: null, x: 0, y: 0, dirty: false,
    };
    players.set(conn.id, me);
    conns.set(conn.id, conn);
    let progress = {};
    if (conn.identity === "user") {
      const { results } = await env.DB.prepare("SELECT level_id, completions, best_ms FROM progress WHERE user_id = ?").bind(conn.userId).all();
      for (const r of results) progress[r.level_id] = { best: r.best_ms, completions: r.completions };
    } else if (conn.userId) {
      progress = memProgress.get(conn.userId) || {};
      memProgress.set(conn.userId, progress);
    }
    me.progress = progress;
    const chat = await getChat(env);
    conn.send({
      type: "welcome", id: conn.id, now: Date.now(), progress, chat,
      players: [...players.values()].filter((p) => p.id !== conn.id).map((p) => ({ id: p.id, username: p.username, level: p.level })),
    });
    room.broadcast({ type: "join", player: { id: me.id, username: me.username, level: null } }, { except: [conn.id] });
  },

  async onMessage(conn, message, room, env) {
    const me = players.get(conn.id);
    if (!me) return;
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const now = Date.now();

    if (msg.type === "chat") {
      if (me.identity !== "user") return conn.send({ type: "chatError", reason: "Sign in to chat" });
      if (now - (me.lastChat || 0) < 700) return conn.send({ type: "chatError", reason: "Slow down" });
      const text = room.censor(String(msg.text ?? "")).replace(/\s+/g, " ").trim().slice(0, 200);
      if (!text) return;
      me.lastChat = now;
      const r = await env.DB.prepare("INSERT INTO chat (user_id, username, text, created_at) VALUES (?, ?, ?, ?)").bind(me.uid, me.username, text, now).run();
      const m = { id: r.meta.last_row_id, username: me.username, text, t: now };
      const log = await getChat(env);
      if (!log.some((x) => x.id === m.id)) { log.push(m); if (log.length > CHAT_KEEP) log.shift(); }
      room.broadcast({ type: "chat", msg: m });
      return;
    }

    if (msg.type === "chatDelete") {
      if (!me.owner) return;
      const id = +msg.id;
      await env.DB.prepare("DELETE FROM chat WHERE id = ?").bind(id).run();
      const log = await getChat(env);
      const i = log.findIndex((x) => x.id === id);
      if (i >= 0) log.splice(i, 1);
      room.broadcast({ type: "chatDel", id });
      return;
    }

    if (msg.type === "spawn") {
      const id = +msg.level, rid = +msg.rid, verify = !!msg.verify;
      me.run = null; me.rid = rid;
      const reject = (reason) => conn.send({ type: "reject", rid, reason });
      let L;
      if (verify) {
        // Publishing run: the author must beat their own level under full validation.
        if (me.identity !== "user") return reject("Sign in to publish");
        const row = await env.DB.prepare("SELECT user_id, data, updated_at FROM levels WHERE id = ?").bind(id).first();
        if (!row || (row.user_id !== me.uid && !me.owner)) return reject("Not your level");
        L = levelEntry(row);
        if (!L.hasGoal) return reject("Add a goal tile first");
      } else {
        const st = await getStack(env);
        const idx = st.ids.indexOf(id);
        if (idx < 0) return reject("Level unavailable");
        const meta = st.live[idx];
        const prev = st.ids[idx - 1];
        const open = me.owner || idx === 0 || me.progress[id] || (prev && me.progress[prev]?.completions > 0) || meta.author_id === me.uid;
        if (!open) return reject("Locked — beat the level before it first");
        if (!me.progress[id]) {
          me.progress[id] = { best: null, completions: 0 };
          if (me.identity === "user") await unlockStmt(env, me, id).run();
        }
        L = await getLevel(env, id, meta.updated_at);
        if (!L) return reject("Level unavailable");
      }
      if (me.rid !== rid) return;
      const p = makePlayer(L.lv);
      me.level = verify ? null : id; me.x = p.x; me.y = p.y; me.dirty = !verify;
      me.run = {
        verify, levelId: id, updatedAt: L.updated_at, authorId: L.author_id,
        start: Date.now(), lv: L.lv, minMs: L.minMs, portals: L.portals, top: L.top,
        coinsAll: L.coins, coins: new Set(), lx: p.x, ly: p.y, lt: Date.now() - 300, base: p.y, strikes: 0,
      };
      if (!verify && me.levelAnnounced !== id) { me.levelAnnounced = id; room.broadcast({ type: "lvl", id: me.id, level: id }); }
      conn.send({ type: "spawned", rid, now: Date.now() });
      return;
    }

    if (msg.type === "pos" || msg.type === "finish") {
      if (!me.run || +msg.rid !== me.rid) return;
      const r = checkSample(me, +msg.x, +msg.y, +msg.t, now);
      if (r === "dead") return kill(me, "hit");
      if (r === "bad" && ++me.run.strikes >= 3) return kill(me, "desync");
      if (!me.run.verify) { me.x = me.run.lx; me.y = me.run.ly; me.dirty = true; }
      if (msg.type === "pos") return;

      // finish claim
      const run = me.run, lv = run.lv;
      me.run = null;
      let onGoal = false;
      for (let cy = Math.floor(run.ly - 1); cy <= Math.floor(run.ly + 1); cy++)
        for (let cx = Math.floor(run.lx - 1); cx <= Math.floor(run.lx + 1); cx++)
          if (tileAt(lv, cx, cy) === "G" && Math.abs(run.lx - (cx + 0.5)) < 1.05 && Math.abs(run.ly - (cy + 0.5)) < 1.05) onGoal = true;
      const elapsed = now - run.start;
      const rid = me.rid;
      if (!onGoal) return conn.send({ type: "reject", rid, reason: "Finish not verified" });
      if (run.coins.size < run.coinsAll.length) return conn.send({ type: "reject", rid, reason: "Missing coins" });
      if (elapsed < run.minMs || run.strikes >= 2) return conn.send({ type: "reject", rid, reason: "Run rejected" });

      if (run.verify) {
        const u = await env.DB.prepare("UPDATE levels SET status = 'published', verified_ms = ? WHERE id = ? AND updated_at = ?")
          .bind(elapsed, run.levelId, run.updatedAt).run();
        if (!u.meta.changes) return conn.send({ type: "reject", rid, reason: "Level changed during the run — save & verify again" });
        invalidateStack();
        return conn.send({ type: "verified", rid, level: run.levelId, time: elapsed });
      }

      const levelId = run.levelId;
      const st = await getStack(env);
      const next = st.ids[st.ids.indexOf(levelId) + 1] || null;
      const unlockNext = next && !me.progress[next];
      const prev = me.progress[levelId] || { best: null, completions: 0 };
      let result = { best: prev.best == null ? elapsed : Math.min(prev.best, elapsed), completions: prev.completions + 1 };
      if (me.identity === "user") {
        const stmts = [
          env.DB.prepare("INSERT INTO runs (user_id, username, level_id, time_ms, created_at) VALUES (?, ?, ?, ?, ?)").bind(me.uid, me.username, levelId, elapsed, now),
          env.DB.prepare(
            "INSERT INTO progress (user_id, username, level_id, completions, best_ms, last_ms, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?) " +
            "ON CONFLICT(user_id, level_id) DO UPDATE SET completions = completions + 1, " +
            "best_ms = CASE WHEN best_ms IS NULL OR excluded.best_ms < best_ms THEN excluded.best_ms ELSE best_ms END, " +
            "last_ms = excluded.last_ms, username = excluded.username, updated_at = excluded.updated_at"
          ).bind(me.uid, me.username, levelId, elapsed, elapsed, now),
          env.DB.prepare("SELECT completions, best_ms FROM progress WHERE user_id = ? AND level_id = ?").bind(me.uid, levelId),
        ];
        if (unlockNext) stmts.push(unlockStmt(env, me, next));
        const res = await env.DB.batch(stmts);
        const got = res[2].results[0];
        if (got) result = { best: got.best_ms, completions: got.completions };
      }
      me.progress[levelId] = result;
      if (unlockNext) me.progress[next] = { best: null, completions: 0 };
      conn.send({
        type: "result", rid, level: levelId, time: elapsed, best: result.best, completions: result.completions,
        next, saved: me.identity === "user", canRate: me.identity === "user" && run.authorId !== me.uid,
      });
    }
  },

  async onTick(room) {
    const snap = [];
    for (const p of players.values()) {
      if (!p.dirty) continue;
      p.dirty = false;
      snap.push([p.id, p.level, Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]);
    }
    if (snap.length) room.broadcast({ type: "snap", p: snap });
  },

  async onClose(conn, room) {
    players.delete(conn.id);
    conns.delete(conn.id);
    room.broadcast({ type: "left", id: conn.id });
  },
};
