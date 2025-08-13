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
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000"], // change for prod
    methods: ["GET", "POST"]
  }
});

app.use(cors({ origin: "http://localhost:3000" })); // adjust for prod
app.use(express.json());

// temp upload dir (auto-cleaned after send)
const upload = multer({ dest: path.join(__dirname, "uploads") });

// ===== Session store =====
/**
 * sessions = {
 *   [sessionId]: {
 *     client: WhatsAppClient,
 *     ready: boolean,
 *     qrDataUrl: string | null
 *   }
 * }
 */
const sessions = {};

// ===== Helpers =====
const ensureConnected = async (sessionId) => {
  const session = sessions[sessionId];
  if (!session || !session.client) return { ok: false, reason: "NO_SESSION" };
  try {
    const state = await session.client.getState();
    const connected = state === "CONNECTED";
    session.ready = connected;
    return { ok: connected, reason: connected ? null : "NOT_CONNECTED" };
  } catch {
    session.ready = false;
    return { ok: false, reason: "NOT_CONNECTED" };
  }
};

const emitTo = (sessionId, event, payload) => {
  io.to(sessionId).emit(event, payload);
};

// ===== Create/Init Session =====
const createSession = (sessionId) => {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    }
  });

  sessions[sessionId] = { client, ready: false, qrDataUrl: null };

  client.on("qr", async (qr) => {
    try {
      const dataUrl = await QRCode.toDataURL(qr);
      sessions[sessionId].qrDataUrl = dataUrl;
      emitTo(sessionId, "qr", { qr: dataUrl });
      emitTo(sessionId, "status", { status: "WAITING_QR" });
    } catch (e) {
      emitTo(sessionId, "error", { message: "Failed to generate QR" });
    }
  });

  client.on("authenticated", () => {
    emitTo(sessionId, "status", { status: "AUTHENTICATED" });
  });

  client.on("ready", async () => {
    sessions[sessionId].ready = true;
    sessions[sessionId].qrDataUrl = null;
    emitTo(sessionId, "status", { status: "LOGGED_IN" });
  });

  client.on("auth_failure", (msg) => {
    sessions[sessionId].ready = false;
    emitTo(sessionId, "status", { status: "AUTH_FAILURE", detail: msg });
  });

  client.on("disconnected", (reason) => {
    emitTo(sessionId, "status", { status: "DISCONNECTED", reason });
    // Remove from memory so next call can re-init cleanly
    delete sessions[sessionId];
  });

  // (Optional) If you wanted inbound msg events to UI, you could:
  // client.on("message", (msg) => emitTo(sessionId, "incoming", { from: msg.from, body: msg.body }));

  client.initialize();
};

// ===== Socket.IO =====
io.on("connection", (socket) => {
  // client emits this to join a session room for realtime events
  socket.on("join-session", (sessionId) => {
    if (sessionId) {
      socket.join(sessionId);
      socket.emit("status", {
        status:
          sessions[sessionId]?.ready ? "LOGGED_IN" :
          sessions[sessionId]?.qrDataUrl ? "WAITING_QR" :
          sessions[sessionId] ? "STARTING" : "NOT_STARTED"
      });
      if (sessions[sessionId]?.qrDataUrl) {
        socket.emit("qr", { qr: sessions[sessionId].qrDataUrl });
      }
    }
  });

  socket.on("disconnect", () => { /* no-op */ });
});

// ===== REST APIs =====

// Start / Reuse a session
app.post("/start-session", (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  if (!sessions[sessionId]) {
    createSession(sessionId);
    return res.json({ status: "STARTING" });
  }
  return res.json({
    status: sessions[sessionId].ready ? "LOGGED_IN" : "WAITING_QR"
  });
});

// Session status (includes QR if any)
app.get("/session-status/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const sess = sessions[sessionId];
  if (!sess) return res.json({ status: "NOT_STARTED" });

  const state = await ensureConnected(sessionId);
  if (state.ok) {
    return res.json({ status: "LOGGED_IN" });
  } else {
    // If not connected but QR exists, tell UI to show it
    return res.json({
      status: sess.qrDataUrl ? "WAITING_QR" : "NOT_CONNECTED",
      qr: sess.qrDataUrl || null
    });
  }
});

// Send text message
app.post("/send-message", async (req, res) => {
  const { sessionId, number, message } = req.body;
  if (!sessionId || !number || !message) {
    return res.status(400).json({ error: "sessionId, number, message required" });
  }
  if (!sessions[sessionId]) return res.status(404).json({ error: "Session not found" });

  const ok = await ensureConnected(sessionId);
  if (!ok.ok) return res.status(400).json({ error: "Session not connected" });

  try {
    await sessions[sessionId].client.sendMessage(`${number}@c.us`, message);
    emitTo(sessionId, "sent", { to: number, type: "text" });
    return res.json({ status: "SENT" });
  } catch (e) {
    return res.status(500).json({ error: "Failed to send message" });
  }
});

// Send media (PDF/Image/etc.)
app.post("/send-media", upload.single("file"), async (req, res) => {
  const { sessionId, number } = req.body;
  const file = req.file;

  const session = sessions[sessionId];
  if (!session) return res.status(400).json({ error: "Session not found" });
  if (!session.ready) return res.status(400).json({ error: "Session not ready" });
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  try {
    const filePath = path.join(__dirname, "uploads", file.filename);

    // Read file in base64
    const fileData = fs.readFileSync(filePath, { encoding: "base64" });

    // Detect MIME type
    const mimeType = mime.lookup(file.originalname) || "application/octet-stream";

    // Create media object
    const media = new MessageMedia(mimeType, fileData, file.originalname);

    // Send via WhatsApp
    await session.client.sendMessage(`${number}@c.us`, media);

    // OPTIONAL: Save permanently to "sent_files"
    const sentFilesDir = path.join(__dirname, "sent_files");
    if (!fs.existsSync(sentFilesDir)) fs.mkdirSync(sentFilesDir);
    fs.renameSync(filePath, path.join(sentFilesDir, file.originalname));

    res.json({ status: "Media sent successfully" });
  } catch (err) {
    console.error("Error sending media:", err);
    res.status(500).json({ error: "Failed to send media" });
  }
});

// Logout session
app.post("/logout-session", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  const sess = sessions[sessionId];
  if (!sess) return res.status(404).json({ error: "Session not found" });

  try {
    await sess.client.logout();
  } catch (_) {
    // ignore
  } finally {
    delete sessions[sessionId];
    emitTo(sessionId, "status", { status: "LOGGED_OUT" });
    return res.json({ status: "LOGGED_OUT" });
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Backend running on :${PORT}`));
