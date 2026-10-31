"use strict";

/* ===========================================================================
   app.js - いさバス八丁（スマホ用 バス接近表示）

   時刻表は gtfs.js がスマホ上で作って localStorage に保存し、
   古くなったら起動時に自動で取り直します（PC は不要）。
   リアルタイム情報（GTFS-RT TripUpdate）は表示中に毎分取得します。
   URL の末尾に #mock を付けて開くと、モックデータでレイアウトを確認できます。
   =========================================================================== */

/* ===========================================================================
   1. 設定
   =========================================================================== */
var CFG = {
  maxItems:        BUSBOARD_CONFIG.maxItems,
  refreshMs:       BUSBOARD_CONFIG.refreshMs,
  minRefreshMs:    5000,   // 手動更新の最短間隔（連打・ODPT負荷対策）
  tickMs:          5000,   // 残り分数の再計算間隔
  horizonMin:      BUSBOARD_CONFIG.horizonMin,
  graceSec:        60,     // 出発時刻を過ぎても何秒間は残すか
  staleSec:        180,    // これを超えたら「古い情報」扱い
  fetchTimeoutMs:  8000
};

/* ===========================================================================
   2. Protocol Buffers デコーダ（GTFS-RT 用の最小実装・外部ライブラリ不要）
   =========================================================================== */
function readVarint(u8, s) {
  var lo = 0, hi = 0, i = 0, b;
  for (;;) {
    b = u8[s.p++];
    if (b === undefined) throw new Error("varint: 途中でデータが終了");
    if (i < 4)        lo |= (b & 0x7f) << (7 * i);
    else if (i === 4) { lo |= (b & 0x0f) << 28; hi |= (b >> 4) & 0x07; }
    else              hi |= (b & 0x7f) << (7 * (i - 5) + 3);
    i++;
    if ((b & 0x80) === 0) break;
    if (i > 10) throw new Error("varint: 長すぎ");
  }
  return { lo: lo >>> 0, hi: hi >>> 0 };
}
function u64(v) { return v.hi * 4294967296 + v.lo; }   // 2^53 未満なら正確
function i32(v) { return v.lo | 0; }                    // 下位32bitを符号付きで解釈

var TD = (typeof TextDecoder !== "undefined") ? new TextDecoder("utf-8") : null;
function str(u8, b, e) {
  if (TD) return TD.decode(u8.subarray(b, e));
  var s = "";
  for (var i = b; i < e; i++) s += String.fromCharCode(u8[i]);
  try { return decodeURIComponent(escape(s)); } catch (_) { return s; }
}

// cb(fieldNumber, wireType, varintValue, chunkBegin, chunkEnd)
function eachField(u8, start, end, cb) {
  var s = { p: start };
  while (s.p < end) {
    var key  = readVarint(u8, s);
    var f    = key.lo >>> 3;
    var wire = key.lo & 7;
    if (wire === 0)      { cb(f, wire, readVarint(u8, s), 0, 0); }
    else if (wire === 2) { var len = readVarint(u8, s).lo, b = s.p; s.p += len; cb(f, wire, null, b, b + len); }
    else if (wire === 5) { s.p += 4; }
    else if (wire === 1) { s.p += 8; }
    else throw new Error("未知のワイヤ型 " + wire);
  }
}

// StopTimeEvent { 1:delay(int32) 2:time(int64) }
function decodeStopTimeEvent(u8, b, e) {
  var o = { time: null, delay: null };
  eachField(u8, b, e, function (f, w, v) {
    if (w !== 0) return;
    if (f === 1) o.delay = i32(v);
    else if (f === 2) o.time = u64(v);
  });
  return o;
}

