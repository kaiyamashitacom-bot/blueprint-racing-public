# Blueprint Racing 引き継ぎ書

次に作る人 (人でも、新しい Claude のセッションでも) が、すぐ続きを始められるように書いた物。
全体の設計は `design/OVERVIEW.md`、決めごとの全部 (日付ごと・あとの項が前の項を置きかえる) は `design/DECISIONS.md`。
この文書は公開リポジトリにも写ることがあるので、メールアドレス・パスワード・鍵・管理者の ID・この機械のフォルダの場所・本番の URL は書かない。

---

## 1. 作業の進め方

### セッションの分け方
- **受付のセッション (名前「スキル追加検討」)**: ユーザーと話して決めごとを聞く係。ユーザーの言葉と、受付の読み (ユーザー未確認) を分けて、作る側のセッションに送ってくる。
- **作る側のセッション (このゲームを作るセッション)**: 受付から来た決まりを `design/DECISIONS.md` に書き、手伝い (エージェント) に分けて作り、試験を通して commit・push・本番に置く。報告は短く、区切りのときだけ受付に送る。
- ユーザーは受付を通して話すことが多いが、作る側のセッションに直接書くこともある。**本番の管理者の ID・お金・公開など、外に出る物・ユーザーにしか決められない物は、ユーザー本人の言葉 (このセッションへの直接の書きこみ) で確かめる**。受付から伝わった了承だけで進めない (権限の確認で止められる)。

### 決めごとの書き方 (`design/DECISIONS.md`)
- 「決まり (ユーザー)」= ユーザーが言ったこと。ユーザーの言葉をかっこで残す。
- 「読み (受付、ユーザー未確認)」= 受付がユーザーの言葉をこう読んだ。
- 「仮 (私が決めた、ユーザー未確認)」= 作る側が筋のよい方で決めた数や形。管理者の画面で変えられるようにしておく。
- 大きく遊び方が変わること (点・賞金・リーグや級の形) は、決めずに「ユーザーに聞くこと」に書く (ユーザーから「仮の数で進めて」と言われたら仮に決めて、聞くことの欄には残す)。

### 手伝い (エージェント) に分けて同時に作るやり方
- 1 つの頼みは 1 人の手伝いに。ファイルが重ならないように分ける (例: 画面の手伝いは `web/src/race/*`、計算の手伝いは `shared/src/*`)。
- 重なるときは「そのファイルは小さくぴったり直す・直す前に読み直す」と頼む。
- 手伝いへの頼みには、読む物 (CLAUDE.md・DECISIONS の節)・作る物・触ってはいけないファイル・試験・報告の形・「commit しない」を必ず書く。
- 開発用のサーバー (web 5273・wrangler 8797) は作る側が立てる。手伝いは立てない・止めない。2 つは別々に立てる (片方が落ちても、もう片方は動き続けるように)。
- 手伝いが書きかけのとき wrangler が起動に失敗することがある (使う前の名前を読み込んだ時など)。そのときは作る側が立て直す。
- ブラウザで確かめるときは、手伝いは自分のタブを開いて最後に閉じる。試しのアカウントは作ったら消す。

### commit のしかた
- 試験と型の確かめが全部通ってから commit。ほかの手伝いの作りかけが混ざらないよう、そのとき必要なファイルだけを `git commit -- <ファイル>` でまとめることが多い。
- `shared/src/index.ts` に、まだ記録していないファイルを読む行があると、記録 (HEAD) が壊れる。commit の前に確かめる。
- commit の最後に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

---

## 2. 置き方 (本番)

