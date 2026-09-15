#!/bin/bash
# test/run-mobile.sh —— 只跑手机端那套（本地迭代用；正式跑用 run-e2e.sh）
#
#   bash test/run-mobile.sh        复制副本 → 起服务 → 起无头 Edge → 跑 test/mobile.mjs → 收摊
#   KEEP=1 bash test/run-mobile.sh 跑完不收摊（方便自己开页面看）

set -e
cd "$(dirname "$0")/.."
APP_DIR=$(pwd)
ROOT=$(cd .. && pwd)
RUN="$APP_DIR/.e2e-runtime"
PORT=${NOTEBOOK_PORT:-4199}
CDP=${CDP_PORT:-9333}
KEEP=${KEEP:-0}
EDGE="${EDGE_BIN:-/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge}"
HEADLESS="${HEADLESS_MODE:-new}"

kill_port() { lsof -ti "tcp:$1" 2>/dev/null | xargs -r kill 2>/dev/null || true; }
kill_browser() {
  # 上一轮要是没退干净，旧进程会占着调试端口和 profile 目录，
  # 新浏览器拿不到 profile 锁就直接退出（表现是「浏览器没起来」，很难查）。
  # 所以：先 TERM，等端口真的空出来，还不走就 KILL。
  pkill -f "remote-debugging-port=$CDP" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    lsof -ti "tcp:$CDP" >/dev/null 2>&1 || return 0
    sleep 0.4
  done
  pkill -9 -f "remote-debugging-port=$CDP" 2>/dev/null || true
  sleep 0.6
}
kill_port "$PORT"
kill_browser

cleanup() {
  if [ "$KEEP" != "1" ]; then
    kill_port "$PORT"
    kill_browser
    rm -rf "$RUN/edge" "$RUN/vault" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "▸ 准备副本 $RUN/vault"
rm -rf "$RUN/vault" "$RUN/app" "$RUN/shots" "$RUN/edge"
mkdir -p "$RUN/vault" "$RUN/app" "$RUN/shots"
# 配置也复制一份进副本：不然测试里拨「手机访问」开关会改掉你真在用的 config.json
cp config.json "$RUN/app/config.json"
rsync -a --exclude '.git' --exclude '.obsidian' --exclude '_py_deps' --exclude 'picture' \
  --exclude 'study-app' --exclude '.e2e-runtime' "$ROOT/" "$RUN/vault/"

echo "▸ 起服务 :${PORT}（指向副本）"
VAULT_DIR="$RUN/vault" \
BACKUP_DIR="$RUN/app/backups" \
UPLOAD_DIR="$RUN/app/uploads" \
EXPORT_DIR="$RUN/app/data" \
NOTEBOOK_PORT="$PORT" \
MAIMEMO_OFF=1 \
TEST_DIR="$RUN/vault/今日测试" \
AI_CONFIG_FILE="$RUN/app/ai-config.json" \
NOTEBOOK_CONFIG="$RUN/app/config.json" \
RELAUNCH_LOG="$RUN/server.log" \
  env -u AI_BASE_URL -u AI_MODEL -u AI_API_KEY \
  node server.mjs --no-open > "$RUN/server.log" 2>&1 &
disown $! 2>/dev/null || true
for _ in $(seq 1 20); do
  curl -s -m 1 "http://127.0.0.1:$PORT/api/health" > /dev/null && break
  sleep 0.5
done
curl -s -m 2 "http://127.0.0.1:$PORT/api/health" | grep -q '"ok":true' || {
  echo "✗ 服务没起来，看 $RUN/server.log"; exit 1; }

echo "▸ 起无头 Edge"
"$EDGE" "--headless=$HEADLESS" --disable-gpu --no-sandbox \
  --no-first-run --no-default-browser-check --disable-extensions \
  --disable-background-networking --disable-sync --disable-component-update \
  --remote-allow-origins='*' \
  --remote-debugging-port="$CDP" --user-data-dir="$RUN/edge" \
  --window-size=1500,1150 "http://127.0.0.1:$PORT/" > "$RUN/edge.log" 2>&1 &
disown $! 2>/dev/null || true
for _ in $(seq 1 30); do
  curl -s -m 1 "http://127.0.0.1:$CDP/json/version" > /dev/null && break
  sleep 0.5
done
curl -s -m 2 "http://127.0.0.1:$CDP/json/version" > /dev/null || {
  echo "✗ 浏览器没起来，看 $RUN/edge.log"; exit 1; }

echo "▸ 跑手机端断言"
set +e
APP_URL="http://127.0.0.1:$PORT" CDP_PORT="$CDP" SHOT_DIR="$RUN/shots" E2E_VAULT="$RUN/vault" \
  node test/mobile.mjs
CODE=$?
set -e
echo "▸ 截图在 $RUN/shots"
exit $CODE
