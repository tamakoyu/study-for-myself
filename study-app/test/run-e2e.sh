#!/bin/bash
# test/run-e2e.sh —— 起「副本 + 真代码」跑一遍端到端测试
#
#   bash test/run-e2e.sh         起服务 + 无头 Edge + 跑断言，跑完自动收摊
#   KEEP=1 bash test/run-e2e.sh  跑完不关服务/浏览器（方便手动看现场）
#
# 绝不碰真笔记：仓库整份复制到 study-app/.e2e-runtime/vault/，
# 服务用 VAULT_DIR 指过去，备份 / 上传 / 导出也全部改道到 .e2e-runtime/。
# study-app/ 已经在 Obsidian 的忽略列表里，副本不会出现在库里。

set -e
cd "$(dirname "$0")/.."
APP_DIR=$(pwd)
ROOT=$(cd .. && pwd)
RUN="$APP_DIR/.e2e-runtime"
PORT=${NOTEBOOK_PORT:-4199}
CDP=${CDP_PORT:-9333}
KEEP=${KEEP:-0}
EDGE="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"

kill_port() { lsof -ti "tcp:$1" 2>/dev/null | xargs -r kill 2>/dev/null || true; }
kill_port "$PORT"
pkill -f "remote-debugging-port=$CDP" 2>/dev/null || true
sleep 0.5

cleanup() {
  if [ "$KEEP" != "1" ]; then
    kill_port "$PORT"
    pkill -f "remote-debugging-port=$CDP" 2>/dev/null || true
    # Edge 的临时 profile 有几百 MB，跑完就删；截图和日志留着
    rm -rf "$RUN/edge" "$RUN/vault"
  fi
}
trap cleanup EXIT

echo "▸ 准备副本 $RUN/vault"
rm -rf "$RUN/vault" "$RUN/app" "$RUN/shots" "$RUN/edge"
mkdir -p "$RUN/vault" "$RUN/app" "$RUN/shots"
rsync -a --exclude '.git' --exclude '.obsidian' --exclude '_py_deps' --exclude 'picture' \
  --exclude 'study-app' --exclude '.e2e-runtime' "$ROOT/" "$RUN/vault/"

echo "▸ 起服务 :$PORT（指向副本）"
VAULT_DIR="$RUN/vault" \
BACKUP_DIR="$RUN/app/backups" \
UPLOAD_DIR="$RUN/app/uploads" \
EXPORT_DIR="$RUN/app/data" \
NOTEBOOK_PORT="$PORT" \
  node server.mjs --no-open > "$RUN/server.log" 2>&1 &
disown $! 2>/dev/null || true
for _ in $(seq 1 20); do
  curl -s -m 1 "http://127.0.0.1:$PORT/api/health" > /dev/null && break
  sleep 0.5
done
curl -s -m 2 "http://127.0.0.1:$PORT/api/health" | grep -q '"ok":true' || {
  echo "✗ 服务没起来，看 $RUN/server.log"; exit 1; }

echo "▸ 起无头 Edge"
"$EDGE" --headless=old --disable-gpu --no-sandbox --remote-allow-origins='*' \
  --remote-debugging-port="$CDP" --user-data-dir="$RUN/edge" \
  --window-size=1500,1150 "http://127.0.0.1:$PORT/" > "$RUN/edge.log" 2>&1 &
disown $! 2>/dev/null || true
for _ in $(seq 1 20); do
  curl -s -m 1 "http://127.0.0.1:$CDP/json/version" > /dev/null && break
  sleep 0.5
done

echo "▸ 跑断言"
set +e
APP_URL="http://127.0.0.1:$PORT" CDP_PORT="$CDP" SHOT_DIR="$RUN/shots" node test/e2e.mjs
CODE=$?
set -e
echo "▸ 截图在 $RUN/shots"
exit $CODE
