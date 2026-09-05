import express from "express";
import http from "http";
import { Server } from "socket.io";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const db = new Database("nexus-chat.db");
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
// Optionaler manueller Override: Owner per Umgebungsvariable erzwingen.
// Standardmäßig wird aber automatisch der ERSTE registrierte Account zum Owner.
const FORCE_OWNER_USERNAME = process.env.OWNER_USERNAME || null;

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  avatar TEXT,
  status TEXT DEFAULT 'online',
  is_owner INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS servers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_id INTEGER
);
CREATE TABLE IF NOT EXISTS memberships(
  server_id INTEGER, user_id INTEGER, role TEXT DEFAULT 'member',
  PRIMARY KEY(server_id, user_id)
);
CREATE TABLE IF NOT EXISTS channels(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER, name TEXT NOT NULL, type TEXT DEFAULT 'text'
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER, user_id INTEGER, content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  edited INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reactions(
  message_id INTEGER, user_id INTEGER, emoji TEXT,
  PRIMARY KEY(message_id, user_id, emoji)
);
`);

function avatarFor(name) {
  return `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(name)}`;
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, avatar: u.avatar, status: u.status, isOwner: !!u.is_owner, verified: !!u.verified };
}
function messageWithReactions(row) {
  const reactions = db.prepare("SELECT emoji, COUNT(*) c FROM reactions WHERE message_id=? GROUP BY emoji").all(row.id);
  return { ...row, reactions };
}

app.use(express.json());
app.use(express.static("public"));

function auth(req, res, next) {
  try {
    req.user = jwt.verify((req.headers.authorization || "").replace("Bearer ", ""), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Nicht angemeldet" });
  }
}
function requireOwner(req, res, next) {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if (!u || !u.is_owner) return res.status(403).json({ error: "Nur für den Owner-Account" });
  req.dbUser = u;
  next();
}

// ---------- Auth ----------
app.post("/api/register", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 2 || password.length < 4) {
    return res.status(400).json({ error: "Benutzername (min. 2) und Passwort (min. 4 Zeichen) erforderlich" });
  }
  try {
    const noUsersYet = db.prepare("SELECT COUNT(*) c FROM users").get().c === 0;
    const makeOwner = noUsersYet || (FORCE_OWNER_USERNAME && username === FORCE_OWNER_USERNAME);
    const hash = bcrypt.hashSync(password, 10);
    const r = db.prepare("INSERT INTO users(username,password,avatar,is_owner,verified) VALUES(?,?,?,?,?)")
      .run(username, hash, avatarFor(username), makeOwner ? 1 : 0, makeOwner ? 1 : 0);

    if (makeOwner) {
      // Allererster Account: legt automatisch die erste Community an und wird deren Owner.
      const s = db.prepare("INSERT INTO servers(name,owner_id) VALUES(?,?)").run("Meine Community", r.lastInsertRowid);
      db.prepare("INSERT INTO memberships(server_id,user_id,role) VALUES(?,?,?)").run(s.lastInsertRowid, r.lastInsertRowid, "owner");
      for (const [chName, type] of [["allgemein", "text"], ["memes", "text"], ["Lounge", "voice"]]) {
        db.prepare("INSERT INTO channels(server_id,name,type) VALUES(?,?,?)").run(s.lastInsertRowid, chName, type);
      }
    } else {
      // Weitere Nutzer treten der ersten bestehenden Community bei.
      const existingServer = db.prepare("SELECT * FROM servers ORDER BY id LIMIT 1").get();
      if (existingServer) {
        db.prepare("INSERT OR IGNORE INTO memberships(server_id,user_id,role) VALUES(?,?,?)").run(existingServer.id, r.lastInsertRowid, "member");
      }
    }
    const token = jwt.sign({ id: r.lastInsertRowid, username }, JWT_SECRET);
    res.json({ token, user: publicUser({ id: r.lastInsertRowid, username, avatar: avatarFor(username), status: "online", is_owner: makeOwner ? 1 : 0, verified: makeOwner ? 1 : 0 }) });
  } catch (e) {
    res.status(409).json({ error: "Benutzername bereits vergeben" });
  }
});

app.post("/api/login", (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE username=?").get(req.body?.username);
  if (!u || !bcrypt.compareSync(req.body?.password || "", u.password)) {
    return res.status(401).json({ error: "Benutzername oder Passwort falsch" });
  }
  db.prepare("UPDATE users SET status='online' WHERE id=?").run(u.id);
  res.json({ token: jwt.sign({ id: u.id, username: u.username }, JWT_SECRET), user: publicUser(u) });
});

// ---------- Bootstrap ----------
app.get("/api/bootstrap", auth, (req, res) => {
  const me = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  const servers = db.prepare(`
    SELECT s.*, m.role FROM servers s
    JOIN memberships m ON m.server_id = s.id
    WHERE m.user_id = ? ORDER BY s.id
  `).all(req.user.id);
  for (const s of servers) {
    s.channels = db.prepare("SELECT * FROM channels WHERE server_id=? ORDER BY id").all(s.id);
    s.members = db.prepare(`
      SELECT u.id, u.username, u.avatar, u.status, u.is_owner, u.verified, m.role
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.server_id = ? ORDER BY u.username
    `).all(s.id).map(r => ({ ...publicUser(r), role: r.role }));
  }
  const first = servers[0];
  const firstTextChannel = first?.channels?.find(c => c.type === "text");
  let messages = [];
  if (firstTextChannel) {
    const rows = db.prepare(`
      SELECT m.*, u.username, u.avatar FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE channel_id=? ORDER BY m.id DESC LIMIT 100
    `).all(firstTextChannel.id).reverse();
    messages = rows.map(messageWithReactions);
  }
  res.json({ user: publicUser(me), servers, messages, activeChannelId: firstTextChannel?.id || null });
});

// ---------- Servers & channels ----------
app.post("/api/servers", auth, (req, res) => {
  const name = (req.body?.name || "Neuer Server").trim().slice(0, 40);
  const s = db.prepare("INSERT INTO servers(name,owner_id) VALUES(?,?)").run(name, req.user.id);
  db.prepare("INSERT INTO memberships(server_id,user_id,role) VALUES(?,?,?)").run(s.lastInsertRowid, req.user.id, "owner");
  db.prepare("INSERT INTO channels(server_id,name,type) VALUES(?,?,?)").run(s.lastInsertRowid, "allgemein", "text");
  db.prepare("INSERT INTO channels(server_id,name,type) VALUES(?,?,?)").run(s.lastInsertRowid, "Allgemein", "voice");
  res.json({ id: s.lastInsertRowid });
});

app.post("/api/channels", auth, (req, res) => {
  const member = db.prepare("SELECT * FROM memberships WHERE server_id=? AND user_id=?").get(req.body.serverId, req.user.id);
  if (!member) return res.status(403).json({ error: "Kein Mitglied dieses Servers" });
  const r = db.prepare("INSERT INTO channels(server_id,name,type) VALUES(?,?,?)")
    .run(req.body.serverId, (req.body.name || "neuer-kanal").trim().slice(0, 40), req.body.type === "voice" ? "voice" : "text");
  res.json({ id: r.lastInsertRowid });
});

app.delete("/api/channels/:id", auth, (req, res) => {
  const ch = db.prepare("SELECT * FROM channels WHERE id=?").get(req.params.id);
  if (!ch) return res.status(404).json({ error: "Kanal nicht gefunden" });
  const member = db.prepare("SELECT * FROM memberships WHERE server_id=? AND user_id=?").get(ch.server_id, req.user.id);
  const me = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if (!member || (member.role !== "owner" && !me.is_owner)) return res.status(403).json({ error: "Keine Berechtigung" });
  db.prepare("DELETE FROM messages WHERE channel_id=?").run(req.params.id);
  db.prepare("DELETE FROM channels WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- Messages ----------
app.get("/api/messages/:channelId", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, u.username, u.avatar FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE channel_id=? ORDER BY m.id DESC LIMIT 100
  `).all(req.params.channelId).reverse();
  res.json(rows.map(messageWithReactions));
});

