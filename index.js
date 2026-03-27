const express = require("express");
const https = require("https");
const path = require("path");
const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

app.use(express.static(path.join(__dirname, "public")));

function fetchNSE(symbol) {
  return new Promise((resolve, reject) => {
    const step1opts = {
      hostname: "www.nseindia.com",
      path: "/option-chain",
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
        "Accept-Encoding": "identity",
        "Connection": "keep-alive"
      }
    };

    const req1 = https.request(step1opts, (res1) => {
      let body = "";
      res1.on("data", d => body += d);
      res1.on("end", () => {
        const cookies = (res1.headers["set-cookie"] || [])
          .map(c => c.split(";")[0]).join("; ");

        setTimeout(() => {
          const step2opts = {
            hostname: "www.nseindia.com",
            path: "/api/option-chain-indices?symbol=" + symbol,
            method: "GET",
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
              "Accept": "application/json, text/plain, */*",
              "Accept-Language": "en-IN,en;q=0.9",
              "Accept-Encoding": "identity",
              "Referer": "https://www.nseindia.com/option-chain",
              "X-Requested-With": "XMLHttpRequest",
              "Connection": "keep-alive",
              "Cookie": cookies
            }
          };

          const req2 = https.request(step2opts, (res2) => {
            let data = "";
            res2.on("data", d => data += d);
            res2.on("end", () => {
              try {
                const json = JSON.parse(data);
                if (json && json.records) {
                  resolve(json);
                } else {
                  reject(new Error("Bad NSE response: " + data.substring(0, 300)));
                }
              } catch (e) {
                reject(new Error("JSON parse failed: " + e.message + " | raw: " + data.substring(0, 200)));
              }
            });
          });
          req2.on("error", reject);
          req2.end();
        }, 800);
      });
    });
    req1.on("error", reject);
    req1.end();
  });
}

function fetchYahoo(symbol, interval, range) {
  return new Promise((resolve, reject) => {
    const p = "/v8/finance/chart/" + symbol + "?interval=" + interval + "&range=" + range + "&includePrePost=false";
    const req = https.request({
      hostname: "query1.finance.yahoo.com",
      path: p,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Encoding": "identity"
      }
    }, (r) => {
      let data = "";
      r.on("data", d => data += d);
      r.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Yahoo parse error: " + e.message));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

app.get("/api/nifty", async (req, res) => {
  try {
    const data = await fetchNSE("NIFTY");
    res.json({ success: true, data: data });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get("/api/banknifty", async (req, res) => {
  try {
    const data = await fetchNSE("BANKNIFTY");
    res.json({ success: true, data: data });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get("/api/candles/nifty", async (req, res) => {
  try {
    const interval = req.query.interval || "5m";
    const range = req.query.range || "1d";
    const data = await fetchYahoo("^NSEI", interval, range);
    res.json({ success: true, data: data });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get("/api/candles/banknifty", async (req, res) => {
  try {
    const interval = req.query.interval || "5m";
    const range = req.query.range || "1d";
    const data = await fetchYahoo("^NSEBANK", interval, range);
    res.json({ success: true, data: data });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get("/api/status", (req, res) => {
  res.json({ status: "ok", version: "3.0", time: new Date().toISOString() });
});

app.get("/api/debug/nse", async (req, res) => {
  try {
    const data = await fetchNSE("NIFTY");
    res.json({
      success: true,
      underlyingValue: data.records && data.records.underlyingValue,
      expiryCount: data.records && data.records.expiryDates && data.records.expiryDates.length,
      dataPoints: data.records && data.records.data && data.records.data.length
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("NSE Proxy v3 running on port " + PORT);
});
