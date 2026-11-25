#!/usr/bin/env bash
# Blueprint Racing を本番 (Cloudflare) に置く。
# 作業中のファイルが混ざらないよう、git に記録した HEAD の写しで 型 → 試験 → web を組み立てる → すぐ wrangler deploy。
# (組み立てと deploy の間にほかの組み立てを挟まない)
# 置き先は server/wrangler.toml の account_id。wrangler login / logout はしない (ログインはユーザー本人だけ)。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ACCOUNT=$(sed -n 's/^account_id = "\(.*\)"/\1/p' server/wrangler.toml)
echo "== 置き先のアカウント: $ACCOUNT"
if ! (cd server && npx wrangler whoami 2>&1) | grep -q "$ACCOUNT"; then
  echo "wrangler のログインが置き先のアカウントではありません。止めます (ログインはユーザーが直す)" >&2
  exit 1
fi

REV=$(git rev-parse --short HEAD)
WORK="${TMPDIR:-/tmp}/bpr-deploy-$REV"
echo "== HEAD ($REV) の写しを $WORK に"
rm -rf "$WORK" && mkdir -p "$WORK"
git archive HEAD | tar -x -C "$WORK"
cd "$WORK"
npm ci --no-audit --no-fund --loglevel=error

echo "== 型"
npm run -s typecheck
echo "== 試験"
npx vitest run
echo "== web を組み立てる → すぐ置く"
npm run -s build
cd server
npx wrangler deploy