- 手順は `scripts/deploy.sh` だけを使う。git の HEAD の写しを作り、`npm ci` → 型 → 試験 → web を組み立て → すぐ `wrangler deploy`。作りかけのファイルは本番に出ない。
- 決まり (ユーザー 11/25「聞かずに置いてよい」): 区切りごとに試験と型が通ったら、聞かずに本番へ置き直してよい。
- 置いたあとは `/health`・ページ・`/api/race-rules`・WebSocket が答えるかを確かめる。
- 本番の URL はユーザーが知っている (`wrangler deploy` の出力にも出る)。広めない決まり。
- cron: UTC `0 1-23/2 * * *` (= 日本時間の 0・2・4…22 時)。リーグ戦の 2 時間ごとのレースを LeagueDO に起こさせる。cron の Worker 側は起こすだけ (無料の枠の 10 ms のため)。計算は DO の中で、1 回の alarm に 1 レース (1 レースはこの機械で 60〜150 ms。DO は 1 回 数秒まで通る)。
- 毎日の大会 (22:30) と季節の締め (月曜 0 時) は AccountsDO の alarm。

### Cloudflare とログインの注意
- この機械の wrangler のログインは、今「レース用のアカウント」。`server/wrangler.toml` の `account_id` がそれ。
- 嵐の環 (となりの new-game) は別のアカウント。嵐の環を置くときは wrangler のログインを戻す必要がある。**ログイン・ログアウトはユーザー本人だけ**がする。
- 無料の枠: 1 日 10 万回の呼び出しまで。人が増えたら有料の枠 (お金なのでユーザーが決める) か、位置を送る回数を減らす (DECISIONS の「ユーザーに聞くこと」)。

### 管理者
- 管理者の ID は wrangler の secret (`BPR_ADMIN_IDS`) に入っている。ソースには書かない。変えるときはユーザー本人の指示が要る。
- 管理者の画面: はじめの画面 →「走る」の「季節と大会」の所の「管理」(管理者だけに出る)。数の調整・ギフト・大会・コースの確かめ・遊ぶ人 (止める・招く・パスワードを戻す)・走行点の交換所・賭け。
- パスワードを忘れた人は、管理者の画面の遊ぶ人の欄で戻す (メールは使わない)。
- 手元で管理者を試すときは `server/.dev.vars` に書いて wrangler を立て直す (git に入らない)。

### GitHub
- 非公開のリポジトリ (origin) に push。push と PR で GitHub Actions が型と試験を回す。
- 公開リポジトリ (`blueprint-racing-public`) と `scripts/publish-public.sh`: 受付から「push のたびに公開リポジトリにも写す (11/25 ユーザー了承)」と伝わっているが、作る側のセッションではユーザー本人からの直接の了承がまだなので、**自動では動かしていない**。気になる点: 実在のサーキットの正式な名前と実在の運転手に似た名前が入っている (公開前に見直す決まり)・`wrangler.toml` の `account_id`。ユーザーが直接「送ってよい」と言ったら、push のあとに毎回 `bash scripts/publish-public.sh`。

### 動画 (`media/`、git に入らない)
- 予告動画 (横と縦・55.7 秒) とティーザー (横と縦・23 秒) と携帯用の小さい版。撮影は Playwright と、この機械にもともとある仕組みで mp4 を作る自前の道具 (`media/tools/encode.swift`)。ffmpeg は入っていない。
- 携帯 (Remote Control) に送れるのは 1 ファイル 30 MiB まで。携帯用は 28 MB 以下に作る。
- ティーザーには実在のサーキットや運転手に似た名前を映さない。

---

## 3. これまでの手伝い (全部)

日付はどれも 11/25〜11/26。番号は大まかな順。

