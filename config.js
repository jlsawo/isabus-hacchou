/* ===========================================================================
   config.js（いさバス八丁）- 対象のバス停と事業者の設定

   いさバス（jlsawo/busboard）の3つののりばに、八丁から荻窪駅方面ののりばを加えた別アプリ。
   八丁の stopId は、設定画面の「のりばを調べる」で調べて記入する。

   stopId は PC 版の Find-Stops.ps1 で調べた、荻窪駅・阿佐ヶ谷駅方面ののりば
   （ポール）です。GTFS-JP はのりばごとに stop_id を振るため、stop_id を選べば
   方向は確定します。反対方向ののりば（30015-02 / 20124-02 / 3303_1）は使いません。

   アクセストークンはここには書きません。初回起動時にスマホで入力し、
   端末の中（localStorage）にだけ保存します。
   =========================================================================== */
var BUSBOARD_CONFIG = {
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
    // 八丁: どちらの事業者が停まるか・どののりばかは「のりばを調べる」の結果で決める
    { key: "hacchou_seibu",  operator: "seibu", name: "八丁",             direction: "荻窪駅方面",         stopId: "", color: "#9fdcab" },  // 薄めの緑
    { key: "hacchou_kanto",  operator: "kanto", name: "八丁",             direction: "荻窪駅方面",         stopId: "", color: "#9fdcab" }
  ]
};
