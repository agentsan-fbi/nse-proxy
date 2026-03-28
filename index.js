const express = require("express");
const https   = require("https");
const zlib    = require("zlib");
const crypto  = require("crypto");
const path    = require("path");
const app     = express();

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// ── In-memory token store (resets on server restart)
let fyersToken = null;
let fyersTokenTime = null;

// ── Generic HTTPS fetch with decompression
function get(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const enc = (res.headers["content-encoding"] || "").toLowerCase();
        const decomp = (cb) => {
          if (enc.includes("br"))      zlib.brotliDecompress(buf, cb);
          else if (enc.includes("gzip")) zlib.gunzip(buf, cb);
          else if (enc.includes("deflate")) zlib.inflate(buf, (e,d) => e ? zlib.inflateRaw(buf,cb) : cb(null,d));
          else cb(null, buf);
        };
        decomp((err, d) => {
          if (err) return reject(err);
          resolve({ status: res.statusCode, headers: res.headers, text: d.toString("utf8") });
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

function post(opts, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    opts.method = "POST";
    opts.headers = opts.headers || {};
    opts.headers["Content-Type"] = "application/json";
    opts.headers["Content-Length"] = Buffer.byteLength(data);
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, text: buf.toString("utf8") });
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(data);
    req.end();
  });
}

// ── Yahoo Finance (server-side proxy for candles)
async function fetchYahoo(symbol, interval, range) {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  const p = `/v8/finance/chart/${symbol}?interval=${interval}&range=${range}&includePrePost=false`;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://finance.yahoo.com",
    "Referer": "https://finance.yahoo.com/"
  };
  for (const host of hosts) {
    try {
      const r = await get({ hostname: host, path: p, method: "GET", headers });
      if (r.status === 429) continue;
      const j = JSON.parse(r.text);
      if (j.chart?.result?.[0]?.timestamp) return j;
    } catch(e) { console.warn("Yahoo", host, e.message); }
  }
  throw new Error("Yahoo Finance rate limited or unavailable");
}

// ── NSE Option Chain
async function fetchNSE(symbol) {
  const r1 = await get({
    hostname: "www.nseindia.com", path: "/option-chain", method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "en-IN,en;q=0.9", "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive", "Cache-Control": "max-age=0"
    }
  });
  const cookies = (r1.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");
  await new Promise(r => setTimeout(r, 1000));
  const r2 = await get({
    hostname: "www.nseindia.com", path: `/api/option-chain-indices?symbol=${symbol}`, method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-IN,en;q=0.9", "Accept-Encoding": "gzip, deflate, br",
      "Referer": "https://www.nseindia.com/option-chain",
      "X-Requested-With": "XMLHttpRequest", "Connection": "keep-alive", "Cookie": cookies
    }
  });
  const j = JSON.parse(r2.text);
  if (j?.records?.underlyingValue) return j;
  throw new Error("NSE blocked (market may be closed). Preview: " + r2.text.substring(0,150));
}

// ══════════════════════════════════════════════════════
// FYERS INTEGRATION
// ══════════════════════════════════════════════════════
const FYERS_APP_ID  = "WFKOLJNNHC-100";
const FYERS_SECRET  = "W8ZQVQ8PM4";
const REDIRECT_URI  = "https://nse-proxy-1o55.onrender.com/api/fyers/callback";

// Step 1: Generate Fyers login URL
app.get("/api/fyers/auth-url", (req, res) => {
  const sha256 = crypto.createHash("sha256").update(FYERS_APP_ID + ":" + FYERS_SECRET).digest("hex");
  const url = `https://api-t1.fyers.in/api/v3/generate-authcode?client_id=${FYERS_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&state=algo_trader&nonce=${sha256}`;
  res.json({ success: true, url });
});

// Step 2: Fyers OAuth callback — exchange auth_code for access_token
app.get("/api/fyers/callback", async (req, res) => {
  const { auth_code, s, code } = req.query;
  if (s !== "ok" || !auth_code) {
    return res.send(`<html><body style="background:#0a0c0f;color:#ef4444;font-family:monospace;padding:30px;">
      <h2>Fyers Login Failed</h2><p>Error: ${req.query.message || "Unknown error"}</p>
      <a href="/" style="color:#00d4aa;">← Back to App</a></body></html>`);
  }
  try {
    const sha256 = crypto.createHash("sha256").update(FYERS_APP_ID + ":" + FYERS_SECRET).digest("hex");
    const r = await post({
      hostname: "api-t1.fyers.in",
      path: "/api/v3/validate-authcode",
      headers: { "Content-Type": "application/json" }
    }, {
      grant_type: "authorization_code",
      appIdHash: sha256,
      code: auth_code
    });
    const j = JSON.parse(r.text);
    if (j.access_token) {
      fyersToken = j.access_token;
      fyersTokenTime = new Date().toLocaleString("en-IN");
      console.log("Fyers token obtained at", fyersTokenTime);
      return res.send(`<html><head><meta http-equiv="refresh" content="2;url=/"></head>
        <body style="background:#07090c;color:#00d4aa;font-family:monospace;padding:40px;text-align:center;">
        <h2>✓ Fyers Connected Successfully!</h2>
        <p style="color:#64748b;">Redirecting to app...</p>
        <script>setTimeout(()=>window.location.href='/',1500);</script>
        </body></html>`);
    } else {
      throw new Error(j.message || JSON.stringify(j));
    }
  } catch(e) {
    console.error("Fyers token error:", e.message);
    res.send(`<html><body style="background:#0a0c0f;color:#ef4444;font-family:monospace;padding:30px;">
      <h2>Token Error</h2><p>${e.message}</p>
      <a href="/" style="color:#00d4aa;">← Back to App</a></body></html>`);
  }
});

