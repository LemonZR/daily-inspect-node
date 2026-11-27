#!/usr/bin/env bash
# ============================================================================
#  每日巡检留证中心 - Linux/macOS 启动脚本
#  可在任意目录执行，自动切换到程序所在目录后启动。
#  前提：已装 Node 14+（推荐 18.16.0）；截图依赖见 install.sh。
# ============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  每日巡检留证中心 (Linux/macOS)"
echo "  程序目录: $SCRIPT_DIR"
echo "============================================"

NODE_BIN=""
NODE_VER=""
try_node() {
  n="$1"
  [ -f "$n" ] || return 1
  if NODE_VER="$("$n" -v 2>&1)"; then NODE_BIN="$n"; return 0; fi
  return 1
}
if command -v node >/dev/null 2>&1; then try_node "$(command -v node)" || true; fi
if [ -z "$NODE_BIN" ] && [ -x /usr/local/bin/node ]; then try_node /usr/local/bin/node || true; fi

if [ -z "$NODE_BIN" ]; then
  echo "[错误] 没有可用的 node。请安装 Node 14+（推荐 18.16.0）并确保在 PATH 中。"
  echo "  查看版本: node -v"
  exit 1
fi
echo "Node: $NODE_VER ($NODE_BIN)"

echo "服务启动后, 浏览器访问: http://localhost:8082（端口被占用会自动顺延）"
echo "按 Ctrl+C 停止服务。"
echo ""
exec "$NODE_BIN" server.js