// StopTimeUpdate { 1:stop_sequence 2:arrival 3:departure 4:stop_id 5:schedule_relationship }
function decodeStopTimeUpdate(u8, b, e) {
  var o = { seq: null, stopId: null, arr: null, dep: null, rel: 0 };
  eachField(u8, b, e, function (f, w, v, cb2, ce2) {
    if (f === 1 && w === 0) o.seq = v.lo;
    else if (f === 2 && w === 2) o.arr = decodeStopTimeEvent(u8, cb2, ce2);
    else if (f === 3 && w === 2) o.dep = decodeStopTimeEvent(u8, cb2, ce2);
    else if (f === 4 && w === 2) o.stopId = str(u8, cb2, ce2);
    else if (f === 5 && w === 0) o.rel = v.lo;
  });
  return o;
}

// TripUpdate { 1:trip 2:stop_time_update[] 4:timestamp 5:delay }
function decodeTripUpdate(u8, b, e) {
  var o = { tripId: null, tripRel: 0, delay: null, ts: null, stus: [] };
  eachField(u8, b, e, function (f, w, v, cb2, ce2) {
    if (f === 1 && w === 2) {
      // TripDescriptor { 1:trip_id 4:schedule_relationship }
      eachField(u8, cb2, ce2, function (tf, tw, tv, tb, te) {
        if (tf === 1 && tw === 2) o.tripId = str(u8, tb, te);
        else if (tf === 4 && tw === 0) o.tripRel = tv.lo;
      });
    }
    else if (f === 2 && w === 2) o.stus.push(decodeStopTimeUpdate(u8, cb2, ce2));
    else if (f === 4 && w === 0) o.ts = u64(v);
    else if (f === 5 && w === 0) o.delay = i32(v);
  });
  return o;
}

// FeedMessage { 1:header 2:entity[] } / FeedHeader{3:timestamp} / FeedEntity{3:trip_update}
function decodeFeed(buf) {
  var u8 = new Uint8Array(buf);
  var headerTs = 0;
  var trips = {};
  eachField(u8, 0, u8.length, function (f, w, v, b, e) {
    if (f === 1 && w === 2) {
      eachField(u8, b, e, function (hf, hw, hv) { if (hf === 3 && hw === 0) headerTs = u64(hv); });
    } else if (f === 2 && w === 2) {
      eachField(u8, b, e, function (ef, ew, ev, eb, ee) {
        if (ef === 3 && ew === 2) {
          var tu = decodeTripUpdate(u8, eb, ee);
          if (tu.tripId) trips[tu.tripId] = tu;
        }
      });
    }
  });
  return { headerTs: headerTs, trips: trips };
}

/* ===========================================================================
   3. 静的時刻表 → 本日の運行便
   =========================================================================== */
