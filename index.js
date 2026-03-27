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

/* ── universal fetch with gzip / deflate / br decompression ── */
function fetch(options, timeoutMs) {
  timeoutMs = timeoutMs || 25000;
  return new Promise(function(resolve, reject) {
    var req = https.request(options, function(res) {
      var chunks = [];
      res.on("data", function(d) { chunks.push(d); });
      res.on("end", function() {
        var buf = Buffer.concat(chunks);
        var enc = (res.headers["content-encoding"] || "").toLowerCase();

        function done(text) {
          resolve({ status: res.statusCode, headers: res.headers, text: text });
        }

        if (enc.indexOf("br") !== -1) {
          zlib.brotliDecompress(buf, function(e, d) { e ? reject(e) : done(d.toString()); });
        } else if (enc.indexOf("gzip") !== -1) {
          zlib.gunzip(buf, function(e, d) { e ? reject(e) : done(d.toString()); });
        } else if (enc.indexOf("deflate") !== -1) {
          zlib.inflate(buf, function(e, d) {
            if (e) {
              zlib.inflateRaw(buf, function(e2, d2) { e2 ? reject(e2) : done(d2.toString()); });
            } else {
              done(d.toString());
            }
          });
        } else {
          done(buf.toString());
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, function() { req.destroy(); reject(new Error("Timeout after " + timeoutMs + "ms")); });
    req.end();
  });
}

/* ── NSE option chain ── */
function fetchNSE(symbol) {
  return new Promise(function(resolve, reject) {
    var step1 = {
      hostname: "www.nseindia.com",
      path: "/option-chain",
      method: "GET",
      headers: {
        "User-Agent"     : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept"         : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-IN,en-GB;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection"     : "keep-alive",
        "Cache-Control"  : "max-age=0"
      }
    };

    fetch(step1).then(function(r1) {
      var cookies = (r1.headers["set-cookie"] || []).map(function(c) { return c.split(";")[0]; }).join("; ");

      setTimeout(function() {
        var step2 = {
          hostname: "www.nseindia.com",
          path    : "/api/option-chain-indices?symbol=" + symbol,
          method  : "GET",
          headers : {
            "User-Agent"      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept"          : "application/json, text/plain, */*",
            "Accept-Language" : "en-IN,en-GB;q=0.9,en;q=0.8",
            "Accept-Encoding" : "gzip, deflate, br",
            "Referer"         : "https://www.nseindia.com/option-chain",
            "X-Requested-With": "XMLHttpRequest",
            "Connection"      : "keep-alive",
            "Cookie"          : cookies
          }
        };

        fetch(step2).then(function(r2) {
          try {
            var json = JSON.parse(r2.text);
            if (json && json.records && json.records.underlyingValue) {
              resolve(json);
            } else {
              reject(new Error("NSE returned invalid data. Text preview: " + r2.text.substring(0, 200)));
            }
          } catch(e) {
            reject(new Error("JSON parse failed: " + e.message + " | preview: " + r2.text.substring(0, 200)));
          }
        }).catch(reject);

      }, 1000);
    }).catch(reject);
  });
}

/* ── Yahoo Finance OHLC candles ── */
function fetchYahoo(symbol, interval, range) {
  var opts = {
    hostname: "query1.finance.yahoo.com",
    path    : "/v8/finance/chart/" + symbol + "?interval=" + interval + "&range=" + range + "&includePrePost=false",
    method  : "GET",
    headers : {
      "User-Agent"     : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept"         : "application/json",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "en-US,en;q=0.9"
    }
  };
  return fetch(opts).then(function(r) {
    try {
      return JSON.parse(r.text);
    } catch(e) {
      throw new Error("Yahoo JSON parse failed: " + e.message);
    }
  });
}

/* ── Routes ── */
app.get("/api/nifty", function(req, res) {
  fetchNSE("NIFTY")
    .then(function(d) { res.json({ success: true, data: d }); })
    .catch(function(e) { res.json({ success: false, error: e.message }); });
});

app.get("/api/banknifty", function(req, res) {
  fetchNSE("BANKNIFTY")
    .then(function(d) { res.json({ success: true, data: d }); })
    .catch(function(e) { res.json({ success: false, error: e.message }); });
});

app.get("/api/candles/nifty", function(req, res) {
  var iv = req.query.interval || "5m";
  var rng = req.query.range || "1d";
  fetchYahoo("^NSEI", iv, rng)
    .then(function(d) { res.json({ success: true, data: d }); })
    .catch(function(e) { res.json({ success: false, error: e.message }); });
});

app.get("/api/candles/banknifty", function(req, res) {
  var iv = req.query.interval || "5m";
  var rng = req.query.range || "1d";
  fetchYahoo("^NSEBANK", iv, rng)
    .then(function(d) { res.json({ success: true, data: d }); })
    .catch(function(e) { res.json({ success: false, error: e.message }); });
});

app.get("/api/status", function(req, res) {
  res.json({ status: "ok", version: "3.1", time: new Date().toISOString() });
});

app.get("/api/debug/nse", function(req, res) {
  fetchNSE("NIFTY")
    .then(function(d) {
      res.json({
        success        : true,
        underlyingValue: d.records.underlyingValue,
        expiryCount    : (d.records.expiryDates || []).length,
        dataPoints     : (d.records.data || []).length
      });
    })
    .catch(function(e) { res.json({ success: false, error: e.message }); });
});

app.get("/api/debug/candles", function(req, res) {
  fetchYahoo("^NSEI", "5m", "1d")
    .then(function(d) {
      var ch  = d.chart && d.chart.result && d.chart.result[0];
      var ts  = (ch && ch.timestamp) || [];
      var cl  = (ch && ch.indicators && ch.indicators.quote && ch.indicators.quote[0] && ch.indicators.quote[0].close) || [];
      res.json({
        success      : true,
        symbol       : ch && ch.meta && ch.meta.symbol,
        lastPrice    : ch && ch.meta && ch.meta.regularMarketPrice,
        totalCandles : ts.length,
        lastClose    : cl[cl.length - 1]
      });
    })
    .catch(function(e) { res.json({ success: false, error: e.message }); });
});

/* ── Serve frontend ── */
app.get("*", function(req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("NSE Proxy v3.1 running on port " + PORT);
});
