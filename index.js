const express = require("express");
const https = require("https");
const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

function fetchNSE(symbol) {
  return new Promise((resolve, reject) => {
    const cookieOptions = {
      hostname: "www.nseindia.com",
      path: "/",
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "keep-alive"
      }
    };
    const cookieReq = https.request(cookieOptions, (cookieRes) => {
      const cookies = (cookieRes.headers["set-cookie"] || [])
        .map(c => c.split(";")[0]).join("; ");
      const options = {
        hostname: "www.nseindia.com",
        path: `/api/option-chain-indices?symbol=${symbol}`,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://www.nseindia.com/option-chain",
          "Connection": "keep-alive",
          "Cookie": cookies
        }
      };
      const dataReq = https.request(options, (dataRes) => {
        let data = "";
        dataRes.on("data", chunk => data += chunk);
        dataRes.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error("Failed to parse NSE response")); }
        });
      });
      dataReq.on("error", reject);
      dataReq.end();
    });
    cookieReq.on("error", reject);
    cookieReq.end();
  });
}

app.get("/nifty", async (req, res) => {
  try { res.json({ success: true, data: await fetchNSE("NIFTY") }); }
  catch (e) { res.json({ success: false, error: e.message }); }
});

app.get("/banknifty", async (req, res) => {
  try { res.json({ success: true, data: await fetchNSE("BANKNIFTY") }); }
  catch (e) { res.json({ success: false, error: e.message }); }
});

app.get("/", (req, res) => {
  res.send("NSE Proxy is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NSE Proxy running on port ${PORT}`));
