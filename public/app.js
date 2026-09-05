const $ = (s) => document.querySelector(s);
let token = localStorage.getItem("nexus_token");
let socket, state = { servers: [], server: null, channel: null, user: null };

async function api(url, opt = {}) {
  opt.headers = {
    ...(opt.headers || {}),
    "Content-Type": "application/json",
    ...(token ? { Authorization: "Bearer " + token } : {}),
  };
  let r;
  try {
    r = await fetch(url, opt);
  } catch (e) {
    // Server nicht erreichbar (schläft, startet gerade, oder offline) - klar markieren,
    // damit boot()/flushQueue() das von "falsches Passwort" & Co. unterscheiden können.
    const err = new Error("Server nicht erreichbar");
    err.isNetworkError = true;
    throw err;
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || "Fehler");
  return body;
}
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

function escapeHtml(x) {
  return String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}
function initials(name) { return (name || "?").slice(0, 2).toUpperCase(); }

async function boot() {
  if (!token) { $("#auth").classList.remove("hidden"); return; }
  let attempt = 0;
  // Zeige den "Server wacht auf"-Screen erst, wenn die erste Anfrage wirklich lange braucht,
  // damit ein normaler schneller Start nicht unnötig flackert.
  const showWakingTimer = setTimeout(() => {
    $("#wakingText").textContent = "Server wacht auf, das kann bis zu einer Minute dauern…";
    $("#wakingUp").classList.remove("hidden");
  }, 2500);
  while (true) {
    try {
      const d = await api("/api/bootstrap");
      clearTimeout(showWakingTimer);
      $("#wakingUp").classList.add("hidden");
      state.user = d.user;
      state.servers = d.servers;
      $("#app").classList.remove("hidden");
      renderMe();
      renderServers();
      const firstServer = d.servers[0];
      if (firstServer) selectServer(firstServer, d.messages, d.activeChannelId);
      connectSocket();
      flushQueue();
      return;
    } catch (e) {
      if (e.isNetworkError) {
        attempt++;
        $("#wakingText").textContent = `Server wacht auf… (Versuch ${attempt})`;
        await sleep(Math.min(2000 * attempt, 8000));
        continue;
      }
      // Kein Netzwerkfehler, sondern z.B. abgelaufenes/ungültiges Token -> zurück zum Login.
      clearTimeout(showWakingTimer);
      $("#wakingUp").classList.add("hidden");
      localStorage.removeItem("nexus_token");
      $("#auth").classList.remove("hidden");
      return;
    }
  }
}

function connectSocket() {
  socket = io({ auth: { token } });
  socket.on("message", (m) => { if (m.channel_id === state.channel?.id) upsertMessage(m); });
  socket.on("message_edited", (m) => { if (m.channel_id === state.channel?.id) updateMessage(m); });
  socket.on("message_deleted", (d) => { if (d.channel_id === state.channel?.id) removeMessage(d.id); });
  socket.on("reaction_updated", (d) => { updateReactions(d.id, d.reactions); });
  socket.on("typing", (x) => {
    $("#typing").textContent = x.username + " schreibt…";
    clearTimeout(window._typingTimer);
    window._typingTimer = setTimeout(() => { $("#typing").textContent = ""; }, 1500);
  });
  socket.on("member_kicked", ({ serverId, userId }) => {
    if (state.server?.id === serverId) {
      state.server.members = state.server.members.filter((m) => m.id !== userId);
      renderMembers();
    }
  });
  socket.on("connect", () => {
    if (state.channel) socket.emit("join_channel", state.channel.id);
    if (!getQueue().length) updateBanner(null);
  });
  socket.on("disconnect", () => {
    if (!getQueue().length) updateBanner("Verbindung getrennt – wird automatisch wiederhergestellt…", "err");
  });
}

// ---------- Banner ----------
function updateBanner(text, level) {
  const el = $("#connBanner");
  if (!text) { el.classList.add("hidden"); return; }
  el.textContent = text;
  el.className = level ? level : "";
  el.classList.remove("hidden");
}

