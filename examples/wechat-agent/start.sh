#!/bin/bash
# wechat-agent 启动/停止/状态
# 用法:
#   bash ~/wechat-agent/start.sh          前台启动
#   bash ~/wechat-agent/start.sh --bg     后台启动
#   bash ~/wechat-agent/start.sh stop     停止
#   bash ~/wechat-agent/start.sh status   查看状态
DIR="$(cd "$(dirname "$0")" && pwd)"
LOGDIR="$HOME/.openclaw/wechat-agent/logs"
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
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    PID=$(cat "$PIDFILE")
    UPTIME=$(ps -o etime= -p "$PID" 2>/dev/null | xargs)
    echo "[status] 运行中 (PID=$PID, 已运行 $UPTIME)"
    echo "[status] 日志: $LOG"
    echo "[status] 最近日志:"
    tail -5 "$LOG" 2>/dev/null
  else
    echo "[status] 未运行"
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

  # build +1
  BUILD_FILE="$DIR/.build"
  PREV=$(cat "$BUILD_FILE" 2>/dev/null || echo 0)
  NEXT=$((PREV + 1))
  echo "$NEXT" > "$BUILD_FILE"
  echo "[start] build $PREV → $NEXT"

  # 启动 weixin-acp
  npx weixin-acp start -- node "$DIR/agent.mjs" >>"$LOG" 2>&1 &
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
