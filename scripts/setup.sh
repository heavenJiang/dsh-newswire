#!/usr/bin/env bash
# 见微知著 · 抓取依赖一键安装（macOS / Linux）
#
#   curl -fsSL https://raw.githubusercontent.com/heavenJiang/dsh-newswire/main/scripts/setup.sh | bash
#   bash scripts/setup.sh [--yes] [--check] [--skip-browse] [--skip-agent-reach] [--skip-mcporter]
#
# 装三样东西，都装在你的用户目录，不需要 sudo：
#   browse       主力通道：通过你已登录的 Chrome 抓取（财联社等站点只能走它）。必需。
#                Anomaly（opencode 团队）出品，https://github.com/anomalyco/browse
#   agent-reach  第二通道：RSS 解析与网页阅读器（美联社、教育部留学服务中心等会用到）。推荐。
#                https://github.com/Panniantong/Agent-Reach
#   mcporter     接入 Exa 搜索：本轮接不上上一轮时按时间段搜回漏掉的新闻。推荐。
#                https://github.com/openclaw/mcporter ；Exa 官方托管 MCP：https://mcp.exa.ai/mcp
# 缺了后两样，插件照常工作，只是对应的源会降级到直接请求。
# 脚本可以重复运行：已装好的会跳过，只检查状态。

set -uo pipefail

YES=0; CHECK=0; SKIP_BROWSE=0; SKIP_AR=0; SKIP_MCP=0
for a in "$@"; do
  case "$a" in
    -y|--yes) YES=1 ;;
    --check) CHECK=1 ;;
    --skip-browse) SKIP_BROWSE=1 ;;
    --skip-agent-reach) SKIP_AR=1 ;;
    --skip-mcporter) SKIP_MCP=1 ;;
    -h|--help) sed -n '2,16p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$a（--help 查看用法）"; exit 2 ;;
  esac
done

AR_VENV="$HOME/.agent-reach-venv"
AR_SRC="https://github.com/Panniantong/Agent-Reach/archive/main.zip"   # 不要用 PyPI 上的同名包，那不是同一个项目
EXA_URL="https://mcp.exa.ai/mcp"

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'; else B=; G=; Y=; R=; D=; N=; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s%s%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$R" "$N" "$*"; }
has()  { command -v "$1" >/dev/null 2>&1; }

# 通过 curl | bash 运行时 stdin 是脚本本身，交互要从终端读
TTY=""
if [ -r /dev/tty ] && [ -w /dev/tty ] && { : </dev/tty; } 2>/dev/null; then TTY=/dev/tty; fi

ask() { # ask "问题" 默认(Y/N)
  local q="$1" def="${2:-Y}" ans
  if [ "$YES" = 1 ]; then return 0; fi
  if [ "$CHECK" = 1 ]; then return 1; fi
  if [ -z "$TTY" ]; then [ "$def" = Y ]; return; fi
  printf '  %s [%s] ' "$q" "$([ "$def" = Y ] && echo Y/n || echo y/N)" >"$TTY"
  read -r ans <"$TTY" || ans=""
  ans="${ans:-$def}"
  case "$ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

# 找到用户目录里装好但还没进 PATH 的命令
for d in "$HOME/.npm-global/bin" "$HOME/.local/bin" "$AR_VENV/bin" "/opt/homebrew/bin" "/usr/local/bin"; do
  case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$PATH:$d" ;; esac
done
export PATH

npm_global() { # npm install -g，全局目录没有写权限时改装到 ~/.npm-global
  local pkg="$1" prefix
  prefix="$(npm prefix -g 2>/dev/null)"
  if [ -n "$prefix" ] && [ ! -w "$prefix/lib" ] && [ ! -w "$prefix" ]; then
    warn "npm 全局目录 $prefix 没有写权限，改装到 ~/.npm-global"
    mkdir -p "$HOME/.npm-global"
    npm install -g --prefix "$HOME/.npm-global" "$pkg" || return 1
    PATH="$HOME/.npm-global/bin:$PATH"
    PATH_HINT_DIR="$HOME/.npm-global/bin"
  else
    npm install -g "$pkg" || return 1
    case ":$PATH:" in *":$prefix/bin:"*) ;; *) PATH="$prefix/bin:$PATH"; PATH_HINT_DIR="$prefix/bin" ;; esac
  fi
}
PATH_HINT_DIR=""

say "${B}见微知著 · 抓取依赖安装${N}"
[ "$CHECK" = 1 ] && say "${D}只检查，不安装${N}"

# ---------------------------------------------------------------- Node.js
step "1/4 Node.js"
NODE_OK=0
if has node; then
  NV="$(node -p 'process.versions.node' 2>/dev/null)"
  if node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>=24||(a===22&&b>=19)?0:1)'; then
    ok "Node.js $NV"; NODE_OK=1
  else
    bad "Node.js $NV 太旧：需要 22.19 以上或 24 以上（插件用内置的 node:sqlite）"
  fi
else
  bad "没有 Node.js：先装 22.19 以上或 24 以上（https://nodejs.org 或 brew install node）"
fi
if [ "$NODE_OK" = 0 ]; then say ""; say "装好 Node.js 后再运行本脚本。"; exit 1; fi

# ---------------------------------------------------------------- browse
step "2/4 browse（主力通道，必需）"
BROWSE_OK=0
if [ "$SKIP_BROWSE" = 1 ]; then
  warn "已跳过"