// ---------- Offline-Warteschlange für Nachrichten ----------
// Nachrichten werden per HTTP (nicht nur per Socket) gesendet, weil ein normaler
// HTTP-Request einen eingeschlafenen Free-Tier-Server zuverlässig aufweckt.
// Solange der Server nicht antwortet, bleibt die Nachricht hier gespeichert
// (auch über einen Neuladen der Seite hinweg) und wird automatisch mit
// wachsender Wartezeit erneut verschickt.
const QUEUE_KEY = "nexus_pending_messages";
function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch { return []; }
}
function saveQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
function queueMessage(item) {
  const q = getQueue();
  q.push(item);
  saveQueue(q);
}
function removeFromQueue(tempId) {
  saveQueue(getQueue().filter((x) => x.tempId !== tempId));
}

let flushing = false;
async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    while (true) {
      const q = getQueue();
      if (!q.length) { updateBanner(null); break; }
      const item = q[0];
      try {
        const msg = await api("/api/messages", {
          method: "POST",
          body: JSON.stringify({ channelId: item.channelId, content: item.content, clientId: item.tempId }),
        });
        removeFromQueue(item.tempId);
        if (item.channelId === state.channel?.id) upsertMessage(msg);
        updateBanner(null);
      } catch (e) {
        if (!e.isNetworkError) {
          // Server hat abgelehnt (z.B. Kanal gelöscht) - nicht endlos wiederholen.
          removeFromQueue(item.tempId);
          markMessageFailed(item.tempId, e.message);
          continue;
        }
        item.attempts = (item.attempts || 0) + 1;
        const q2 = getQueue(); q2[0] = item; saveQueue(q2);
        const waitMs = Math.min(2000 * item.attempts, 15000);
        updateBanner(`Server wacht auf – Nachricht wird in ${Math.round(waitMs / 1000)}s erneut versucht…`, "err");
        await sleep(waitMs);
      }
    }
  } finally {
    flushing = false;
  }
}
function markMessageFailed(tempId, reason) {
  const el = $("#messages").querySelector(`.msg[data-tempid="${tempId}"] .pending-tag`);
  if (el) { el.textContent = "fehlgeschlagen: " + reason; el.style.color = "var(--danger)"; }
}

function renderMe() {
  $("#meAvatar").src = state.user.avatar;
  $("#meName").innerHTML = escapeHtml(state.user.username) + (state.user.isOwner ? ' <span class="crown">👑</span>' : "");
  $("#meTag").textContent = state.user.isOwner ? "Owner-Konto" : (state.user.verified ? "Verifiziert" : "Mitglied");
  $("#ownerPanelToggle").classList.toggle("hidden", !state.user.isOwner);
}

function renderServers() {
  const wrap = $("#servers");
  wrap.innerHTML = "";
  state.servers.forEach((s) => {
    const el = document.createElement("div");
    el.className = "server" + (state.server?.id === s.id ? " active" : "");
    el.textContent = initials(s.name);
    el.title = s.name;
    el.onclick = () => selectServer(s);
    wrap.appendChild(el);
  });
  const add = document.createElement("div");
  add.className = "server add";
  add.textContent = "+";
  add.title = "Server erstellen";
  add.onclick = async () => {
    const name = prompt("Name des neuen Servers:");
    if (!name) return;
    await api("/api/servers", { method: "POST", body: JSON.stringify({ name }) });
    const d = await api("/api/bootstrap");
    state.servers = d.servers;
    renderServers();
    selectServer(state.servers[state.servers.length - 1]);
  };
  wrap.appendChild(add);
}

async function selectServer(s, initialMessages, initialChannelId) {
  state.server = s;
  $("#serverName").textContent = s.name;
  renderChannelList();
  renderMembers();
  const targetChannel = initialChannelId
    ? s.channels.find((c) => c.id === initialChannelId)
    : s.channels.find((c) => c.type === "text");
  if (initialMessages && targetChannel) {
    state.channel = targetChannel;
    $("#channelName").textContent = targetChannel.name;
    renderMessageList(initialMessages);
    socket && socket.emit("join_channel", targetChannel.id);
  } else if (targetChannel) {
    selectChannel(targetChannel);
  }
  renderServers();
}