function ymd(d) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
function midnight(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

// 「本日」と「前日」の運行日を対象にする（24時以降の便を拾うため）
function scheduledDepartures(data, now) {
  var out = [];
  if (!data || !data.trips) return out;

  for (var back = 1; back >= 0; back--) {
    var d = new Date(now.getTime() - back * 86400000);
    var key = String(ymd(d));
    var active = (data.dates && data.dates[key]) || null;
    if (!active || !active.length) continue;

    var base = midnight(d);
    var activeSet = {};
    for (var i = 0; i < active.length; i++) activeSet[active[i]] = 1;

    for (var t = 0; t < data.trips.length; t++) {
      var tr = data.trips[t];
      // [0]tripId [1]opIdx [2]stopIdx [3]stopSeq [4]routeIdx [5]signIdx [6]depSec [7]svcIdx
      if (!activeSet[tr[7]]) continue;
      out.push({
        tripId:  tr[0],
        op:      data.ops[tr[1]],
        stop:    data.stops[tr[2]],
        seq:     tr[3],
        route:   data.routes[tr[4]],
        sign:    data.signs[tr[5]],
        schedMs: base + tr[6] * 1000
      });
    }
  }
  return out;
}

/* ===========================================================================
   4. 予測時刻の決定（リアルタイム情報の適用）
   =========================================================================== */
var STU_SKIPPED = 1;      // StopTimeUpdate.ScheduleRelationship.SKIPPED
var TRIP_CANCELED = 3;    // TripDescriptor.ScheduleRelationship.CANCELED
var TRIP_DELETED  = 7;

function applyRealtime(sched, rt) {
  var rows = [];
  for (var i = 0; i < sched.length; i++) {
    var s = sched[i];
    var feed = rt[s.op.key];
    var tu = (feed && feed.trips) ? feed.trips[s.tripId] : null;

    var ms = s.schedMs, live = false;

    if (tu) {
      if (tu.tripRel === TRIP_CANCELED || tu.tripRel === TRIP_DELETED) continue;

      // 該当停留所の StopTimeUpdate を探す（stop_id 優先、無ければ stop_sequence）
      var stu = null;
      for (var j = 0; j < tu.stus.length; j++) {
        var u = tu.stus[j];
        if (u.stopId != null && u.stopId === s.stop.stopId) { stu = u; break; }
        if (stu == null && u.seq != null && u.seq === s.seq) stu = u;
      }

      if (stu) {
        if (stu.rel === STU_SKIPPED) continue;
        var ev = stu.dep || stu.arr;
        if (ev && ev.time)            { ms = ev.time * 1000; live = true; }
        else if (ev && ev.delay != null) { ms = s.schedMs + ev.delay * 1000; live = true; }
        else if (tu.delay != null)    { ms = s.schedMs + tu.delay * 1000; live = true; }
      } else if (tu.delay != null) {
        ms = s.schedMs + tu.delay * 1000; live = true;
      }
    }

    rows.push({
      tripId: s.tripId, op: s.op, stop: s.stop,
      route: s.route, sign: s.sign,
      schedMs: s.schedMs, ms: ms, live: live
    });
  }
  return rows;
}

function pickTop(rows, nowMs) {
  var lo = nowMs - CFG.graceSec * 1000;
  var hi = nowMs + CFG.horizonMin * 60000;
  var seen = {};
  var out = [];
  rows.sort(function (a, b) { return a.ms - b.ms; });
  for (var i = 0; i < rows.length && out.length < CFG.maxItems; i++) {
    var r = rows[i];
    if (r.ms < lo || r.ms > hi) continue;
    var k = r.op.key + "|" + r.tripId + "|" + r.stop.stopId;
    if (seen[k]) continue;
    seen[k] = 1;
    out.push(r);
  }
  return out;
}

/* ===========================================================================
   5. 取得
   =========================================================================== */
function fetchArrayBuffer(url) {
  if (typeof fetch === "function" && typeof AbortController === "function") {
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, CFG.fetchTimeoutMs);
    return fetch(url, { signal: ac.signal, cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.arrayBuffer();
      })
      .then(function (b) { clearTimeout(timer); return b; },
            function (e) { clearTimeout(timer); throw e; });
  }
  // 古い WebView 向けフォールバック
  return new Promise(function (resolve, reject) {
    var x = new XMLHttpRequest();
    x.open("GET", url, true);
    x.responseType = "arraybuffer";
    x.timeout = CFG.fetchTimeoutMs;
    x.onload = function () { (x.status >= 200 && x.status < 300) ? resolve(x.response) : reject(new Error("HTTP " + x.status)); };
    x.onerror = function () { reject(new Error("network")); };
    x.ontimeout = function () { reject(new Error("timeout")); };
    x.send();
  });
}


/* ===========================================================================
   6. 端末内の保存
   =========================================================================== */
var APP_VERSION = "1";   // 更新が反映されたかを設定画面で確かめるための番号（index.html の ?v= と揃える）
var KEY_TOKEN = "busboard.token";
// トークンは同じサイト（jlsawo.github.io）のいさバスと共有し、時刻表はアプリごとに分ける
var KEY_DATA  = BUSBOARD_CONFIG.storageKey || "busboard.timetable";

// プライベートモードなどで localStorage が使えなくても、表示は続ける
function load(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
}
function loadTimetable() {
  try { return JSON.parse(load(KEY_DATA) || "null"); } catch (_) { return null; }
}

