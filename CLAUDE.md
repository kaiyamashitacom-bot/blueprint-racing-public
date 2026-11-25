# 設計図レース (仮の名前)

上から見る 2D の車のレース。嵐の環 (`../new-game`) とは別のゲーム。決めごとは `design/DECISIONS.md` (ユーザーと 1 つずつ決めた。勝手に変えない)。
ユーザーへの報告は短い日本語。実在のゲームやサーキットは写さない。

## フォルダの地図
- `shared/src/` ゲームの中身 (画面とサーバーの両方で使う): `parts.ts` 部品の表・`design.ts` 設計図と性能・`track.ts` `tracks.ts` コース・`physics.ts` 車の動き (1/60 秒刻み)・`bot.ts` コンピューターの運転・`race.ts` 周と順位と点・`room.ts` レースの部屋 (待合→信号→レース→結果)・`protocol.ts` やりとり
- `web/src/` 画面 (TypeScript + Canvas 2D、React なし): `ui/` メニュー・車づくり・練習・ネットのレース、`race/view.ts` レースの画面
- `server/src/worker.ts` Cloudflare Workers + Durable Objects (部屋 1 つ = DO 1 つ)
- 試験: `shared/test/`

## コマンド
- `npm run dev` で 画面 5273 + サーバー 8797 (5173 は嵐の環が使うので避けた)
- `npm test` (速い。全部回してよい)・`npm run typecheck`

## 決まり
- 本番に置く (wrangler deploy)・GitHub に上げる・アカウントを作るのはユーザーの了承のあと
- 音や絵の素材を入れるときは、使用条件をユーザーに確かめてから
