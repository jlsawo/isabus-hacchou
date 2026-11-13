/* ===========================================================================
   gtfs.js - 時刻表（GTFS 静的データ）をスマホ上で作る

   ODPT から GTFS の zip を直接ダウンロードし、ブラウザの中で展開して、
   config.js の対象のりばに停まる便だけを抜き出します。
   PC 版の tools/Build-Board.ps1 と同じ処理を JavaScript で行うものです。
   出力の形式も Build-Board.ps1 が埋め込んでいた BUSBOARD_DATA と同じです。
   =========================================================================== */
"use strict";

var GTFS = (function () {

  // 保存する時刻表の形式の番号。中身の形を変えたら上げると、スマホ側で自動的に作り直される
  //   2: 「荻窪駅から」の乗り場に緯度・経度を持たせた
  //   3: 荻窪駅のすべてののりば（poles）を持たせた（乗り場の絵に点で描くため）
  var FORMAT = 5;   // 4: 荻窪駅からの便に「乗るのりばが始発か」を追加 5: 荻窪駅行きの便に「始発を出る時刻」を追加

  /* ---------- 取得 ---------- */
  function addToken(url, token) {
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + "acl:consumerKey=" + encodeURIComponent(token);
  }

  function fetchWithTimeout(url, timeoutMs) {
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, timeoutMs);
    return fetch(url, { signal: ac.signal, cache: "no-store" }).then(
      function (res) { clearTimeout(timer); return res; },
      function (err) {
        clearTimeout(timer);
        if (err && err.name === "AbortError") throw new Error("時間切れ");
        // CORS で遮られた場合もここに来る（ブラウザは理由を教えてくれない）
        throw new Error("通信できませんでした（" + (err && err.message ? err.message : err) + "）");
      });
  }

  // token が無いときは中継サーバー（トークンはサーバー側）の URL をそのまま取る
  function fetchZip(url, token) {
    return fetchWithTimeout(token ? addToken(url, token) : url, 180000).then(function (res) {
      if (res.status === 401 || res.status === 403) throw new Error("HTTP " + res.status + "（アクセストークンが正しいか確認してください）");
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      // エラー文が 200 で返ってくる場合に備え、zip の先頭の印（PK）を確かめる
      var head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      if (head[0] !== 0x50 || head[1] !== 0x4b) {
        throw new Error("zip ではない応答でした: " + new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(200, buf.byteLength))));
      }
      return buf;
    });
  }

  /* ---------- zip の読み取り（中央ディレクトリを見る最小実装） ---------- */
  function readZipEntries(buf) {
    var dv = new DataView(buf);
    var eocd = -1;
    for (var p = buf.byteLength - 22; p >= Math.max(0, buf.byteLength - 65557); p--) {
      if (dv.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
    }
    if (eocd < 0) throw new Error("zip 形式ではありません");

    var count = dv.getUint16(eocd + 10, true);
    var cd    = dv.getUint32(eocd + 16, true);
    var u8    = new Uint8Array(buf);
    var td    = new TextDecoder("utf-8");
    var out   = {};

    for (var i = 0; i < count; i++) {
      if (dv.getUint32(cd, true) !== 0x02014b50) throw new Error("zip の目次が壊れています");
      var method   = dv.getUint16(cd + 10, true);
      var compSize = dv.getUint32(cd + 20, true);
      var nameLen  = dv.getUint16(cd + 28, true);
      var extraLen = dv.getUint16(cd + 30, true);
      var cmtLen   = dv.getUint16(cd + 32, true);
      var local    = dv.getUint32(cd + 42, true);
      var name     = td.decode(u8.subarray(cd + 46, cd + 46 + nameLen));

      // ローカルヘッダの可変長部分を飛ばして実データの位置を求める
      var dataStart = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);

      // フォルダ付きで固められていても拾えるよう、ファイル名だけで引く
      var base = name.split("/").pop();
      if (base) {
        if (out[base]) out.__dups = (out.__dups || []).concat(name);
        out[base] = { method: method, start: dataStart, size: compSize };
      }
      cd += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }

  function entryStream(buf, e) {
    var blob = new Blob([new Uint8Array(buf, e.start, e.size)]);
    if (e.method === 0) return blob.stream();
    if (e.method === 8) return blob.stream().pipeThrough(new DecompressionStream("deflate-raw"));
    throw new Error("未対応の圧縮方式 " + e.method);
  }

  /* ---------- CSV ---------- */
  function splitCsv(line) {
    if (line.indexOf('"') < 0) return line.split(",");
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (q) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  // 1行ずつ cb(values, index) を呼ぶ。index は 列名 -> 添字。
  // stop_times.txt は数十MBになるので、展開しながら少しずつ処理する。
  function forEachRow(buf, entries, file, cb, required) {
    var e = entries[file];
    if (!e) {
      if (required) return Promise.reject(new Error(file + " が zip の中にありません"));
      return Promise.resolve(0);
    }
    var reader = entryStream(buf, e).pipeThrough(new TextDecoderStream("utf-8")).getReader();
    var rest = "", index = null, n = 0;

    function handle(line) {
      if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      if (!line) return;
      if (!index) {
        index = {};
        // 列名は事業者によって大文字が混ざることがあるので小文字にそろえる
        splitCsv(line.replace(/^﻿/, "")).forEach(function (c, i) { index[c.trim().toLowerCase()] = i; });
        return;
      }
      cb(splitCsv(line), index);
      n++;
    }

    function pump() {
      return reader.read().then(function (r) {
        if (r.done) { if (rest) handle(rest); return n; }
        var lines = (rest + r.value).split("\n");
        rest = lines.pop();
        for (var i = 0; i < lines.length; i++) handle(lines[i]);
        return pump();
      });
    }
    return pump();
  }

  function col(v, ix, name) {
    var i = ix[name];
    return i === undefined ? "" : (v[i] || "").trim();
  }

  // 日付は 20261031 の形にそろえる（2026-10-31 や前後の空白も受け付ける）
  function normDate(x) { return (x || "").replace(/\D/g, ""); }

  function toSeconds(hms) {
    if (!hms) return null;
    var p = hms.trim().split(":");
    if (p.length < 2) return null;
    var h = parseInt(p[0], 10), m = parseInt(p[1], 10), s = p.length > 2 ? parseInt(p[2], 10) : 0;
    if (isNaN(h) || isNaN(m)) return null;
    return h * 3600 + m * 60 + (isNaN(s) ? 0 : s);
  }

  function ymdKey(d) {
    return String(d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate());
  }

  /* ---------- 日本の祝日（振替休日・国民の休日を含む） ----------
     データの運行日カレンダーが期限切れのとき、休日ダイヤを当てる日を決めるのに使う。 */
  function isBaseHoliday(y, m, d) {
    var nth = Math.floor((d - 1) / 7) + 1;                 // その曜日の第何週か
    var mon = new Date(y, m - 1, d).getDay() === 1;
    var eq = function (base) { return Math.floor(base + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4)); };
    if (m === 1)  return d === 1 || (mon && nth === 2);    // 元日・成人の日
    if (m === 2)  return d === 11 || d === 23;              // 建国記念の日・天皇誕生日
    if (m === 3)  return d === eq(20.8431);                 // 春分の日
    if (m === 4)  return d === 29;                          // 昭和の日
    if (m === 5)  return d === 3 || d === 4 || d === 5;     // 憲法記念日・みどりの日・こどもの日
    if (m === 7)  return mon && nth === 3;                  // 海の日
    if (m === 8)  return d === 11;                          // 山の日
    if (m === 9)  return (mon && nth === 3) || d === eq(23.2488);   // 敬老の日・秋分の日
    if (m === 10) return mon && nth === 2;                  // スポーツの日
    if (m === 11) return d === 3 || d === 23;               // 文化の日・勤労感謝の日
    return false;
  }
  function isHoliday(date) {
    var y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
    if (isBaseHoliday(y, m, d)) return true;
    var prev = function (n) { var x = new Date(y, m - 1, d - n); return isBaseHoliday(x.getFullYear(), x.getMonth() + 1, x.getDate()); };
    var next = new Date(y, m - 1, d + 1);
    // 国民の休日: 祝日にはさまれた平日
    if (date.getDay() !== 0 && prev(1) && isBaseHoliday(next.getFullYear(), next.getMonth() + 1, next.getDate())) return true;
    // 振替休日: 日曜の祝日から続く祝日の連なりの翌日
    for (var n = 1; n <= 7; n++) {
      var x = new Date(y, m - 1, d - n);
      if (!isBaseHoliday(x.getFullYear(), x.getMonth() + 1, x.getDate())) return false;
      if (x.getDay() === 0) return true;
    }
    return false;
  }

  /* ---------- 関東バスの最新版 date を CKAN から調べる ---------- */
  // 時刻表の取得先: 自分のトークンがあれば ODPT から直接、無ければ中継サーバーから
  function gtfsSource(cfg, opKey, op, token, log) {
    if (!token && cfg.proxy) return Promise.resolve(cfg.proxy + "/gtfs/" + opKey);
    return resolveGtfsUrl(op, log);
  }

  function resolveGtfsUrl(op, log) {
    if (op.gtfsUrl) return Promise.resolve(op.gtfsUrl);
    return fetchWithTimeout(op.ckanApi, 20000).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    }).then(function (text) {
      var dates = {}, m, re = /(?:date=|-)(20\d{6})/g;
      while ((m = re.exec(text))) dates[m[1]] = 1;
      var list = Object.keys(dates).sort();
      if (!list.length) throw new Error("日付が見つかりません");
      var latest = list[list.length - 1];
      log("  最新版 " + latest);
      return op.gtfsUrlTemplate.replace("{DATE}", latest);
    }).catch(function (err) {
      log("  最新版を調べられなかったため " + op.gtfsFallbackDate + " 版を使います（" + err.message + "）");
      return op.gtfsUrlTemplate.replace("{DATE}", op.gtfsFallbackDate);
    });
  }

  /* ---------- 時刻表を作る ---------- */
  // 戻り値は Build-Board.ps1 の BUSBOARD_DATA と同じ形（feeds は含まない）
  function build(cfg, token, log) {
    log = log || function () {};
    var ops = [], opIndex = {};
    var stops = cfg.stops.map(function (s) {
      return { key: s.key, name: s.name, direction: s.direction, stopId: s.stopId };
    });
    var routeMap = {}, routes = [], signMap = {}, signs = [];
    var trips = [], dates = {}, meta = {};

    // 「荻窪駅から」モード: 荻窪駅ののりばから乗って、returnMode.stops ののりばで降りる便
    var ret = cfg.returnMode || { stops: [] };
    var retTrips = [], retStops = [], retStopMap = {};
    var poles = [];   // 荻窪駅のすべてののりば（使わないものも含む）

    function pool(map, list, v) {
      v = v || "";
      if (!(v in map)) { map[v] = list.length; list.push(v); }
      return map[v];
    }

    var opKeys = [];
    // stopId が未設定ののりば（調べる前）は飛ばす
    cfg.stops.forEach(function (s) {
      if (!s.stopId) { log(s.name + "（" + cfg.operators[s.operator].label + "）は stop_id が未設定のため飛ばします"); return; }
      if (opKeys.indexOf(s.operator) < 0) opKeys.push(s.operator);
    });
    ret.stops.forEach(function (s) {
      if (s.stopId && opKeys.indexOf(s.operator) < 0) opKeys.push(s.operator);
    });

    var chain = Promise.resolve();
    opKeys.forEach(function (opKey) {
      chain = chain.then(function () {
        var op = cfg.operators[opKey];
        opIndex[opKey] = ops.length;
        ops.push({ key: opKey, label: op.label });

        var targets = {};   // stop_id -> stops[] の添字
        cfg.stops.forEach(function (s, i) { if (s.operator === opKey && s.stopId) targets[s.stopId] = i; });
        var retTargets = {};   // 降りるのりばの stop_id -> returnMode.stops[] の添字
        ret.stops.forEach(function (s, i) { if (s.operator === opKey && s.stopId) retTargets[s.stopId] = i; });
        var fromPoles = {};    // 乗るのりば（荻窪駅の各のりば）の stop_id -> 表示名
        var retHits = [], fromRows = {};

        var buf, entries;
        var hits = [], tripIds = {}, routeName = {}, tripInfo = {}, used = {};
        var firstSeq = {};   // trip_id -> 最初の停留所の stop_sequence（始発かどうかを見るため）
        var firstDep = {};   // trip_id -> 始発を出る時刻（秒）。走っているはずの便かを見るため
        var cal = [], calDates = [];

        log(op.label + "バス: 時刻表をダウンロード中…");
        return gtfsSource(cfg, opKey, op, token, log).then(function (url) {
          return fetchZip(url, token);
        }).then(function (b) {
          buf = b;
          log("  " + (buf.byteLength / 1048576).toFixed(1) + " MB 取得。展開しています…");
          entries = readZipEntries(buf);

          var found = {};
          return forEachRow(buf, entries, "stops.txt", function (v, ix) {
            var id = col(v, ix, "stop_id");
            if (id in targets || id in retTargets) found[id] = 1;
            var name = col(v, ix, "stop_name");
            if (ret.fromNamePrefix && name.indexOf(ret.fromNamePrefix) === 0) {
              var pc = col(v, ix, "platform_code");
              fromPoles[id] = {
                name: name + (pc ? " " + pc + (/^\d+$/.test(pc) ? "番" : "") : ""),
                lat: col(v, ix, "stop_lat"), lon: col(v, ix, "stop_lon")   // 地図で乗り場を示すため
              };
            }
          }, true).then(function () {
            Object.keys(targets).concat(Object.keys(retTargets)).forEach(function (id) {
              if (!found[id]) throw new Error(op.label + "バスの時刻表に stop_id " + id + " がありません");
            });
          });
        }).then(function () {
          log("  発車時刻を抽出中…");
          return forEachRow(buf, entries, "stop_times.txt", function (v, ix) {
            var sid = v[ix.stop_id];
            var isT = sid in targets, isR = sid in retTargets, isF = sid in fromPoles;
            var sq0 = parseInt(v[ix.stop_sequence], 10), tid0 = v[ix.trip_id];
            if (!(firstSeq[tid0] <= sq0)) {
              firstSeq[tid0] = sq0;
              firstDep[tid0] = toSeconds(col(v, ix, "departure_time") || col(v, ix, "arrival_time"));
            }
            if (!isT && !isR && !isF) return;
            var tid = v[ix.trip_id], seq = parseInt(v[ix.stop_sequence], 10);
            if (isR) {
              // 降りる側は到着時刻を使う
              var arr = toSeconds(col(v, ix, "arrival_time") || col(v, ix, "departure_time"));
              if (arr != null) retHits.push({ tripId: tid, retIdx: retTargets[sid], seq: seq, arr: arr });
            }
            var sec = toSeconds(col(v, ix, "departure_time") || col(v, ix, "arrival_time"));
            if (sec == null) return;
            if (isF) (fromRows[tid] = fromRows[tid] || []).push({ sid: sid, seq: seq, dep: sec });
            if (!isT) return;
            tripIds[tid] = 1;
            hits.push({ tripId: tid, stopIdx: targets[sid], seq: seq, dep: sec });
          }, true);
        }).then(function () {
          return forEachRow(buf, entries, "routes.txt", function (v, ix) {
            routeName[col(v, ix, "route_id")] = col(v, ix, "route_short_name") || col(v, ix, "route_long_name");
          }, true);
        }).then(function () {
          // 「荻窪駅から」: 降りるのりばより前に荻窪駅ののりばを通る便だけを残す
          retHits = retHits.filter(function (h) {
            var best = null;
            (fromRows[h.tripId] || []).forEach(function (f) {
              if (f.seq < h.seq && (!best || f.seq > best.seq)) best = f;
            });
            if (!best) return false;
            h.from = best;
            tripIds[h.tripId] = 1;
            return true;
          });
          fromRows = null;
          Object.keys(fromPoles).forEach(function (id) {
            var p = fromPoles[id];
            poles.push({ id: id, op: opKey, name: p.name, lat: p.lat, lon: p.lon });
          });
          return forEachRow(buf, entries, "trips.txt", function (v, ix) {
            var tid = col(v, ix, "trip_id");
            if (!tripIds[tid]) return;
            var rid = col(v, ix, "route_id");
            tripInfo[tid] = { route: routeName[rid] || rid, sign: col(v, ix, "trip_headsign"), service: col(v, ix, "service_id") };
          }, true);
        }).then(function () {
          return forEachRow(buf, entries, "calendar.txt", function (v, ix) {
            var r = {};
            for (var k in ix) r[k] = (v[ix[k]] || "").trim();
            r.start_date = normDate(r.start_date);
            r.end_date = normDate(r.end_date);
            cal.push(r);
          }, false);
        }).then(function () {
          return forEachRow(buf, entries, "calendar_dates.txt", function (v, ix) {
            calDates.push({ sid: col(v, ix, "service_id"), date: normDate(col(v, ix, "date")), type: col(v, ix, "exception_type") });
          }, false);
        }).then(function () {
          buf = null;   // メモリを早めに手放す

          var kept = 0;
          hits.forEach(function (h) {
            var info = tripInfo[h.tripId];
            if (!info) return;
            var svcKey = opKey + "|" + info.service;
            used[info.service] = 1;
            // [0]tripId [1]opIdx [2]stopIdx [3]stopSeq [4]routeIdx [5]signIdx [6]depSec [7]svcKey
            // [8]（荻窪駅からのみ） [9] のりばが始発なら 1 [10] 始発を出る時刻（秒）
            var fd = firstDep[h.tripId];
            trips.push([h.tripId, opIndex[opKey], h.stopIdx, h.seq,
                        pool(routeMap, routes, info.route), pool(signMap, signs, info.sign || info.route),
                        h.dep, svcKey, null, h.seq === firstSeq[h.tripId] ? 1 : 0, fd != null ? fd : null]);
            kept++;
          });
          var retKept = 0;
          retHits.forEach(function (h) {
            var info = tripInfo[h.tripId];
            if (!info) return;
            var rs = ret.stops[h.retIdx];
            var key = rs.key + "@" + h.from.sid;
            if (!(key in retStopMap)) {
              retStopMap[key] = retStops.length;
              var pole = fromPoles[h.from.sid] || {};
              retStops.push({ key: key, colorKey: rs.key, name: pole.name || ret.fromNamePrefix,
                              direction: "→ " + rs.name, stopId: h.from.sid, lat: pole.lat, lon: pole.lon });
            }
            used[info.service] = 1;
            // 荻窪駅を出る時刻で並べる。[8] は降りるのりばに着く時刻、[9] は乗るのりばが始発か
            retTrips.push([h.tripId, opIndex[opKey], retStopMap[key], h.from.seq,
                           pool(routeMap, routes, info.route), pool(signMap, signs, info.sign || info.route),
                           h.from.dep, opKey + "|" + info.service, h.arr,
                           h.from.seq === firstSeq[h.tripId] ? 1 : 0]);   // [9] 乗るのりばが始発なら 1
            retKept++;
          });
          if (!kept && !retKept) throw new Error(op.label + "バスで対象のりばの便が見つかりませんでした");
          log("  " + kept + " 便を取り込みました" + (retKept ? "（荻窪駅から " + retKept + " 便）" : ""));

          // 運行日カレンダーを展開（前日から calendarDays 日分）
          var dow = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
          var start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 1);
          var sets = {};

          // 運行日カレンダーの期限が切れている場合（関東バスで実際にあった）は、
          // 最後の期間のダイヤをその先も使い、祝日には日曜のダイヤを当てる。
          var lastEnd = "";
          cal.forEach(function (c) { if (used[c.service_id] && c.end_date > lastEnd) lastEnd = c.end_date; });
          var extended = 0;

          for (var d = 0; d < cfg.calendarDays; d++) {
            var day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
            var key = ymdKey(day), set = {};
            var beyond = op.extendExpiredCalendar && lastEnd && key > lastEnd;
            var dayCol = dow[beyond && isHoliday(day) ? 0 : day.getDay()];
            cal.forEach(function (c) {
              if (!used[c.service_id] || c[dayCol] !== "1") return;
              if (c.start_date && key < c.start_date) return;
              if (c.end_date && key > c.end_date && !(beyond && c.end_date === lastEnd)) return;
              set[c.service_id] = 1;
            });
            if (beyond && Object.keys(set).length) extended++;
            sets[key] = set;
          }
          if (extended) log("  ※ 運行日データが " + lastEnd + " で期限切れのため、最後のダイヤを延長して使います");
          calDates.forEach(function (x) {
            if (!used[x.sid] || !sets[x.date]) return;
            if (x.type === "1") sets[x.date][x.sid] = 1;
            else if (x.type === "2") delete sets[x.date][x.sid];
          });
          var firstDay = null;
          Object.keys(sets).sort().forEach(function (key) {
            var sids = Object.keys(sets[key]);
            if (!sids.length) return;
            if (!firstDay) firstDay = key;
            dates[key] = (dates[key] || []).concat(sids.map(function (s) { return opKey + "|" + s; }));
          });

          // 運行日が読めなかったときの調査用に、カレンダーの概要を残す
          var calU = cal.filter(function (c) { return used[c.service_id]; });
          var cdU = calDates.filter(function (x) { return used[x.sid]; });
          function range(list, f) {
            var v = list.map(f).filter(Boolean).sort();
            return v.length ? v[0] + "〜" + v[v.length - 1] : "-";
          }
          meta[opKey] = {
            usedSvcs: Object.keys(used).length,
            svcSample: Object.keys(used).slice(0, 2),
            cal: cal.length, calUsed: calU.length,
            calRange: range(calU, function (c) { return c.start_date; }) + " / 終了 " + range(calU, function (c) { return c.end_date; }),
            calSample: calU.length ? calU[0] : (cal[0] || null),
            cd: calDates.length, cdUsed: cdU.length,
            cdRange: range(cdU, function (x) { return x.date; }),
            firstDay: firstDay,
            extendedFrom: extended ? lastEnd : null,
            dups: (entries.__dups || []).slice(0, 4)
          };
        });
      });
    });

    return chain.then(function () {
      var now = new Date();
      var keys = Object.keys(dates).sort();
      return {
        builtAt:    now.getFullYear() + "-" + ("0" + (now.getMonth() + 1)).slice(-2) + "-" + ("0" + now.getDate()).slice(-2),
        builtAtMs:  now.getTime(),
        format:     FORMAT,
        validUntil: keys.length ? keys[keys.length - 1] : null,
        ops: ops, stops: stops, routes: routes, signs: signs, dates: dates, trips: trips,
        retTrips: retTrips, retStops: retStops, poles: poles,
        retCfg: ret.stops.map(function (s) { return s.key + "=" + (s.stopId || ""); }).join(","),
        meta: meta
      };
    });
  }

  /* ---------- のりばを調べる（PC 版 Find-Stops.ps1 の移植） ----------
     停留所名に query を含むのりばを、通る系統・行先・便数つきで一覧にする。
     結果を見て、目的の方面ののりばの stop_id を config.js に書く。 */
  function findStops(cfg, token, query, log) {
    var lines = [];
    var chain = Promise.resolve();
    Object.keys(cfg.operators).forEach(function (opKey) {
      chain = chain.then(function () {
        var op = cfg.operators[opKey];
        var buf, entries, cand = {}, order = [], tripStops = {}, routeName = {};
        log(op.label + "バス: 「" + query + "」を検索中…");
        return gtfsSource(cfg, opKey, op, token, log).then(function (url) { return fetchZip(url, token); }).then(function (b) {
          buf = b; entries = readZipEntries(buf);
          return forEachRow(buf, entries, "stops.txt", function (v, ix) {
            var name = col(v, ix, "stop_name");
            if (name.indexOf(query) < 0) return;
            var id = col(v, ix, "stop_id");
            cand[id] = { name: name, lat: col(v, ix, "stop_lat"), lon: col(v, ix, "stop_lon"),
                         trips: 0, routes: {}, signs: {}, dirs: {}, first: null, last: null };
            order.push(id);
          }, true);
        }).then(function () {
          if (!order.length) return;
          return forEachRow(buf, entries, "stop_times.txt", function (v, ix) {
            var sid = v[ix.stop_id];
            if (!cand[sid]) return;
            var tid = v[ix.trip_id];
            (tripStops[tid] = tripStops[tid] || []).push(sid);
            var t = col(v, ix, "departure_time") || col(v, ix, "arrival_time");
            var c = cand[sid];
            if (t && (!c.first || t < c.first)) c.first = t;
            if (t && (!c.last || t > c.last)) c.last = t;
          }, true).then(function () {
            return forEachRow(buf, entries, "routes.txt", function (v, ix) {
              routeName[col(v, ix, "route_id")] = col(v, ix, "route_short_name") || col(v, ix, "route_long_name");
            }, true);
          }).then(function () {
            return forEachRow(buf, entries, "trips.txt", function (v, ix) {
              var sids = tripStops[col(v, ix, "trip_id")];
              if (!sids) return;
              var r = routeName[col(v, ix, "route_id")] || col(v, ix, "route_id");
              var hs = col(v, ix, "trip_headsign") || "（行先なし）";
              var di = col(v, ix, "direction_id");
              sids.forEach(function (sid) {
                var c = cand[sid];
                c.trips++;
                c.routes[r] = (c.routes[r] || 0) + 1;
                c.signs[hs] = (c.signs[hs] || 0) + 1;
                if (di !== "") c.dirs[di] = (c.dirs[di] || 0) + 1;
              });
            }, true);
          });
        }).then(function () {
          buf = null;
          function top(o, n) {
            return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; }).slice(0, n)
              .map(function (k) { return k + "(" + o[k] + ")"; }).join(" ");
          }
          lines.push("■ " + op.label + "（" + opKey + "）: " + order.length + " 件");
          order.forEach(function (id) {
            var c = cand[id];
            lines.push("stop_id: " + id + "  " + c.name);
            lines.push("  便数 " + c.trips + (c.first ? "  始発 " + c.first.slice(0, 5) + "  終発 " + c.last.slice(0, 5) : ""));
            if (c.trips) {
              lines.push("  系統 " + top(c.routes, 6));
              lines.push("  行先 " + top(c.signs, 5));
            }
            lines.push("  地図 https://www.google.com/maps?q=" + c.lat + "," + c.lon);
          });
        });
      });
    });
    return chain.then(function () { return lines.join("\n"); });
  }

  return { FORMAT: FORMAT, build: build, addToken: addToken, isHoliday: isHoliday, findStops: findStops };
})();
