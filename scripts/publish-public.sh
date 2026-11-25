#!/bin/bash
# 公開リポジトリ (kaiyamashitacom-bot/blueprint-racing-public) に、今の HEAD の中身を写して push する。
# - 履歴は持っていかない (元の記録の書き手・この Mac の名前を出さないため)。公開側は 1 回の写しごとに 1 つの記録
# - 個人のメールアドレスとこの Mac のフォルダの場所を消してから送る
# - 記録 (commit) されていない作りかけは送らない。HEAD の写しだけ
# 使い方: main に commit して origin に push したあと、毎回 `bash scripts/publish-public.sh`
# ユーザーの了承: 11/25「앞으로 모든 소스코드는 해당 레포에 알아서 커밋푸시 하도록 자동화해」
set -euo pipefail

PUBLIC_URL="https://github.com/kaiyamashitacom-bot/blueprint-racing-public.git"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
SUBJECT="$(git -C "$ROOT" log -1 --format=%s | perl -CS -pe 's/^(.{0,100}).*/$1/')" # 文字の途中で切らない
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. 公開側を取ってくる
git clone -q "$PUBLIC_URL" "$WORK/pub"
cd "$WORK/pub"
if git log -1 --format=%B 2>/dev/null | grep -q "元の記録 $SHA"; then
  echo "公開リポジトリはもう $SHA の写しです。送る物はありません"
  exit 0
fi

# 2. 中身を HEAD の写しに入れかえる (.git だけ残す)
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git -C "$ROOT" archive --format=tar HEAD | tar -x -C .

# 3. 個人の情報を消す
# 消す文字と置きかえる文字は、git に入れない scripts/publish-private-patterns.txt に置く
# (1 行に「消す文字<TAB>置きかえる文字」。上から順に、文字どおりに置きかえる)。
# このスクリプト自身にも公開側にも、個人の情報の文字そのものが出ないようにするため。
PATTERNS="$ROOT/scripts/publish-private-patterns.txt"
if [ ! -f "$PATTERNS" ]; then
  echo "$PATTERNS がありません (git に入れない置きかえの表)。この Mac で作ってから打ってください" >&2
  exit 1
fi
while IFS=$'\t' read -r from to; do
  [ -z "$from" ] && continue
  case "$from" in \#*) continue ;; esac
  grep -rlIF --exclude-dir=.git -- "$from" . | while read -r f; do
    FROM="$from" TO="$to" perl -0pi -e 's/\Q$ENV{FROM}\E/$ENV{TO}/g' "$f"
  done || true # 見つからない時の grep の 1 で止めない
done < "$PATTERNS"
LEFT=0
while IFS=$'\t' read -r from to; do
  [ -z "$from" ] && continue
  case "$from" in \#*) continue ;; esac
  if grep -rnIF --exclude-dir=.git -- "$from" .; then LEFT=1; fi
done < "$PATTERNS"
# 置きかえの表に無い物も、よくある形は止める (この Mac のホームの場所・個人のメール)
if grep -rnIE -e "/Users/[A-Za-z0-9._-]+/" -e "[A-Za-z0-9._%+-]+@(gmail|yahoo|icloud|outlook|hotmail)\.[a-z.]+" . --exclude-dir=.git; then LEFT=1; fi
if [ "$LEFT" = 1 ]; then
  echo "個人の情報が残っているので送りません。上の行を直してください" >&2
  exit 1
fi

# 4. 記録して送る
git add -A
if git diff --cached --quiet; then
  echo "中身に変わりがありません"
  exit 0
fi
ID="$(gh api user -q .id)"
git -c user.name=kaiyamashitacom-bot -c user.email="$ID+kaiyamashitacom-bot@users.noreply.github.com" \
  commit -q -m "$SUBJECT" -m "元の記録 $SHA の写し" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q origin main
echo "公開リポジトリに送りました: $(git rev-parse --short HEAD) (元の記録 $SHA)"
