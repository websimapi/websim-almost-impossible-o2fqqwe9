// The level map: the whole community stack as a winding path.
const SP = 112; // vertical spacing between nodes (px)
const TOP_PAD = 70;

const xPct = (i) => 50 + Math.sin(i * 0.85) * 28;

export function createMap(ctx) {
  const root = document.getElementById("map");
  let detail = null; // { id, archived }
  const api = { open, close, refresh, onClose: null };

  function open() {
    root.hidden = false;
    detail = null;
    build(true);
  }
  function close() {
    root.hidden = true;
    detail = null;
    api.onClose?.();
  }
  function refresh() {
    if (!root.hidden) build(false);
  }

  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const avatar = (u) => `<img class="av" src="https://images.websim.com/avatar/${encodeURIComponent(u || "")}" alt="">`;
  const stars = (r) => (r == null ? "unrated" : `★ ${r.toFixed(1)}`);
  const secs = (ms) => (ms ? `~${Math.round(ms / 1000)}s` : "—");

  function build(scrollToCurrent) {
    const { S, levelState, continueIndex, esc, fmt } = ctx;
    const prevScroll = root.querySelector(".map-scroll")?.scrollTop ?? 0;
    const states = S.levels.map((_, i) => levelState(i));
    const nBeaten = states.filter((s) => s === "beaten").length;
    const nOpen = states.filter((s) => s === "open").length;
    const ci = continueIndex();
    const curIdx = S.levels.findIndex((l) => l.id === S.levelId);

    // --- top bar
    const top = el("div", "map-top");
    top.append(el("div", "map-stats",
      `<b>Level map</b><span class="st beaten">★ ${nBeaten} beaten</span><span class="st open">● ${nOpen} unlocked</span><span class="st">${S.levels.length} levels</span>`));
    if (ci >= 0) {
      const c = el("button", "chip pri", `Continue ▶ #${ci + 1}`);
      c.onclick = () => ctx.play(S.levels[ci].id);
      top.append(c);
    }
    const x = el("button", "chip", "✕");
    x.onclick = close;
    top.append(x);

    // --- track
    const scroll = el("div", "map-scroll");
    const track = el("div", "map-track");
    const height = TOP_PAD * 2 + Math.max(0, S.levels.length - 1) * SP;
    track.style.height = height + "px";

    // path: solid through the reachable part, dashed beyond
    const lastOpen = states.reduce((a, s, i) => (s !== "locked" ? i : a), 0);
    const pt = (i) => [xPct(i), TOP_PAD + i * SP];
    const seg = (a, b) => {
      let d = "";
      for (let i = a; i < b; i++) {
        const [x0, y0] = pt(i), [x1, y1] = pt(i + 1), ym = (y0 + y1) / 2;
        d += `${i === a ? `M${x0} ${y0}` : ""} C${x0} ${ym} ${x1} ${ym} ${x1} ${y1} `;
      }
      return d;
    };
    if (S.levels.length > 1) {
      track.insertAdjacentHTML("beforeend", `<svg class="map-path" viewBox="0 0 100 ${height}" preserveAspectRatio="none">
        <path d="${seg(lastOpen, S.levels.length - 1)}" class="p-locked"/>
        <path d="${seg(0, lastOpen)}" class="p-open"/>
      </svg>`);
    }

    const onLevel = new Map();
    for (const o of S.others.values()) if (o.level) onLevel.set(o.level, (onLevel.get(o.level) || 0) + 1);

    S.levels.forEach((l, i) => {
      const st = states[i];
      const [px, py] = pt(i);
      const node = el("div", `node ${st}${i === curIdx ? " here" : ""}${i === ci ? " next" : ""}${px > 50 ? " flip" : ""}`);
      node.style.left = px + "%";
      node.style.top = py + "px";
      const icon = st === "beaten" ? "★" : st === "locked" ? "🔒" : "";
      const p = S.progress[l.id];
      const others = onLevel.get(l.id);
      node.innerHTML = `
        <button class="dot" title="${esc(l.name)}"><span class="n">${i + 1}</span>${icon ? `<span class="badge">${icon}</span>` : ""}</button>
        <div class="lbl">
          <div class="nm">${esc(l.name)}${l.view === "top" ? ' <span class="tag">top-down</span>' : ""}${l.mine ? ' <span class="tag mine">yours</span>' : ""}</div>
          <div class="by">${avatar(l.author)}@${esc(l.author)}</div>
          <div class="meta">${stars(l.rating)}${l.ratings ? ` (${l.ratings})` : ""} · ${secs(l.avgMs)}${p?.best != null ? ` · best ${fmt(p.best)}` : ""}${others ? ` · <span class="live">● ${others} playing</span>` : ""}</div>
        </div>`;
      node.querySelector(".dot").onclick = () => { detail = { id: l.id }; build(false); };
      node.querySelector(".lbl").onclick = () => { detail = { id: l.id }; build(false); };
      track.append(node);
    });
    scroll.append(track);

    if (!S.levels.length) scroll.append(el("div", "map-empty", "No levels yet."));

    if (S.archived.length) {
      const ar = el("div", "map-archived");
      ar.append(el("h3", "", "Archived <span class=\"muted\">— hidden from the stack for low ratings; your ratings can bring them back</span>"));
      for (const l of S.archived) {
        const row = el("button", "arow", `<span>${esc(l.name)} <span class="muted">by @${esc(l.author)}</span></span><span class="muted">${stars(l.rating)} (${l.ratings})</span>`);
        row.onclick = () => { detail = { id: l.id, archived: true }; build(false); };
        ar.append(row);
      }
      scroll.append(ar);
    }

    const parts = [top, scroll];
    if (detail) parts.push(detailCard());
    root.replaceChildren(...parts);

    if (scrollToCurrent) {
      const target = curIdx >= 0 ? curIdx : Math.max(0, ci);
      scroll.scrollTop = TOP_PAD + target * SP - scroll.clientHeight / 2;
    } else scroll.scrollTop = prevScroll;
  }

  function detailCard() {
    const { S, levelState, esc, fmt, starPicker, rate } = ctx;
    const i = S.levels.findIndex((l) => l.id === detail.id);
    const l = detail.archived ? S.archived.find((a) => a.id === detail.id) : S.levels[i];
    const card = el("div", "map-detail");
    if (!l) return card;
    const st = detail.archived ? "archived" : levelState(i);
    const p = S.progress[l.id];
    const statusTxt = { beaten: "★ Beaten", open: "● Unlocked", locked: "🔒 Locked", archived: "Archived" }[st];
    card.innerHTML = `
      <button class="chip x">✕</button>
      <div class="d-title">${detail.archived ? "" : `<span class="muted">#${i + 1}</span> `}${esc(l.name)}</div>
      <a class="d-by" href="https://websim.com/@${encodeURIComponent(l.author || "")}" target="_blank">${avatar(l.author)}@${esc(l.author)}</a>
      <div class="d-grid">
        <div><b>${statusTxt}</b><span>status</span></div>
        <div><b>${l.view === "top" ? "Top-down" : "Side-scroller"}</b><span>type</span></div>
        <div><b>${stars(l.rating)}</b><span>${l.ratings} rating${l.ratings === 1 ? "" : "s"}</span></div>
        <div><b>${secs(l.avgMs)}</b><span>avg time</span></div>
        <div><b>${l.finishes}</b><span>finishes</span></div>
        <div><b>${p?.best != null ? fmt(p.best) : "—"}</b><span>your best${p?.completions ? ` · ${p.completions}×` : ""}</span></div>
      </div>`;
    card.querySelector(".x").onclick = () => { detail = null; build(false); };
    if (p?.completions > 0 && !l.mine && S.me?.signedIn) {
      card.append(el("div", "d-label", S.myRatings[l.id] ? "Your rating" : "Rate this level"));
      card.append(starPicker(S.myRatings[l.id], (n) => rate(l.id, n)));
    }
    const actions = el("div", "d-actions");
    if (st === "locked") {
      actions.append(el("div", "muted", `Beat #${i} “${esc(S.levels[i - 1]?.name)}” to unlock`));
    } else if (st !== "archived") {
      const b = el("button", "chip pri", st === "beaten" ? "Play again ▶" : "Play ▶");
      b.onclick = () => ctx.play(l.id);
      actions.append(b);
    }
    card.append(actions);
    return card;
  }

  addEventListener("keydown", (e) => { if (e.code === "Escape" && !root.hidden) close(); });
  return api;
}