// Step 3: Check if token is valid
app.get("/api/fyers/status", (req, res) => {
  res.json({
    connected: !!fyersToken,
    tokenTime: fyersTokenTime,
    appId: FYERS_APP_ID
  });
});

// Step 4: Logout / clear token
app.post("/api/fyers/logout", (req, res) => {
  fyersToken = null; fyersTokenTime = null;
  res.json({ success: true });
});

// Step 5: Fyers Option Chain proxy
app.get("/api/fyers/option-chain", async (req, res) => {
  if (!fyersToken) return res.json({ success: false, error: "Not connected. Please login with Fyers first." });
  const symbol = req.query.symbol || "NSE:NIFTY50-INDEX";
  const strikeCount = req.query.strikes || 20;
  try {
    const r = await get({
      hostname: "api-t1.fyers.in",
      path: `/data/v3/options-chain?symbol=${encodeURIComponent(symbol)}&strikecount=${strikeCount}`,
      method: "GET",
      headers: {
        "Authorization": FYERS_APP_ID + ":" + fyersToken,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate, br"
      }
    });
    const j = JSON.parse(r.text);
    res.json({ success: j.s === "ok", data: j, error: j.message });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Step 6: Fyers quotes (LTP for Nifty/BankNifty)
app.get("/api/fyers/quotes", async (req, res) => {
  if (!fyersToken) return res.json({ success: false, error: "Not connected." });
  const symbols = req.query.symbols || "NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX";
  try {
    const r = await get({
      hostname: "api-t1.fyers.in",
      path: `/data/v3/quotes?symbols=${encodeURIComponent(symbols)}`,
      method: "GET",
      headers: {
        "Authorization": FYERS_APP_ID + ":" + fyersToken,
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip, deflate, br"
      }
    });
    const j = JSON.parse(r.text);
    res.json({ success: j.s === "ok", data: j, error: j.message });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// Step 7: Fyers historical candles
app.get("/api/fyers/history", async (req, res) => {
  if (!fyersToken) return res.json({ success: false, error: "Not connected." });
  const symbol = req.query.symbol || "NSE:NIFTY50-INDEX";
  const resolution = req.query.resolution || "5"; // 1,2,3,5,10,15,20,30,60,120,240,1D
  const dateFrom = req.query.date_from || Math.floor(Date.now()/1000 - 86400);
  const dateTo   = req.query.date_to   || Math.floor(Date.now()/1000);
  try {
    const r = await get({
      hostname: "api-t1.fyers.in",
      path: `/data/v3/history?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&date_from=${dateFrom}&date_to=${dateTo}&cont_flag=1`,
      method: "GET",
      headers: {
        "Authorization": FYERS_APP_ID + ":" + fyersToken,
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip, deflate, br"
      }
    });
    const j = JSON.parse(r.text);
    res.json({ success: j.s === "ok", data: j, error: j.message });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════
// EXISTING ROUTES
// ══════════════════════════════════════════════════════
app.get("/api/candles/nifty", async (req, res) => {
  try { res.json({ success: true, data: await fetchYahoo("%5ENSEI", req.query.interval||"5m", req.query.range||"1d") }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});

app.get("/api/candles/banknifty", async (req, res) => {
  try { res.json({ success: true, data: await fetchYahoo("%5ENSEBANK", req.query.interval||"5m", req.query.range||"1d") }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});

app.get("/api/nifty", async (req, res) => {
  try { res.json({ success: true, data: await fetchNSE("NIFTY") }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});

app.get("/api/banknifty", async (req, res) => {
  try { res.json({ success: true, data: await fetchNSE("BANKNIFTY") }); }
  catch(e) { res.json({ success: false, error: e.message }); }
});

app.get("/api/status", (req, res) => {
  res.json({ status: "ok", version: "5.0", fyers: !!fyersToken, time: new Date().toISOString() });
});

app.get("/api/debug/candles", async (req, res) => {
  try {
    const d = await fetchYahoo("%5ENSEI", "5m", "1d");
    const ch = d.chart.result[0];
    res.json({ success: true, symbol: ch.meta.symbol, lastPrice: ch.meta.regularMarketPrice, totalCandles: ch.timestamp.length });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NSE Proxy v5.0 on port ${PORT}`));