function renderChannelList() {
  const wrap = $("#channels");
  wrap.innerHTML = "";
  const cat = document.createElement("div");
  cat.className = "cat";
  cat.innerHTML = `<span>KANÄLE</span><button id="addChannelBtn" class="cat-add">＋</button>`;
  wrap.appendChild(cat);
  cat.querySelector("#addChannelBtn").onclick = async () => {
    const name = prompt("Name des neuen Kanals:");
    if (!name) return;
    await api("/api/channels", { method: "POST", body: JSON.stringify({ serverId: state.server.id, name, type: "text" }) });
    const d = await api("/api/bootstrap");
    state.servers = d.servers;
    const refreshed = state.servers.find((x) => x.id === state.server.id);
    selectServer(refreshed);
  };
  state.server.channels.forEach((c) => {
    const row = document.createElement("div");
    row.className = "channel" + (c.type === "voice" ? " voice" : "") + (state.channel?.id === c.id ? " active" : "");
    row.innerHTML = `<span>${c.type === "voice" ? "🔊" : "#"} ${escapeHtml(c.name)}</span>` +
      (state.user.isOwner || state.server.role === "owner" ? `<span class="del" title="Kanal löschen">✕</span>` : "");
    row.onclick = () => { if (c.type !== "voice") selectChannel(c); };
    const delBtn = row.querySelector(".del");
    if (delBtn) {
      delBtn.onclick = async (ev) => {
        ev.stopPropagation();
        if (!confirm(`Kanal "${c.name}" wirklich löschen?`)) return;
        await api("/api/channels/" + c.id, { method: "DELETE" });
        const d = await api("/api/bootstrap");
        state.servers = d.servers;
        selectServer(state.servers.find((x) => x.id === state.server.id));
      };
    }
    wrap.appendChild(row);
  });
}

async function selectChannel(c) {
  state.channel = c;
  $("#channelName").textContent = c.name;
  socket && socket.emit("join_channel", c.id);
  const msgs = await api("/api/messages/" + c.id);
  renderMessageList(msgs);
  renderChannelList();
}

function renderMessageList(msgs) {
  const wrap = $("#messages");
  wrap.innerHTML = "";
  if (!msgs.length) {
    wrap.innerHTML = `<div class="empty">Noch keine Nachrichten hier. Schreib die erste!</div>`;
    return;
  }
  msgs.forEach((m) => appendMessage(m, false));
  renderQueuedFor(state.channel?.id);
  wrap.scrollTop = wrap.scrollHeight;
}
// Zeigt Nachrichten an, die noch in der Warteschlange stecken (z.B. weil der Server
// beim letzten Versuch geschlafen hat und die Seite danach neu geladen wurde).
function renderQueuedFor(channelId) {
  if (!channelId) return;
  getQueue()
    .filter((x) => x.channelId === channelId)
    .forEach((item) => {
      if ($("#messages").querySelector(`.msg[data-tempid="${item.tempId}"]`)) return;
      appendMessage({
        tempId: item.tempId, pending: true, user_id: state.user.id, username: state.user.username,
        avatar: state.user.avatar, content: item.content, created_at: new Date().toISOString(),
      }, true);
    });
}

