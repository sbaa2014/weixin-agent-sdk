#!/bin/bash
# wechat-agent 启动/停止/状态
# 用法:
#   bash /opt/wechat-agent/start.sh          前台启动
#   bash /opt/wechat-agent/start.sh --bg     后台启动
#   bash /opt/wechat-agent/start.sh stop     停止
#   bash /opt/wechat-agent/start.sh status   查看状态
#
# 程序目录: /opt/wechat-agent (共享，只读)
# 数据目录: ~/.openclaw/wechat-agent (每用户隔离)
DIR="$(cd "$(dirname "$0")" && pwd)"
DATADIR="$HOME/.openclaw/wechat-agent"
LOGDIR="$DATADIR/logs"
LOG="$LOGDIR/bridge.log"
PIDFILE="$LOGDIR/bridge.pid"
mkdir -p "$LOGDIR"

case "${1:-start}" in

stop)
  if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    if kill -0 "$PID" 2>/dev/null; then
      echo "[stop] 正在停止 (PID=$PID)..."
      kill "$PID" 2>/dev/null
      # 等子进程退出
      for i in $(seq 1 10); do
        kill -0 "$PID" 2>/dev/null || break
        sleep 1
      done
      # 还活着就强杀
      kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
      echo "[stop] 已停止"
    else
      echo "[stop] 进程 $PID 已不存在"
    fi
    rm -f "$PIDFILE"
  else
    echo "[stop] 未找到 PID 文件，尝试清理残留进程..."
  fi
  # 兜底清理
  pkill -f "weixin-acp.*wechat-agent" 2>/dev/null
  pkill -f "node.*wechat-agent/agent" 2>/dev/null
  echo "[stop] 完成"
  ;;

status)
  # 版本信息（始终显示）
  BUILD=$(stat -c %Y "$DIR"/*.mjs "$DIR"/*.sh 2>/dev/null | sort -rn | head -1 | xargs -I{} date -d @{} +%m%d-%H%M 2>/dev/null || echo "?")
  VER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DIR/package.json','utf8')).version)" 2>/dev/null || echo "?")
  echo "[status] wechat-agent v${VER} (${BUILD})"

  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    PID=$(cat "$PIDFILE")
    UPTIME=$(ps -o etime= -p "$PID" 2>/dev/null | xargs)
    echo "[status] 状态: 运行中"
    echo "[status] PID: $PID  运行时长: $UPTIME"

    # 资源用量
    MEM=$(ps -o rss= -p "$PID" 2>/dev/null | xargs)
    if [ -n "$MEM" ]; then
      MEM_MB=$((MEM / 1024))
      echo "[status] 内存: ${MEM_MB}MB (bridge)"
    fi
    # agent 子进程
    AGENT_PID=$(pgrep -f "node.*$DIR/agent.mjs" 2>/dev/null | head -1)
    if [ -n "$AGENT_PID" ]; then
      AGENT_MEM=$(ps -o rss= -p "$AGENT_PID" 2>/dev/null | xargs)
      AGENT_MEM_MB=$((AGENT_MEM / 1024))
      echo "[status] Agent: PID=$AGENT_PID 内存=${AGENT_MEM_MB}MB"
    else
      echo "[status] Agent: 未启动 (等待首条消息)"
    fi

    # 日志大小
    BRIDGE_SIZE=$(du -sh "$LOG" 2>/dev/null | cut -f1)
    AGENT_LOG="$LOGDIR/agent.log"
    AGENT_SIZE=$(du -sh "$AGENT_LOG" 2>/dev/null | cut -f1 || echo "0")
    TOTAL_SIZE=$(du -sh "$LOGDIR" 2>/dev/null | cut -f1)
    echo "[status] 日志: bridge=${BRIDGE_SIZE} agent=${AGENT_SIZE} 合计=${TOTAL_SIZE}"

    # 今日统计 (从 agent.log 提取)
    TODAY=$(date +%Y-%m-%d)
    if [ -f "$AGENT_LOG" ]; then
      PROMPTS=$(grep -c "^${TODAY}.*\[INFO\] prompt " "$AGENT_LOG" 2>/dev/null; true)
      TOOLS=$(grep -c "^${TODAY}.*\[INFO\] tool.call " "$AGENT_LOG" 2>/dev/null; true)
      ERRORS=$(grep -c "^${TODAY}.*\[ERR\]" "$AGENT_LOG" 2>/dev/null; true)
      printf "[status] 今日: %s条消息 %s次工具 %s个错误\n" "${PROMPTS:-0}" "${TOOLS:-0}" "${ERRORS:-0}"
    fi

    echo "[status] 日志路径: $LOGDIR/"
    echo "[status] 最近日志:"
    tail -3 "$LOG" 2>/dev/null
  else
    echo "[status] 状态: 未运行"
  fi
  ;;

start|--bg)
  # 检查是否已在运行
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "[start] 已在运行 (PID=$(cat "$PIDFILE"))，先 stop 再启动"
    exit 1
  fi
  rm -f "$PIDFILE"

  set -e

  # 清理超过1天的媒体缓存
  find "/tmp/weixin-agent-$(whoami)/media" -type f -mtime +1 -delete 2>/dev/null || true

  BUILD=$(stat -c %Y "$DIR"/*.mjs "$DIR"/*.sh 2>/dev/null | sort -rn | head -1 | xargs -I{} date -d @{} +%m%d-%H%M 2>/dev/null || echo "?")
  echo "[start] ${BUILD}"

  # 启动 weixin-acp（在 home 目录下运行，避免权限问题）
  cd "$HOME"
  LOCAL_ACP="$DIR/../../packages/weixin-acp/dist/main.mjs"
  if [ -f "$LOCAL_ACP" ]; then
    echo "[start] 使用本地 weixin-acp: $LOCAL_ACP"
    node "$LOCAL_ACP" start -- node "$DIR/agent.mjs" >>"$LOG" 2>&1 &
  else
    npx weixin-acp start -- node "$DIR/agent.mjs" >>"$LOG" 2>&1 &
  fi
  BRIDGE_PID=$!
  echo "$BRIDGE_PID" > "$PIDFILE"

  # 等 "monitor started" (最多 60 秒)
  echo "[start] 等待 weixin-acp 启动 (PID=$BRIDGE_PID)..."
  STARTED=0
  for i in $(seq 1 60); do
    if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
      echo "[start] 进程意外退出"
      rm -f "$PIDFILE"
      exit 1
    fi
    if tail -20 "$LOG" 2>/dev/null | grep -q "monitor started"; then
      STARTED=1
      break
    fi
    sleep 1
  done

  if [ "$STARTED" = "0" ]; then
    echo "[start] 启动超时，查看日志: $LOG"
    exit 1
  fi

  echo "[start] weixin-acp 已连接，发送重启通知..."
  node "$DIR/notify-restart.mjs" 2>&1

  # 前台 or 后台
  if [ "$1" = "--bg" ]; then
    disown $BRIDGE_PID
    echo "[start] 后台运行中 (PID=$BRIDGE_PID)"
    echo "[start] 日志: $LOG"
    echo "[start] 停止: bash $DIR/start.sh stop"
  else
    echo "[start] 前台运行中，Ctrl+C 停止"
    wait $BRIDGE_PID
  fi
  ;;

*)
  echo "用法: bash $0 [start|--bg|stop|status]"
  ;;

esac
