"use strict";

/* ===========================================================================
   app.js - いさバス（スマホ用 バス接近表示）

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
// trips / stops を省略すると「荻窪駅行き」、data.retTrips / data.retStops を渡すと「荻窪駅から」
function scheduledDepartures(data, now, trips, stops) {
  var out = [];
  trips = trips || (data && data.trips);
  stops = stops || (data && data.stops);
  if (!data || !trips) return out;

  for (var back = 1; back >= 0; back--) {
    var d = new Date(now.getTime() - back * 86400000);
    var key = String(ymd(d));
    var active = (data.dates && data.dates[key]) || null;
    if (!active || !active.length) continue;

    var base = midnight(d);
    var activeSet = {};
    for (var i = 0; i < active.length; i++) activeSet[active[i]] = 1;

    for (var t = 0; t < trips.length; t++) {
      var tr = trips[t];
      // [0]tripId [1]opIdx [2]stopIdx [3]stopSeq [4]routeIdx [5]signIdx [6]depSec [7]svcIdx [8]降車のりば着（荻窪駅からのみ）
      if (!activeSet[tr[7]]) continue;
      out.push({
        tripId:  tr[0],
        op:      data.ops[tr[1]],
        stop:    stops[tr[2]],
        seq:     tr[3],
        route:   data.routes[tr[4]],
        sign:    data.signs[tr[5]],
        schedMs: base + tr[6] * 1000,
        arrMs:   tr[8] != null ? base + tr[8] * 1000 : null
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
      schedMs: s.schedMs, ms: ms, live: live,
      // 降りるのりばに着く時刻は、乗るのりばでの遅れをそのまま足した見込み
      arrMs: s.arrMs != null ? s.arrMs + (ms - s.schedMs) : null
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
var APP_VERSION = "32";   // 更新が反映されたかを設定画面で確かめるための番号（index.html の ?v= と揃える）
var KEY_TOKEN = "busboard.token";
// トークンは同じサイト（jlsawo.github.io）のいさバスと共有し、時刻表はアプリごとに分ける
var KEY_DATA  = BUSBOARD_CONFIG.storageKey || "busboard.timetable";
var KEY_MODE  = (BUSBOARD_CONFIG.storageKey || "busboard") + ".mode";
var KEY_OPTIONAL = (BUSBOARD_CONFIG.storageKey || "busboard") + ".showOptional";

/* 表示の切り替え: "to" = 荻窪駅行き、"from" = 荻窪駅から（法務局・清水二丁目へ） */
var MODES = {
  to:   { label: "荻窪駅行き" },
  from: { label: (BUSBOARD_CONFIG.returnMode && BUSBOARD_CONFIG.returnMode.label) || "荻窪駅から" }
};

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

