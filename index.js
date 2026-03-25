const express = require("express");
const https = require("https");
const path = require("path");
const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

// Serve the trading app at root
app.use(express.static(path.join(__dirname, "public")));

function fetchNSE(symbol) {
  return new Promise((resolve, reject) => {
    const cookieOptions = {
      hostname: "www.nseindia.com", path: "/", method: "GET",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36", "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9", "Connection": "keep-alive" }
    };
    const cookieReq = https.request(cookieOptions, (cookieRes) => {
      const cookies = (cookieRes.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");
      const options = {
        hostname: "www.nseindia.com",
        path: `/api/option-chain-indices?symbol=${symbol}`, method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36", "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", "Referer": "https://www.nseindia.com/option-chain", "Connection": "keep-alive", "Cookie": cookies }
      };
      const dataReq = https.request(options, (dataRes) => {
        let data = "";
        dataRes.on("data", chunk => data += chunk);
        dataRes.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("Failed to parse NSE")); } });
      });
      dataReq.on("error", reject);
      dataReq.end();
    });
    cookieReq.on("error", reject);
    cookieReq.end();
  });
}

function fetchYahoo(symbol, interval, range) {
  return new Promise((resolve, reject) => {
    const p = `/v8/finance/chart/${symbol}?interval=${interval}&range=${range}&includePrePost=false`;
    const options = {
      hostname: "query1.finance.yahoo.com", path: p, method: "GET",
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36", "Accept": "application/json", "Accept-Language": "en-US,en;q=0.9" }
    };
    const req = https.request(options, (r) => {
      let data = "";
      r.on("data", chunk => data += chunk);
      r.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("Failed to parse Yahoo")); } });
    });
    req.on("error", reject);
    req.end();
  });
}

app.get("/api/nifty", async (req, res) => {
  try { res.json({ success: true, data: await fetchNSE("NIFTY") }); }
  catch (e) { res.json({ success: false, error: e.message }); }
});

app.get("/api/banknifty", async (req, res) => {
  try { res.json({ success: true, data: await fetchNSE("BANKNIFTY") }); }
  catch (e) { res.json({ success: false, error: e.message }); }
});

app.get("/api/candles/nifty", async (req, res) => {
  try {
    const interval = req.query.interval || "5m";
    const range = req.query.range || "1d";
    res.json({ success: true, data: await fetchYahoo("^NSEI", interval, range) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get("/api/candles/banknifty", async (req, res) => {
  try {
    const interval = req.query.interval || "5m";
    const range = req.query.range || "1d";
    res.json({ success: true, data: await fetchYahoo("^NSEBANK", interval, range) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Debug endpoint — test what data looks like
app.get("/api/debug/candles", async (req, res) => {
  try {
    const data = await fetchYahoo("^NSEI", "5m", "1d");
    const chart = data.chart?.result?.[0];
    if (!chart) { res.json({ success: false, error: "No chart data", raw: data }); return; }
    const timestamps = chart.timestamp?.slice(-3) || [];
    const closes = chart.indicators?.quote?.[0]?.close?.slice(-3) || [];
    res.json({
      success: true,
      symbol: chart.meta?.symbol,
      currency: chart.meta?.currency,
      lastPrice: chart.meta?.regularMarketPrice,
      totalCandles: chart.timestamp?.length,
      last3Timestamps: timestamps.map(t => new Date(t * 1000).toLocaleString("en-IN")),
      last3Closes: closes,
      marketState: chart.meta?.marketState
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get("/api/status", (req, res) => {
  res.json({ status: "ok", version: "2.0", time: new Date().toISOString(), endpoints: ["/api/nifty", "/api/banknifty", "/api/candles/nifty", "/api/candles/banknifty", "/api/debug/candles"] });
});

// Fallback — serve app for all other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NSE Proxy v2 running on port ${PORT}`));