else
  if ! has browse; then
    if ask "没有 browse，现在用 npm 安装 @opencode/browse？" Y; then
      npm_global @opencode/browse && ok "已安装 browse $(browse --version 2>/dev/null)" || bad "browse 安装失败，见上面 npm 的输出"
    else
      bad "没有 browse：npm install -g @opencode/browse"
    fi
  else
    ok "browse $(browse --version 2>/dev/null)"
  fi
  if has browse; then
    st="$(browse status --json 2>/dev/null)"
    if printf '%s' "$st" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s.slice(s.indexOf("{")));process.exit(j.relay&&j.relay.running&&j.extension&&j.extension.connected&&(j.extension.browsers||[]).length?0:1)}catch{process.exit(1)}})'; then
      ok "Chrome 扩展已连接"; BROWSE_OK=1
    else
      warn "Chrome 还没连上 browse：需要在 Chrome 里装 browse 扩展并配对一次"
      if [ -n "$TTY" ] && ask "现在运行 browse install（会打开扩展页面，按提示添加并配对）？" Y; then
        browse install <"$TTY" >"$TTY" 2>&1 || true
        st="$(browse status --json 2>/dev/null)"
        printf '%s' "$st" | grep -q '"connected": *true' && { ok "Chrome 扩展已连接"; BROWSE_OK=1; } || warn "还没连上：稍后运行 browse install 完成配对"
      else
        say "    稍后在终端运行：${B}browse install${N}"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------- agent-reach
step "3/4 agent-reach（第二通道，推荐）"
AR_OK=0
if [ "$SKIP_AR" = 1 ]; then
  warn "已跳过"
elif has agent-reach; then
  ok "agent-reach $(agent-reach --version 2>/dev/null | tail -1)"; AR_OK=1
else
  PY=""
  for p in python3.13 python3.12 python3.11 python3.10 python3; do
    if has "$p" && "$p" -c 'import sys,venv;sys.exit(0 if sys.version_info>=(3,10) else 1)' 2>/dev/null; then PY="$p"; break; fi
  done
  if [ -z "$PY" ]; then
    bad "需要 Python 3.10 以上才能装 agent-reach（brew install python 或系统包管理器）"
  elif ask "安装 agent-reach 到 ~/.agent-reach-venv（独立的 Python 环境，不影响系统）？" Y; then
    if "$PY" -m venv "$AR_VENV" && "$AR_VENV/bin/python" -m pip install -q --upgrade pip && "$AR_VENV/bin/python" -m pip install -q "$AR_SRC"; then
      ok "已安装 agent-reach（$AR_VENV）"; AR_OK=1
    else
      bad "agent-reach 安装失败，见上面 pip 的输出"
    fi
  else
    warn "未安装：相关源会降级到直接请求"
  fi
fi

# ---------------------------------------------------------------- mcporter + Exa
step "4/4 mcporter 与 Exa 搜索（补抓漏掉的新闻，推荐）"
MCP_OK=0; EXA_OK=0
if [ "$SKIP_MCP" = 1 ]; then
  warn "已跳过"
else
  if has mcporter; then
    ok "mcporter $(mcporter --version 2>/dev/null | head -1)"; MCP_OK=1
  elif ask "安装 mcporter（npm 包，用来调用 Exa 搜索）？" Y; then
    npm_global mcporter && { ok "已安装 mcporter"; MCP_OK=1; } || bad "mcporter 安装失败"
  else
    warn "未安装：接不上上一轮时只能靠翻页补抓"
  fi
  if [ "$MCP_OK" = 1 ]; then
    if mcporter config list 2>/dev/null | grep -qE '^exa( |$)'; then
      ok "Exa 已接入"; EXA_OK=1
    elif ask "把 Exa 搜索接入 mcporter（$EXA_URL，官方托管服务，匿名可用、有频率限制）？" Y; then
      mcporter config add exa "$EXA_URL" --scope home >/dev/null 2>&1 && { ok "Exa 已接入"; EXA_OK=1; } || bad "接入失败：可手动运行 mcporter config add exa $EXA_URL --scope home"
    fi
  fi
fi

# ---------------------------------------------------------------- 小结
step "结果"
[ "$BROWSE_OK" = 1 ] && ok "browse：可用" || bad "browse：不可用，大多数源抓不到（必需）"
[ "$AR_OK" = 1 ] && ok "agent-reach：可用" || warn "agent-reach：未装（可选）"
[ "$EXA_OK" = 1 ] && ok "Exa 补抓：可用" || warn "Exa 补抓：未接入（可选）"
if [ -n "$PATH_HINT_DIR" ]; then
  say ""
  warn "命令装在 $PATH_HINT_DIR，它不在你的 PATH 里：插件设置里的 browse / mcporter 路径请填这个目录下的文件，或把目录加进 PATH"
  say "    echo 'export PATH=\"$PATH_HINT_DIR:\$PATH\"' >> ~/.zshrc"
fi
say ""
say "下一步：安装插件并重启 harness"
say "    ${B}dsh plugin --profile web add github:heavenJiang/dsh-newswire${N}"
say "${D}以后随时可以用 --check 重新检查：bash scripts/setup.sh --check${N}"
[ "$BROWSE_OK" = 1 ] || exit 1
