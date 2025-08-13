import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const API = process.env.REACT_APP_BACKEND_URL || "http://localhost:5000";

export default function App() {
  const [sessionId, setSessionId] = useState("");
  const [status, setStatus] = useState("NOT_STARTED");
  const [qr, setQr] = useState("");
  const [number, setNumber] = useState("");
  const [message, setMessage] = useState("");
  const [file, setFile] = useState(null);
  const [adminLogs, setAdminLogs] = useState([]);
  const [logsLimit, setLogsLimit] = useState(200);

  const socketRef = useRef(null);

  useEffect(() => {
    const s = io(API, { transports: ["websocket"] });
    socketRef.current = s;

    s.on("status", (p) => p?.status && setStatus(p.status));
    s.on("qr", ({ qr }) => setQr(qr));
    s.on("sent", (info) => {
      // optionally push to UI log
      console.log("SENT:", info);
    });
    s.on("error", (e) => console.error("socket error", e));
    return () => s.disconnect();
  }, []);

  const joinRoom = () => {
    if (!sessionId.trim()) return alert("Enter a session ID");
    socketRef.current?.emit("join-session", sessionId);
  };

  const start = async () => {
    if (!sessionId.trim()) return alert("Enter a session ID");
    setQr("");
    joinRoom();

    const r = await fetch(`${API}/start-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId })
    });
    const data = await r.json();
    setStatus(data.status || "STARTING");

    // quick fallback for QR if socket misses first event
    const s = await fetch(`${API}/session-status/${sessionId}`).then(r => r.json());
    setStatus(s.status);
    if (s.qr) setQr(s.qr);
  };

  const check = async () => {
    if (!sessionId.trim()) return alert("Enter a session ID");
    const s = await fetch(`${API}/session-status/${sessionId}`).then(r => r.json());
    setStatus(s.status);
    setQr(s.qr || "");
  };

  const logout = async () => {
    if (!sessionId.trim()) return alert("Enter a session ID");
    const r = await fetch(`${API}/logout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId })
    });
    const d = await r.json();
    setStatus(d.status || "LOGGED_OUT");
    setQr("");
  };

  const sendText = async () => {
    if (!sessionId || !number || !message) return alert("Provide sessionId, number, message");
    const r = await fetch(`${API}/send-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, number, message })
    });
    const d = await r.json();
    if (d.status !== "SENT") alert(d.error || "Send failed");
  };

  const sendMedia = async () => {
    if (!sessionId || !number || !file) return alert("Provide sessionId, number, file");
    const form = new FormData();
    form.append("sessionId", sessionId);
    form.append("number", number);
    form.append("file", file);
    // form.append("caption", "Optional caption");

    const r = await fetch(`${API}/send-media`, { method: "POST", body: form });
    const d = await r.json();
    if (d.status !== "SENT") alert(d.error || "Send failed");
  };

  const fetchLogs = async () => {
    const params = new URLSearchParams();
    if (sessionId) params.set("sessionId", sessionId);
    params.set("limit", logsLimit);
    const r = await fetch(`${API}/admin/logs?` + params.toString());
    const data = await r.json();
    setAdminLogs(data);
  };

  const deleteCache = async () => {
    if (!sessionId.trim()) return alert("Enter a session ID");
    const r = await fetch(`${API}/admin/delete-cache`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId })
    });
    const d = await r.json();
    alert(d.status || "Done");
  };

  const forceReset = async () => {
    if (!sessionId.trim()) return alert("Enter a session ID");
    const r = await fetch(`${API}/admin/force-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId })
    });
    const d = await r.json();
    setStatus("NOT_STARTED");
    setQr("");
    alert(d.status || "Reset done");
  };

  return (
    <div style={{ maxWidth: 960, margin: "32px auto", fontFamily: "system-ui, Arial", padding: 16 }}>
      <h2>WhatsApp Integration — Render Test Console</h2>

      <div style={{ display: "grid", gridTemplateColumns: "1.5fr auto auto auto auto", gap: 8 }}>
        <input placeholder="Session ID (e.g. trainer1)" value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
        <button onClick={start}>Start</button>
        <button onClick={check}>Check</button>
        <button onClick={logout}>Logout</button>
        <button onClick={joinRoom}>Join Room</button>
      </div>

      <div style={{ marginTop: 10 }}><b>Status:</b> {status}</div>

      {qr && (
        <div style={{ marginTop: 16 }}>
          <p>Scan this QR in WhatsApp → Linked devices:</p>
          <img src={qr} alt="QR" style={{ width: 260, height: 260, border: "1px solid #ddd" }} />
        </div>
      )}

      <hr style={{ margin: "24px 0" }} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8 }}>
        <input placeholder="Recipient (e.g. 923001234567)" value={number} onChange={(e) => setNumber(e.target.value)} />
        <input placeholder="Message" value={message} onChange={(e) => setMessage(e.target.value)} />
        <button onClick={sendText}>Send Text</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginTop: 8 }}>
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button onClick={sendMedia}>Send File</button>
      </div>

      <hr style={{ margin: "24px 0" }} />

      <div style={{ display: "grid", gridTemplateColumns: "auto auto auto auto 1fr", gap: 8, alignItems: "center" }}>
        <button onClick={fetchLogs}>Fetch Logs</button>
        <input type="number" min="10" max="1000" value={logsLimit} onChange={(e) => setLogsLimit(e.target.value)} style={{ width: 100 }} />
        <button onClick={deleteCache}>Delete Cache</button>
        <button onClick={forceReset}>Force Reset</button>
        <div>Backend: {API}</div>
      </div>

      <div style={{
        marginTop: 12, height: 260, overflow: "auto", border: "1px solid #eee", padding: 8,
        background: "#fafafa", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono'", fontSize: 12
      }}>
        {adminLogs.map((l, i) => (
          <div key={i}>
            [{l.ts}] [{l.level}] {l.sessionId ? `[${l.sessionId}] ` : ""}{l.msg} {l.meta ? JSON.stringify(l.meta) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}
