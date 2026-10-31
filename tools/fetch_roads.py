"""荻窪駅前の道路・線路・バスターミナルの形を OpenStreetMap（Overpass API）から取り、roads.json に保存する。

アプリ（app.js）は乗り場の地図を描くとき、まずこの roads.json を読む。
外部のサーバーに頼らず、📍 を押した瞬間に地図を出すため。
GitHub Actions（.github/workflows/roads.yml）から実行する。範囲を変えるときは BBOX を直す。
"""
import json
import sys
import time
import urllib.parse
import urllib.request

# 南, 西, 北, 東（荻窪駅を中心に、北口ロータリーと青梅街道を含む東西約1km・南北約800m）
BBOX = "35.7010,139.6140,35.7085,139.6260"

SERVERS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

QUERY = (
    "[out:json][timeout:60];("
    f'way["highway"]({BBOX});'
    f'way["railway"~"^(rail|subway|light_rail)$"]({BBOX});'
    f'way["amenity"="bus_station"]({BBOX});'
    ");out tags geom;"
)


def kind(t):
    """app.js の osmKind と同じ種類分け。描かないもの（歩道など）は None。"""
    hw = t.get("highway", "")
    if hw in ("motorway", "trunk", "primary") or hw in ("motorway_link", "trunk_link", "primary_link"):
        return "major"
    if hw in ("secondary", "tertiary", "secondary_link", "tertiary_link"):
        return "mid"
    if hw in ("residential", "unclassified", "living_street", "service", "road"):
        return "minor"
    if hw == "pedestrian" and t.get("area") != "yes":
        return "minor"
    if t.get("railway") in ("rail", "subway", "light_rail"):
        return "rail"
    if t.get("amenity") == "bus_station":
        return "bus"
    return None


def fetch():
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    last = None
    for url in SERVERS:
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": "isabus-hacchou/1.0 (github.com/jlsawo/isabus-hacchou)"})
                with urllib.request.urlopen(req, timeout=90) as res:
                    return json.load(res)
            except Exception as e:  # 混んでいるときは少し待って別のサーバーも試す
                last = e
                print(f"{url} 失敗 ({attempt + 1}回目): {e}", file=sys.stderr)
                time.sleep(10 * (attempt + 1))
    raise SystemExit(f"どのサーバーからも取得できませんでした: {last}")


def main():
    data = fetch()
    ways = []
    for el in data.get("elements", []):
        k = kind(el.get("tags", {}))
        if not k or "geometry" not in el:
            continue
        ways.append({
            "k": k,
            "n": el.get("tags", {}).get("name", ""),
            "g": [[round(p["lat"], 6), round(p["lon"], 6)] for p in el["geometry"]],
        })
    if not ways:
        raise SystemExit("道路が1本も取れませんでした")
    out = {"bbox": BBOX, "fetched": time.strftime("%Y-%m-%d"), "source": "© OpenStreetMap contributors (ODbL)", "ways": ways}
    with open("roads.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"roads.json: {len(ways)} 本")


if __name__ == "__main__":
    main()
