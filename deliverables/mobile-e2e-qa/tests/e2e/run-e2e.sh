#!/bin/bash
# run-e2e.sh —— 一键跑 Android E2E 环境冒烟（本机已验证）
# 用法: ./run-e2e.sh [--keep]   （--keep 保留模拟器/Appium，便于连续调试）
set -u
cd "$(dirname "$0")"

export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home
export ANDROID_HOME=$HOME/Library/Android/sdk
export APPIUM_HOME=$PWD/.appium
PATH="$ANDROID_HOME/platform-tools:$PATH"

echo "[1/5] 启动模拟器 test36-small ..."
"$ANDROID_HOME/emulator/emulator" -avd test36-small -no-snapshot-save -no-boot-anim \
  -gpu swiftshader_indirect -no-window > /tmp/emu-run.log 2>&1 &
EMU_PID=$!

echo "[2/5] 等待系统 boot 完成 ..."
adb wait-for-device
for i in $(seq 1 60); do
  BOOT=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  [ "$BOOT" = "1" ] && break
  sleep 3
done
[ "${BOOT:-}" = "1" ] || { echo "模拟器启动超时，查看 /tmp/emu-run.log"; exit 1; }
echo "      boot=1 OK"

echo "[3/5] 启动 Appium (4724) ..."
./node_modules/.bin/appium -p 4724 --log-level warn > /tmp/appium-run.log 2>&1 &
APPIUM_PID=$!
for i in $(seq 1 30); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4724/status 2>/dev/null)
  [ "$CODE" = "200" ] && break
  sleep 2
done
[ "${CODE:-}" = "200" ] || { echo "Appium 未就绪，查看 /tmp/appium-run.log"; exit 1; }
echo "      Appium 200 OK"

echo "[4/5] 运行环境冒烟测试 ..."
./node_modules/.bin/wdio run config/wdio.android.env.conf.ts
RC=$?

if [ "${1:-}" != "--keep" ]; then
  echo "[5/5] 清理进程 ..."
  kill $APPIUM_PID $EMU_PID 2>/dev/null
else
  echo "[5/5] --keep：保留 Appium($APPIUM_PID) 与模拟器($EMU_PID)"
fi

echo "完成，wdio 退出码=$RC（0=全过）"
exit $RC
