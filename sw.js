/* ===========================================================================
   sw.js（いさバス）- ホーム画面アプリとして開いたときの読み込みを速く・電波が弱くても開けるようにする

   アプリ本体のファイルだけを保存する。ODPT への通信（時刻表・リアルタイム情報）は
   一切保存せず、そのまま通す。本体は「まずネットから、だめなら保存分」で読むので、
   GitHub に更新を上げれば次に開いたときに反映される。
   =========================================================================== */
var CACHE = "isabus-hacchou-v28";
var FILES = [
  "./", "index.html", "config.js", "style.css", "app.js", "gtfs.js",
  "roads.json", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }));
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("isabus-hacchou-") === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    // GitHub Pages は10分間ブラウザに保存させる設定なので、毎回サーバに確かめて最新版を取る
    fetch(e.request.url, { cache: "no-cache" }).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return res;
    }).catch(function () {
      return caches.match(e.request, { ignoreSearch: true });
    })
  );
});