function feedsFor(token) {
  var out = [];
  for (var k in BUSBOARD_CONFIG.operators) {
    var u = BUSBOARD_CONFIG.operators[k].tripUpdateUrl;
    if (u) out.push({ key: k, url: GTFS.addToken(u, token) });
  }
  return out;
}

/* ===========================================================================
   7. 状態と描画
   =========================================================================== */
var STATE = {
  data:          null,   // 静的時刻表
  token:         null,
  rt:            {},     // { seibu: {headerTs, trips}, kanto: {...} }
  feedTs:        0,      // 表示用のデータ生成時刻（feed header timestamp の最大）
  lastOkMs:      0,      // 最後に取得に成功した時刻
  lastTryMs:     0,
  inFlight:      false,
  building:      false,
  lastError:     null,
  mock:          false
};

var $list  = document.getElementById("list");
var $clock = document.getElementById("clock");
var $spin  = document.getElementById("spin");
var $meta1 = document.getElementById("meta1");
var $btn   = document.getElementById("refresh");
var $panel = document.getElementById("panel");
var $token = document.getElementById("token");
var $log   = document.getElementById("log");
var $ttInfo = document.getElementById("tt-info");

function two(n) { return (n < 10 ? "0" : "") + n; }
function hhmm(d)  { return two(d.getHours()) + ":" + two(d.getMinutes()); }
function hhmmss(d){ return hhmm(d) + ":" + two(d.getSeconds()); }
function fmtKey(k) { return k ? k.slice(0, 4) + "-" + k.slice(4, 6) + "-" + k.slice(6, 8) : "?"; }

function render() {
  var now = new Date();
  var nowMs = now.getTime();
  $clock.textContent = hhmm(now);

  var stale = STATE.lastOkMs > 0 && (nowMs - STATE.lastOkMs) > CFG.staleSec * 1000;
  document.body.classList.toggle("stale", stale);

  var rows = [];
  if (STATE.data) {
    rows = pickTop(applyRealtime(scheduledDepartures(STATE.data, now), STATE.rt), nowMs);
  }

  var emptyMsg = STATE.data ? "この先" + CFG.horizonMin + "分に便がありません"
               : STATE.building ? "時刻表を準備しています…"
               : !STATE.token ? "⚙ からアクセストークンを設定してください"
               : "時刻表データがありません";

  var html = "";
  for (var i = 0; i < CFG.maxItems; i++) {
    var r = rows[i];
    if (!r) {
      html += '<li class="row empty">' + esc(emptyMsg) + "</li>";
      continue;
    }
    var mins = Math.floor((r.ms - nowMs) / 60000);
    if (mins < 0) mins = 0;
    var soon = mins < 1;
    var minsHtml = soon
      ? '<span class="soon">まもなく</span>'
      : '<span class="num">' + mins + '</span><span class="unit">分</span>';

    html +=
      '<li class="row stop-' + r.stop.key + (soon ? " is-soon" : "") + '">' +
        '<div class="mins"' + (soon ? "" : stopColorAttr(r.stop.key)) + ">" + minsHtml + "</div>" +
        '<div class="info">' +
          '<div class="line1">' +
            '<span class="route">' + esc(r.route) + "</span>" +
            '<span class="sign">' + esc(r.sign) + "</span>" +
          "</div>" +
          '<div class="line2">' +
            '<span class="stop">' + esc(r.stop.name) + " " + esc(r.stop.direction) + "</span>" +
            '<span class="op op-' + r.op.key + '">' + esc(r.op.label) + "</span>" +
            (r.live ? "" : '<span class="tag">予定</span>') +
          "</div>" +
        "</div>" +
      "</li>";
  }
  $list.innerHTML = html;

  // メタ情報（ODPT 開発者ガイドライン 2.1.1 / 2.2.1）
  var parts = [];
  if (STATE.feedTs) parts.push("データ生成 " + hhmmss(new Date(STATE.feedTs * 1000)));
  if (STATE.lastOkMs) parts.push("取得 " + hhmmss(new Date(STATE.lastOkMs)));
  if (STATE.data && STATE.data.builtAt) parts.push("時刻表 " + STATE.data.builtAt);
  if (STATE.building) parts.push("時刻表を更新中…");
  if (STATE.mock) parts.push("【モックデータ】");

  var msg = parts.join("　");
  if (stale) {
    var agoMin = Math.floor((nowMs - STATE.lastOkMs) / 60000);
    msg = '<span class="warn">' + agoMin + "分前の情報です</span>　" + msg;
  } else if (STATE.data && !STATE.lastOkMs && !STATE.mock) {
    msg = '<span class="warn">リアルタイム情報を取得できていません（時刻表のみ表示）</span>　' + msg;
  }
  if (STATE.lastError) msg += '　<span class="warn">' + esc(STATE.lastError) + "</span>";
  $meta1.innerHTML = msg || "&nbsp;";
}

