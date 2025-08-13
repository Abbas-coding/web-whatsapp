import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const API = process.env.REACT_APP_BACKEND_URL; // change for prod

function App() {
  const [sessionId, setSessionId] = useState("");
  const [connectedStatus, setConnectedStatus] = useState("NOT_STARTED"); // NOT_STARTED | WAITING_QR | LOGGED_IN | ...
  const [qr, setQr] = useState("");
  const [number, setNumber] = useState("");
  const [message, setMessage] = useState("");
  const [file, setFile] = useState(null);
  const [log, setLog] = useState([]);
  const socketRef = useRef(null);

  // socket setup once
  useEffect(() => {
    const s = io(API, { transports: ["websocket"] });
    socketRef.current = s;

    s.on("connect", () => {
      console.log("socket connected");
    });

    s.on("status", (payload) => {
      if (payload?.status) {
        setConnectedStatus(payload.status);
        pushLog(`STATUS: ${payload.status}`);
      }
    });

    s.on("qr", ({ qr }) => {
      setQr(qr);
      pushLog("QR received.");
    });

    s.on("sent", (info) => {
      pushLog(`SENT: ${info.type} to ${info.to}${info.filename ? ` (${info.filename})` : ""}`);
    });

    s.on("error", (e) => {
      pushLog(`ERROR: ${e?.message || "Unknown error"}`);
    });

    return () => {
      s.disconnect();
    };
  }, []);

  const pushLog = (line) => setLog((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev]);

  const joinRoom = (id) => {
    if (!socketRef.current) return;
    socketRef.current.emit("join-session", id);
  };

  const startSession = async () => {
    if (!sessionId.trim()) return alert("Enter a session ID");
    setQr("");
    joinRoom(sessionId);

    const res = await fetch(`${API}/start-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId })
    });
    const data = await res.json();
    setConnectedStatus(data.status || "STARTING");

    // also poll status once to catch any existing QR quickly
    const stat = await fetch(`${API}/session-status/${sessionId}`).then(r => r.json());
    setConnectedStatus(stat.status);
    if (stat.qr) setQr(stat.qr);
  };

  const checkStatus = async () => {
    if (!sessionId.trim()) return alert("Enter a session ID");
    const data = await fetch(`${API}/session-status/${sessionId}`).then(r => r.json());
    setConnectedStatus(data.status);
    setQr(data.qr || "");
    pushLog(`STATUS: ${data.status}`);
  };

  const logout = async () => {
    if (!sessionId.trim()) return alert("Enter a session ID");
    const res = await fetch(`${API}/logout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId })
    });
    const data = await res.json();
    setConnectedStatus(data.status || "LOGGED_OUT");
    setQr("");
  };

  const sendText = async () => {
    if (!sessionId || !number || !message) return alert("Provide sessionId, number and message");
    const res = await fetch(`${API}/send-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, number, message })
    });
    const data = await res.json();
    if (data.status !== "SENT") pushLog(`ERROR: ${data.error || "Send failed"}`);
  };

  const sendMedia = async () => {
    if (!sessionId || !number || !file) return alert("Provide sessionId, number and choose a file");
    const formData = new FormData();
    formData.append("sessionId", sessionId);
    formData.append("number", number);
    formData.append("file", file);
    // Optional caption:
    // formData.append("caption", "Workout Plan");

    const res = await fetch(`${API}/send-media`, {
      method: "POST",
      body: formData
    });
    const data = await res.json();
    if (data.status !== "SENT") pushLog(`ERROR: ${data.error || "Send failed"}`);
  };

  return (
    <div style={{ maxWidth: 820, margin: "40px auto", fontFamily: "system-ui, Arial", padding: 16 }}>
      <h2>WhatsApp Integration — Multi-Session (Socket Enabled)</h2>

      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 8, alignItems: "center" }}>
        <input
          placeholder="Session ID (e.g. trainer1)"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
        />
        <button onClick={startSession}>Start Session</button>
        <button onClick={checkStatus}>Check Status</button>
        <button onClick={logout}>Logout</button>
      </div>

      <div style={{ marginTop: 12 }}>
        <b>Status:</b> {connectedStatus}
      </div>

      {qr && (
        <div style={{ marginTop: 16 }}>
          <p>Scan this QR in WhatsApp → Linked devices:</p>
          <img src={qr} alt="QR Code" style={{ width: 260, height: 260, border: "1px solid #ddd" }} />
        </div>
      )}

      <hr style={{ margin: "24px 0" }} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, alignItems: "center" }}>
        <input
          placeholder="Recipient (e.g. 923001234567)"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
        />
        <input
          placeholder="Text message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button onClick={sendText}>Send Text</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center", marginTop: 10 }}>
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button onClick={sendMedia}>Send File (PDF/Image/Video)</button>
      </div>

      <div style={{ marginTop: 24 }}>
        <b>Activity Log</b>
        <div style={{
          marginTop: 8,
          height: 180,
          overflow: "auto",
          border: "1px solid #eee",
          padding: 8,
          background: "#fafafa",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontSize: 12
        }}>
          {log.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      </div>
    </div>
  );
}

export default App;
