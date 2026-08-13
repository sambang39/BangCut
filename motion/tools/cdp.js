// Minimal dependency-free CDP client.
//   node cdp.js '<js expr>' [await]      -> Runtime.evaluate
//   node cdp.js FILE <path> [await]      -> evaluate expression from file
//   node cdp.js SHOT <outfile.png>       -> Page.captureScreenshot
const net = require("net"), http = require("http"), crypto = require("crypto"), fs = require("fs");
const SHOT = process.argv[2] === "SHOT";
const SHOT_OUT = process.argv[3];
const FILE = process.argv[2] === "FILE";
const EXPR = FILE ? fs.readFileSync(process.argv[3], "utf8") : (process.argv[2] || "location.reload()");
const AWAIT = process.argv[3] === "await" || (FILE && process.argv[4] === "await");

function getTarget(cb) {
  http.get("http://localhost:8095/json", (res) => {
    let d = ""; res.on("data", c => d += c); res.on("end", () => {
      const t = JSON.parse(d).find(x => x.title === "BangCut") || JSON.parse(d)[0];
      cb(t.webSocketDebuggerUrl);
    });
  }).on("error", e => { console.log("HTTP_ERR", e.message); process.exit(1); });
}

function ws(url) {
  const u = new URL(url);
  const key = crypto.randomBytes(16).toString("base64");
  const sock = net.connect(u.port, u.hostname, () => {
    sock.write(
      `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
  let handshook = false, buf = Buffer.alloc(0);
  function send(obj) {
    const p = Buffer.from(JSON.stringify(obj));
    const mask = crypto.randomBytes(4);
    const len = p.length;
    let hdr;
    if (len < 126) hdr = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) { hdr = Buffer.from([0x81, 0x80 | 126, len >> 8 & 255, len & 255]); }
    else { hdr = Buffer.from([0x81, 0x80 | 127, 0,0,0,0, len>>24&255, len>>16&255, len>>8&255, len&255]); }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = p[i] ^ mask[i % 4];
    sock.write(Buffer.concat([hdr, mask, masked]));
  }
  sock.on("data", (chunk) => {
    if (!handshook) {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      handshook = true; buf = buf.slice(idx + 4);
      if (SHOT) send({ id: 1, method: "Page.captureScreenshot", params: { format: "png" } });
      else send({ id: 1, method: "Runtime.evaluate",
        params: { expression: EXPR, returnByValue: true, awaitPromise: AWAIT } });
      chunk = Buffer.alloc(0);
    } else {
      buf = Buffer.concat([buf, chunk]);
    }
    while (buf.length >= 2) {
      let len = buf[1] & 127, off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) break;
      const payload = buf.slice(off, off + len).toString();
      buf = buf.slice(off + len);
      try {
        const m = JSON.parse(payload);
        if (m.id === 1) {
          if (SHOT) {
            fs.writeFileSync(SHOT_OUT, Buffer.from(m.result.data, "base64"));
            console.log("SAVED " + SHOT_OUT);
          } else {
            const r = m.result && m.result.result;
            console.log(r ? JSON.stringify(r.value !== undefined ? r.value : r) : payload);
          }
          sock.end(); process.exit(0);
        }
      } catch (e) {}
    }
  });
  sock.on("error", e => { console.log("SOCK_ERR", e.message); process.exit(1); });
  setTimeout(() => { console.log("TIMEOUT"); process.exit(0); }, 15000);
}
getTarget(ws);