// 分数の色は config.js の stops[].color（無ければ既定の青）
function stopColorAttr(key) {
  for (var i = 0; i < BUSBOARD_CONFIG.stops.length; i++) {
    var s = BUSBOARD_CONFIG.stops[i];
    if (s.key === key && s.color) return ' style="color:' + esc(s.color) + '"';
  }
  return "";
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ===========================================================================
   8. リアルタイム情報の更新
   =========================================================================== */
// 復帰やタップは何度呼ばれても、実際の通信は minRefreshMs に1回だけ走る。
// 「更新」ボタンだけは STATE.lastTryMs を 0 にしてこの制限を外す。
function refresh() {
  var nowMs = Date.now();
  if (STATE.inFlight) return;
  if (nowMs - STATE.lastTryMs < CFG.minRefreshMs) return;
  if (STATE.mock) { STATE.lastOkMs = nowMs; render(); return; }
  if (!STATE.data || !STATE.token) return;
  if (document.visibilityState === "hidden") return;   // 裏にいる間は通信しない

  STATE.inFlight = true;
  STATE.lastTryMs = nowMs;
  $spin.classList.add("on");
  $btn.disabled = true;

  var jobs = feedsFor(STATE.token).map(function (f) {
    return fetchArrayBuffer(f.url).then(
      function (buf) { return { key: f.key, feed: decodeFeed(buf) }; },
      function (err) { return { key: f.key, error: err }; }
    );
  });

  Promise.all(jobs).then(function (results) {
    var okCount = 0, ts = 0, errs = [];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (r.feed) {
        STATE.rt[r.key] = r.feed;
        if (r.feed.headerTs > ts) ts = r.feed.headerTs;
        okCount++;
      } else {
        errs.push(r.key + ": " + (r.error && r.error.message ? r.error.message : "失敗"));
      }
    }
    if (okCount > 0) {
      STATE.lastOkMs = Date.now();
      if (ts) STATE.feedTs = ts;
    }
    STATE.lastError = errs.length ? errs.join(" / ") : null;
  }).catch(function (e) {
    STATE.lastError = e && e.message ? e.message : String(e);
  }).then(function () {
    STATE.inFlight = false;
    $spin.classList.remove("on");
    $btn.disabled = false;
    render();
  });
}

/* ===========================================================================
   9. 時刻表の自動更新
   =========================================================================== */
function logLine(text, isErr) {
  var div = document.createElement("div");
  if (isErr) div.className = "err";
  div.textContent = text;
  $log.appendChild(div);
}

