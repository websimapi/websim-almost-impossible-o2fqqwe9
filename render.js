import { enemyPos, PR } from "./server.js";

export function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const t = amt < 0 ? 0 : 255, k = Math.abs(amt);
  r = Math.round(r + (t - r) * k); g = Math.round(g + (t - g) * k); b = Math.round(b + (t - b) * k);
  return `rgb(${r},${g},${b})`;
}

export function mixHex(a, b, t) {
  const A = parseInt(a.slice(1), 16), B = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((A >> s) & 255) * (1 - t) + ((B >> s) & 255) * t);
  return "#" + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
}

export function drawBackground(ctx, W, H, bg) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, shade(bg, 0.18));
  g.addColorStop(1, shade(bg, -0.45));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// Draw one tile at screen (sx, sy) with size ts.
export function drawTile(ctx, c, sx, sy, ts, t = 0) {
  const lw = Math.max(1, ts * 0.06);
  ctx.lineWidth = lw;
  ctx.lineJoin = "round";
  const outline = "rgba(255,255,255,0.9)";
  if (c === "#" || c === "_" || c === "-") {
    const h = c === "#" ? ts : c === "_" ? ts / 2 : ts * 0.2;
    const y = c === "_" ? sy + ts / 2 : sy;
    ctx.fillStyle = "#050507";
    ctx.fillRect(sx, y, ts, h);
    ctx.strokeStyle = outline;
    ctx.strokeRect(sx + lw / 2, y + lw / 2, ts - lw, h - lw);
  } else if (c === "%") {
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(sx, sy, ts, ts);
  } else if ("^v<>".includes(c)) {
    const a = 0.04 * ts, b = ts - a;
    ctx.beginPath();
    if (c === "^") { ctx.moveTo(sx + a, sy + ts); ctx.lineTo(sx + b, sy + ts); ctx.lineTo(sx + ts / 2, sy + a); }
    if (c === "v") { ctx.moveTo(sx + a, sy); ctx.lineTo(sx + b, sy); ctx.lineTo(sx + ts / 2, sy + b); }
    if (c === "<") { ctx.moveTo(sx + ts, sy + a); ctx.lineTo(sx + ts, sy + b); ctx.lineTo(sx + a, sy + ts / 2); }
    if (c === ">") { ctx.moveTo(sx, sy + a); ctx.lineTo(sx, sy + b); ctx.lineTo(sx + b, sy + ts / 2); }
    ctx.closePath();
    ctx.fillStyle = "#050507";
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.stroke();
  } else if (c === "o") {
    ctx.fillStyle = "#ffd23f";
    ctx.beginPath();
    ctx.ellipse(sx + ts / 2, sy + ts, ts * 0.4, ts * 0.28, 0, Math.PI, 0);
    ctx.fill();
    ctx.strokeStyle = "#050507";
    ctx.stroke();
  } else if (c === "u" || c === "d") {
    const col = c === "u" ? "#4ff0ff" : "#ffd23f";
    const pulse = 0.75 + 0.25 * Math.sin(t * 6);
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = col;
    ctx.lineWidth = lw * 2;
    ctx.beginPath();
    ctx.ellipse(sx + ts / 2, sy + ts / 2, ts * 0.28, ts * 0.62, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath();
    const dir = c === "u" ? -1 : 1;
    ctx.moveTo(sx + ts / 2, sy + ts / 2 + dir * ts * 0.25);
    ctx.lineTo(sx + ts * 0.36, sy + ts / 2 - dir * ts * 0.05);
    ctx.lineTo(sx + ts * 0.64, sy + ts / 2 - dir * ts * 0.05);
    ctx.fill();
    ctx.globalAlpha = 1;
  } else if (c === "G") {
    const n = 4, q = ts / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      ctx.fillStyle = (i + j) % 2 ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.6)";
      ctx.fillRect(sx + i * q, sy + j * q, q, q);
    }
  }
}

export function drawEnemy(ctx, e, sx, sy, ts, t) {
  const s = e.size * ts;
  ctx.save();
  ctx.translate(sx, sy);
  if (e.kind === "block") {
    ctx.fillStyle = "#050507";
    ctx.fillRect(-s, -s, s * 2, s * 2);
    ctx.strokeStyle = "#ff3b5c";
    ctx.lineWidth = Math.max(1.5, ts * 0.07);
    ctx.strokeRect(-s, -s, s * 2, s * 2);
  } else {
    ctx.rotate(t * 8);
    ctx.fillStyle = "#050507";
    ctx.beginPath();
    const teeth = 10;
    for (let i = 0; i < teeth * 2; i++) {
      const a = (i / (teeth * 2)) * Math.PI * 2, r = i % 2 ? s * 0.82 : s * 1.08;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = Math.max(1, ts * 0.05);
    ctx.stroke();
    ctx.fillStyle = "#ff3b5c";
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// cam: { ox, oy, ts, W, H } — world tile (x,y) maps to screen ((x-ox)*ts, (y-oy)*ts)
export function drawWorld(ctx, lv, cam, t, et, bg) {
  const { ox, oy, ts, W, H } = cam;
  drawBackground(ctx, W, H, bg || lv.settings.bg);
  const x0 = Math.max(0, Math.floor(ox)), x1 = Math.min(lv.w - 1, Math.floor(ox + W / ts));
  const y0 = Math.max(0, Math.floor(oy)), y1 = Math.min(lv.h - 1, Math.floor(oy + H / ts));
  for (let y = y0; y <= y1; y++) {
    const row = lv.rows[y];
    for (let x = x0; x <= x1; x++) {
      const c = row[x];
      if (c !== ".") drawTile(ctx, c, (x - ox) * ts, (y - oy) * ts, ts, t);
    }
  }
  for (const e of lv.enemies) {
    const p = enemyPos(e, et);
    const sx = (p.x - ox) * ts, sy = (p.y - oy) * ts;
    if (sx < -ts * 5 || sx > W + ts * 5 || sy < -ts * 5 || sy > H + ts * 5) continue;
    drawEnemy(ctx, e, sx, sy, ts, t);
  }
}

const avatars = new Map();
export function avatar(username) {
  if (!username) return null;
  let img = avatars.get(username);
  if (!img) {
    img = new Image();
    img.src = `https://images.websim.com/avatar/${encodeURIComponent(username)}`;
    avatars.set(username, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

export function drawPlayer(ctx, sx, sy, ts, username, { alpha = 1, ring = "#ff8a1f", label = null } = {}) {
  const r = PR * ts;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fillStyle = ring;
  ctx.fill();
  const img = avatar(username);
  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(sx, sy, r * 0.84, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, sx - r * 0.84, sy - r * 0.84, r * 1.68, r * 1.68);
    ctx.restore();
  } else {
    ctx.fillStyle = shade("#ff8a1f", 0.4);
    ctx.beginPath();
    ctx.arc(sx, sy, r * 0.84, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineWidth = Math.max(1.5, ts * 0.06);
  ctx.strokeStyle = "#050507";
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.stroke();
  if (label) {
    ctx.font = `600 ${Math.max(10, ts * 0.32)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillText(label, sx, sy - r - 6);
  }
  ctx.restore();
}
