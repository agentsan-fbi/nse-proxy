const express = require("express");
const https   = require("https");
const zlib    = require("zlib");
const path    = require("path");
const app     = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

app.use(express.static(path.join(__dirname, "public")));

/* ── decompress + fetch helper ── */
function get(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (r) => {
      const chunks = [];
      r.on("data", d => chunks.push(d));
      r.on("end", () => {
        const buf = Buffer.concat(chunks);
        const enc = (r.headers["content-encoding"] || "").toLowerCase();
        const decompress = (buf, cb) => {
          if (enc.includes("br"))      zlib.brotliDecompress(buf, cb);
          else if (enc.includes("gzip")) zlib.gunzip(buf, cb);
          else if (enc.includes("deflate")) zlib.inflate(buf, (e,d) => e ? zlib.inflateRaw(buf,cb) : cb(null,d));
          else cb(null, buf);
        };
        decompress(buf, (e, d) => {
          if (e) return reject(e);
          resolve({ status: r.statusCode, headers: r.headers, text: d.toString() });
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

/* ── NSE option chain ── */
function fetchNSE(symbol) {
  return new Promise((resolve, reject) => {
    const h1 = {
      hostname: "www.nseindia.com", path: "/option-chain", method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9", "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive", "Cache-Control": "max-age=0"
      }
    };
    get(h1).then(r1 => {
      const cookies = (r1.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");
      setTimeout(() => {
        const h2 = {
          hostname: "www.nseindia.com",
          path: "/api/option-chain-indices?symbol=" + symbol, method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-IN,en;q=0.9", "Accept-Encoding": "gzip, deflate, br",
            "Referer": "https://www.nseindia.com/option-chain",
            "X-Requested-With": "XMLHttpRequest",
            "Connection": "keep-alive", "Cookie": cookies
          }
        };
        get(h2).then(r2 => {
          try {
            const j = JSON.parse(r2.text);
            if (j && j.records && j.records.underlyingValue) resolve(j);
            else reject(new Error("NSE blocked this server IP. Use /api/debug/nse to see raw response. Preview: " + r2.text.substring(0,200)));
          } catch(e) {
            reject(new Error("Parse error: " + e.message + " | HTTP " + r2.status + " | preview: " + r2.text.substring(0,200)));
          }
        }).catch(reject);
      }, 1000);
    }).catch(reject);
  });
}

/* ── Routes ── */
app.get("/api/nifty", (req, res) => {
  fetchNSE("NIFTY")
    .then(d => res.json({ success: true, data: d }))
    .catch(e => res.json({ success: false, error: e.message }));
});

app.get("/api/banknifty", (req, res) => {
  fetchNSE("BANKNIFTY")
    .then(d => res.json({ success: true, data: d }))
    .catch(e => res.json({ success: false, error: e.message }));
});

app.get("/api/status", (req, res) => {
  res.json({ status: "ok", version: "3.2", time: new Date().toISOString() });
});

app.get("/api/debug/nse", (req, res) => {
  fetchNSE("NIFTY")
    .then(d => res.json({
      success: true,
      underlyingValue: d.records.underlyingValue,
      expiryCount: (d.records.expiryDates || []).length,
      dataPoints: (d.records.data || []).length
    }))
    .catch(e => res.json({ success: false, error: e.message }));
});

// NOTE: Candle data is now fetched DIRECTLY from browser to avoid server IP blocks.
// No /api/candles routes needed.

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("NSE Proxy v3.2 on port " + PORT));