// のりばごとに、どの段階で便が残っている／落ちているかを表示する（不具合調査用）
function diagnose() {
  var d = STATE.data;
  if (!d) return "";
  var now = new Date(), nowMs = now.getTime();
  var lo = nowMs - CFG.graceSec * 1000, hi = nowMs + CFG.horizonMin * 60000;
  var sched = scheduledDepartures(d, now);
  var rows = applyRealtime(sched, STATE.rt);
  var todayKey = String(ymd(now));
  var todaySvcs = (d.dates && d.dates[todayKey]) || [];
  var lines = ["【診断】" + hhmm(now) + " 時点・この先" + CFG.horizonMin + "分"];

  d.stops.forEach(function (st, i) {
    var all = d.trips.filter(function (t) { return t[2] === i; });
    var s1 = sched.filter(function (s) { return s.stop === st && s.schedMs >= lo && s.schedMs <= hi; });
    var r1 = rows.filter(function (r) { return r.stop === st && r.ms >= lo && r.ms <= hi; });
    var live = r1.filter(function (r) { return r.live; }).length;
    var next = r1.sort(function (a, b) { return a.ms - b.ms; })[0];
    lines.push(st.name + "（" + st.stopId + "）: 収録 " + all.length + " / 予定 " + s1.length +
               " / 表示候補 " + r1.length + "（RT " + live + "）" +
               (next ? " / 次 " + hhmm(new Date(next.ms)) + " " + next.route : ""));
  });

  d.ops.forEach(function (op) {
    var svcs = todaySvcs.filter(function (k) { return k.indexOf(op.key + "|") === 0; });
    var feed = STATE.rt[op.key];
    var nTrips = feed ? Object.keys(feed.trips).length : 0;
    var match = 0;
    if (feed) d.trips.forEach(function (t) { if (d.ops[t[1]] === op && feed.trips[t[0]]) match++; });
    lines.push(op.label + ": 今日の運行パターン " + svcs.length +
               (svcs.length ? "（" + svcs.slice(0, 3).map(function (k) { return k.split("|")[1]; }).join(", ") + (svcs.length > 3 ? " ほか" : "") + "）" : "") +
               " / RT " + (feed ? nTrips + " 便・生成 " + hhmmss(new Date(feed.headerTs * 1000)) + "・時刻表と一致 " + match : "未取得"));
  });

  d.ops.forEach(function (op) {
    var m = d.meta && d.meta[op.key];
    if (!m) { lines.push(op.label + "の詳細: 「時刻表を今すぐ更新」で表示されます"); return; }
    lines.push(op.label + "の詳細: 使う運行パターン " + m.usedSvcs + "（例 " + m.svcSample.join(", ") + "）" +
               " / calendar " + m.cal + " 行（該当 " + m.calUsed + "・開始 " + m.calRange + "）" +
               " / calendar_dates " + m.cd + " 行（該当 " + m.cdUsed + "・" + m.cdRange + "）" +
               " / 最初の運行日 " + (m.firstDay || "なし") +
               (m.extendedFrom ? " / " + m.extendedFrom + " 以降はダイヤを延長" : "") +
               (m.dups.length ? " / 重複ファイル " + m.dups.join(", ") : ""));
    if (m.calSample) lines.push("  calendar の例: " + JSON.stringify(m.calSample));
  });
  var sampleK = d.trips.filter(function (t) { return d.ops[t[1]].key === "kanto"; })[0];
  if (sampleK) lines.push("関東の便の例: " + sampleK[0] + " / " + sampleK[7] + " / " + Math.floor(sampleK[6] / 3600) + ":" + two(Math.floor(sampleK[6] % 3600 / 60)));
  return lines.join("\n");
}

function updatePanelInfo() {
  document.getElementById("diag").textContent = diagnose();
  var d = STATE.data;
  $ttInfo.textContent = (d
    ? "時刻表: " + d.builtAt + " 取得（" + fmtKey(d.validUntil) + " まで収録）・" + d.trips.length + " 便"
    : "時刻表: まだありません") + "　／　アプリの版: " + APP_VERSION;
}

function timetableIsOld(d) {
  if (!d || !d.builtAtMs) return true;
  var ageDays = (Date.now() - d.builtAtMs) / 86400000;
  return ageDays >= BUSBOARD_CONFIG.timetableMaxAgeDays;
}

