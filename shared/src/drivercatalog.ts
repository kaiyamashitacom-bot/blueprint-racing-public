// 名簿の運転手 (11/25 ユーザー「あと運転手も追加していこう」「似た名前にしよう」)。
// 実在の F1 の運転手を思わせる似た名前 (1〜2 字を変える・響きを似せる)。本人の名前そのままは使わない。
// 顔写真・ロゴ・番号は付けない。本人について事実のように書く説明文も付けない (国と年代の札と、能力・得意だけ)。
// 能力と得意は元の人の評判に寄せた (仮)。公開を広げる前・本物のお金を入れる前に名前を見直す (DECISIONS)。
//
// 足すときは末尾に足すだけ (append-only)。並び・id・能力を変えると、保存してある候補と合わなくなる。
// rare = 珍しい運転手: ふつうの候補には出ない (季節のごほうび・ギフトコードでだけ会える)。
import type { SpecialtyId } from "./drivers.ts";

export interface CatalogDriver {
  id: string;
  name: string;
  /** 国の札 (3 字) */
  nat: string;
  /** 年代 (1950, 1960, … 2020) */
  era: number;
  /** 速さ・安定・タイヤと燃料・ピットの判断 */
  s: readonly [number, number, number, number];
  /** 育つ余地 (能力ごとに足す。100 まで) */
  g: number;
  specs: readonly SpecialtyId[];
  rare?: boolean;
}

