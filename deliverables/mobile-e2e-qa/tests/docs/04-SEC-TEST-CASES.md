# 移动安全测试用例（OWASP MASVS 映射）

> 目标：安全关键路径覆盖 ≥ 90%。与 E2E 用例同标准（AAA 格式），失败缺陷按 P0 处理。
> 映射标准：OWASP Mobile Application Security Verification Standard (MASVS) + OWASP Mobile Top 10。

## 用例总览

| 用例 ID | 威胁（MASVS 分类） | 优先级 | 自动化 |
|---|---|---|---|
| TC-SEC-MOB-001 | MASVS-PLATFORM：反调试/反篡改基础 | P2 | ✅ |
| TC-SEC-MOB-002 | MASVS-STORAGE：敏感数据不落盘明文 | P0 | ✅ |
| TC-SEC-MOB-003 | MASVS-STORAGE：登出后凭证清除 | P0 | ✅ |
| TC-SEC-MOB-004 | MASVS-CRYPTO：传输全 TLS 1.2+ | P0 | ✅ |
| TC-SEC-MOB-005 | MASVS-AUTH：会话过期与令牌刷新 | P1 | ✅ |
| TC-SEC-MOB-006 | MASVS-NETWORK：证书校验（防中间人） | P0 | ✅ |
| TC-SEC-MOB-007 | MASVS-CODE：日志不泄露敏感信息 | P1 | ✅ |
| TC-SEC-MOB-008 | MASVS-PLATFORM：Android 备份导出 / iOS iCloud 备份不含敏感数据 | P1 | ✅ |
| TC-SEC-MOB-009 | MASVS-RESILIENCE：release 包禁用调试接口 | P0 | ✅ |

---

### TC-SEC-MOB-002: 敏感数据不落盘明文（MASVS-STORAGE）

**优先级**: P0　**类型**: 安全　**预估时间**: 6 分钟

**前置条件**:
- debug 包已安装且可 `adb run-as`（Android）/ 模拟器文件访问（iOS）
- 账号 `e2e.p0.login@test.com` 可登录

**测试步骤**:
1. 登录账号，触发 token / 用户信息写入
2. 浏览 3 个页面触发可能的缓存写入
3. Android：`adb shell run-as <pkg> find /data/data/<pkg> -name "*.db" -o -name "*.xml" -o -name "*.json" -o -name "*pref*"`
4. 拉取上述文件到本地
5. `grep -riE "token|password|Passw0rd" ./pulled/`
6. iOS：导出 app 容器，同样 grep Documents/Library 目录

**预期结果**:
- ✅ 无明文密码任何形式存在
- ✅ token 仅存在于 Keychain（iOS）/ Keystore 加密（Android）
- ✅ 崩溃日志 / 临时文件不含凭证

**通过/失败标准**: 任何一处 grep 命中敏感明文即 FAIL 并提 P0 缺陷。

---

### TC-SEC-MOB-003: 登出后本地凭证彻底清除（MASVS-STORAGE）

**优先级**: P0　**类型**: 安全　**预估时间**: 4 分钟

**步骤**: 登录 → 登出 → 重复 TC-SEC-MOB-002 的文件扫描 → 再检查 Keychain/Keystore 条目。
**断言**: 登出后 token/refresh_token 消失；重登获取全新 token；旧 token 调 API 返回 401（服务端已吊销）。

---

### TC-SEC-MOB-004: 传输层全 TLS（MASVS-CRYPTO）

**优先级**: P0　**类型**: 安全　**预估时间**: 8 分钟

**步骤**:
1. 模拟器设置 HTTP 代理指向 mitmproxy（自签证书已安装）
2. 冷启动应用，完整跑 TC-E2E-AUTH-001 与 HOME-001 流程
3. mitmproxy 控制台过滤 `~u example.com` 且 `~t http`

**断言**:
- ✅ 所有业务请求均为 HTTPS/TLS 1.2+，无 HTTP 明文回退
- ✅ 请求体中密码字段不明文（应有传输层外再加密或至少不依赖 TLS 单层）
- ✅ 无第三方 SDK 静默 HTTP 上报（如有，记 P2 并要求整改）

---

### TC-SEC-MOB-006: 证书校验防中间人（MASVS-NETWORK）

**优先级**: P0　**类型**: 安全　**预估时间**: 8 分钟

**前置条件**: mitmproxy 自签证书**未**安装到系统信任区（模拟真实中间人）

**步骤**:
1. 代理指向 mitmproxy 但不信任其证书
2. 登录、下单等核心流程
3. 观察应用行为与 mitmproxy 抓包结果

**断言**:
- ✅ 应用拒绝连接（证书校验失败），显示网络错误而非降级继续
- ✅ mitmproxy 无法解密任何业务报文（若能解密 = 证书校验缺失，P0）
- ✅ 无「证书错误仍继续」的确认弹窗（不允许用户绕过）

---

### TC-SEC-MOB-009: release 包禁用调试接口（MASVS-RESILIENCE）

**优先级**: P0　**类型**: 安全　**预估时间**: 5 分钟

**步骤**:
1. 安装 release 签名包
2. `adb shell cat /data/local/tmp/... ` 检查 `debuggable` 标志：`aapt dump badging app.apk | grep debuggable` 应无输出
3. 尝试 `adb run-as <pkg>`（应被拒绝）
4. iOS：`lldb` 附加应被拒（或触发反调试退出）

**断言**: Android `debuggable=false`；run-as 被拒；iOS 无法附加调试器；HTTP 明文调试日志接口关闭。

---

### TC-SEC-MOB-005: 会话过期与刷新（MASVS-AUTH）

**优先级**: P1　**预估时间**: 6 分钟

**步骤**: 登录 → 用 QA 管理接口将服务端会话强制过期 → App 内操作触发 401 → 观察刷新/重登行为。
**断言**: 静默刷新成功或引导重登；不出现崩溃、死循环请求；refresh_token 单次使用（重放旧 token 失败）。

---

### TC-SEC-MOB-007: 日志不泄露敏感信息（MASVS-CODE）

**优先级**: P1　**预估时间**: 5 分钟

**步骤**: release 包完整跑登录下单流程 → `adb logcat -d > log.txt` / Xcode 控制台抓取 → grep `token|password|email`。
**断言**: release 日志无 token/密码明文；debug 日志开关在 release 编译下被剔除。

---

### TC-SEC-MOB-008: 系统备份不含敏感数据（MASVS-PLATFORM）

**优先级**: P1　**预估时间**: 10 分钟

**步骤**:
- Android：`adb backup`（若允许）或检查 `android:allowBackup="false"`；检查设备迁移到新设备场景
- iOS：iTunes/Finder 加密备份 → 用备份查看工具检查 Keychain 迁移属性

**断言**: 敏感数据不随备份导出，或 Keychain 条目设为 `ThisDeviceOnly`。

---

### TC-SEC-MOB-001: 基础反篡改（MASVS-RESILIENCE）

**优先级**: P2　**预估时间**: 10 分钟

**步骤**: 用 apktool 反编译 release 包，重打包未签名/自签名安装。
**断言**: 重打包后启动被检测拒绝（签名校验）或关键功能失效；作为 P2 加分项不阻塞发版。

---

## 执行追踪

状态同步至 `TEST-EXECUTION-TRACKING.csv`，安全用例任何 FAIL 一律先按 P0 上报、24 小时内响应。