// 失敗しても手元の時刻表はそのまま使い続ける（次回の起動でまた試す）
function rebuildTimetable() {
  if (STATE.building || !STATE.token) return Promise.resolve(false);
  STATE.building = true;
  $log.textContent = "";
  document.getElementById("rebuild").disabled = true;
  document.getElementById("save").disabled = true;
  render();

  return GTFS.build(BUSBOARD_CONFIG, STATE.token, function (t) { logLine(t); }).then(function (data) {
    STATE.data = data;
    if (!save(KEY_DATA, JSON.stringify(data))) logLine("※ 時刻表を端末に保存できませんでした（次回また取得します）", true);
    logLine("完了しました。");
    return true;
  }).catch(function (e) {
    logLine("失敗: " + (e && e.message ? e.message : e), true);
    if (!STATE.data) $panel.classList.add("open");   // 何も表示できないときは理由を見せる
    return false;
  }).then(function (ok) {
    STATE.building = false;
    document.getElementById("rebuild").disabled = false;
    document.getElementById("save").disabled = false;
    updatePanelInfo();
    render();
    if (ok) { STATE.lastTryMs = 0; refresh(); }
    return ok;
  });
}

/* ===========================================================================
   10. 設定パネル
   =========================================================================== */
function updateTokenState() {
  var t = STATE.token;
  document.getElementById("token-state").textContent = t
    ? "保存済みのトークン: " + t.slice(0, 4) + "…" + t.slice(-4) + "（" + t.length + "文字）"
    : "トークンはまだ保存されていません";
  // トークンが無いうちは「今すぐ更新」を出さない（押しても何もできないため）
  document.getElementById("rebuild").style.display = t ? "" : "none";
}

function openPanel() {
  $token.value = STATE.token || "";
  updateTokenState();
  updatePanelInfo();
  $panel.classList.add("open");
}

document.getElementById("gear").addEventListener("click", openPanel);
document.getElementById("close").addEventListener("click", function () {
  $panel.classList.remove("open");
  onWake();
});
document.getElementById("save").addEventListener("click", function () {
  // 貼り付けで紛れ込んだ空白や改行は取り除く
  var t = $token.value.replace(/\s+/g, "");
  $token.value = t;
  if (!t) {
    $log.textContent = "";
    logLine("入力欄が空です。アクセストークンを貼り付けてから押してください。", true);
    $token.focus();
    return;
  }
  STATE.token = t;
  if (!save(KEY_TOKEN, t)) logLine("※ トークンを端末に保存できませんでした（次回また入力が必要です）", true);
  updateTokenState();
  rebuildTimetable().then(function (ok) { if (ok) $panel.classList.remove("open"); });
});
document.getElementById("rebuild").addEventListener("click", function () {
  if (!STATE.token) {
    $log.textContent = "";
    logLine("先にトークンを入力して「保存して時刻表を取得」を押してください。", true);
    return;
  }
  rebuildTimetable();
});

var $findOut = document.getElementById("find-out");
document.getElementById("find").addEventListener("click", function () {
  var q = document.getElementById("find-q").value.trim();
  if (!q) { $findOut.textContent = "停留所名を入力してください。"; return; }
  if (!STATE.token) { $findOut.textContent = "先にアクセストークンを保存してください。"; return; }
  var btn = this;
  btn.disabled = true;
  $findOut.textContent = "";
  GTFS.findStops(BUSBOARD_CONFIG, STATE.token, q, function (t) { $findOut.textContent += t + "\n"; })
    .then(function (text) { $findOut.textContent = text || "見つかりませんでした。"; })
    .catch(function (e) { $findOut.textContent += "失敗: " + (e && e.message ? e.message : e); })
    .then(function () { btn.disabled = false; });
});

/* ===========================================================================
   11. 画面復帰・操作
   =========================================================================== */
function onWake() {
  render();     // まず手元の時刻表から即描画（ネットワーク待ちなし）
  refresh();    // 続けて再取得。届いたら数字が差し替わる
  if (!STATE.mock && STATE.token && timetableIsOld(STATE.data)) rebuildTimetable();
}

