const express = require("express");
const https   = require("https");
const http    = require("http");
const zlib    = require("zlib");
const path    = require("path");
const app     = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, "public")));

/* ─── generic HTTPS fetch with auto decompression ─── */
function get(opts, followRedirects) {
  followRedirects = followRedirects === undefined ? 3 : followRedirects;
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      // follow redirects
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location && followRedirects > 0) {
        const loc = res.headers.location;
        const isHttps = loc.startsWith("https");
        const parsed = new URL(loc.startsWith("http") ? loc : "https://" + opts.hostname + loc);
        const newOpts = {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: "GET",
          headers: opts.headers
        };
        res.resume();
        return get(newOpts, followRedirects - 1).then(resolve).catch(reject);
      }

      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const enc = (res.headers["content-encoding"] || "").toLowerCase();

        const decompress = (cb) => {
          if (enc.includes("br")) {
            zlib.brotliDecompress(buf, cb);
          } else if (enc.includes("gzip")) {
            zlib.gunzip(buf, cb);
          } else if (enc.includes("deflate")) {
            zlib.inflate(buf, (e, d) => {
              if (e) zlib.inflateRaw(buf, cb);
              else cb(null, d);
            });
          } else {
            cb(null, buf);
          }
        };

        decompress((err, decompressed) => {
          if (err) return reject(err);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: decompressed.toString("utf8")
          });
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Request timeout")); });
    req.end();
  });
}

/* ─── Yahoo Finance candles ─── */
async function fetchYahoo(symbol, interval, range) {
  // Try query1 first, then query2
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  const path2 = `/v8/finance/chart/${symbol}?interval=${interval}&range=${range}&includePrePost=false&events=div%2Csplit`;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://finance.yahoo.com",
    "Referer": "https://finance.yahoo.com/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site"
  };

  for (const host of hosts) {
    try {
      const r = await get({ hostname: host, path: path2, method: "GET", headers });
      if (r.status === 429) { continue; } // too many requests, try other host
      const j = JSON.parse(r.text);
      if (j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].timestamp) {
        return j;
      }
    } catch (e) {
      console.warn(`Yahoo ${host} error:`, e.message);
    }
  }
  throw new Error("Yahoo Finance unavailable from server. Status 429 (rate limited).");
}

/* ─── NSE Option Chain ─── */
async function fetchNSE(symbol) {
  // Step 1: get cookies
  const r1 = await get({
    hostname: "www.nseindia.com",
    path: "/option-chain",
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-IN,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
      "Cache-Control": "max-age=0",
      "Upgrade-Insecure-Requests": "1"
    }
  });

  const cookies = (r1.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");

  await new Promise(r => setTimeout(r, 1000)); // wait 1s before API call

  // Step 2: fetch option chain API
  const r2 = await get({
    hostname: "www.nseindia.com",
    path: `/api/option-chain-indices?symbol=${symbol}`,
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-IN,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Referer": "https://www.nseindia.com/option-chain",
      "X-Requested-With": "XMLHttpRequest",
      "Connection": "keep-alive",
      "Cookie": cookies
    }
  });

  const j = JSON.parse(r2.text);
  if (j && j.records && j.records.underlyingValue) return j;
  throw new Error(`NSE returned invalid data (HTTP ${r2.status}). Preview: ${r2.text.substring(0, 150)}`);
}

/* ─── ROUTES ─── */

// Yahoo candle data — proxied through server to avoid browser CORS
app.get("/api/candles/nifty", async (req, res) => {
  try {
    const data = await fetchYahoo("%5ENSEI", req.query.interval || "5m", req.query.range || "1d");
    res.json({ success: true, data });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get("/api/candles/banknifty", async (req, res) => {
  try {
    const data = await fetchYahoo("%5ENSEBANK", req.query.interval || "5m", req.query.range || "1d");
    res.json({ success: true, data });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// NSE option chain
app.get("/api/nifty", async (req, res) => {
  try {
    res.json({ success: true, data: await fetchNSE("NIFTY") });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get("/api/banknifty", async (req, res) => {
  try {
    res.json({ success: true, data: await fetchNSE("BANKNIFTY") });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Debug endpoints
app.get("/api/debug/candles", async (req, res) => {
  try {
    const data = await fetchYahoo("%5ENSEI", "5m", "1d");
    const ch = data.chart.result[0];
    res.json({
      success: true,
      symbol: ch.meta.symbol,
      lastPrice: ch.meta.regularMarketPrice,
      totalCandles: ch.timestamp.length,
      lastTimestamp: new Date(ch.timestamp[ch.timestamp.length - 1] * 1000).toLocaleString("en-IN")
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get("/api/debug/nse", async (req, res) => {
  try {
    const d = await fetchNSE("NIFTY");
    res.json({ success: true, underlyingValue: d.records.underlyingValue, expiryCount: d.records.expiryDates.length, dataPoints: d.records.data.length });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get("/api/status", (req, res) => {
  res.json({ status: "ok", version: "4.0", time: new Date().toISOString() });
});

// Serve frontend for all other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NSE Proxy v4.0 on port ${PORT}`));