// リアルタイム情報の取得先: 自分のトークンがあれば ODPT から直接、無ければ中継サーバーから
function feedsFor(token) {
  var out = [];
  for (var k in BUSBOARD_CONFIG.operators) {
    var u = BUSBOARD_CONFIG.operators[k].tripUpdateUrl;
    if (!u) continue;
    if (token) out.push({ key: k, url: GTFS.addToken(u, token) });
    else if (BUSBOARD_CONFIG.proxy) out.push({ key: k, url: BUSBOARD_CONFIG.proxy + "/rt/" + k });
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

  var fromMode = STATE.mode === "from";
  var rows = [];
  if (STATE.data) {
    var sched = fromMode
      ? scheduledDepartures(STATE.data, now, STATE.data.retTrips || [], STATE.data.retStops || [])
      : scheduledDepartures(STATE.data, now);
    var applied = applyRealtime(sched, STATE.rt);
    var opt = BUSBOARD_CONFIG.optional;
    if (!fromMode && !STATE.showOptional && opt) {
      applied = applied.filter(function (r) { return opt.keys.indexOf(r.stop.key) < 0; });
    }
    rows = pickTop(applied, nowMs);
  }

  var emptyMsg = (fromMode && STATE.data && !STATE.data.retTrips) ? "時刻表を更新すると表示されます"
               : STATE.data ? "この先" + CFG.horizonMin + "分に便がありません"
               : STATE.building ? "時刻表を準備しています…"
               : !canFetch() ? "⚙ からアクセストークンを設定してください"
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
      ? '<span class="soon-wrap"><span class="soon-dot" aria-hidden="true"></span><span class="soon">まもなく</span></span>'
      : '<span class="num">' + mins + '</span><span class="unit">分</span>';

    html +=
      '<li class="row stop-' + r.stop.key + (soon ? " is-soon" : "") + '">' +
        '<div class="mins"' + stopColorAttr(r.stop.colorKey || r.stop.key) + ">" + minsHtml + "</div>" +
        '<div class="info">' +
          '<div class="line1">' +
            '<span class="route">' + esc(r.route) + "</span>" +
            '<span class="sign">' + esc(r.sign) + "</span>" +
          "</div>" +
          '<div class="line2">' +
            '<span class="stop">' + esc(r.stop.name) + " " + esc(r.stop.direction) + "</span>" +
            '<span class="op op-' + r.op.key + '">' + esc(r.op.label) + "</span>" +
            (r.arrMs ? '<span class="arr">' + hhmm(new Date(r.arrMs)) + "着</span>" : "") +
            (r.stop.lat && r.stop.lon ? mapLink(r.stop) : "") +
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

// 分数の色は config.js の stops[].color / returnMode.stops[].color（無ければ既定の青）
function stopColorAttr(key) {
  var all = BUSBOARD_CONFIG.stops.concat((BUSBOARD_CONFIG.returnMode || {}).stops || []);
  for (var i = 0; i < all.length; i++) {
    var s = all[i];
    if (s.key === key && s.color) return ' style="color:' + esc(s.color) + '"';
  }
  return "";
}

// 「八丁あり」: 押したときだけ、荻窪駅行きの表示に optional.keys ののりばを加える（ふだんは出さない）
function setOptional(on) {
  STATE.showOptional = !!on;
  save(KEY_OPTIONAL, STATE.showOptional ? "1" : "0");
  var $e = document.getElementById("optional");
  $e.setAttribute("aria-pressed", STATE.showOptional ? "true" : "false");
  $e.classList.toggle("on", STATE.showOptional);
  render();
}

// 乗り場の場所を吹き出しの小さな地図で見せるボタン（1文字分のアイコン）
function mapLink(stop) {
  return '<button type="button" class="map" data-stop="' + esc(stop.stopId) + '" data-lat="' + esc(stop.lat) + '" data-lon="' + esc(stop.lon) +
         '" data-name="' + esc(stop.name) + '" aria-label="' + esc(stop.name) + 'の場所を地図で見る">📍</button>';
}

/* ---------- 乗り場の地図の吹き出し ----------
   道路（ロータリー・青梅街道）と線路だけのシンプルな絵に、荻窪駅のすべてののりばを点で描き、
   押した便の乗り場だけを赤く目立たせる。道路と線路の形は OpenStreetMap から一度だけ取ってきて保存する。
   範囲はどの乗り場でも同じ（使う乗り場と荻窪駅がすべて入る範囲）で、印の位置だけが変わる。× で閉じる。 */
var MAP_MAX_ZOOM = 18;   // 1画素がおよそ0.5m。乗り場が近くに集まっていれば、ロータリーが大きく見えるこの縮尺

var MAP_CREDIT = '道路: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
var KEY_OSM      = (BUSBOARD_CONFIG.storageKey || "busboard") + ".osm";
var $bubble = document.getElementById("mapbubble");
var BUBBLE = null;   // 開いている吹き出しの情報（絵の描き直しに使う）

// 緯度経度 ⇔ ズーム z の世界全体での画素位置
function worldPx(lat, lon, z) {
  var n = Math.pow(2, z) * 256, rad = lat * Math.PI / 180;
  return { x: (lon + 180) / 360 * n, y: (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n };
}
function worldLatLon(x, y, z) {
  var n = Math.pow(2, z) * 256;
  return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI, lon: x / n * 360 - 180 };
}

// 使う乗り場・目印・近くののりばがすべて余白つきで入る、いちばん大きい縮尺と中心
var MAP_NEAR_M = 300;
function mapView(w, h) {
  var pts = ((STATE.data && STATE.data.retStops) || [])
    .map(function (s) { return [parseFloat(s.lat), parseFloat(s.lon)]; })
    .filter(function (p) { return !isNaN(p[0]) && !isNaN(p[1]); });
  // 目印（荻窪駅）も必ず地図に入るようにする
  var lm = BUSBOARD_CONFIG.returnMode && BUSBOARD_CONFIG.returnMode.landmark;
  if (lm) pts.push([lm.lat, lm.lon]);
  // ロータリーや青梅街道沿いの、近くにある荻窪駅ののりばもすべて入れる（南口など遠いものは入れない）
  if (pts.length) {
    var cLat = pts.reduce(function (t, p) { return t + p[0]; }, 0) / pts.length;
    var cLon = pts.reduce(function (t, p) { return t + p[1]; }, 0) / pts.length;
    ((STATE.data && STATE.data.poles) || []).forEach(function (p) {
      var la = parseFloat(p.lat), lo = parseFloat(p.lon);
      var dy = (la - cLat) * 111000, dx = (lo - cLon) * 111000 * Math.cos(cLat * Math.PI / 180);
      if (Math.sqrt(dx * dx + dy * dy) <= MAP_NEAR_M) pts.push([la, lo]);
    });
  }
  var lats = pts.map(function (p) { return p[0]; }), lons = pts.map(function (p) { return p[1]; });
  var c = { lat: (Math.min.apply(null, lats) + Math.max.apply(null, lats)) / 2,
            lon: (Math.min.apply(null, lons) + Math.max.apply(null, lons)) / 2 };
  for (var z = MAP_MAX_ZOOM; z > 12; z--) {
    var a = worldPx(Math.max.apply(null, lats), Math.min.apply(null, lons), z);
    var b = worldPx(Math.min.apply(null, lats), Math.max.apply(null, lons), z);
    if (b.x - a.x <= w - 48 && b.y - a.y <= h - 48) break;   // 印が端で切れないよう 24px の余白
  }
  var cp = worldPx(c.lat, c.lon, z);
  return { z: z, left: cp.x - w / 2, top: cp.y - h / 2, w: w, h: h };
}

/* ---- 道路と線路の形（OpenStreetMap） ---- */
function viewBbox(v) {
  var nw = worldLatLon(v.left, v.top, v.z), se = worldLatLon(v.left + v.w, v.top + v.h, v.z);
  return [se.lat, nw.lon, nw.lat, se.lon].map(function (x) { return x.toFixed(4); }).join(",");   // 南,西,北,東
}
// 道路の形は、まずアプリに同梱した roads.json（GitHub Actions が OpenStreetMap から取って入れたもの）を使う。
// 外部のサーバーを待たないので、📍 を押した瞬間に描ける。無いときだけ、その場で取りに行く。
var ROADS = null;
fetch("roads.json").then(function (res) { return res.ok ? res.json() : null; }).then(function (j) {
  if (j && j.ways && j.ways.length) { ROADS = j; if (BUBBLE) renderMapInner(); }
}).catch(function () {});

function loadOsm(bbox) {
  if (ROADS) return ROADS;
  try { var o = JSON.parse(load(KEY_OSM) || "null"); return o && o.bbox === bbox ? o : null; } catch (_) { return null; }
}

// 絵に使うものだけを種類分けして残す（歩道・建物などは描かない）
function osmKind(t) {
  var hw = t.highway;
  if (/^(motorway|trunk|primary)(_link)?$/.test(hw)) return "major";
  if (/^(secondary|tertiary)(_link)?$/.test(hw)) return "mid";
  // 住宅街の細い道や、駐車場・私道の通路は描かない。ロータリーやバスの通路（service）は描く
  if (hw === "service" && !/^(driveway|parking_aisle|alley|drive-through|emergency_access)$/.test(t.service || "")) return "minor";
  if (hw === "pedestrian" && t.area !== "yes") return "minor";
  if (/^(rail|subway|light_rail)$/.test(t.railway)) return "rail";
  if (t.amenity === "bus_station") return "bus";
  if (t.public_transport === "station" || t.building === "train_station" || t.railway === "station") return "station";
  return null;
}

var osmLoading = false;
function fetchOsm(bbox) {
  if (osmLoading) return;
  osmLoading = true;
  var q = "[out:json][timeout:25];(" +
          'way["highway"](' + bbox + ');way["railway"~"^(rail|subway|light_rail)$"](' + bbox + ");" +
          'way["amenity"="bus_station"](' + bbox + ');way["public_transport"="station"](' + bbox + ');' +
          'way["building"="train_station"](' + bbox + "););out tags geom;";
  // 混んでいて断られることがあるので、だめなら別のサーバーを順に試す（1台20秒まで）
  var servers = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
                 "https://overpass.private.coffee/api/interpreter"];
  function tryServer(i) {
    if (i >= servers.length) return Promise.reject(new Error("all failed"));
    var ac = new AbortController(), timer = setTimeout(function () { ac.abort(); }, 20000);
    return fetch(servers[i], {
      method: "POST", body: "data=" + encodeURIComponent(q), signal: ac.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).catch(function () { clearTimeout(timer); return tryServer(i + 1); });
  }
  tryServer(0).then(function (j) {
    var ways = [];
    (j.elements || []).forEach(function (el) {
      var k = osmKind(el.tags || {});
      if (!k || !el.geometry) return;
      ways.push({ k: k, n: (el.tags && el.tags.name) || "",
                  g: el.geometry.map(function (p) { return [+p.lat.toFixed(6), +p.lon.toFixed(6)]; }) });
    });
    save(KEY_OSM, JSON.stringify({ bbox: bbox, ways: ways }));
  }).catch(function () {
    if (BUBBLE) BUBBLE.osmFailed = true;
  }).then(function () {
    osmLoading = false;
    if (BUBBLE) renderMapInner();   // 届いたら描き直す
  });
}

// 乗り場の絵（SVG）。道路は白、縁取りと線路は灰色、のりばは灰色の点
// 乗り場の番号: 番線（platform_code）が名前に入っていればそれ、無ければ stop_id の末尾の数字
function poleNumber(name, id) {
  var m = /(\d+)番/.exec(name || "") || /[-_](\d+)$/.exec(id || "");
  return m ? String(parseInt(m[1], 10)) : "";
}

// 乗り場の絵（SVG）。バス乗り場の案内図のように、紺の地に白い道、白い駅、
// 今回の乗り場だけを番号入りの赤い丸で示す。ほかの乗り場は目立たない小さな点
function drawSchematic(v, osm, cur) {
  var s = Math.pow(2, v.z - 17);   // 線の太さは ズーム17 を基準にする
  function xy(lat, lon) { var p = worldPx(lat, lon, v.z); return [p.x - v.left, p.y - v.top]; }
  function path(g) { return g.map(function (p, i) { var q = xy(p[0], p[1]); return (i ? "L" : "M") + q[0].toFixed(1) + " " + q[1].toFixed(1); }).join(""); }
  // 画面の外にある道は描かない（roads.json は広めに取ってあるので、描く量を減らして速くする）
  var ways = (osm ? osm.ways : []).filter(function (w) {
    return w.g.some(function (p) { var q = xy(p[0], p[1]); return q[0] > -60 && q[0] < v.w + 60 && q[1] > -60 && q[1] < v.h + 60; });
  });
  function of(k) { return ways.filter(function (w) { return w.k === k; }); }

  var out = '<svg class="mb-svg" viewBox="0 0 ' + v.w + " " + v.h + '" width="' + v.w + '" height="' + v.h + '">' +
            '<rect width="100%" height="100%" fill="#2f3b52"/>';
  // バスターミナル（ロータリーの広場）は白っぽく塗る
  of("bus").forEach(function (w) { out += '<path d="' + path(w.g) + 'Z" fill="#e9edf2"/>'; });

  var widths = { minor: 6, mid: 9, major: 14 };
  ["minor", "mid", "major"].forEach(function (k) {
    var wd = Math.max(2.5, widths[k] * s);
    of(k).forEach(function (w) { out += '<path d="' + path(w.g) + '" fill="none" stroke="#ffffff" stroke-width="' + wd + '" stroke-linecap="round" stroke-linejoin="round"/>'; });
  });
  // 線路は何本も並ぶので、まとめて1本の白黒の帯にする（画面の中の線路の点に直線を当てはめる）
  var rp = [];
  of("rail").forEach(function (w) { w.g.forEach(function (p) { var q = xy(p[0], p[1]); if (q[0] >= -20 && q[0] <= v.w + 20 && q[1] >= -20 && q[1] <= v.h + 20) rp.push(q); }); });
  if (rp.length >= 2) {
    var mx = 0, my = 0;
    rp.forEach(function (q) { mx += q[0]; my += q[1]; }); mx /= rp.length; my /= rp.length;
    var sxx = 0, sxy = 0;
    rp.forEach(function (q) { sxx += (q[0] - mx) * (q[0] - mx); sxy += (q[0] - mx) * (q[1] - my); });
    var k = sxx ? sxy / sxx : 0;   // 傾き
    var y0 = my - k * mx, y1 = my + k * (v.w - mx), bw = Math.max(7, 10 * s);
    var band = "M0 " + y0.toFixed(1) + "L" + v.w + " " + y1.toFixed(1);
    out += '<path d="' + band + '" stroke="#11161f" stroke-width="' + (bw + 2) + '"/>' +
           '<path d="' + band + '" stroke="#ffffff" stroke-width="' + bw + '" stroke-dasharray="' + (14 * s) + " " + (14 * s) + '"/>';
  }

  // 文字は「青梅街道」と「荻窪駅」だけ
  var label = function (x, y, text, rot) {
    return '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" class="mb-label"' +
           (rot ? ' transform="rotate(' + rot.toFixed(1) + " " + x.toFixed(1) + " " + y.toFixed(1) + ')"' : "") + ">" + esc(text) + "</text>";
  };
  // 青梅街道の上で、画面の中に入っている点を道沿いに細かく調べ、横方向の真ん中に近い所に名前を置く
  var best = null;
  of("major").filter(function (w) { return w.n.indexOf("青梅街道") >= 0; }).forEach(function (w) {
    var pts = w.g.map(function (p) { return xy(p[0], p[1]); });
    for (var i = 1; i < pts.length; i++) {
      var a0 = pts[i - 1], a1 = pts[i], len = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
      for (var t = 0; t <= len; t += 8) {
        var x = a0[0] + (a1[0] - a0[0]) * t / len, y = a0[1] + (a1[1] - a0[1]) * t / len;
        if (x < 40 || x > v.w - 40 || y < -10 || y > v.h + 10) continue;
        var d = Math.abs(x - v.w * 0.4);   // 真ん中より少し左（右上のコンパスと重なりにくい）
        if (!best || d < best.d) best = { d: d, x: x, y: y, ang: Math.atan2(a1[1] - a0[1], a1[0] - a0[0]) * 180 / Math.PI };
      }
    }
  });
  if (best) {
    var ang = best.ang;
    if (ang > 90) ang -= 180; if (ang < -90) ang += 180;   // 文字が逆さにならないように
    // 道が端ぎりぎりにあるときは、文字が切れないよう少し内側に寄せる
    out += label(best.x, Math.max(10, Math.min(v.h - 10, best.y)), "青梅街道", ang);
  }
  // 駅は白い四角で描く（線路に沿って東西に長い）。大きさは config.js の landmark.size（メートル）
  var lm = BUSBOARD_CONFIG.returnMode && BUSBOARD_CONFIG.returnMode.landmark;
  if (lm) {
    var lp = xy(lm.lat, lm.lon);
    var pxPerM = Math.pow(2, v.z) * 256 / (40075016.686 * Math.cos(lm.lat * Math.PI / 180));
    // 縮尺が小さくなっても建物とわかるよう、最小 70×20px にする
    var sw = Math.max(70, (lm.size ? lm.size[0] : 90) * pxPerM), sh = Math.max(20, (lm.size ? lm.size[1] : 28) * pxPerM);
    out += '<rect x="' + (lp[0] - sw / 2).toFixed(1) + '" y="' + (lp[1] - sh / 2).toFixed(1) + '" width="' + sw.toFixed(1) + '" height="' + sh.toFixed(1) +
           '" fill="#ffffff" stroke="#11161f" stroke-width="1"/>' +
           '<text x="' + lp[0].toFixed(1) + '" y="' + lp[1].toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" class="mb-station">' + esc(lm.name) + "</text>";
  }

  // ほかの乗り場は、目立たない小さな点
  ((STATE.data && STATE.data.poles) || []).forEach(function (p) {
    if (p.id === cur.stopId) return;
    var q = xy(parseFloat(p.lat), parseFloat(p.lon));
    if (q[0] < 0 || q[0] > v.w || q[1] < 0 || q[1] > v.h) return;
    out += '<circle cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="3" fill="#8794a8"/>';
  });

  // 今回の乗り場: 番号入りの赤い丸
  var cp = xy(cur.lat, cur.lon), num = poleNumber(cur.name, cur.stopId);
  out += '<circle cx="' + cp[0].toFixed(1) + '" cy="' + cp[1].toFixed(1) + '" r="11" fill="#e8332a" stroke="#ffffff" stroke-width="2"/>' +
         (num ? '<text x="' + cp[0].toFixed(1) + '" y="' + (cp[1] + 0.5).toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" class="mb-num">' + esc(num) + "</text>" : "");

  // コンパス（地図はいつも北が上）
  var cx = v.w - 22, cy = 34;   // 上の「N」が切れない位置
  out += '<g class="mb-compass">' +
         '<circle cx="' + cx + '" cy="' + cy + '" r="14" fill="#fff" stroke="#bcc4cd" stroke-width="1"/>' +
         '<path d="M' + cx + " " + (cy - 10) + "L" + (cx + 5) + " " + (cy + 3) + "L" + cx + " " + (cy + 1) + "L" + (cx - 5) + " " + (cy + 3) + 'Z" fill="#e8332a"/>' +
         '<path d="M' + cx + " " + (cy + 10) + "L" + (cx + 5) + " " + (cy + 3) + "L" + cx + " " + (cy + 1) + "L" + (cx - 5) + " " + (cy + 3) + 'Z" fill="#9aa3ad"/>' +
         '<text x="' + cx + '" y="' + (cy - 17) + '" text-anchor="middle" class="mb-north">N</text></g>';

  if (!osm) {
    out += '<text x="8" y="' + (v.h - 8) + '" class="mb-status">' +
           (BUBBLE && BUBBLE.osmFailed ? "道路の形を取得できませんでした（のりばの点のみ）" : "道路の形を読み込んでいます…") + "</text>";
  }
  return out + "</svg>";
}

/* ---- 荻窪駅北口のバス乗り場の案内図（手描き） ----
   JR荻窪駅北口駅前広場バスのりば案内図・タウンセブンの案内図などを参考に描いたもの（480×310）。
   乗り場は番号で置く（番号は poleNumber、合わないときは config.js の returnMode.poleNumbers で直す）。
   今回の乗り場は番号入りの赤い丸、ほかはグレーの丸。 */
var GUIDE_W = 480, GUIDE_H = 310;
var GUIDE_BASE = "<g font-family=\"'Noto Sans CJK JP','Noto Sans JP',sans-serif\"><rect width=\"480\" height=\"310\" fill=\"#ffffff\"/>\n  <g stroke=\"#d9dde3\" fill=\"none\" stroke-linejoin=\"round\">\n    <!-- 北へ延びる道 -->\n    <path d=\"M248 0 L236 118\" stroke-width=\"9\"/>\n    <path d=\"M352 0 L340 150\" stroke-width=\"9\"/>\n    <!-- 西口へ下りる道（2本） -->\n    <path d=\"M246 132 L204 192 L196 214 L120 226 L0 240\" stroke-width=\"12\"/>\n    <path d=\"M206 268 L206 212\" stroke-width=\"8\"/>\n    <!-- 青梅街道 -->\n    <path d=\"M0 36 L212 120 L304 152 L480 152\" stroke-width=\"22\"/>\n    <!-- ロータリーへの道 -->\n    <path d=\"M312 156 L312 186\" stroke-width=\"12\"/>\n  </g>\n  <!-- ロータリー -->\n  <rect x=\"300\" y=\"180\" width=\"104\" height=\"80\" rx=\"16\" fill=\"#d9dde3\"/>\n  <path d=\"M326 198 H382 A10 10 0 0 1 392 208 V226 A10 10 0 0 1 382 236 H326 A6 6 0 0 1 326 224 H360 A3 3 0 0 0 360 218 V216 A3 3 0 0 0 360 210 H326 A6 6 0 0 1 326 198 Z\" fill=\"#ffffff\" stroke=\"#c9ced6\"/>\n  <!-- タクシー乗り場 -->\n  <rect x=\"315\" y=\"245\" width=\"14\" height=\"10\" rx=\"2\" fill=\"#f5c542\" stroke=\"#c9a227\"/>\n  <text x=\"322\" y=\"253\" text-anchor=\"middle\" font-size=\"6.5\" font-weight=\"700\" fill=\"#1f2937\">T</text>\n  <text x=\"302\" y=\"266.5\" font-size=\"7\" fill=\"#6b7280\">タクシー乗り場</text>\n  <!-- タウンセブン: 北へとがった五角形。左上の辺は西口への道、右上の辺は駐車場出口の道に面する -->\n  <path d=\"M216 194 L262 158 L300 174 L298 244 L216 244 Z\" fill=\"#f1f3f6\" stroke=\"#c9ced6\"/>\n  <text x=\"258\" y=\"210\" text-anchor=\"middle\" font-size=\"9\" fill=\"#6b7280\">タウンセブン</text>\n  <!-- ルミネ: タウンセブンのすぐ下、駅と一体の横長の建物（右端の先が北口） -->\n  <rect x=\"214\" y=\"248\" width=\"86\" height=\"18\" fill=\"#f1f3f6\" stroke=\"#c9ced6\"/>\n  <text x=\"257\" y=\"260\" text-anchor=\"middle\" font-size=\"9\" fill=\"#6b7280\">ルミネ</text>\n  <!-- マクドナルド（西口からの道の途中、左側） -->\n  <rect x=\"186\" y=\"241\" width=\"13\" height=\"11\" fill=\"#f1f3f6\" stroke=\"#c9ced6\"/>\n  <text x=\"182\" y=\"249.5\" text-anchor=\"end\" font-size=\"7.5\" fill=\"#6b7280\">マクドナルド</text>\n  <!-- 駅（線路の帯） -->\n  <path d=\"M0 284 L480 284\" stroke=\"#9aa3ad\" stroke-width=\"10\"/>\n  <path d=\"M0 284 L480 284\" stroke=\"#ffffff\" stroke-width=\"7\" stroke-dasharray=\"14 14\"/>\n  <rect x=\"196\" y=\"268\" width=\"156\" height=\"32\" fill=\"#8a929c\"/>\n  <text x=\"270\" y=\"290\" text-anchor=\"middle\" font-size=\"15\" font-weight=\"700\" fill=\"#ffffff\">荻窪駅</text>\n  <text x=\"210\" y=\"279\" text-anchor=\"middle\" font-size=\"8\" font-weight=\"700\" fill=\"#ffffff\">西口</text>\n  <text x=\"334\" y=\"279\" text-anchor=\"middle\" font-size=\"8\" font-weight=\"700\" fill=\"#ffffff\">北口</text>\n  <!-- 信号 -->\n  <g><rect x=\"232\" y=\"123.5\" width=\"24\" height=\"9\" rx=\"4.5\" fill=\"#4b5563\"/><circle cx=\"237\" cy=\"128\" r=\"2.6\" fill=\"#22c55e\"/><circle cx=\"244\" cy=\"128\" r=\"2.6\" fill=\"#facc15\"/><circle cx=\"251\" cy=\"128\" r=\"2.6\" fill=\"#ef4444\"/></g>\n  <g><rect x=\"300\" y=\"141.5\" width=\"24\" height=\"9\" rx=\"4.5\" fill=\"#4b5563\"/><circle cx=\"305\" cy=\"146\" r=\"2.6\" fill=\"#22c55e\"/><circle cx=\"312\" cy=\"146\" r=\"2.6\" fill=\"#facc15\"/><circle cx=\"319\" cy=\"146\" r=\"2.6\" fill=\"#ef4444\"/></g>\n  <!-- 文字 -->\n  <text x=\"372\" y=\"156.5\" text-anchor=\"middle\" font-size=\"13\" font-weight=\"700\" fill=\"#6b7280\">青梅街道</text>\n  <text x=\"4\" y=\"138\" font-size=\"9\" fill=\"#9aa3ad\">至 吉祥寺</text>\n  <text x=\"120\" y=\"244\" text-anchor=\"middle\" font-size=\"9\" fill=\"#9aa3ad\" transform=\"rotate(-9 120 244)\">白山通り</text>\n  <text x=\"474\" y=\"192\" text-anchor=\"end\" font-size=\"9\" fill=\"#9aa3ad\">至 新宿</text>\n  <!-- 建物（お店）: 実寸に近い小さな四角。店名は外に -->\n  <g transform=\"rotate(21.6 70.0 104.6)\"><rect x=\"62.0\" y=\"98.6\" width=\"16\" height=\"12\" fill=\"#f1f3f6\" stroke=\"#c9ced6\"/></g><text x=\"65.2\" y=\"119.2\" text-anchor=\"middle\" font-size=\"7.5\" fill=\"#6b7280\" transform=\"rotate(21.6 65.2 116.7)\">ソフトバンク</text>\n  <g transform=\"rotate(21.6 130.0 128.4)\"><rect x=\"121.0\" y=\"122.4\" width=\"18\" height=\"12\" fill=\"#f1f3f6\" stroke=\"#c9ced6\"/></g><text x=\"125.2\" y=\"143.0\" text-anchor=\"middle\" font-size=\"7.5\" fill=\"#6b7280\" transform=\"rotate(21.6 125.2 140.5)\">三井住友銀行</text>\n  <g transform=\"rotate(21.6 176.0 146.6)\"><rect x=\"169.0\" y=\"140.6\" width=\"14\" height=\"12\" fill=\"#f1f3f6\" stroke=\"#c9ced6\"/></g><text x=\"171.2\" y=\"161.2\" text-anchor=\"middle\" font-size=\"7.5\" fill=\"#6b7280\" transform=\"rotate(21.6 171.2 158.7)\">サンドラッグ</text>\n  <g transform=\"rotate(21.6 208.0 159.3)\"><rect x=\"203.0\" y=\"154.3\" width=\"10\" height=\"10\" fill=\"#f1f3f6\" stroke=\"#c9ced6\"/></g><text x=\"203.2\" y=\"173.8\" text-anchor=\"middle\" font-size=\"7.5\" fill=\"#6b7280\" transform=\"rotate(21.6 203.2 171.3)\">ドトール</text>\n  <g transform=\"rotate(21.6 95.0 41.4)\"><rect x=\"86.0\" y=\"35.4\" width=\"18\" height=\"12\" fill=\"#f1f3f6\" stroke=\"#c9ced6\"/></g><text x=\"99.8\" y=\"30.4\" text-anchor=\"middle\" font-size=\"7.5\" fill=\"#6b7280\" transform=\"rotate(21.6 99.8 30.4)\">りそな銀行</text>\n  <rect x=\"378\" y=\"104\" width=\"32\" height=\"24\" fill=\"#f1f3f6\" stroke=\"#c9ced6\"/><text x=\"394\" y=\"98\" text-anchor=\"middle\" font-size=\"7.5\" fill=\"#6b7280\">ドン・キホーテ</text>\n  <rect x=\"252\" y=\"106\" width=\"16\" height=\"12\" fill=\"#f1f3f6\" stroke=\"#c9ced6\"/><text x=\"260\" y=\"88\" text-anchor=\"middle\" font-size=\"7.5\" fill=\"#6b7280\">お菓子の</text><text x=\"260\" y=\"98\" text-anchor=\"middle\" font-size=\"7.5\" fill=\"#6b7280\">まちおか</text>\n  <!-- コンパス -->\n  <circle cx=\"456\" cy=\"30\" r=\"13\" fill=\"#ffffff\" stroke=\"#c9ced6\"/>\n  <path d=\"M456 21 L461 33 L456 31 L451 33 Z\" fill=\"#e8332a\"/><path d=\"M456 41 L461 33 L456 31 L451 33 Z\" fill=\"#9aa3ad\"/></g>";
var GUIDE_POLES = {
  N0: [344, 252], N1: [374, 252], N2: [398, 236], N3: [374, 186], N4: [300, 208],
  N5: [77, 86.9], N6: [137, 110.7], N7: [200, 135.6], N8: [420, 172], N9: [446, 132]
};
var GUIDE_NOTES = { N8: "（午前のみ）", N9: "（午後のみ）" };

// 乗り場 → 案内図の上の場所の名前（例: "N3"）。分からなければ ""（そのときは道路の形から描いた図）
function guideKey(name, id) {
  var o = (BUSBOARD_CONFIG.returnMode && BUSBOARD_CONFIG.returnMode.poleNumbers) || {};
  if (o[id]) return o[id];
  var num = poleNumber(name, id);
  if (!num || /南口/.test(name || "")) return "";
  var key = "N" + num;
  return GUIDE_POLES[key] ? key : "";
}

function drawGuideMap(cur, w, h) {
  var out = '<svg class="mb-svg" viewBox="0 0 ' + GUIDE_W + " " + GUIDE_H + '" width="' + w + '" height="' + h + '">' + GUIDE_BASE;
  // ほかの乗り場: グレーの丸と番号
  Object.keys(GUIDE_POLES).forEach(function (k) {
    if (k === cur.key) return;
    var p = GUIDE_POLES[k];
    out += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="7" fill="#8a94a3"/>' +
           '<text x="' + p[0] + '" y="' + (p[1] + 3) + '" text-anchor="middle" class="mb-gnum">' + k.slice(1) + "</text>";
  });
  // 今回の乗り場: 番号入りの赤い丸
  var c = GUIDE_POLES[cur.key];
  out += '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="11" fill="#e8332a" stroke="#ffffff" stroke-width="2.5"/>' +
         '<text x="' + c[0] + '" y="' + (c[1] + 4.5) + '" text-anchor="middle" class="mb-gcur">' + cur.key.slice(1) + "</text>";
  if (GUIDE_NOTES[cur.key]) {
    var nx = Math.min(c[0], GUIDE_W - 40);   // 右端で文字が切れないよう内側に寄せる
    out += '<text x="' + nx + '" y="' + (c[1] + 24) + '" text-anchor="middle" class="mb-gnote">' + GUIDE_NOTES[cur.key] + "</text>";
  }
  return out + "</svg>";
}

// 吹き出しの中の絵と赤い印を描く。案内図に載っている乗り場なら案内図、そうでなければ道路の形から描いた図
function renderMapInner() {
  if (!BUBBLE) return;
  var b = BUBBLE, v = b.v, $m = $bubble.querySelector(".mb-map");
  b.key = guideKey(b.name, b.stopId);
  if (b.key) {
    var gw = v.w, gh = Math.round(v.w * GUIDE_H / GUIDE_W);
    $m.style.height = gh + "px";
    $m.innerHTML = drawGuideMap(b, gw, gh);
    $bubble.querySelector(".mb-credit").textContent = "";
    return;
  }
  var bbox = viewBbox(v), osm = loadOsm(bbox);
  if (!osm && !b.osmFailed && !ROADS) fetchOsm(bbox);
  $m.innerHTML = drawSchematic(v, osm, b);
}

function openMapBubble(btn) {
  var lat = parseFloat(btn.getAttribute("data-lat")), lon = parseFloat(btn.getAttribute("data-lon"));
  if (isNaN(lat) || isNaN(lon)) return;

  var w = Math.min(320, window.innerWidth - 24), h = Math.round(w * 0.8);   // 縦にも余裕を持たせ、ロータリーが大きく見える縮尺に
  BUBBLE = { v: mapView(w, h), lat: lat, lon: lon, stopId: btn.getAttribute("data-stop"), name: btn.getAttribute("data-name") };

  $bubble.innerHTML =
    '<div class="mb-head"><span class="mb-title">' + esc(btn.getAttribute("data-name")) + "</span>" +
      '<button type="button" class="mb-close" aria-label="閉じる">×</button></div>' +
    '<div class="mb-map" style="width:' + w + "px;height:" + h + 'px"></div>' +
    '<div class="mb-credit">' + MAP_CREDIT + "</div>" +
    '<span class="mb-arrow"></span>';
  renderMapInner();
  $bubble.hidden = false;

  // ボタンの下に出す。下に入りきらなければ上に出す。吹き出しの矢印はボタンを指す
  var r = btn.getBoundingClientRect(), bw = $bubble.offsetWidth, bh = $bubble.offsetHeight;
  var x = Math.max(12, Math.min(window.innerWidth - bw - 12, r.left + r.width / 2 - bw / 2));
  var below = r.bottom + 10 + bh <= window.innerHeight - 8;
  $bubble.style.left = x + "px";
  $bubble.style.top = (below ? r.bottom + 10 : Math.max(8, r.top - 10 - bh)) + "px";
  $bubble.classList.toggle("above", !below);
  $bubble.querySelector(".mb-arrow").style.left = (r.left + r.width / 2 - x - 8) + "px";
}

function closeMapBubble() { BUBBLE = null; $bubble.hidden = true; $bubble.innerHTML = ""; }

$bubble.addEventListener("click", function (e) {
  if (e.target.closest(".mb-close")) closeMapBubble();
});
document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMapBubble(); });

// 画面上部の帯: 「ホーム画面に追加」（インストールできるときだけ）と「八丁あり」（荻窪駅行きのときだけ）
function updateBar() {
  var showOpt = STATE.mode !== "from" && !!BUSBOARD_CONFIG.optional;
  var showInstall = !!STATE.installPrompt;
  document.getElementById("optional").hidden = !showOpt;
  document.getElementById("install").hidden = !showInstall;
  document.getElementById("filterbar").hidden = !showOpt && !showInstall;
}

/* ---------- インストール ----------
   Chrome は、まだインストールしていないときだけ beforeinstallprompt を知らせてくる。
   そのときだけボタンを出し、押したらインストールの確認を出す。インストール済みのアプリとして
   開いているとき（display-mode: standalone）や、インストールが済んだあとは出さない。 */
STATE.installPrompt = null;
window.addEventListener("beforeinstallprompt", function (e) {
  if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return;
  e.preventDefault();   // Chrome が自分で出す案内の代わりに、このボタンを出す
  STATE.installPrompt = e;
  updateBar();
});
window.addEventListener("appinstalled", function () {
  STATE.installPrompt = null;
  updateBar();
});
document.getElementById("install").addEventListener("click", function () {
  var p = STATE.installPrompt;
  if (!p) return;
  p.prompt();
  p.userChoice.then(function (c) {
    if (c && c.outcome === "accepted") { STATE.installPrompt = null; updateBar(); }
  }).catch(function () {});
});

function setMode(mode) {
  STATE.mode = MODES[mode] ? mode : "to";
  save(KEY_MODE, STATE.mode);
  var $m = document.getElementById("mode");
  $m.textContent = MODES[STATE.mode].label;
  $m.classList.toggle("is-from", STATE.mode === "from");
  closeMapBubble();
  // 「荻窪駅から」には八丁が出ないので、除外ボタンの帯ごと隠す
  updateBar();
  render();
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
  if (!STATE.data || !canFetch()) return;
  if (document.visibilityState === "hidden") return;   // 裏にいる間は通信しない

  STATE.inFlight = true;
  STATE.lastTryMs = nowMs;
  $spin.classList.add("on");
  $btn.disabled = true;

  var jobs = feedsFor(getToken()).map(function (f) {
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

  if (d.retStops) {
    var rs = applyRealtime(scheduledDepartures(d, now, d.retTrips, d.retStops), STATE.rt)
      .filter(function (r) { return r.ms >= lo && r.ms <= hi; });
    var byDest = {};
    rs.forEach(function (r) { byDest[r.stop.direction] = (byDest[r.stop.direction] || 0) + 1; });
    lines.push("荻窪駅から: 収録 " + d.retTrips.length + " / 表示候補 " + rs.length +
               (Object.keys(byDest).length ? "（" + Object.keys(byDest).map(function (k) { return k + " " + byDest[k]; }).join("、") + "）" : "") +
               " / 乗り場 " + d.retStops.map(function (s) { return s.name; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join("・"));
  }

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

// config.js ののりば（stop_id）が、保存してある時刻表を作ったときと違うか
function stopsChanged(d) {
  var want = BUSBOARD_CONFIG.stops.map(function (s) { return s.key + "=" + (s.stopId || ""); }).join(",");
  var have = (d.stops || []).map(function (s) { return s.key + "=" + (s.stopId || ""); }).join(",");
  var wantRet = ((BUSBOARD_CONFIG.returnMode || {}).stops || []).map(function (s) { return s.key + "=" + (s.stopId || ""); }).join(",");
  return want !== have || wantRet !== (d.retCfg || "");
}

function timetableIsOld(d) {
  if (!d || !d.builtAtMs) return true;
  if ((d.format || 1) !== GTFS.FORMAT) return true;   // 時刻表の形式が変わったら作り直す
  if (stopsChanged(d)) return true;   // のりばの設定を変えたら、ボタンを押さなくても作り直す
  var ageDays = (Date.now() - d.builtAtMs) / 86400000;
  return ageDays >= BUSBOARD_CONFIG.timetableMaxAgeDays;
}

// 失敗しても手元の時刻表はそのまま使い続ける（次回の起動でまた試す）
function rebuildTimetable() {
  if (STATE.building || !canFetch()) return Promise.resolve(false);
  STATE.building = true;
  $log.textContent = "";
  document.getElementById("rebuild").disabled = true;
  document.getElementById("save").disabled = true;
  render();

  return GTFS.build(BUSBOARD_CONFIG, getToken(), function (t) { logLine(t); }).then(function (data) {
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
function getToken() { return STATE.token; }
// トークンを入れなくても、中継サーバーがあれば使える
function canFetch() { return !!(STATE.token || BUSBOARD_CONFIG.proxy); }

function updateTokenState() {
  var t = STATE.token;
  // 中継サーバーがあれば、利用者にはトークンの欄を見せない（管理者モードでは見せる）
  var hide = !!BUSBOARD_CONFIG.proxy && !STATE.admin;
  document.getElementById("token-section").hidden = hide;
  document.getElementById("save").style.display = hide ? "none" : "";
  document.getElementById("token-state").textContent = t
    ? "保存済みのトークン: " + t.slice(0, 4) + "…" + t.slice(-4) + "（" + t.length + "文字）"
    : "トークンはまだ保存されていません";
  // トークンが無いうちは「今すぐ更新」を出さない（押しても何もできないため）
  document.getElementById("rebuild").style.display = canFetch() ? "" : "none";
}

function openPanel() {
  $token.value = STATE.token || "";
  updateTokenState();
  updatePanelInfo();
  $panel.classList.add("open");
}

document.getElementById("gear").addEventListener("click", openPanel);

// 管理者モード: 「アプリの版」の行を5回続けてタップすると、のりば検索とトークンの欄を出す
(function () {
  var taps = 0, timer = null;
  $ttInfo.addEventListener("click", function () {
    taps++;
    clearTimeout(timer);
    timer = setTimeout(function () { taps = 0; }, 1500);
    if (taps < 5) return;
    taps = 0;
    STATE.admin = !STATE.admin;
    document.getElementById("admin-tools").hidden = !STATE.admin;
    updateTokenState();
  });
})();
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
  if (!canFetch()) {
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
  if (!canFetch()) { $findOut.textContent = "先にアクセストークンを保存してください。"; return; }
  var btn = this;
  btn.disabled = true;
  $findOut.textContent = "";
  GTFS.findStops(BUSBOARD_CONFIG, getToken(), q, function (t) { $findOut.textContent += t + "\n"; })
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
  if (!STATE.mock && canFetch() && timetableIsOld(STATE.data)) rebuildTimetable();
}

document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible") onWake();
});
window.addEventListener("pageshow", onWake);
window.addEventListener("online", refresh);

// 一覧をタップしても再取得（「更新」ボタンが自身で処理するので、ボタン上は除く）
$list.addEventListener("click", function (e) {
  var btn = e.target.closest && e.target.closest(".map");
  if (btn) { openMapBubble(btn); return; }   // 地図アイコンは吹き出しを開くだけ
  refresh();
});

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
    if (!canFetch()) openPanel();
  }

  STATE.mode = load(KEY_MODE) === "from" ? "from" : "to";
  if (BUSBOARD_CONFIG.optional) document.getElementById("optional").textContent = BUSBOARD_CONFIG.optional.label;
  STATE.showOptional = load(KEY_OPTIONAL) === "1";
  setOptional(STATE.showOptional);
  document.getElementById("optional").addEventListener("click", function () { setOptional(!STATE.showOptional); });
  setMode(STATE.mode);
  document.getElementById("mode").addEventListener("click", function () {
    setMode(STATE.mode === "from" ? "to" : "from");
  });

  // 保存した時刻表がブラウザの容量整理で消されにくくする
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }

  setInterval(render, CFG.tickMs);
  setInterval(refresh, CFG.refreshMs);
  onWake();
})();
