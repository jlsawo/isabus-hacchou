/* ===========================================================================
   config.js（いさバス）- 対象のバス停と事業者の設定

   法務局杉並出張所・清水二丁目・八丁から荻窪駅方面ののりばを表示する。旧いさバス（jlsawo/busboard）の後継。
   八丁の stopId は、設定画面の「のりばを調べる」で調べて記入したもの。

   stopId は PC 版の Find-Stops.ps1 で調べた、荻窪駅・阿佐ヶ谷駅方面ののりば
   （ポール）です。GTFS-JP はのりばごとに stop_id を振るため、stop_id を選べば
   方向は確定します。反対方向ののりば（30015-02 / 20124-02 / 3303_1）は使いません。

   アクセストークンはここには書きません。初回起動時にスマホで入力し、
   端末の中（localStorage）にだけ保存します。
   =========================================================================== */
var BUSBOARD_CONFIG = {
  // 中継サーバー（proxy/worker.js を Cloudflare Workers に置いたもの）の URL。
  // 設定すると、トークンを入力しなくても使える（トークンはサーバーの中にだけある）。
  // 空のときは、各自のトークンで ODPT から直接取得する。
  proxy: "",

  storageKey: "busboard.hacchou.timetable",   // 時刻表の保存先（いさバスとは別にする）
  maxItems:   7,       // 表示件数
  horizonMin: 120,     // 何分先までを対象にするか
  refreshMs:  60000,   // リアルタイム情報の取得間隔

  // 時刻表（GTFS 静的データ）の自動更新
  timetableMaxAgeDays: 7,    // これより古くなったら起動時に裏で取り直す
  calendarDays:        60,   // 何日先までの運行日を展開しておくか

  operators: {
    seibu: {
      label: "西武",
      gtfsUrl: "https://api.odpt.org/api/v4/files/SeibuBus/data/SeibuBus-GTFS.zip",
      tripUpdateUrl: "https://api.odpt.org/api/v4/gtfs/realtime/SeibuBus_trip_update",
      extendExpiredCalendar: true
    },
    kanto: {
      label: "関東",
      // 関東バスの GTFS は版ごとに date が変わるため、CKAN から最新版を調べる。
      // 調べられなかったときは gtfsFallbackDate の版を使う。
      gtfsUrlTemplate: "https://api.odpt.org/api/v4/files/odpt/KantoBus/AllLines.zip?date={DATE}",
      ckanApi: "https://ckan.odpt.org/api/3/action/package_show?id=kanto_bus_all_lines",
      gtfsFallbackDate: "20261014",
      tripUpdateUrl: "https://api.odpt.org/api/v4/gtfs/realtime/odpt_KantoBus_AllLines_trip_update",
      // 関東バスのデータは運行日の期限（end_date）が版の日付で切れていることがある。
      // そのときは最後のダイヤを延長して使い、祝日は日曜のダイヤにする（gtfs.js 参照）。
      extendExpiredCalendar: true
    }
  },

  stops: [
    // color は分数の色。省略すると既定の青。
    { key: "houmukyoku",     operator: "seibu", name: "法務局杉並出張所", direction: "荻窪・阿佐ヶ谷方面", stopId: "30015-01", color: "#f7b8cb" },  // 桜色
    { key: "shimizu2_seibu", operator: "seibu", name: "清水二丁目",       direction: "荻窪駅方面",         stopId: "20124-01" },
    { key: "shimizu2_kanto", operator: "kanto", name: "清水二丁目",       direction: "荻窪駅方面",         stopId: "3303_2" },
    // 八丁（杉並区）: 「のりばを調べる」の結果から荻窪駅行きののりばを選んだ。
    //   西武 30012-01 … 荻14・荻13（石神井公園駅・上井草駅 → 荻窪駅）
    //   関東 3105_2   … 荻30〜荻40（→ 荻窪駅北口）
    // 使わないのりば: 30012-02 / 3105_1（反対方向）、30012-03 / 30012-04（法務局を通る荻15〜荻18。
    // 30012-03 の便は法務局杉並出張所 30015-01 と同じバスなので、法務局の行として表示される）
    { key: "hacchou_seibu",  operator: "seibu", name: "八丁",             direction: "荻窪駅方面",         stopId: "30012-01", color: "#9fdcab" },  // 薄めの緑
    { key: "hacchou_kanto",  operator: "kanto", name: "八丁",             direction: "荻窪駅方面",         stopId: "3105_2",   color: "#9fdcab" }
  ],

  // 「荻窪駅行き」で、ボタンひとつで隠せるのりば（画面上部の「八丁は除く」）
  excludable: { label: "八丁は除く", keys: ["hacchou_seibu", "hacchou_kanto"] },

  // 「荻窪駅から」表示（画面上のボタンで切り替え）。
  // 荻窪駅ののりば（停留所名が fromNamePrefix で始まるもの）から乗り、下の stopId ののりばで降りる便を、
  // 荻窪駅を出る時刻の順に表示する。降りるのりばは荻窪駅から離れる方向のもの
  // （荻窪駅行きで使っている 30015-01 / 20124-01 / 3303_2 の向かい側）。
  returnMode: {
    label: "荻窪駅から",
    fromNamePrefix: "荻窪駅",
    // 乗り場の地図に四角で描く駅（JR 荻窪駅。OpenStreetMap の線路の真ん中に合わせた）。size は東西・南北の大きさ（メートル）
    landmark: { name: "荻窪駅", lat: 35.70441, lon: 139.62000, size: [90, 28] },
    stops: [
      { key: "ret_houmukyoku",     operator: "seibu", name: "法務局杉並出張所", stopId: "30015-02", color: "#f7b8cb" },  // 桜色
      { key: "ret_shimizu2_seibu", operator: "seibu", name: "清水二丁目",       stopId: "20124-02" },
      { key: "ret_shimizu2_kanto", operator: "kanto", name: "清水二丁目",       stopId: "3303_1" }
    ]
  }
};
