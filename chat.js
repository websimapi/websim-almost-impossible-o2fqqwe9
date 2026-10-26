// Global public chat — works over every screen (game, map, editor, admin).
export function createChat({ send, getMe, esc }) {
  const $ = (id) => document.getElementById(id);
  const btn = $("chatBtn"), badge = $("chatBadge"), panel = $("chat");
  const list = $("chatList"), form = $("chatForm"), input = $("chatInput"), note = $("chatNote");
  let unread = 0;
  let msgs = [];

  const time = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  function setOpen(open) {
    panel.hidden = !open;
    btn.classList.toggle("on", open);
    localStorage.setItem("chatOpen", open ? "1" : "0");
    if (open) {
      unread = 0;
      paintBadge();
      list.scrollTop = list.scrollHeight;
    }
  }
  function paintBadge() {
    badge.hidden = !unread;
    badge.textContent = unread > 9 ? "9+" : unread;
  }

  function row(m) {
    const me = getMe();
    const div = document.createElement("div");
    div.className = "cmsg" + (me?.username && m.username === me.username ? " mine" : "");
    div.dataset.id = m.id;
    const u = encodeURIComponent(m.username || "");
    div.innerHTML = `
      <a href="https://websim.com/@${u}" target="_blank" class="cav"><img src="https://images.websim.com/avatar/${u}" alt=""></a>
      <div class="cbody">
        <div class="chd"><a href="https://websim.com/@${u}" target="_blank">@${esc(m.username)}</a><span>${time(m.t)}</span></div>
        <div class="ctx">${esc(m.text)}</div>
      </div>`;
    if (me?.isOwner) {
      const del = document.createElement("button");
      del.className = "cdel";
      del.title = "Delete message";
      del.textContent = "×";
      del.onclick = () => send({ type: "chatDelete", id: m.id });
      div.append(del);
    }
    return div;
  }

  function render() {
    list.replaceChildren(...msgs.map(row));
    if (!msgs.length) list.innerHTML = `<div class="cempty">No messages yet — say hi!</div>`;
    list.scrollTop = list.scrollHeight;
  }

  function refreshMe() {
    const me = getMe();
    const can = !!me?.signedIn;
    input.disabled = !can;
    input.placeholder = can ? "Message everyone…" : "Sign in to chat";
    render();
  }

  btn.onclick = () => {
    setOpen(panel.hidden);
    if (!panel.hidden && !input.disabled) input.focus();
  };
  $("chatClose").onclick = () => setOpen(false);
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send({ type: "chat", text });
    input.value = "";
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep game/editor/map shortcuts out of typing
    if (e.code === "Escape") input.blur();
  });
  input.addEventListener("keyup", (e) => e.stopPropagation());

  setOpen(localStorage.getItem("chatOpen") === "1");
  refreshMe();

  return {
    refreshMe,
    setHistory(list0) { msgs = list0 || []; render(); },
    add(m) {
      if (msgs.some((x) => x.id === m.id)) return;
      msgs.push(m);
      if (msgs.length > 100) msgs.shift();
      const near = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      list.querySelector(".cempty")?.remove();
      list.append(row(m));
      if (near || m.username === getMe()?.username) list.scrollTop = list.scrollHeight;
      if (panel.hidden) { unread++; paintBadge(); }
    },
    remove(id) {
      msgs = msgs.filter((x) => x.id !== id);
      list.querySelector(`[data-id="${id}"]`)?.remove();
    },
    error(reason) {
      note.textContent = reason;
      note.hidden = false;
      clearTimeout(note._t);
      note._t = setTimeout(() => (note.hidden = true), 1800);
    },
  };
}
