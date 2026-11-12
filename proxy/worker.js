/* ===========================================================================
   いさバス 中継サーバー（Cloudflare Workers）

   ODPT のアクセストークンをこのサーバーの中（Cloudflare の秘密の設定 ODPT_TOKEN）
   だけに置き、利用者のスマホにはトークンを渡さずにバスの情報を届ける。
   いさバスのページ（ALLOWED_ORIGINS）からの問い合わせにだけ答える。
   同じ情報は短い時間だけ使い回し、ODPT への問い合わせを増やしすぎない。

     GET /rt/seibu   GET /rt/kanto     リアルタイム情報（GTFS-RT TripUpdate）  20秒使い回し
     GET /vp/seibu   GET /vp/kanto     バスの位置（GTFS-RT VehiclePosition）   20秒使い回し
     GET /gtfs/seibu GET /gtfs/kanto   時刻表（GTFS zip）                       6時間使い回し

   設置は GitHub Actions（.github/workflows/proxy.yml）が行う。
   =========================================================================== */

const ALLOWED_ORIGINS = ["https://jlsawo.github.io"];

const UPSTREAM = {
  seibu: {
    rt:   "https://api.odpt.org/api/v4/gtfs/realtime/SeibuBus_trip_update",
    vp:   "https://api.odpt.org/api/v4/gtfs/realtime/SeibuBus_vehicle",
    gtfs: "https://api.odpt.org/api/v4/files/SeibuBus/data/SeibuBus-GTFS.zip"
  },
  kanto: {
    rt:   "https://api.odpt.org/api/v4/gtfs/realtime/odpt_KantoBus_AllLines_trip_update",
    vp:   "https://api.odpt.org/api/v4/gtfs/realtime/odpt_KantoBus_AllLines_vehicle",
    // 関東バスの GTFS は版ごとに date が変わるので CKAN で最新版を調べる。だめなら fallbackDate
    gtfsTemplate: "https://api.odpt.org/api/v4/files/odpt/KantoBus/AllLines.zip?date={DATE}",
    ckan: "https://ckan.odpt.org/api/3/action/package_show?id=kanto_bus_all_lines",
    fallbackDate: "20261014"
  }
};

const TTL = { rt: 20, vp: 20, gtfs: 6 * 3600 };   // 使い回す秒数

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET",
    "Vary": "Origin"
  };
}

function addToken(url, token) {
  return url + (url.includes("?") ? "&" : "?") + "acl:consumerKey=" + encodeURIComponent(token);
}

async function kantoGtfsUrl(up) {
  try {
    const res = await fetch(up.ckan, { cf: { cacheTtl: 3600 } });
    if (res.ok) {
      const dates = [...(await res.text()).matchAll(/(?:date=|-)(20\d{6})/g)].map(m => m[1]).sort();
      if (dates.length) return up.gtfsTemplate.replace("{DATE}", dates[dates.length - 1]);
    }
  } catch (_) { /* 調べられなければ下の版を使う */ }
  return up.gtfsTemplate.replace("{DATE}", up.fallbackDate);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: allowed ? 204 : 403, headers: allowed ? cors(origin) : {} });
    }
    // いさバスのページ以外（他のサイトや、ブラウザ以外からの直接の取得）には答えない
    if (!allowed) return new Response("forbidden", { status: 403 });
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: cors(origin) });

    const m = new URL(request.url).pathname.match(/^\/(rt|vp|gtfs)\/(seibu|kanto)$/);
    if (!m) return new Response("not found", { status: 404, headers: cors(origin) });
    const [, kind, op] = m;
    if (!env.ODPT_TOKEN) return new Response("token not configured", { status: 500, headers: cors(origin) });

    // 使い回し（キーにはトークンを含めない）
    const cache = caches.default;
    const key = new Request("https://isabus-cache/" + kind + "/" + op);
    let res = await cache.match(key);
    if (!res) {
      const up = UPSTREAM[op];
      const url = kind === "gtfs" ? (up.gtfs || await kantoGtfsUrl(up)) : up[kind];
      const upstream = await fetch(addToken(url, env.ODPT_TOKEN));
      if (!upstream.ok) {
        // ODPT の応答本文はそのまま返さない（トークンの断片が含まれる可能性に備える）
        return new Response("upstream error " + upstream.status, { status: 502, headers: cors(origin) });
      }
      res = new Response(upstream.body, {
        headers: {
          "Content-Type": kind === "gtfs" ? "application/zip" : "application/x-protobuf",
          "Cache-Control": "public, max-age=" + TTL[kind]
        }
      });
      ctx.waitUntil(cache.put(key, res.clone()));
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors(origin))) out.headers.set(k, v);
    out.headers.set("Cache-Control", "no-store");   // ブラウザ側では使い回さない（使い回しはサーバー側で行う）
    return out;
  }
};