export const DRIVER_CATALOG: readonly CatalogDriver[] = [
  // ---- 2020 年代
  { id: "c01", name: "マックス・フェルスタペン", nat: "NED", era: 2020, s: [80, 74, 70, 68], g: 6, specs: ["rain", "pass"] },
  { id: "c02", name: "シャルル・ルクレーク", nat: "MON", era: 2020, s: [79, 62, 58, 62], g: 8, specs: ["quali"] },
  { id: "c03", name: "ランド・ノリソ", nat: "GBR", era: 2020, s: [77, 68, 62, 60], g: 8, specs: ["quali"] },
  { id: "c04", name: "オスカー・ピアストロ", nat: "AUS", era: 2020, s: [74, 72, 64, 58], g: 12, specs: ["defend"] },
  { id: "c05", name: "カルロス・サインス", nat: "ESP", era: 2020, s: [72, 70, 72, 70], g: 6, specs: ["tyre"] },
  { id: "c06", name: "ジョージ・ラッセロ", nat: "GBR", era: 2020, s: [75, 66, 62, 64], g: 10, specs: ["quali"] },
  { id: "c07", name: "ユウキ・ツノタ", nat: "JPN", era: 2020, s: [70, 55, 56, 58], g: 12, specs: ["start"] },
  { id: "c08", name: "アレクサンダー・アルボム", nat: "THA", era: 2020, s: [68, 68, 64, 60], g: 10, specs: ["defend"] },
  // 若手 (安くて育つ余地が大きい)
  { id: "c09", name: "アンドレア・アントネッロ", nat: "ITA", era: 2020, s: [52, 40, 38, 42], g: 40, specs: ["quali"] },
  { id: "c10", name: "オリバー・ベアマム", nat: "GBR", era: 2020, s: [48, 46, 40, 40], g: 38, specs: ["pass"] },
  { id: "c11", name: "フランコ・コラピンタ", nat: "ARG", era: 2020, s: [46, 38, 42, 40], g: 36, specs: [] },
  { id: "c12", name: "ガブリエル・ボルトレット", nat: "BRA", era: 2020, s: [44, 50, 46, 44], g: 38, specs: ["tyre"] },
  { id: "c13", name: "リアム・ローゾン", nat: "NZL", era: 2020, s: [50, 42, 40, 42], g: 34, specs: ["pass"] },
  { id: "c14", name: "アイザック・ハジャール", nat: "FRA", era: 2020, s: [50, 44, 38, 40], g: 38, specs: ["start"] },
  // ---- 2010 年代
  { id: "c15", name: "ルイス・ハミルトム", nat: "GBR", era: 2010, s: [79, 76, 74, 72], g: 4, specs: ["rain", "tyre"] },
  { id: "c16", name: "セルジオ・ペレツ", nat: "MEX", era: 2010, s: [66, 62, 78, 64], g: 4, specs: ["tyre", "fuel"] },
  { id: "c17", name: "ニコ・ヒュルケンボルク", nat: "GER", era: 2010, s: [70, 64, 60, 62], g: 4, specs: ["quali"] },
  { id: "c18", name: "ケビン・マグヌッソン", nat: "DEN", era: 2010, s: [66, 58, 56, 56], g: 4, specs: ["defend", "start"] },
  { id: "c19", name: "バルテリ・ボタス", nat: "FIN", era: 2010, s: [74, 66, 60, 60], g: 4, specs: ["quali"] },
  { id: "c20", name: "ダニエル・リチャルド", nat: "AUS", era: 2010, s: [72, 62, 60, 58], g: 4, specs: ["pass"] },
  { id: "c21", name: "セバスチャン・ベッテン", nat: "GER", era: 2010, s: [77, 66, 64, 66], g: 4, specs: ["quali", "start"] },
  { id: "c22", name: "カムイ・コバヤス", nat: "JPN", era: 2010, s: [64, 54, 58, 52], g: 6, specs: ["pass"] },
  // ---- 2000 年代
  { id: "c23", name: "フェルナンド・アロンゾ", nat: "ESP", era: 2000, s: [78, 74, 72, 76], g: 3, specs: ["defend", "start"] },
  { id: "c24", name: "キミ・ライコネル", nat: "FIN", era: 2000, s: [76, 66, 70, 58], g: 3, specs: ["tyre"] },
  { id: "c25", name: "ジェンソン・バトム", nat: "GBR", era: 2000, s: [70, 70, 74, 72], g: 3, specs: ["rain", "tyre"] },
  { id: "c26", name: "フェリペ・マッソ", nat: "BRA", era: 2000, s: [70, 62, 62, 58], g: 3, specs: ["kerb"] },
  { id: "c27", name: "ルーベンス・バリチェラ", nat: "BRA", era: 2000, s: [68, 70, 64, 66], g: 3, specs: ["defend"] },
  { id: "c28", name: "タクマ・サトオ", nat: "JPN", era: 2000, s: [66, 50, 54, 50], g: 5, specs: ["pass"] },
  { id: "c29", name: "ロベルト・クビザ", nat: "POL", era: 2000, s: [72, 64, 62, 60], g: 4, specs: ["kerb"] },
  // ---- 1990 年代
  { id: "c30", name: "ミカ・ハッキネム", nat: "FIN", era: 1990, s: [77, 64, 62, 60], g: 3, specs: ["quali"] },
  { id: "c31", name: "デイモン・ヒルズ", nat: "GBR", era: 1990, s: [68, 68, 66, 64], g: 3, specs: ["defend"] },
  { id: "c32", name: "ジャン・アレシ", nat: "FRA", era: 1990, s: [72, 52, 56, 52], g: 3, specs: ["rain"] },
  { id: "c33", name: "ゲルハルト・ベルゲル", nat: "AUT", era: 1990, s: [70, 62, 60, 62], g: 3, specs: ["start"] },
  // ---- 1980 年代
  { id: "c34", name: "ナイジェル・マンセロ", nat: "GBR", era: 1980, s: [76, 58, 58, 56], g: 3, specs: ["pass"] },
  { id: "c35", name: "サトル・ナカジム", nat: "JPN", era: 1980, s: [58, 62, 62, 58], g: 3, specs: ["rain"] },
  // ---- 1970 年代
  { id: "c36", name: "ジェームス・ハンド", nat: "GBR", era: 1970, s: [74, 54, 56, 54], g: 3, specs: ["pass", "start"] },
  { id: "c37", name: "エマソン・フィッティパルト", nat: "BRA", era: 1970, s: [70, 70, 66, 64], g: 3, specs: ["tyre"] },
  { id: "c38", name: "ジル・ヴィルヌーフ", nat: "CAN", era: 1970, s: [76, 48, 52, 50], g: 3, specs: ["pass", "rain"] },
  { id: "c39", name: "ジャッキー・スチュアード", nat: "GBR", era: 1970, s: [72, 74, 68, 66], g: 3, specs: ["rain", "fuel"] },
  // ---- 1960 年代
  { id: "c40", name: "ジャック・ブラバン", nat: "AUS", era: 1960, s: [66, 68, 66, 70], g: 3, specs: ["fuel", "kerb"] },
  // ---- 珍しい運転手 (季節のごほうび・ギフトコードだけ)
  { id: "rare1", name: "アイルトン・セーナ", nat: "BRA", era: 1980, s: [85, 70, 66, 68], g: 3, specs: ["rain", "quali"], rare: true },
  { id: "rare2", name: "ミハエル・シュマッハ", nat: "GER", era: 1990, s: [84, 76, 74, 76], g: 3, specs: ["rain", "start"], rare: true },
  { id: "rare3", name: "アラン・プロスタ", nat: "FRA", era: 1980, s: [78, 80, 82, 80], g: 3, specs: ["tyre", "fuel"], rare: true },
  { id: "rare4", name: "ニキ・ラウタ", nat: "AUT", era: 1970, s: [76, 80, 76, 82], g: 3, specs: ["tyre", "defend"], rare: true },
  { id: "rare5", name: "ジム・クラーグ", nat: "GBR", era: 1960, s: [84, 72, 68, 66], g: 3, specs: ["quali", "kerb"], rare: true },
  { id: "rare6", name: "ファン・マヌエル・ファンジョ", nat: "ARG", era: 1950, s: [82, 78, 76, 74], g: 3, specs: ["fuel", "kerb"], rare: true },
];
