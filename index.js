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

// ─────────────────────────────────────────────────────
// IMPORTANT: Replace these with your Fyers API credentials
// Get them from: https://myapi.fyers.in/dashboard
// ─────────────────────────────────────────────────────
const FYERS_APP_ID  = "WFKOLJNNHC-100";   // ← YOUR APP ID (client_id)
const FYERS_SECRET  = "W8ZQVQ8PM4";       // ← YOUR APP SECRET
const REDIRECT_URI  = "https://nse-proxy-1o55.onrender.com/api/fyers/callback";
// ─────────────────────────────────────────────────────
// WHERE THEY ARE USED:
//  FYERS_APP_ID  → auth URL (client_id param), SHA-256 hash, status response, Authorization header
//  FYERS_SECRET  → SHA-256 hash of (APP_ID + ":" + SECRET) sent as appIdHash during token exchange
// ─────────────────────────────────────────────────────

// In-memory token store (resets on server restart — user must re-login daily, per SEBI rules)
let fyersToken     = null;
let fyersTokenTime = null;

// ─── Generic HTTPS GET with decompression
function get(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const enc = (res.headers["content-encoding"] || "").toLowerCase();
        const decomp = (cb) => {
          if (enc.includes("br"))         zlib.brotliDecompress(buf, cb);
          else if (enc.includes("gzip"))  zlib.gunzip(buf, cb);
          else if (enc.includes("deflate")) zlib.inflate(buf, (e, d) => e ? zlib.inflateRaw(buf, cb) : cb(null, d));
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

// ─── Generic HTTPS POST
function post(opts, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    opts.method = "POST";
    opts.headers = opts.headers || {};
    opts.headers["Content-Type"]  = "application/json";
    opts.headers["Content-Length"] = Buffer.byteLength(data);
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(data);
    req.end();
  });
}

// ─── Yahoo Finance (server-side proxy for candles)
async function fetchYahoo(symbol, interval, range) {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  const p = `/v8/finance/chart/${symbol}?interval=${interval}&range=${range}&includePrePost=false`;
  const headers = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Accept":          "application/json",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin":          "https://finance.yahoo.com",
    "Referer":         "https://finance.yahoo.com/"
  };
  for (const host of hosts) {
    try {
      const r = await get({ hostname: host, path: p, method: "GET", headers });
      if (r.status === 429) { console.warn("Yahoo 429 on", host); continue; }
      const j = JSON.parse(r.text);
      if (j.chart?.result?.[0]?.timestamp) return j;
    } catch(e) { console.warn("Yahoo", host, e.message); }
  }
  throw new Error("Yahoo Finance unavailable");
}

