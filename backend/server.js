// server.js
require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const mime = require("mime-types");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

const app = express();
const server = http.createServer(app);

// ===== CORS (REST) =====
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,           // production frontend
  "http://localhost:3000"             // local dev frontend
].filter(Boolean);

app.use((req, res, next) => {
  // make sure preflights never fail
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (ALLOWED_ORIGINS.includes(req.headers.origin)) {
    res.header("Access-Control-Allow-Origin", req.headers.origin);
  }
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(cors({ origin: ALLOWED_ORIGINS, methods: ["GET", "POST"], credentials: false }));
app.use(express.json());

// ===== Socket.IO (CORS) =====
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"] }
});

// ===== Uploads (fixed paths) =====
const UPLOAD_DIR = path.join(__dirname, "uploads");
const SENT_DIR = path.join(__dirname, "sent_files");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(SENT_DIR)) fs.mkdirSync(SENT_DIR);
const upload = multer({ dest: UPLOAD_DIR });

// ===== Logs (ring buffer) =====
const MAX_LOGS = 1000;
const logs = []; // {ts, sessionId, level, msg, meta}

const log = (level, msg, sessionId = null, meta = null) => {
  const entry = { ts: new Date().toISOString(), sessionId, level, msg, meta };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  console.log(`[${entry.ts}] [${level}] ${sessionId ? `[${sessionId}] ` : ""}${msg}`, meta || "");
};
const emitTo = (sessionId, event, payload) => io.to(sessionId).emit(event, payload);

// ===== Sessions =====
/**
 * sessions = {
 *   [sessionId]: {
 *     client,
 *     ready: boolean,
 *     qrDataUrl: string | null
 *   }
 * }
 */
const sessions = {};

const getAuthDirsForSession = (sessionId) => {
  // whatsapp-web.js with LocalAuth stores at .wwebjs_auth/session-<clientId>
  const base = path.join(process.cwd(), ".wwebjs_auth");
  return [
    path.join(base, `session-${sessionId}`),
    // fallback pattern (older versions)
    path.join(base, sessionId)
  ];
};

const ensureConnected = async (sessionId) => {
  const sess = sessions[sessionId];
  if (!sess || !sess.client) return { ok: false, reason: "NO_SESSION" };
  try {
    const state = await sess.client.getState();
    const connected = state === "CONNECTED";
    sess.ready = connected;
    return { ok: connected, reason: connected ? null : "NOT_CONNECTED" };
  } catch (e) {
    sess.ready = false;
    return { ok: false, reason: "NOT_CONNECTED" };
  }
};

const createSession = (sessionId) => {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: {
      headless: true,
      // Render-friendly flags for quick, sandboxed startup
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-dev-shm-usage",
        "--no-zygote",
        "--single-process"
      ]
    }
  });

  sessions[sessionId] = { client, ready: false, qrDataUrl: null };

  client.on("qr", async (qr) => {
    try {
      const dataUrl = await QRCode.toDataURL(qr);
      sessions[sessionId].qrDataUrl = dataUrl;
      emitTo(sessionId, "qr", { qr: dataUrl });
      emitTo(sessionId, "status", { status: "WAITING_QR" });
      log("INFO", "QR generated", sessionId);
    } catch (e) {
      emitTo(sessionId, "error", { message: "QR generation failed" });
      log("ERROR", "QR generation failed", sessionId, { error: String(e) });
    }
  });

  client.on("authenticated", () => {
    log("INFO", "Authenticated", sessionId);
    emitTo(sessionId, "status", { status: "AUTHENTICATED" });
  });

  client.on("ready", () => {
    sessions[sessionId].ready = true;
    sessions[sessionId].qrDataUrl = null;
    log("INFO", "Client ready", sessionId);
    emitTo(sessionId, "status", { status: "LOGGED_IN" });
  });

  client.on("auth_failure", (msg) => {
    sessions[sessionId].ready = false;
    log("WARN", "Auth failure", sessionId, { msg });
    emitTo(sessionId, "status", { status: "AUTH_FAILURE", detail: msg });
  });

  client.on("disconnected", (reason) => {
    log("WARN", "Client disconnected", sessionId, { reason });
    emitTo(sessionId, "status", { status: "DISCONNECTED", reason });
    delete sessions[sessionId];
  });

  client.initialize();
  log("INFO", "Session initializing", sessionId);
};

// ===== Socket.IO =====
io.on("connection", (socket) => {
  socket.on("join-session", (sessionId) => {
    if (!sessionId) return;
    socket.join(sessionId);
    const sess = sessions[sessionId];
    const status =
      sess?.ready ? "LOGGED_IN" :
      sess?.qrDataUrl ? "WAITING_QR" :
      sess ? "STARTING" : "NOT_STARTED";
    socket.emit("status", { status });
    if (sess?.qrDataUrl) socket.emit("qr", { qr: sess.qrDataUrl });
  });
});

// ===== REST APIs =====

// Health
app.get("/admin/ping", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), sessions: Object.keys(sessions) });
});

