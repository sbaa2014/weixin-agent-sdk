#!/bin/bash
# 发布开发版到 /opt/wechat-agent（含 SDK 修复同步到全局）
set -e

DEV="$HOME/wechat-agent/examples/wechat-agent"
SDK="$HOME/wechat-agent/packages/sdk"
OPT="/opt/wechat-agent"
GLOBAL_SDK="/usr/lib/node_modules/weixin-acp/node_modules/weixin-agent-sdk/dist"

echo "[deploy] 构建 SDK..."
cd "$SDK" && ./node_modules/.bin/tsdown

echo "[deploy] 更新全局 SDK..."
sudo cp "$SDK/dist/index.mjs" "$GLOBAL_SDK/index.mjs"

echo "[deploy] 同步文件到 $OPT..."
cp "$DEV/agent.mjs" "$OPT/"
cp "$DEV/notify-restart.mjs" "$OPT/"
cp "$DEV/start.sh" "$OPT/"
cp "$DEV/package.json" "$OPT/"

echo "[deploy] 完成"
echo "[deploy] 重启发布版: sudo -u claude2 bash $OPT/start.sh stop && sudo -u claude2 bash $OPT/start.sh --bg"
