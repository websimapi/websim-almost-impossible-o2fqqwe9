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
// Backend
// ============================================================
export const schema = `
  CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS levels (id INTEGER PRIMARY KEY AUTOINCREMENT, num INTEGER NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS progress (user_id TEXT NOT NULL, username TEXT, level_id INTEGER NOT NULL, completions INTEGER NOT NULL DEFAULT 0, best_ms INTEGER, last_ms INTEGER, updated_at INTEGER, PRIMARY KEY (user_id, level_id));
  CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT, level_id INTEGER NOT NULL, time_ms INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS runs_user ON runs (user_id);
  CREATE INDEX IF NOT EXISTS runs_created ON runs (created_at);
`;

const json = (d, status = 200) => Response.json(d, { status, headers: { "cache-control": "no-store" } });

function isOwner(request) {
  const uid = request.headers.get("x-websim-user-id");
  return !!uid && uid === request.headers.get("x-websim-project-owner-id");
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const m = request.method;
    const owner = isOwner(request);

    if (m === "GET" && path === "/api/me") {
      return json({
        userId: request.headers.get("x-websim-user-id"),
        username: request.headers.get("x-websim-username"),
        isOwner: owner,
      });
    }

    if (m === "GET" && path === "/api/levels") {
      const { results } = await env.DB.prepare("SELECT id, num, name, updated_at FROM levels WHERE published = 1 ORDER BY num, id").all();
      return json(results);
    }

    let mm;
    if (m === "GET" && (mm = path.match(/^\/api\/level\/(\d+)$/))) {
      const row = await env.DB.prepare("SELECT id, num, name, data, published, updated_at FROM levels WHERE id = ?").bind(+mm[1]).first();
      if (!row || (!row.published && !owner)) return json({ error: "Not found" }, 404);
      return json({ id: row.id, name: row.name, updated_at: row.updated_at, data: normalizeLevel(JSON.parse(row.data)) });
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
        const { results } = await env.DB.prepare("SELECT id, num, name, data, published, updated_at FROM levels ORDER BY num, id").all();
        return json(results.map((r) => ({ ...r, data: normalizeLevel(JSON.parse(r.data)) })));
      }

      if (m === "POST" && path === "/api/admin/levels") {
        const b = await readBody(request);
        const data = JSON.stringify(normalizeLevel(b.data));
        const name = String(b.name ?? "").trim().slice(0, 60) || "Untitled";
        const pub = b.published ? 1 : 0;
        const now = Date.now();
        if (b.id) {
          const r = await env.DB.prepare("UPDATE levels SET name = ?, data = ?, published = ?, updated_at = ? WHERE id = ?")
            .bind(name, data, pub, now, +b.id).run();
          if (!r.meta.changes) return json({ error: "Not found" }, 404);
          return json({ id: +b.id, updated_at: now });
        }
        const r = await env.DB.prepare("INSERT INTO levels (num, name, data, published, updated_at) VALUES ((SELECT COALESCE(MAX(num), 0) + 1 FROM levels), ?, ?, ?, ?)")
          .bind(name, data, pub, now).run();
        return json({ id: r.meta.last_row_id, updated_at: now });
      }

      if (m === "DELETE" && (mm = path.match(/^\/api\/admin\/levels\/(\d+)$/))) {
        await env.DB.prepare("DELETE FROM levels WHERE id = ?").bind(+mm[1]).run();
        return json({ ok: true });
      }

      if (m === "POST" && path === "/api/admin/levels/reorder") {
        const { ids } = await readBody(request);
        if (!Array.isArray(ids) || ids.length > 60) return json({ error: "Bad ids" }, 400);
        await env.DB.batch(ids.map((id, i) => env.DB.prepare("UPDATE levels SET num = ? WHERE id = ?").bind(i + 1, +id)));
        return json({ ok: true });
      }

      if (m === "GET" && path === "/api/admin/players") {
        const [prog, runs, levels] = await env.DB.batch([
          env.DB.prepare("SELECT * FROM progress ORDER BY updated_at DESC LIMIT 2000"),
          env.DB.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT 300"),
          env.DB.prepare("SELECT id, num, name FROM levels ORDER BY num, id"),
        ]);
        return json({ progress: prog.results, runs: runs.results, levels: levels.results });
      }

      if (m === "PATCH" && path === "/api/admin/progress") {
        const b = await readBody(request);
        const toMs = (v) => (v === null || v === "" || v === undefined ? null : Math.max(0, Math.round(+v)));
        await env.DB.prepare("UPDATE progress SET completions = ?, best_ms = ?, last_ms = ?, updated_at = ? WHERE user_id = ? AND level_id = ?")
          .bind(Math.max(0, Math.round(+b.completions || 0)), toMs(b.best_ms), toMs(b.last_ms), Date.now(), String(b.user_id), +b.level_id).run();
        return json({ ok: true });
      }

      if (m === "DELETE" && path === "/api/admin/progress") {
        const uid = url.searchParams.get("user_id");
        const lid = url.searchParams.get("level_id");
        if (!uid) return json({ error: "user_id required" }, 400);
        if (lid) {
          await env.DB.batch([
            env.DB.prepare("DELETE FROM progress WHERE user_id = ? AND level_id = ?").bind(uid, +lid),
            env.DB.prepare("DELETE FROM runs WHERE user_id = ? AND level_id = ?").bind(uid, +lid),
          ]);
        } else {
          await env.DB.batch([
            env.DB.prepare("DELETE FROM progress WHERE user_id = ?").bind(uid),
            env.DB.prepare("DELETE FROM runs WHERE user_id = ?").bind(uid),
          ]);
        }
        return json({ ok: true });
      }

      if (m === "DELETE" && (mm = path.match(/^\/api\/admin\/runs\/(\d+)$/))) {
        await env.DB.prepare("DELETE FROM runs WHERE id = ?").bind(+mm[1]).run();
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
let order = { at: 0, list: [] };
const levelCache = new Map(); // id -> { at, lv, minMs, portals }

async function getOrder(env) {
  if (Date.now() - order.at > 4000) {
    const { results } = await env.DB.prepare("SELECT id FROM levels WHERE published = 1 ORDER BY num, id").all();
    order = { at: Date.now(), list: results.map((r) => r.id) };
  }
  return order.list;
}

async function getLevel(env, id) {
  const c = levelCache.get(id);
  if (c && Date.now() - c.at < 4000) return c;
  const row = await env.DB.prepare("SELECT data FROM levels WHERE id = ? AND published = 1").bind(id).first();
  if (!row) { levelCache.delete(id); return null; }
  const lv = normalizeLevel(JSON.parse(row.data));
  const entry = {
    at: Date.now(), lv,
    minMs: (goalDistance(lv) / (lv.settings.speed * 1.12)) * 1000,
    portals: lv.rows.some((r) => /[ud]/.test(r)),
    top: lv.settings.view === "top",
    coins: coinList(lv),
  };
  levelCache.set(id, entry);
  return entry;
}

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
      level: null, rid: 0, run: null, x: 0, y: 0, dirty: false, unlocked: new Set(),
    };
    players.set(conn.id, me);
    conns.set(conn.id, conn);
    let progress = {};
    if (conn.identity === "user") {
      const { results } = await env.DB.prepare("SELECT level_id, completions, best_ms FROM progress WHERE user_id = ?").bind(conn.userId).all();
      for (const r of results) progress[r.level_id] = { best: r.best_ms, completions: r.completions };
    } else if (conn.userId) {
      progress = memProgress.get(conn.userId) || {};
    }
    me.progress = progress;
    conn.send({
      type: "welcome", id: conn.id, now: Date.now(), progress,
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

    if (msg.type === "spawn") {
      const id = +msg.level, rid = +msg.rid;
      me.run = null; me.rid = rid;
      const list = await getOrder(env);
      const idx = list.indexOf(id);
      if (idx < 0) return conn.send({ type: "reject", rid, reason: "Level unavailable" });
      if (idx > 0 && !me.owner && !me.unlocked.has(id)) {
        const prev = list[idx - 1];
        let ok = !!me.progress[prev];
        if (me.identity === "user") {
          ok = !!(await env.DB.prepare("SELECT 1 AS ok FROM progress WHERE user_id = ? AND level_id = ? AND completions > 0").bind(me.uid, prev).first("ok"));
        }
        if (!ok) return conn.send({ type: "reject", rid, reason: "Locked — beat the previous level first" });
        me.unlocked.add(id);
      }
      const L = await getLevel(env, id);
      if (!L || me.rid !== rid) return;
      const p = makePlayer(L.lv);
      me.level = id; me.x = p.x; me.y = p.y; me.dirty = true;
      me.run = { start: Date.now(), lv: L.lv, minMs: L.minMs, portals: L.portals, top: L.top, coinsAll: L.coins, coins: new Set(), lx: p.x, ly: p.y, lt: Date.now() - 300, base: p.y, strikes: 0 };
      if (me.levelAnnounced !== id) { me.levelAnnounced = id; room.broadcast({ type: "lvl", id: me.id, level: id }); }
      conn.send({ type: "spawned", rid, now: Date.now() });
      return;
    }

    if (msg.type === "pos" || msg.type === "finish") {
      if (!me.run || +msg.rid !== me.rid) return;
      const r = checkSample(me, +msg.x, +msg.y, +msg.t, now);
      if (r === "dead") return kill(me, "hit");
      if (r === "bad" && ++me.run.strikes >= 3) return kill(me, "desync");
      me.x = me.run.lx; me.y = me.run.ly; me.dirty = true;
      if (msg.type === "pos") return;

      // finish claim
      const run = me.run, lv = run.lv;
      me.run = null;
      let onGoal = false;
      for (let cy = Math.floor(me.y - 1); cy <= Math.floor(me.y + 1); cy++)
        for (let cx = Math.floor(me.x - 1); cx <= Math.floor(me.x + 1); cx++)
          if (tileAt(lv, cx, cy) === "G" && Math.abs(me.x - (cx + 0.5)) < 1.05 && Math.abs(me.y - (cy + 0.5)) < 1.05) onGoal = true;
      const elapsed = now - run.start;
      if (!onGoal) return conn.send({ type: "reject", rid: me.rid, reason: "Finish not verified" });
      if (run.coins.size < run.coinsAll.length) return conn.send({ type: "reject", rid: me.rid, reason: "Missing coins" });
      if (elapsed < run.minMs || r === "bad" && run.strikes >= 2) return conn.send({ type: "reject", rid: me.rid, reason: "Run rejected" });

      const levelId = me.level;
      const prev = me.progress[levelId] || { best: null, completions: 0 };
      let result = { best: prev.best == null ? elapsed : Math.min(prev.best, elapsed), completions: prev.completions + 1 };
      if (me.identity === "user") {
        const [, , row] = await env.DB.batch([
          env.DB.prepare("INSERT INTO runs (user_id, username, level_id, time_ms, created_at) VALUES (?, ?, ?, ?, ?)").bind(me.uid, me.username, levelId, elapsed, now),
          env.DB.prepare(
            "INSERT INTO progress (user_id, username, level_id, completions, best_ms, last_ms, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?) " +
            "ON CONFLICT(user_id, level_id) DO UPDATE SET completions = completions + 1, " +
            "best_ms = CASE WHEN best_ms IS NULL OR excluded.best_ms < best_ms THEN excluded.best_ms ELSE best_ms END, " +
            "last_ms = excluded.last_ms, username = excluded.username, updated_at = excluded.updated_at"
          ).bind(me.uid, me.username, levelId, elapsed, elapsed, now),
          env.DB.prepare("SELECT completions, best_ms FROM progress WHERE user_id = ? AND level_id = ?").bind(me.uid, levelId),
        ]);
        const got = row.results[0];
        if (got) result = { best: got.best_ms, completions: got.completions };
      } else if (me.uid) {
        memProgress.set(me.uid, me.progress);
      }
      me.progress[levelId] = result;
      const list = await getOrder(env);
      const next = list[list.indexOf(levelId) + 1];
      if (next) me.unlocked.add(next);
      conn.send({ type: "result", rid: me.rid, level: levelId, time: elapsed, best: result.best, completions: result.completions, next: next || null, saved: me.identity === "user" });
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