function messageEl(m) {
  const el = document.createElement("div");
  el.className = "msg" + (m.pending ? " pending" : "");
  if (m.id != null) el.dataset.id = m.id;
  if (m.tempId) el.dataset.tempid = m.tempId;
  const mine = m.user_id === state.user.id;
  const canModify = !m.pending && (mine || state.user.isOwner);
  const d = new Date(m.created_at || Date.now());
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const reactionsHtml = (m.reactions || []).map((r) => `<span class="reaction" data-emoji="${r.emoji}">${r.emoji} ${r.c}</span>`).join("");
  el.innerHTML = `
    <img class="avatar" src="${m.avatar || ""}" />
    <div class="body">
      <div class="head">
        <b>${escapeHtml(m.username)}</b>
        <time>${time}${m.edited ? " (bearbeitet)" : ""}</time>
        ${m.pending ? `<span class="pending-tag">wird gesendet…</span>` : ""}
      </div>
      <p class="text">${escapeHtml(m.content)}</p>
      <div class="reactions">${reactionsHtml}${m.pending ? "" : `<span class="react-add" title="Reagieren">+😀</span>`}</div>
    </div>
    <div class="actions">
      ${m.pending ? "" : `<span class="act react-quick" title="👍">👍</span>`}
      ${canModify ? `<span class="act edit" title="Bearbeiten">✎</span><span class="act del" title="Löschen">🗑</span>` : ""}
    </div>
  `;
  if (!m.pending) {
    el.querySelector(".react-quick").onclick = () => react(m.id, "👍");
    el.querySelector(".react-add").onclick = () => {
      const emoji = prompt("Emoji für die Reaktion:", "🔥");
      if (emoji) react(m.id, emoji);
    };
    el.querySelectorAll(".reaction").forEach((r) => { r.onclick = () => react(m.id, r.dataset.emoji); });
  }
  if (canModify) {
    el.querySelector(".edit").onclick = async () => {
      const next = prompt("Nachricht bearbeiten:", m.content);
      if (next == null || !next.trim()) return;
      await api("/api/messages/" + m.id, { method: "PUT", body: JSON.stringify({ content: next.trim() }) });
    };
    el.querySelector(".del").onclick = async () => {
      if (!confirm("Nachricht löschen?")) return;
      await api("/api/messages/" + m.id, { method: "DELETE" });
    };
  }
  return el;
}

function appendMessage(m, scroll) {
  $("#messages").querySelector(".empty")?.remove();
  $("#messages").appendChild(messageEl(m));
  if (scroll) $("#messages").scrollTop = $("#messages").scrollHeight;
}
// Fügt eine Nachricht ein oder ersetzt eine passende ausstehende (pending) Nachricht,
// und verhindert Duplikate, falls dieselbe Nachricht sowohl per HTTP-Antwort als auch
// per Socket-Broadcast beim selben Client ankommt.
function upsertMessage(m) {
  const wrap = $("#messages");
  if (m.clientId) {
    const pendingEl = wrap.querySelector(`.msg[data-tempid="${m.clientId}"]`);
    if (pendingEl) { pendingEl.replaceWith(messageEl(m)); wrap.scrollTop = wrap.scrollHeight; return; }
  }
  if (m.id != null && wrap.querySelector(`.msg[data-id="${m.id}"]`)) return; // schon gerendert
  appendMessage(m, true);
}
function updateMessage(m) {
  const old = $("#messages").querySelector(`.msg[data-id="${m.id}"]`);
  if (old) old.replaceWith(messageEl(m));
}
function removeMessage(id) {
  $("#messages").querySelector(`.msg[data-id="${id}"]`)?.remove();
}
function updateReactions(id, reactions) {
  const el = $("#messages").querySelector(`.msg[data-id="${id}"] .reactions`);
  if (!el) return;
  const addBtn = el.querySelector(".react-add");
  el.innerHTML = reactions.map((r) => `<span class="reaction" data-emoji="${r.emoji}">${r.emoji} ${r.c}</span>`).join("");
  el.insertAdjacentHTML("beforeend", `<span class="react-add" title="Reagieren">+😀</span>`);
  el.querySelectorAll(".reaction").forEach((r) => { r.onclick = () => react(id, r.dataset.emoji); });
  el.querySelector(".react-add").onclick = () => {
    const emoji = prompt("Emoji für die Reaktion:", "🔥");
    if (emoji) react(id, emoji);
  };
}
async function react(id, emoji) {
  await api(`/api/messages/${id}/react`, { method: "POST", body: JSON.stringify({ emoji }) });
}

