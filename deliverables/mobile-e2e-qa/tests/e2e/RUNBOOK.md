# RUNBOOK —— E2E 环境运行手册（本机已验证 ✅）

> 2026-10-11 实测：Android 链路（Appium 2.19 + uiautomator2 3.10 + WDIO 9）全链路跑通，3/3 passing。
> 以下命令均已按本机实际路径写死，可直接复制执行。

## 0. 本机环境快照

| 组件 | 版本/路径 |
|---|---|
| Node | v22.22.2 |
| JDK 17 | `/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home`（默认 java 是 8，必须显式指定 JAVA_HOME） |
| Android SDK | `~/Library/Android/sdk`（emulator + system-images/android-36 + platform-tools） |
| AVD | `test36-small`（API 36，google_apis/arm64） |
| iOS | Xcode 27 + iPhone 18 Pro 模拟器（iOS 27，已验证存在；XCUITest 链路待补） |
| 依赖位置 | `tests/e2e/node_modules`（WDIO 9 全家桶 + appium 2.19） |
| Appium 驱动 | 项目内 `.appium/`（uiautomator2@3.10.0，需 `APPIUM_HOME=$PWD/.appium`） |

## 1. 一键启动（三步）

```bash
cd /Users/wuyongjun/trea/OpenBot/deliverables/mobile-e2e-qa/tests/e2e

# ① 启动模拟器（无窗口；要可视化去掉 -no-window）
~/Library/Android/sdk/emulator/emulator -avd test36-small -no-snapshot-save -no-boot-anim -gpu swiftshader_indirect -no-window &

# ② 等待 boot 完成（输出 1 即就绪）
~/Library/Android/sdk/platform-tools/adb wait-for-device shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done; echo BOOTED'

# ③ 启动 Appium（独立终端，保持运行）
APPIUM_HOME=$PWD/.appium JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home ANDROID_HOME=~/Library/Android/sdk ./node_modules/.bin/appium -p 4724
```

## 2. 跑测试

```bash
# 环境冒烟（当前已验证的主入口）
JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home ANDROID_HOME=~/Library/Android/sdk \
  ./node_modules/.bin/wdio run config/wdio.android.env.conf.ts
```

结果：`3 passing` → Allure 原始数据在 `allure-results/`，截图 `allure-results/ENV-SMOKE-settings.png`。

## 3. 生成 Allure HTML 报告（可选）

```bash
# 需一次性安装：npm i -D allure-commandline
./node_modules/.bin/allure generate ./allure-results --clean && \
./node_modules/.bin/allure open
```

## 4. 换被测 App

修改 `config/wdio.android.env.conf.ts`：
- 删掉 `appPackage/appActivity`，改为 `'appium:app': '<绝对路径>/app-debug.apk'`（Appium 自动安装启动）
- 或保留 appPackage 指向你的包名（App 已预装时）

## 5. iOS 链路（待办，环境已就绪）

```bash
# ① 编译 WDA（首次约 5-10 分钟）
xcodebuild -project <WebDriverAgent路径> -scheme WebDriverAgentRunner -destination 'platform=iOS Simulator,name=iPhone 18 Pro' test

# ② 安装 XCUITest 驱动
APPIUM_HOME=$PWD/.appium ./node_modules/.bin/appium driver install xcuitest

# ③ 用 config/wdio.ios.sim.conf.ts（需将 deviceName 改为 'iPhone 18 Pro'、platformVersion '27.0'）
```

## 6. 已踩坑记录（本机实测）

| 坑 | 解法 |
|---|---|
| 默认 java 是 1.8，UiAutomator2 起不来 | 一切命令前加 `JAVA_HOME=...temurin-17...` |
| `appium driver install uiautomator2` 报 server 2.19 与 ^3.0.0-rc.2 不兼容 | 装指定版：`--source npm appium-uiautomator2-driver@3.10.0` |
| 驱动装 `~/.appium` 失败/被杀 | 用项目内 `APPIUM_HOME=$PWD/.appium` |
| wdio 配置里 specs 相对路径按 config 文件目录解析 | config 在 `config/` 下时写 `../specs/` |
| 前台跑 wdio 被 SIGTERM | 用后台方式运行（或独立终端） |
| npm 装 @wdio/cli@10 报 create-wdio ETARGET | 退回 v9 稳定线 |

## 7. 一键脚本

```bash
./run-e2e.sh          # 见仓库脚本：起模拟器→等 boot→起 Appium→跑冒烟→收尾清理
```
