const express = require("express");
const https = require("https");
const http = require("http");
const path = require("path");
const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// NSE fetch with full browser simulation
function fetchNSE(symbol) {
  return new Promise((resolve, reject) => {
    const step1 = {
      hostname: "www.nseindia.com",
      path: "/option-chain",
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-IN,en-GB;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Cache-Control": "max-age=0"
      }
    };

    const req1 = https.request(step1, (res1) => {
      let body1 = "";
      res1.on("data", d => body1 += d);
      res1.on("end", () => {
        const cookies = (res1.headers["set-cookie"] || [])
          .map(c => c.split(";")[0]).join("; ");

        setTimeout(() => {
          const step2 = {
            hostname: "www.nseindia.com",
            path: `/api/option-chain-indices?symbol=${symbol}`,
            method: "GET",
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
              "Accept": "application/json, text/plain, */*",
              "Accept-Language": "en-IN,en-GB;q=0.9,en;q=0.8",
              "Accept-Encoding": "gzip, deflate, br",
              "Referer": "https://www.nseindia.com/option-chain",
              "Connection": "keep-alive",
              "Sec-Fetch-Dest": "empty",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Site": "same-origin",
              "X-Requested-With": "XMLHttpRequest",
              "Cookie": cookies
            }
          };

          const req2 = https.request(step2, (res2) => {
            const chunks = [];
            res2.on("data", d => chunks.push(d));
            res2.on("end", () => {
              try {
                const raw = Buffer.concat(chunks).toString();
                const json = JSON.parse(raw);
                if (json && json.records) resolve(json);
                else reject(new Error("Invalid NSE response: " + raw.substring(0, 200)));
              } catch (e) {
                reject(new Error("Parse error: " + e.message));
              }
            });
          });
          req2.on("error", reject);
          req2.end();
        }, 500);
      });
    });
    req1.on("error", reject);
    req1.end();
  });
}

// Yahoo Finance OHLC
function fetchYahoo(symbol, interval, range) {
  return new Promise((resolve, reject) => {
    const p = `/v8/finance/chart/${symbol}?interval=${interval}&range=${range}&includePrePost=false`;
    const req = https.request({
      hostname: "query1.finance.yahoo.com", path: p, method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json"
      }
    }, (r) => {
      const chunks = [];
      r.on("data", d => chunks.push(d));
      r.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
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
    res.json({ success: true, data: await fetchYahoo("^NSEI", req.query.interval||"5m", req.query.range||"1d") });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get("/api/candles/banknifty", async (req, res) => {
  try {
    res.json({ success: true, data: await fetchYahoo("^NSEBANK", req.query.interval||"5m", req.query.range||"1d") });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get("/api/status", (req, res) => {
  res.json({ status: "ok", version: "3.0", time: new Date().toISOString() });
});

app.get("/api/debug/nse", async (req, res) => {
  try {
    const data = await fetchNSE("NIFTY");
    res.json({ success: true, underlyingValue: data.records?.underlyingValue, expiryCount: data.records?.expiryDates?.length, dataPoints: data.records?.data?.length });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NSE Proxy v3 on port ${PORT}`));
```

**Commit changes** → wait 2 mins for Render to redeploy.

---

## 🟢 Fix 2 — Test if NSE Works

After deploy, visit this URL directly:
```
https://nse-proxy-1o55.onrender.com/api/debug/nse