// Zusätzlich zum Socket-Weg: Nachrichten per normalem HTTP-Request senden.
// Ein HTTP-Request weckt einen eingeschlafenen Free-Tier-Server (z.B. Render)
// zuverlässiger auf als ein WebSocket-Verbindungsversuch, deshalb nutzt der
// Client diesen Weg automatisch, solange der Socket nicht verbunden ist.
app.post("/api/messages", auth, (req, res) => {
  const { channelId, content, clientId } = req.body || {};
  const text = (content || "").trim();
  if (!text || !channelId) return res.status(400).json({ error: "Kanal und Inhalt erforderlich" });
  const ch = db.prepare("SELECT * FROM channels WHERE id=?").get(channelId);
  if (!ch) return res.status(404).json({ error: "Kanal nicht gefunden" });
  const member = db.prepare("SELECT * FROM memberships WHERE server_id=? AND user_id=?").get(ch.server_id, req.user.id);
  if (!member) return res.status(403).json({ error: "Kein Mitglied dieses Servers" });
  const r = db.prepare("INSERT INTO messages(channel_id,user_id,content) VALUES(?,?,?)").run(channelId, req.user.id, text);
  const msg = messageWithReactions(db.prepare(`
    SELECT m.*, u.username, u.avatar FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?
  `).get(r.lastInsertRowid));
  msg.clientId = clientId || null;
  io.to(`channel:${channelId}`).emit("message", msg);
  res.json(msg);
});