function renderMembers() {
  const wrap = $("#membersPane");
  wrap.innerHTML = `<div class="role-label">MITGLIEDER — ${state.server.members.length}</div>`;
  state.server.members
    .slice()
    .sort((a, b) => (b.isOwner - a.isOwner) || a.username.localeCompare(b.username))
    .forEach((m) => {
      const row = document.createElement("div");
      row.className = "member" + (m.status === "online" ? " online" : "");
      row.innerHTML = `
        <img class="avatar" src="${m.avatar}" />
        <span class="name">${escapeHtml(m.username)}${m.isOwner ? ' <span class="crown">👑</span>' : ""}${m.verified ? ' <span class="check" title="Verifiziert">✔</span>' : ""}</span>
        ${(state.user.isOwner && m.id !== state.user.id) ? `<span class="kick" title="Aus Server entfernen">Kick</span>` : ""}
      `;
      const kickBtn = row.querySelector(".kick");
      if (kickBtn) {
        kickBtn.onclick = async () => {
          if (!confirm(`${m.username} wirklich entfernen?`)) return;
          await api("/api/owner/kick", { method: "POST", body: JSON.stringify({ serverId: state.server.id, userId: m.id }) });
          state.server.members = state.server.members.filter((x) => x.id !== m.id);
          renderMembers();
        };
      }
      wrap.appendChild(row);
    });
}

// ---------- Owner panel ----------
$("#ownerPanelToggle").onclick = async () => {
  const d = await api("/api/owner/users");
  const list = $("#ownerUserList");
  list.innerHTML = "";
  d.users.forEach((u) => {
    const row = document.createElement("div");
    row.className = "owner-row";
    row.innerHTML = `
      <img class="avatar" src="${u.avatar}" />
      <span>${escapeHtml(u.username)}${u.isOwner ? ' <span class="crown">👑</span>' : ""}</span>
      ${u.verified ? '<span class="badge verified">Verifiziert</span>' : `<button class="verify-btn">Verifizieren</button>`}
    `;
    const btn = row.querySelector(".verify-btn");
    if (btn) {
      btn.onclick = async () => {
        await api("/api/owner/verify/" + u.id, { method: "POST" });
        $("#ownerPanelToggle").click();
      };
    }
    list.appendChild(row);
  });
  $("#ownerModal").classList.remove("hidden");
};
$("#closeOwnerModal").onclick = () => $("#ownerModal").classList.add("hidden");

// ---------- Composer ----------
$("#composer").onsubmit = (e) => {
  e.preventDefault();
  const content = $("#input").value.trim();
  $("#input").value = "";
  if (!content || !state.channel) return;
  const tempId = "temp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  // Sofort anzeigen, auch wenn der Server gerade schläft/nicht erreichbar ist.
  appendMessage({
    tempId, pending: true, user_id: state.user.id, username: state.user.username,
    avatar: state.user.avatar, content, created_at: new Date().toISOString(),
  }, true);
  queueMessage({ tempId, channelId: state.channel.id, content, attempts: 0 });
  flushQueue();
};
$("#input").oninput = () => { if (state.channel && socket) socket.emit("typing", { channelId: state.channel.id }); };

// ---------- Auth ----------
$("#login").onclick = async () => {
  try {
    const d = await api("/api/login", { method: "POST", body: JSON.stringify({ username: $("#loginUser").value, password: $("#loginPass").value }) });
    token = d.token; localStorage.setItem("nexus_token", token); location.reload();
  } catch (e) { $("#authMsg").textContent = e.message; }
};
$("#register").onclick = async () => {
  try {
    const d = await api("/api/register", { method: "POST", body: JSON.stringify({ username: $("#loginUser").value, password: $("#loginPass").value }) });
    token = d.token; localStorage.setItem("nexus_token", token); location.reload();
  } catch (e) { $("#authMsg").textContent = e.message; }
};

boot();