// Admin logs
app.get("/admin/logs", (req, res) => {
  const { sessionId, limit } = req.query;
  let out = logs;
  if (sessionId) out = out.filter(l => l.sessionId === sessionId);
  const lim = Math.min(Number(limit) || 200, 1000);
  res.json(out.slice(-lim).reverse());
});

// Start/Re-use session
app.post("/start-session", (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  if (!sessions[sessionId]) {
    createSession(sessionId);
    return res.json({ status: "STARTING" });
  }
  const sess = sessions[sessionId];
  return res.json({ status: sess.ready ? "LOGGED_IN" : (sess.qrDataUrl ? "WAITING_QR" : "STARTING") });
});

// Session status (quick QR fallback)
app.get("/session-status/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const sess = sessions[sessionId];
  if (!sess) return res.json({ status: "NOT_STARTED" });

  const state = await ensureConnected(sessionId);
  if (state.ok) return res.json({ status: "LOGGED_IN" });

  return res.json({
    status: sess.qrDataUrl ? "WAITING_QR" : "NOT_CONNECTED",
    qr: sess.qrDataUrl || null
  });
});

// Send text
app.post("/send-message", async (req, res) => {
  const { sessionId, number, message } = req.body;
  if (!sessionId || !number || !message) {
    return res.status(400).json({ error: "sessionId, number, message required" });
  }
  const sess = sessions[sessionId];
  if (!sess) return res.status(404).json({ error: "Session not found" });

  const ok = await ensureConnected(sessionId);
  if (!ok.ok) return res.status(400).json({ error: "Session not connected" });

  try {
    await sess.client.sendMessage(`${number}@c.us`, message);
    emitTo(sessionId, "sent", { to: number, type: "text" });
    log("INFO", "Text sent", sessionId, { to: number });
    res.json({ status: "SENT" });
  } catch (e) {
    log("ERROR", "Send text failed", sessionId, { error: String(e) });
    res.status(500).json({ error: "Failed to send message" });
  }
});

// Send media (PDF/Image/Video)
app.post("/send-media", upload.single("file"), async (req, res) => {
  const { sessionId, number, caption } = req.body;
  const file = req.file;
  if (!sessionId || !number || !file) {
    return res.status(400).json({ error: "sessionId, number, file required" });
  }
  const sess = sessions[sessionId];
  if (!sess) return res.status(404).json({ error: "Session not found" });

  const ok = await ensureConnected(sessionId);
  if (!ok.ok) {
    try { fs.unlinkSync(file.path); } catch {}
    return res.status(400).json({ error: "Session not connected" });
  }

  try {
    const absPath = path.join(UPLOAD_DIR, file.filename);
    const base64 = fs.readFileSync(absPath, { encoding: "base64" });
    const mimeType = mime.lookup(file.originalname) || "application/octet-stream";
    const media = new MessageMedia(mimeType, base64, file.originalname);

    await sess.client.sendMessage(`${number}@c.us`, media, { caption });
    emitTo(sessionId, "sent", { to: number, type: "media", filename: file.originalname });
    log("INFO", "Media sent", sessionId, { to: number, filename: file.originalname });

    // persist to sent_files (optional)
    const finalPath = path.join(SENT_DIR, file.originalname);
    fs.renameSync(absPath, finalPath);

    res.json({ status: "SENT" });
  } catch (e) {
    log("ERROR", "Send media failed", sessionId, { error: String(e) });
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: "Failed to send media" });
  }
});

// Logout
app.post("/logout-session", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  const sess = sessions[sessionId];
  if (!sess) return res.status(404).json({ error: "Session not found" });

  try {
    await sess.client.logout();
  } catch (_) {}
  delete sessions[sessionId];
  log("INFO", "Logged out", sessionId);
  emitTo(sessionId, "status", { status: "LOGGED_OUT" });
  res.json({ status: "LOGGED_OUT" });
});

// Delete cache only (auth folders)
app.post("/admin/delete-cache", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  const dirs = getAuthDirsForSession(sessionId);
  let deleted = [];
  for (const d of dirs) {
    if (fs.existsSync(d)) {
      fs.rmSync(d, { recursive: true, force: true });
      deleted.push(d);
    }
  }
  log("INFO", "Cache deleted", sessionId, { deleted });
  res.json({ status: "CACHE_DELETED", deleted });
});

// Force reset (logout + delete cache)
app.post("/admin/force-reset", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  try {
    if (sessions[sessionId]?.client) {
      try { await sessions[sessionId].client.logout(); } catch (_) {}
      delete sessions[sessionId];
    }
    const dirs = getAuthDirsForSession(sessionId);
    let deleted = [];
    for (const d of dirs) {
      if (fs.existsSync(d)) {
        fs.rmSync(d, { recursive: true, force: true });
        deleted.push(d);
      }
    }
    log("INFO", "Force reset complete", sessionId, { deleted });
    res.json({ status: "FORCE_RESET_DONE", deleted });
  } catch (e) {
    log("ERROR", "Force reset failed", sessionId, { error: String(e) });
    res.status(500).json({ error: "Force reset failed" });
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  log("INFO", `Backend running on :${PORT}`);
});
