#!/bin/bash
# 双击本文件即可启动错题本程序。
# 首次使用若提示「无法打开」，在终端执行：chmod +x "$(dirname "$0")/启动错题本.command"

cd "$(dirname "$0")" || exit 1

# Finder 启动时 PATH 很窄，手动补上 node 常见位置
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  ✗ 没找到 node。"
  echo "    请先安装 Node.js（https://nodejs.org），然后重新双击本文件。"
  echo ""
  read -r -p "  按回车关闭…" _
  exit 1
fi

echo ""
echo "  正在启动高数错题本…"
node server.mjs
STATUS=$?

echo ""
echo "  服务已退出（状态码 $STATUS）。"
read -r -p "  按回车关闭窗口…" _