function canModify(req, msg) {
  const me = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  return msg.user_id === req.user.id || !!me?.is_owner;
}

app.put("/api/messages/:id", auth, (req, res) => {
  const msg = db.prepare("SELECT * FROM messages WHERE id=?").get(req.params.id);
  if (!msg) return res.status(404).json({ error: "Nachricht nicht gefunden" });
  if (!canModify(req, msg)) return res.status(403).json({ error: "Keine Berechtigung" });
  const content = (req.body?.content || "").trim();
  if (!content) return res.status(400).json({ error: "Nachricht darf nicht leer sein" });
  db.prepare("UPDATE messages SET content=?, edited=1 WHERE id=?").run(content, req.params.id);
  const updated = messageWithReactions(db.prepare(`
    SELECT m.*, u.username, u.avatar FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?
  `).get(req.params.id));
  io.to(`channel:${msg.channel_id}`).emit("message_edited", updated);
  res.json(updated);
});

app.delete("/api/messages/:id", auth, (req, res) => {
  const msg = db.prepare("SELECT * FROM messages WHERE id=?").get(req.params.id);
  if (!msg) return res.status(404).json({ error: "Nachricht nicht gefunden" });
  if (!canModify(req, msg)) return res.status(403).json({ error: "Keine Berechtigung" });
  db.prepare("DELETE FROM reactions WHERE message_id=?").run(req.params.id);
  db.prepare("DELETE FROM messages WHERE id=?").run(req.params.id);
  io.to(`channel:${msg.channel_id}`).emit("message_deleted", { id: Number(req.params.id), channel_id: msg.channel_id });
  res.json({ ok: true });
});

app.post("/api/messages/:id/react", auth, (req, res) => {
  const msg = db.prepare("SELECT * FROM messages WHERE id=?").get(req.params.id);
  if (!msg) return res.status(404).json({ error: "Nachricht nicht gefunden" });
  const emoji = (req.body?.emoji || "👍").slice(0, 8);
  const existing = db.prepare("SELECT * FROM reactions WHERE message_id=? AND user_id=? AND emoji=?").get(req.params.id, req.user.id, emoji);
  if (existing) db.prepare("DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?").run(req.params.id, req.user.id, emoji);
  else db.prepare("INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,?)").run(req.params.id, req.user.id, emoji);
  const reactions = db.prepare("SELECT emoji, COUNT(*) c FROM reactions WHERE message_id=? GROUP BY emoji").all(req.params.id);
  io.to(`channel:${msg.channel_id}`).emit("reaction_updated", { id: msg.id, reactions });
  res.json({ reactions });
});

// ---------- Owner-only moderation ----------
app.get("/api/owner/users", auth, requireOwner, (req, res) => {
  const users = db.prepare("SELECT id, username, avatar, status, is_owner, verified FROM users ORDER BY username").all();
  res.json({ users: users.map(publicUser) });
});

app.post("/api/owner/verify/:id", auth, requireOwner, (req, res) => {
  const result = db.prepare("UPDATE users SET verified=1 WHERE id=?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Nutzer nicht gefunden" });
  const user = db.prepare("SELECT id, username FROM users WHERE id=?").get(req.params.id);
  res.json({ ok: true, message: `${user.username} wurde verifiziert`, user });
});

app.post("/api/owner/kick", auth, requireOwner, (req, res) => {
  const { serverId, userId } = req.body || {};
  db.prepare("DELETE FROM memberships WHERE server_id=? AND user_id=?").run(serverId, userId);
  io.emit("member_kicked", { serverId, userId });
  res.json({ ok: true });
});

// ---------- Realtime ----------
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth?.token || "", JWT_SECRET);
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});

io.on("connection", (socket) => {
  db.prepare("UPDATE users SET status='online' WHERE id=?").run(socket.user.id);

  socket.on("join_channel", (id) => socket.join(`channel:${id}`));

  socket.on("send_message", ({ channelId, content }) => {
    content = (content || "").trim();
    if (!content || !channelId) return;
    const r = db.prepare("INSERT INTO messages(channel_id,user_id,content) VALUES(?,?,?)").run(channelId, socket.user.id, content);
    const msg = messageWithReactions(db.prepare(`
      SELECT m.*, u.username, u.avatar FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?
    `).get(r.lastInsertRowid));
    io.to(`channel:${channelId}`).emit("message", msg);
  });

  socket.on("typing", ({ channelId }) => {
    socket.to(`channel:${channelId}`).emit("typing", { username: socket.user.username });
  });

  socket.on("disconnect", () => {
    db.prepare("UPDATE users SET status='offline' WHERE id=?").run(socket.user.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Nexus Chat läuft auf http://localhost:" + PORT));