| # | 作った物 | 主なファイル | 残した注意 |
|---|---|---|---|
| 1 | ピット・タイヤ 5 種・天気と予報・水たまり | `shared/src/tires.ts` `weather.ts` `pit.ts` | 数は仮 |
| 2 | コースづくりの画面 (はじめは取っておいて最後につないだ) | `shared/src/trackcheck.ts` `web/src/ui/editor.ts` `usertracks.ts` | |
| 3 | はじめの画面と車づくりを F1 中継風に | `web/src/style.css` `ui/menu.ts` `ui/builder.ts` `draw.ts` | |
| 4 | NPC を強く・傷み・DRS・風よけ・旗と SC/VSC | `shared/src/line.ts` `damage.ts` `drs.ts` `racecontrol.ts` | 強い当たりは黄旗だけ |
| 5 | ログイン・持ち物・お店・賞金 | `server/src/accounts*.ts` `api.ts` `crypto.ts` `web/src/ui/account.ts` `shop.ts` | パスワードは PBKDF2 |
| 6 | チーム・運転手・研究・市場の計算 | `shared/src/team.ts` `drivers.ts` `research.ts` `market.ts` `rivals.ts` `econ.ts` | |
| 7 | 季節・級・大会・リーグ戦の計算 | `shared/src/season.ts` `league.ts` `tournament.ts` `scheduled.ts` `stamps.ts` `notify.ts` `adminconfig.ts` | |
| 8 | レースの画面を中継風に・待合・結果・準備の札 | `web/src/race/race.css` `view.ts` `ui/setup.ts` | |
| 9 | 部屋の休止 (WebSocket Hibernation) | `server/src/worker.ts` (`RaceRoomDO`) `shared/src/room.ts` | |
| 10 | 試走台・タイヤの特徴・改訂番号 | `shared/src/bench.ts` `tires.ts` `web/src/ui/builder.ts` `store.ts` | |
| 11 | 持っていくタイヤの組 (予選の持ち越しも) | `shared/src/tireset.ts` | |
| 12 | タイム差と相手のタイヤ・前後の車のカード | `shared/src/timing.ts` | |
| 13 | 無線の作戦係・走った線 | `shared/src/radio.ts` `replay.ts` `web/src/race/radio-ui.ts` `replay-ui.ts` | |
| 14 | 1 周アタック | `shared/src/timeattack.ts` `server/src/timeattack.ts` `web/src/ui/timeattack.ts` | |
| 15 | チームの画面とサーバー (2 台目・研究・市場) | `server/src/team.ts` `web/src/ui/team.ts` `drivers.ts` `research.ts` `market.ts` | |
| 16 | 季節と大会のサーバー・管理者の画面 | `server/src/season.ts` `web/src/ui/season.ts` `tournament.ts` `admin.ts` | |
| 17 | リーグ戦のサーバー (LeagueDO・cron・画面を出さない計算) | `server/src/league*.ts` `shared/src/leaguerace.ts` `web/src/ui/league.ts` | |
| 18 | 試し遊び 1 回目・2 回目 (読むだけ) と、その直し (車の手ざわり・画面・はじめの流れ) | `shared/src/physics.ts` `web/src/race/*` `web/src/ui/*` | |
| 19 | コースづくりの公開・みんなのコース | `server/src/tracks.ts` `web/src/ui/tracks.ts` | |
| 20 | 部屋を開く・2 台のピット待ち・荒らし止めと招く人 | `server/src/rooms.ts` `admin_players.ts` | |
| 21 | 音 (全部プログラムで鳴らす。外の素材なし) | `web/src/audio/*` | 耳でまだ聞いていない |
| 22 | オーバーテイクモード・マニュアルのギア | `shared/src/overtake.ts` `gearbox.ts` | MT は +3% (管理者が変えられる) |
| 23 | ギフトコード (中身の一覧から自動で並ぶ) | `shared/src/gift.ts` `server/src/gift.ts` `web/src/ui/admin_gifts.ts` | コードの文字はデータにだけ置く |
| 24 | 数の調整を使いやすく (説明・記録・戻す) | `shared/src/adminconfig_meta.ts` `server/src/admin_config_log.ts` `web/src/ui/admin_config.ts` | 新しい数には meta が要る (試験で落ちる) |
| 25 | セクター (S1・S2・S3) と、セクターと DRS を見やすく | `shared/src/sectors.ts` `web/src/race/sectors-ui.ts` `trackdraw.ts` | |
| 26 | 実在のサーキット 14 本・足した日からの回し方 | `shared/src/tracks.ts` (`TRACK_ROTATION_FROM`) | 鈴鹿は交われないので形を変えた。名前は公開前に見直す |
| 27 | 曲がりを良くする (3 回) | `shared/src/physics.ts` | 手で走った手ざわりはユーザーの確かめ待ち |
| 28 | 予告動画とティーザー | `media/` (git に入らない) | |
| 29 | 部品の進化・研究の木・限界突破の品 | `shared/src/evolution.ts` `evoparts.ts` `items.ts` `server/src/items.ts` | |
| 30 | 運転手を 80 + 珍しい 6 に・得意 | `shared/src/drivercatalog.ts` | 似た名前は公開前に見直す (亡くなった方を思わせる名前もある) |
| 31 | 賭け (リーグ戦・大会の優勝予想) | `shared/src/betting.ts` `server/src/bets*.ts` `web/src/ui/bets.ts` | ゲームのお金だけ。`realMoneyEnabled` で全部止まる |
| 32 | 大会の景品・毎日の大会・全員参加・予選なしの並び | `shared/src/tourprize.ts` `dailytour.ts` `tourgrid.ts` | |
| 33 | 走行点と交換所 | `shared/src/racepoints.ts` `server/src/racepoints.ts` `web/src/ui/exchange.ts` | |
| 34 | オープニングと最初はログイン | `web/src/ui/opening.ts` `welcome.ts` `version.ts` | |
| 35 | 残りの直し (止めた人・部屋・毎日上がる・ピットの判断・作戦の合図・設計図をサーバーと合わせる・回転計・走る線から乾く) | `shared/src/teamorder.ts` `web/src/designsync.ts` ほか | |
| 36 | 足りなかった音・大会の優勝予想 | `web/src/audio/pitwork.ts` `server/src/bets_tour.ts` | |

