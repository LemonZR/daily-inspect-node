#!/usr/bin/env bash
# ============================================================================
#  一键安装依赖（Linux / macOS）
#  用法: chmod +x install.sh && ./install.sh
#  作用: 安装 Python 3 截图依赖 (pyte/wcwidth/Pillow)，校验可导入。
#  Node 中心端零 npm 依赖，只需系统已装 Node 14+（推荐 18）。
# ============================================================================
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"
echo "程序目录: $(pwd)"
echo "============================================"
echo "  每日巡检留证中心 - 依赖安装 (Linux/macOS)"
echo "============================================"

# ---- 1. 选 Python 3（python 可能是 2.x，一律跳过）----
PY=""
for c in python3 python3.13 python3.12 python3.11 python3.10 python3.9 python3.8; do
  if command -v "$c" >/dev/null 2>&1; then
    if "$c" -c 'import sys; sys.exit(0 if sys.version_info[0]==3 else 1)' 2>/dev/null; then PY="$c"; break; fi
  fi
done
if [ -z "$PY" ]; then
  echo "[错误] 未找到 Python 3。请先安装 Python 3 后重试（apt/yum/dnf/brew 均可）。"
  exit 1
fi
PYBIN="$("$PY" -c 'import sys; print(sys.executable)')"
echo "Python : $PYBIN ($($PY --version 2>&1))"

# ---- 2. Node 检查（中心端零依赖，只需解释器）----
if command -v node >/dev/null 2>&1; then
  echo "Node   : $(node -v) ($(command -v node))"
else
  echo "[警告] 未找到 node。请安装 Node 14+（推荐 18.16.0）后运行 ./start.sh。"
fi

# ---- 3. pip 安装 ----
REQ="$(pwd)/requirements.txt"
if [ ! -f "$REQ" ]; then echo "[错误] 找不到 requirements.txt"; exit 1; fi
echo "依赖清单: $(tr '\n' ' ' < "$REQ")"

if ! "$PY" -m pip --version >/dev/null 2>&1; then
  echo "[提示] pip 不可用，尝试 ensurepip 引导..."
  "$PY" -m ensurepip --upgrade >/dev/null 2>&1 || true
fi
if ! "$PY" -m pip --version >/dev/null 2>&1; then
  echo "[错误] 当前 Python 没有可用的 pip，请先安装 pip（如 apt install python3-pip）后重试。"
  exit 1
fi

PIP_ARGS=(install -r requirements.txt)
# Debian 12 / Ubuntu 22.04+ 的 PEP 668 会拒绝直接装到系统环境
if "$PY" -c 'import sysconfig,os; sys.exit(0 if os.path.exists(os.path.join(sysconfig.get_path("stdlib"),"EXTERNALLY-MANAGED")) else 1)' 2>/dev/null; then
  echo "[提示] 检测到 PEP 668 外部管理环境，自动追加 --break-system-packages。"
  echo "        若希望隔离安装，可先 python3 -m venv .venv 并 source .venv/bin/activate 后重跑。"
  PIP_ARGS+=(--break-system-packages)
fi
echo "执行: $PY -m pip ${PIP_ARGS[*]}"
"$PY" -m pip "${PIP_ARGS[@]}"

# ---- 4. 校验 ----
echo ""
if "$PY" -c "import pyte, wcwidth, PIL; print('IMPORT_OK  pyte / wcwidth / Pillow', PIL.__version__)"; then
  echo ""
  echo "============================================"
  echo "  安装完成"
  echo "  启动服务:  ./start.sh"
  echo "  浏览器访问: http://localhost:8082"
  echo "  首次启动会生成 config/config.json 与随机登录口令"
  echo "  （见 config/INITIAL_PASSWORD.txt，改密后删除该文件）。"
  echo "============================================"
else
  echo "[错误] 依赖导入失败。请确认安装和校验用的是同一个 Python 解释器。"
  exit 1
fi
