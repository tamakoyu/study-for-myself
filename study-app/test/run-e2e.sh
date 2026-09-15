#!/bin/bash
# test/run-e2e.sh —— 起「副本 + 真代码」跑一遍端到端测试
#
#   bash test/run-e2e.sh         起服务 + 无头 Edge + 跑断言，跑完自动收摊
#   ONLY=desktop bash test/run-e2e.sh   只跑桌面端（手机端会把页面导航到 /m，排查时分开跑更省事）
#   ONLY=mobile  bash test/run-e2e.sh   只跑手机端
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
ONLY=${ONLY:-all}
EDGE="${EDGE_BIN:-/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge}"
# Edge/Chromium 132 起删掉了 --headless=old，再传它会被忽略 → 弹出真窗口（就是「闪退」的由来）。
# 现在统一用 --headless=new；想换浏览器用 EDGE_BIN=... 覆盖。
HEADLESS="${HEADLESS_MODE:-new}"

kill_port() { lsof -ti "tcp:$1" 2>/dev/null | xargs -r kill 2>/dev/null || true; }
kill_port "$PORT"
pkill -f "remote-debugging-port=$CDP" 2>/dev/null || true
sleep 0.5

# 端口必须真的让出来，否则这一轮会**连上一个没退干净的旧进程**：
# 旧浏览器停在上一轮跑完的页面（比如手机端 /m），桌面端断言就会找不到元素，
# 报出来的又是「等不到 .plan-link」这种指不到真正原因的错误 ——
# 之前那种「同样代码一轮红一轮绿」有一半就是这么来的。宁可直接停在这里。
for p in "$PORT" "$CDP"; do
  left=$(lsof -ti "tcp:$p" 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')
  if [ -n "$left" ]; then
    echo "✗ 端口 $p 还被占用（pid: $left）—— 上一轮的服务 / 浏览器没退干净。"
    echo "  先清掉再来：lsof -ti tcp:$p | xargs kill"
    exit 1
  fi
done

cleanup() {
  if [ "$KEEP" != "1" ]; then
    kill_port "$PORT"
    pkill -f "remote-debugging-port=$CDP" 2>/dev/null || true
    # 给进程一点时间退出再删 profile，不然 Edge 还在写，rm 会以 ENOTEMPTY 收场，
    # 临时目录（和浏览器）就留在那儿，污染下一轮
    sleep 1
    # Edge 的临时 profile 有几百 MB，跑完就删；截图和日志留着
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

echo "▸ 起服务 :$PORT（指向副本）"
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
BROWSER_OK=0
for _ in $(seq 1 30); do
  if curl -s -m 1 "http://127.0.0.1:$CDP/json/version" > /dev/null; then BROWSER_OK=1; break; fi
  sleep 0.5
done
if [ "$BROWSER_OK" != "1" ]; then
  echo "✗ 浏览器没起来（CDP 端口 $CDP 连不上）。"
  echo "  如果刚才看到 Edge 窗口闪了一下，说明 headless 没生效 —— 换一种模式再试："
  echo "     HEADLESS_MODE=new bash test/run-e2e.sh"
  echo "  日志：$RUN/edge.log"
  pkill -f "remote-debugging-port=$CDP" 2>/dev/null || true
  exit 1
fi

echo "▸ 跑单元测试（纯函数，不联外网）"
set +e
node test/units.mjs
UNIT=$?
set -e
[ "$UNIT" = "0" ] || { echo "✗ 单元测试没过，先修函数再来跑端到端"; exit 1; }

echo "▸ 跑内置 AI 集成测试（起一个假模型服务，不需要真 key）"
set +e
node test/ai.mjs
AITEST=$?
set -e
[ "$AITEST" = "0" ] || { echo "✗ 内置 AI 测试没过"; exit 1; }

echo "▸ 跑断言（桌面端）"
set +e
if [ "$ONLY" = "mobile" ]; then
  echo "  （ONLY=mobile，跳过）"
  CODE=0
else
  APP_URL="http://127.0.0.1:$PORT" CDP_PORT="$CDP" SHOT_DIR="$RUN/shots" E2E_VAULT="$RUN/vault" node test/e2e.mjs
  CODE=$?
  # 「有几条断言没过」（会打印 === 结果：N/M 通过 ===）和「脚本自己崩了」不是一回事：
  # 崩了的话根本不会有汇总行，而只看有没有 ❌ 会把它误判成「全绿」。
  if [ "$CODE" != "0" ]; then
    echo "  ⚠ 桌面端这轮退出码 $CODE —— 没有汇总行就是**中途崩了**，上面的 ❌ 列表未必是全貌"
  fi
fi
set -e

# 手机端（/m）：同一个浏览器，把窗口调成 390×844 再走一遍。
# 放在桌面端**后面** —— 它最后会把页面导航到 /m，跑完再回到桌面端收个尾。
echo "▸ 跑断言（手机端 /m）"
set +e
if [ "$ONLY" = "desktop" ]; then
  echo "  （ONLY=desktop，跳过）"
else
  APP_URL="http://127.0.0.1:$PORT" CDP_PORT="$CDP" SHOT_DIR="$RUN/shots" E2E_VAULT="$RUN/vault" node test/mobile.mjs
  MOBCODE=$?
  [ "$MOBCODE" = "0" ] || CODE=$MOBCODE
fi
set -e

echo "▸ 截图在 $RUN/shots"
exit $CODE