今動いている手伝い: 全体の設計書 (`design/OVERVIEW.md`) を書く手伝いだけ (この文書と同じ区切り)。

手元の試し用サーバーに残っている試しのアカウント (本番ではない): `qatmp722753`・`tbt739162`。パスワードが分からず消せなかった。手元の wrangler の保存を消せば消える。

---

## 4. 残りの仕事・次にやること

- 手で走った手ざわりの確かめ (曲がり・かんたん操作)。ジェッダでかんたん操作の試しの運転が 1 回 壁に軽く触れる。
- 音を耳で聞いて直す。iPhone の実機で全体を確かめる (まだ誰も確かめていない)。
- 本番でリーグ戦が走り始めたら、`wrangler tail` で alarm 1 回の計算時間 (cpuTime) を見て記録する (近ければ 1 レースを分ける)。
- 2 台目が実際に出るレースでの作戦の合図、ログインした状態のオープニング、管理者の画面のお知らせの欄を、ブラウザで通して見る。
- 練習の賞金 (サーバーが確かめたときだけ) はまだ。
- 「進化の割引」の品はまだ (交換所はお金の引換券で代わり)。
- タイヤの温まりのしくみはない (「温まり早い」の特徴は入れていない)。

### ユーザーに聞くこと
- 実在のサーキットと運転手に似た名前を、公開を広げる前にどうするか。
- 公開リポジトリへの自動の写し (本人の直接の了承)。
- 無料の枠を超えそうなときの有料の枠。
- 本物のお金 (課金) を入れるか。入れるなら賭けの機能を見直す (法律の確かめ)。

---

## 5. これまでの記録

| 日時 | 大きな区切り | 本番の版 |
|---|---|---|
| 11/25 夕 | 最初の版 (走る + 車づくり)・F1 中継風・ピットとタイヤと天気・旗と DRS・ログイン | — |
| 11/25 19:5x | 初めて本番に置いた (1〜6 番目の塊まで) | 2c3b1271 → f7bfd7a7 |
| 11/25 20〜21 時 | 試し遊びの直し・ギフトコード・数の調整・セクター・実在のサーキット | 931187d7 → 7c3855cf → 837cc788 → 246e7f3b → e4196e0a |
| 11/25 21〜22 時 | 曲がり (3 回)・セクターと DRS を見やすく | 0bfa02c6 → 296a42ee → 1d3373c8 |
| 11/25 22 時台 | 部品の進化・運転手・賭け・大会の景品・毎日の大会・走行点 | f2832dc8 → 658bf9ac → 277e5f98 |
| 11/25 23 時台 | オープニング・最初はログイン・音・大会の賭け・残りの直し | 331dd666 |

git の記録は `git log` (最初は fc5bd65)。
