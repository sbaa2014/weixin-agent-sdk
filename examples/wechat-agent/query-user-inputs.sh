#!/usr/bin/env bash
# Query recent WeChat user inputs and bot replies from the systemd journal and
# Codex sessions.
#
# Usage:
#   bash query-user-inputs.sh <wechat-user-id|1|2|3|4> [days]
#   bash query-user-inputs.sh --list
#   bash query-user-inputs.sh 1 7 --output user-1-session.log
#
# Examples:
#   bash query-user-inputs.sh 'o9cq80_...@im.wechat'
#   bash query-user-inputs.sh 'o9cq80_...@im.wechat' 7

set -euo pipefail

UNIT_NAME="${WECHAT_SYSTEMD_UNIT:-wechat-agent-claude3.service}"
CODEX_ROOT="${CODEX_HOME:-${HOME}/.codex}"
SESSION_ROOT="${CODEX_ROOT}/sessions"
ACCOUNT_ROOT="${HOME}/.openclaw/openclaw-weixin"
ACCOUNT_INDEX_FILE="${ACCOUNT_ROOT}/accounts.json"
TARGET_SELECTOR=""
DAYS_BACK="3"
OUTPUT_FILE=""

usage() {
  echo "用法: $0 <微信用户ID|1|2|3|4> [最近几天] [--output 文件]" >&2
  echo "       $0 --list" >&2
  exit 2
}

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --list|-l)
      if [[ ! -f "$ACCOUNT_INDEX_FILE" ]]; then
        echo "错误: 找不到账号索引: $ACCOUNT_INDEX_FILE" >&2
        exit 1
      fi
      mapfile -t account_ids < <(jq -r '.[]' "$ACCOUNT_INDEX_FILE")
      for i in "${!account_ids[@]}"; do
        account_file="$ACCOUNT_ROOT/accounts/${account_ids[$i]}.json"
        user_id="$(jq -r '.userId // "(未记录)"' "$account_file" 2>/dev/null || echo '(未记录)')"
        printf '%d  %s  %s\n' "$((i + 1))" "${account_ids[$i]}" "$user_id"
      done
      exit 0
      ;;
    --output|-o)
      [[ $# -ge 2 ]] || usage
      OUTPUT_FILE="$2"
      shift 2
      ;;
    --)
      shift
      POSITIONAL+=("$@")
      break
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

TARGET_SELECTOR="${POSITIONAL[0]:-}"
DAYS_BACK="${POSITIONAL[1]:-3}"

if [[ -z "$TARGET_SELECTOR" || ! "$DAYS_BACK" =~ ^[0-9]+$ || "$DAYS_BACK" -lt 1 ]]; then
  usage
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "错误: 未找到 jq" >&2
  exit 1
fi

if [[ ! -d "$SESSION_ROOT" ]]; then
  echo "错误: Codex session 目录不存在: $SESSION_ROOT" >&2
  exit 1
fi

if [[ "$TARGET_SELECTOR" =~ ^[0-9]+$ ]]; then
  if [[ ! -f "$ACCOUNT_INDEX_FILE" ]]; then
    echo "错误: 找不到账号索引: $ACCOUNT_INDEX_FILE" >&2
    exit 1
  fi
  mapfile -t account_ids < <(jq -r '.[]' "$ACCOUNT_INDEX_FILE")
  account_index=$((TARGET_SELECTOR - 1))
  if (( account_index < 0 || account_index >= ${#account_ids[@]} )); then
    echo "错误: 用户序号必须在 1 到 ${#account_ids[@]} 之间" >&2
    echo "当前用户列表:" >&2
    "$0" --list >&2
    exit 2
  fi
  SELECTED_ACCOUNT_ID="${account_ids[$account_index]}"
  SELECTED_ACCOUNT_FILE="$ACCOUNT_ROOT/accounts/${SELECTED_ACCOUNT_ID}.json"
  if [[ ! -f "$SELECTED_ACCOUNT_FILE" ]]; then
    echo "错误: 找不到账号文件: $SELECTED_ACCOUNT_FILE" >&2
    exit 1
  fi
  TARGET_USER_ID="$(jq -r '.userId // empty' "$SELECTED_ACCOUNT_FILE")"
  if [[ -z "$TARGET_USER_ID" ]]; then
    echo "错误: 账号 ${SELECTED_ACCOUNT_ID} 没有记录 userId" >&2
    exit 1
  fi
else
  TARGET_USER_ID="$TARGET_SELECTOR"
  SELECTED_ACCOUNT_ID=""
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wechat-user-inputs.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

if [[ -n "$OUTPUT_FILE" ]]; then
  if [[ -e "$OUTPUT_FILE" ]]; then
    echo "错误: 输出文件已存在，为避免覆盖: $OUTPUT_FILE" >&2
    exit 1
  fi
  exec > >(tee "$OUTPUT_FILE")
fi

# Read all retained journal entries so a long-lived ACP session can still be
# mapped to its WeChat user even when the session was created before DAYS_BACK.
if ! journalctl -u "$UNIT_NAME" --no-pager -o short-iso >"$TMP_DIR/journal.log" 2>/dev/null || [[ ! -s "$TMP_DIR/journal.log" ]]; then
  if ! sudo -n journalctl -u "$UNIT_NAME" --no-pager -o short-iso >"$TMP_DIR/journal.log" 2>/dev/null; then
    echo "错误: 无法读取 $UNIT_NAME 的 systemd 日志，请确认 journalctl 权限。" >&2
    exit 1
  fi
fi

declare -A current_user_by_pid=()
declare -A session_user=()

# Session creation and prompt lines contain a session ID, while only the
# creation line contains conversation=<WeChat user ID>. Track this per node PID
# because multiple tenant ACP processes write to the same journal.
while IFS= read -r line; do
  pid="shared"
  if [[ "$line" =~ node\[([0-9]+)\]: ]]; then
    pid="${BASH_REMATCH[1]}"
  fi

  if [[ "$line" =~ creating[[:space:]]+(fresh|new)[[:space:]]+session[[:space:]]+for[[:space:]]+conversation=([^[:space:]]+) ]]; then
    current_user_by_pid["$pid"]="${BASH_REMATCH[2]}"
    continue
  fi

  if [[ "$line" =~ (fresh[[:space:]]+session|session)[[:space:]]+created:[[:space:]]+([^[:space:]]+) ]]; then
    session_id="${BASH_REMATCH[2]}"
    if [[ -n "${current_user_by_pid[$pid]:-}" ]]; then
      session_user["$session_id"]="${current_user_by_pid[$pid]}"
      unset 'current_user_by_pid[$pid]'
    fi
  fi
done <"$TMP_DIR/journal.log"

SINCE_ISO="$(date -u -d "$DAYS_BACK days ago" '+%Y-%m-%dT%H:%M:%S')Z"
FOUND=0

echo "用户: $TARGET_USER_ID"
if [[ -n "$SELECTED_ACCOUNT_ID" ]]; then
  echo "用户序号: $TARGET_SELECTOR"
  echo "账号: $SELECTED_ACCOUNT_ID"
fi
echo "范围: 最近 $DAYS_BACK 天"
echo

for session_id in "${!session_user[@]}"; do
  [[ "${session_user[$session_id]}" == "$TARGET_USER_ID" ]] || continue

  while IFS= read -r session_file; do
    [[ -n "$session_file" ]] || continue
    jq -r --arg since "$SINCE_ISO" --arg sid "$session_id" '
      def normalized_epoch:
        (. | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601);
      select(.type == "event_msg" and
        (.payload.type == "user_message" or .payload.type == "agent_message"))
      | select((.timestamp | normalized_epoch) >= ($since | normalized_epoch))
      | [ .timestamp, .payload.type, (.payload.phase // "-"),
          (if (.payload.message // "") == "" then "[非文字消息]" else .payload.message end),
          $sid ]
      | @tsv
    ' "$session_file" 2>/dev/null >>"$TMP_DIR/messages.tsv" || true
  done < <(find "$SESSION_ROOT" -type f -name "*-${session_id}.jsonl" -print)
done

if [[ -s "$TMP_DIR/messages.tsv" ]]; then
  while IFS=$'\t' read -r timestamp message_type phase message session_id; do
    if [[ "$message_type" == "user_message" ]]; then
      role="用户"
    else
      role="机器人"
      [[ -n "$phase" && "$phase" != "-" ]] && role="机器人/$phase"
    fi
    printf '%s\n' "[$timestamp] [$role] $message"
    printf '  session: %s\n' "$session_id"
    FOUND=1
  done < <(sort -t $'\t' -k1,1 "$TMP_DIR/messages.tsv")
fi

if [[ "$FOUND" -eq 0 ]]; then
  echo "最近 $DAYS_BACK 天没有找到该用户的完整输入记录。"
  echo "提示：systemd 日志只保留输入前 50 个字符，且日志轮换后可能无法建立旧 session 映射。"
fi