document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible") onWake();
});
window.addEventListener("pageshow", onWake);
window.addEventListener("online", refresh);

// 一覧をタップしても再取得（「更新」ボタンが自身で処理するので、ボタン上は除く）
$list.addEventListener("click", refresh);

$btn.addEventListener("click", function () {
  STATE.lastTryMs = 0;   // 明示的な更新は最短間隔を無視する
  refresh();
});

/* ===========================================================================
   12. モックデータ（レイアウト確認用）
   =========================================================================== */
function mockData() {
  var now = new Date();
  var sec = Math.floor((now.getTime() - midnight(now)) / 1000);

  var ops = [
    { key: "seibu", label: "西武" },
    { key: "kanto", label: "関東" }
  ];
  var stops = [
    { key: "houmukyoku", name: "法務局杉並出張所", direction: "荻窪・阿佐ヶ谷方面", stopId: "MOCK-H" },
    { key: "shimizu2",   name: "清水二丁目",       direction: "荻窪駅方面",         stopId: "MOCK-S" }
  ];
  var routes = ["荻10", "荻11", "荻12", "荻15", "荻15-2", "荻16", "荻17"];
  var signs  = ["荻窪駅", "荻窪駅北口", "阿佐ヶ谷駅"];

  // [発車まで(分), op, stop, route, sign, リアルタイム反映するか]
  var spec = [
    [ 1, 1, 1, 2, 1, true ],   // 清水二丁目  関東 荻12  荻窪駅北口
    [ 4, 0, 0, 5, 0, true ],   // 法務局      西武 荻16  荻窪駅
    [ 7, 0, 1, 1, 0, false],   // 清水二丁目  西武 荻11  荻窪駅
    [12, 0, 0, 3, 2, true ],   // 法務局      西武 荻15  阿佐ヶ谷駅
    [19, 1, 1, 0, 1, false],   // 清水二丁目  関東 荻10  荻窪駅北口
    [26, 0, 0, 4, 2, false]    // 法務局      西武 荻15-2 阿佐ヶ谷駅
  ];

  var trips = [], rt = { seibu: { headerTs: 0, trips: {} }, kanto: { headerTs: 0, trips: {} } };
  var nowSec = Math.floor(now.getTime() / 1000);

  for (var i = 0; i < spec.length; i++) {
    var s = spec[i], id = "MOCK" + i;
    trips.push([id, s[1], s[2], 1, s[3], s[4], sec + s[0] * 60, "MOCKSVC"]);
    if (s[5]) {
      rt[ops[s[1]].key].trips[id] = {
        tripId: id, tripRel: 0, delay: null, ts: nowSec,
        stus: [{ seq: 1, stopId: stops[s[2]].stopId, arr: null,
                 dep: { time: nowSec + s[0] * 60, delay: null }, rel: 0 }]
      };
    }
  }
  rt.seibu.headerTs = rt.kanto.headerTs = nowSec;

  var dates = {};
  dates[String(ymd(now))] = ["MOCKSVC"];

  return {
    data: { builtAt: "モック", ops: ops, stops: stops, routes: routes, signs: signs,
            dates: dates, trips: trips, feeds: null },
    rt: rt
  };
}

/* ===========================================================================
   13. 起動
   =========================================================================== */
(function init() {
  if (location.hash === "#mock") {
    var m = mockData();
    STATE.mock = true;
    STATE.data = m.data;
    STATE.rt = m.rt;
    STATE.lastOkMs = Date.now();
    STATE.feedTs = Math.floor(Date.now() / 1000);
  } else {
    STATE.token = load(KEY_TOKEN);
    STATE.data = loadTimetable();
    if (!STATE.token) openPanel();
  }

  // 保存した時刻表がブラウザの容量整理で消されにくくする
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }

  setInterval(render, CFG.tickMs);
  setInterval(refresh, CFG.refreshMs);
  onWake();
})();