// ─── NSE Option Chain
async function fetchNSE(symbol) {
  const r1 = await get({
    hostname: "www.nseindia.com", path: "/option-chain", method: "GET",
    headers: {
      "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
      "Accept":          "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "en-IN,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection":      "keep-alive",
      "Cache-Control":   "max-age=0"
    }
  });
  const cookies = (r1.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");
  await new Promise(r => setTimeout(r, 1000));
  const r2 = await get({
    hostname: "www.nseindia.com", path: `/api/option-chain-indices?symbol=${symbol}`, method: "GET",
    headers: {
      "User-Agent":        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
      "Accept":            "application/json, text/plain, */*",
      "Accept-Language":   "en-IN,en;q=0.9",
      "Accept-Encoding":   "gzip, deflate, br",
      "Referer":           "https://www.nseindia.com/option-chain",
      "X-Requested-With":  "XMLHttpRequest",
      "Connection":        "keep-alive",
      "Cookie":            cookies
    }
  });
  const j = JSON.parse(r2.text);
  if (j?.records?.underlyingValue) return j;
  throw new Error("NSE blocked — market may be closed. " + r2.text.substring(0, 150));
}

// ═════════════════════════════════════════════════════
// FYERS API v3 INTEGRATION
// Docs: https://myapi.fyers.in/docsv3
// ═════════════════════════════════════════════════════

// ── Fyers Authorization header for data endpoints
// Format: "app_id:access_token" as per Fyers v3 docs
function fyersAuth() {
  return FYERS_APP_ID + ":" + fyersToken;
}

// ── Standard Fyers data headers
function fyersHeaders() {
  return {
    "Authorization":   fyersAuth(),
    "Content-Type":    "application/json",
    "Accept":          "application/json",
    "Accept-Encoding": "gzip, deflate, br"
  };
}

// Step 1: Generate Fyers OAuth login URL
app.get("/api/fyers/auth-url", (req, res) => {
  // appIdHash = SHA-256 of "APP_ID:SECRET" — used as nonce for security
  const appIdHash = crypto.createHash("sha256")
    .update(FYERS_APP_ID + ":" + FYERS_SECRET)
    .digest("hex");

  const url = `https://api-t1.fyers.in/api/v3/generate-authcode` +
    `?client_id=${encodeURIComponent(FYERS_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&state=nse_algo_trader`;

  res.json({ success: true, url });
});

// Step 2: Fyers OAuth callback — exchange auth_code for access_token
app.get("/api/fyers/callback", async (req, res) => {
  const { auth_code, s, code } = req.query;
  console.log("Fyers callback:", req.query);

  if (s !== "ok" || !auth_code) {
    return res.send(`<html><body style="background:#0a0c0f;color:#ef4444;font-family:monospace;padding:30px;text-align:center;">
      <h2>❌ Fyers Login Failed</h2>
      <p>Error: ${req.query.message || "Login was not completed"}</p>
      <p style="font-size:12px;color:#64748b;">You may close this window and try again.</p>
      <button onclick="window.close()" style="margin-top:16px;padding:8px 20px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;">Close Window</button>
    </body></html>`);
  }

  try {
    // SHA-256 of "APP_ID:SECRET" for token exchange
    const appIdHash = crypto.createHash("sha256")
      .update(FYERS_APP_ID + ":" + FYERS_SECRET)
      .digest("hex");

    const r = await post({
      hostname: "api-t1.fyers.in",
      path: "/api/v3/validate-authcode",
      headers: { "Content-Type": "application/json" }
    }, {
      grant_type: "authorization_code",
      appIdHash:  appIdHash,
      code:       auth_code         // auth_code from query → 'code' in body
    });

    const j = JSON.parse(r.text);
    console.log("Fyers token response:", j.s, j.message || "");

    if (j.access_token) {
      fyersToken     = j.access_token;
      fyersTokenTime = new Date().toLocaleString("en-IN");
      console.log("✓ Fyers token stored at", fyersTokenTime);

      return res.send(`<html>
        <head>
          <meta charset="UTF-8">
          <style>body{background:#07090c;color:#00d4aa;font-family:monospace;padding:40px;text-align:center;}</style>
        </head>
        <body>
          <div style="font-size:48px;margin-bottom:16px;">✅</div>
          <h2>Fyers Connected Successfully!</h2>
          <p style="color:#64748b;">Token obtained. This window will close automatically...</p>
          <button onclick="window.close()" style="margin-top:16px;padding:10px 24px;background:#00d4aa;color:#000;border:none;border-radius:6px;cursor:pointer;font-weight:700;">Close &amp; Return to App</button>
          <script>
            // Notify parent window that auth is complete
            if (window.opener && !window.opener.closed) {
              try { window.opener.postMessage('fyers_auth_success', '*'); } catch(e) {}
            }
            setTimeout(() => window.close(), 2000);
          </script>
        </body>
      </html>`);
    } else {
      throw new Error(j.message || "Token exchange failed: " + JSON.stringify(j));
    }
  } catch(e) {
    console.error("Fyers token error:", e.message);
    res.send(`<html><body style="background:#0a0c0f;color:#ef4444;font-family:monospace;padding:30px;text-align:center;">
      <h2>❌ Token Exchange Failed</h2>
      <p style="color:#94a3b8;">${e.message}</p>
      <p style="font-size:12px;color:#64748b;">Please close this window and try connecting again.</p>
      <button onclick="window.close()" style="margin-top:16px;padding:8px 20px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;">Close Window</button>
    </body></html>`);
  }
});

// Step 3: Check Fyers connection status
app.get("/api/fyers/status", (req, res) => {
  res.json({
    connected:  !!fyersToken,
    tokenTime:  fyersTokenTime,
    appId:      FYERS_APP_ID
  });
});

// Step 4: Logout — clear token (user must re-login daily per SEBI rules)
app.post("/api/fyers/logout", (req, res) => {
  fyersToken     = null;
  fyersTokenTime = null;
  console.log("Fyers token cleared");
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────
// FYERS DATA ENDPOINTS
// Base URL for data: https://api-t1.fyers.in/data/
// Authorization: "APP_ID:ACCESS_TOKEN"
// ─────────────────────────────────────────────────────

// Fyers Quotes — GET /data/quotes?symbols=NSE:NIFTY50-INDEX,...
// Returns LTP and other quote data for up to 50 symbols
app.get("/api/fyers/quotes", async (req, res) => {
  if (!fyersToken) return res.json({ success: false, error: "Not connected. Please login with Fyers first." });
  const symbols = req.query.symbols || "NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX";
  try {
    const r = await get({
      hostname: "api-t1.fyers.in",
      path:     `/data/quotes?symbols=${encodeURIComponent(symbols)}`,
      method:   "GET",
      headers:  fyersHeaders()
    });
    const j = JSON.parse(r.text);
    if (j.s === "error") {
      // Token might be expired
      if (j.code === -16 || j.code === -17 || j.code === -8 || j.code === -15) {
        fyersToken = null; fyersTokenTime = null;
        return res.json({ success: false, error: "Token expired. Please reconnect Fyers.", tokenExpired: true });
      }
    }
    res.json({ success: j.s === "ok", data: j, error: j.message });
  } catch(e) {
    console.error("Fyers quotes error:", e.message);
    res.json({ success: false, error: e.message });
  }
});

// Fyers Historical Candles — GET /data/history
// resolution: 1,2,3,5,10,15,20,30,60,120,240,1D,1W,1M
// date_format=1 means unix timestamps for range_from/range_to
app.get("/api/fyers/history", async (req, res) => {
  if (!fyersToken) return res.json({ success: false, error: "Not connected." });
  const symbol     = req.query.symbol     || "NSE:NIFTY50-INDEX";
  const resolution = req.query.resolution || "5";   // 1,2,3,5,10,15,20,30,60,120,240,1D
  const dateFrom   = req.query.date_from  || Math.floor(Date.now() / 1000 - 86400);
  const dateTo     = req.query.date_to    || Math.floor(Date.now() / 1000);
  try {
    const r = await get({
      hostname: "api-t1.fyers.in",
      path:     `/data/history?symbol=${encodeURIComponent(symbol)}&resolution=${encodeURIComponent(resolution)}&date_format=1&range_from=${dateFrom}&range_to=${dateTo}&cont_flag=1`,
      method:   "GET",
      headers:  fyersHeaders()
    });
    const j = JSON.parse(r.text);
    if (j.s === "error") {
      if (j.code === -16 || j.code === -17 || j.code === -8 || j.code === -15) {
        fyersToken = null; fyersTokenTime = null;
        return res.json({ success: false, error: "Token expired. Please reconnect Fyers.", tokenExpired: true });
      }
    }
    // Response: { s: "ok", candles: [[timestamp, open, high, low, close, volume], ...] }
    res.json({ success: j.s === "ok", data: j, error: j.message });
  } catch(e) {
    console.error("Fyers history error:", e.message);
    res.json({ success: false, error: e.message });
  }
});

// Fyers Option Chain — GET /data/options-chain-v3
// strikecount: number of strikes (max 50, means ±N from ATM so total 2N+1)
// timestamp: optional expiry timestamp from expiryData (pass as unix seconds string)
app.get("/api/fyers/option-chain", async (req, res) => {
  if (!fyersToken) return res.json({ success: false, error: "Not connected. Please login with Fyers first." });
  const symbol      = req.query.symbol    || "NSE:NIFTY50-INDEX";
  const strikeCount = req.query.strikes   || "20";
  const timestamp   = req.query.timestamp || "";   // optional: filter by expiry

  let path = `/data/options-chain-v3?symbol=${encodeURIComponent(symbol)}&strikecount=${strikeCount}`;
  if (timestamp) path += `&timestamp=${encodeURIComponent(timestamp)}`;

  try {
    const r = await get({
      hostname: "api-t1.fyers.in",
      path,
      method:   "GET",
      headers:  fyersHeaders()
    });
    const j = JSON.parse(r.text);
    if (j.s === "error" || (j.code && j.code !== 200)) {
      if (j.code === -16 || j.code === -17 || j.code === -8 || j.code === -15) {
        fyersToken = null; fyersTokenTime = null;
        return res.json({ success: false, error: "Token expired. Please reconnect Fyers.", tokenExpired: true });
      }
      return res.json({ success: false, error: j.message || "Fyers option chain error", data: j });
    }
    // Response: { code:200, s:"ok", data:{ optionsChain:[...], expiryData:[...], callOi, putOi, indiavixData } }
    res.json({ success: j.s === "ok" || j.code === 200, data: j, error: j.message });
  } catch(e) {
    console.error("Fyers option chain error:", e.message);
    res.json({ success: false, error: e.message });
  }
});

// ═════════════════════════════════════════════════════
// YAHOO + NSE ROUTES (combined data source)
// ═════════════════════════════════════════════════════

// Yahoo candle data — used as primary chart data source
app.get("/api/candles/nifty", async (req, res) => {
  try {
    res.json({ success: true, data: await fetchYahoo("%5ENSEI", req.query.interval || "5m", req.query.range || "1d") });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.get("/api/candles/banknifty", async (req, res) => {
  try {
    res.json({ success: true, data: await fetchYahoo("%5ENSEBANK", req.query.interval || "5m", req.query.range || "1d") });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// NSE Option Chain — Mon–Fri 9:15 AM to 3:30 PM IST only
app.get("/api/nifty", async (req, res) => {
  try {
    res.json({ success: true, data: await fetchNSE("NIFTY") });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.get("/api/banknifty", async (req, res) => {
  try {
    res.json({ success: true, data: await fetchNSE("BANKNIFTY") });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// Status endpoint
app.get("/api/status", (req, res) => {
  res.json({
    status:    "ok",
    version:   "6.0",
    fyers:     !!fyersToken,
    fyersTime: fyersTokenTime,
    time:      new Date().toISOString()
  });
});

// Debug endpoint
app.get("/api/debug/candles", async (req, res) => {
  try {
    const d  = await fetchYahoo("%5ENSEI", "5m", "1d");
    const ch = d.chart.result[0];
    res.json({ success: true, symbol: ch.meta.symbol, lastPrice: ch.meta.regularMarketPrice, totalCandles: ch.timestamp.length });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// Catch-all → serve index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NSE Proxy v6.0 on port ${PORT} — Fyers v3 API ready`));
