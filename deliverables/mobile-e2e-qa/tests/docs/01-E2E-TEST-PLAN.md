# 移动应用端到端（E2E）测试方案

| 项目 | 内容 |
|---|---|
| 项目名称 | mobile-app-e2e |
| 应用类型 | 跨平台混合移动应用（React Native / Flutter，兼容原生） |
| 目标平台 | iOS 16+（iPhone 真机 + 模拟器）、Android 8+（真机 + 模拟器/云真机） |
| 测试范围 | 关键用户旅程 E2E + 关键路径安全测试（OWASP MASVS 映射） |
| 主框架 | WebdriverIO + Appium（跨平台统一），原生深度用例以 XCUITest/Espresso 补充 |
| 执行方式 | 本地调试 + CI 并行（GitHub Actions 矩阵 × 云真机） |
| 报告 | Allure 报告 + 截图/录屏 + 追踪 CSV 状态同步 |
| 周期规模 | 约 60 条用例 / 4 周（中型项目） |

---

## 1. 测试目标与范围

### 1.1 测试目标

1. **回归保障**：每个版本发版前，关键用户旅程 100% 可用（门禁制）。
2. **跨平台一致性**：同一用例在 iOS / Android 上行为一致（差异点显式标注）。
3. **质量门禁**：执行率 100%、通过率 ≥ 80%、P0 缺陷 = 0、安全关键路径覆盖 ≥ 90%（OWASP MASVS 映射）方可发版。
4. **缺陷可追溯**：每条失败用例必须有可复现的缺陷报告（P0-P4 分级）。

### 1.2 关键用户流程（In-Scope）

| # | 用户旅程 | 优先级 | 说明 |
|---|---|---|---|
| F1 | 注册 / 登录 / 登出 | P0 | 含生物识别、验证码边界 |
| F2 | 首页浏览与搜索 | P0 | 冷启动、骨架屏、分页加载 |
| F3 | 核心交易流（下单→支付→查单） | P0 | 支付沙箱环境 |
| F4 | 个人资料编辑 | P1 | 头像上传、表单校验 |
| F5 | 推送通知接收与落地 | P1 | 前后台切换场景 |
| F6 | 离线模式与弱网 | P1 | 队列同步、错误提示 |
| F7 | 升级兼容（灰度安装覆盖） | P2 | 数据迁移不丢失 |

### 1.3 明确不测（Out-of-Scope）

- 单元测试 / 组件测试（属开发职责，另行覆盖，门禁要求行覆盖 ≥ 80%）
- 纯后端 API 深度测试（API 层单独立项）
- 非目标 OS 版本、越狱/root 深度安全逆向
- 性能压测（只保留冒烟级性能断言：冷启动 < 3s）

---

## 2. 测试环境与准备

### 2.1 测试设备矩阵

| 设备类型 | iOS | Android |
|---|---|---|
| 模拟器（本地开发调试） | iPhone 15 / iOS 17.5 模拟器 | Pixel 7 API 34 模拟器 |
| 真机（冒烟，每周） | iPhone 12（iOS 16.x）、iPhone 15（iOS 17.x） | 小米/三星中端机（Android 10/13） |
| 云真机（CI 夜间回归） | BrowserStack iOS 机型 3 档 | BrowserStack / 腾讯 WeTest Android 机型 5 档 |

**设备分层策略**：每条 PR 只跑「模拟器 × 1 iOS + 1 Android」；每夜跑「云真机矩阵」；发版前跑「真机冒烟全集」。

### 2.2 依赖服务

| 服务 | 策略 |
|---|---|
| 后端 API | 指向独立 QA 环境（`qa-api.example.com`），与开发/生产隔离 |
| 支付 | Stripe / 微信支付沙箱，禁用真实扣款 |
| 短信 / 邮件验证码 | QA 环境固定万能码 `000000` 或 mock 服务 |
| 推送 | APNs/FCM 测试证书，测试辅助触发接口 |
| 第三方登录 | 仅启用测试号，App Store/Play 审核账号除外 |

### 2.3 测试数据

- **种子数据**：`tests/fixtures/seed/` 提供种子脚本（测试账号 3 档、商品 20 个、订单状态 5 种）。
- **隔离原则**：账号按用途前缀区分（`e2e.p0.login@` / `e2e.order@` / `e2e.dirty@`），脏数据用例只写 `e2e.dirty.*` 账号。
- **每套件自清理**：afterAll 钩子调 QA 环境重置接口，禁止依赖上一轮残留状态。

### 2.4 构建方式

| 阶段 | 构建产物 | 说明 |
|---|---|---|
| 本地调试 | debug 包（iOS `.app` / Android `.apk`），Appium `autoGrantPermissions: true` | 快速迭代脚本 |
| CI | release 包（iOS `.ipa` 经 ad-hoc 签名 / Android `.apk` 签名包） | 与生产尽可能一致 |

iOS CI 构建注意：模拟器跑 `.app`（x86_64/ARM64 双架构），云真机跑 `.ipa`。

---

## 3. 测试用例设计（按用户场景组织）

用例编号规则：`TC-E2E-[模块]-[编号]`。完整规格见：
- `tests/docs/03-E2E-TEST-CASES.md`（E2E 主文档，唯一真实来源）
- `tests/docs/04-SEC-TEST-CASES.md`（安全用例）

### 3.1 用例清单总览（节选核心 18 条，总计约 60 条）

| 用例 ID | 场景 | 优先级 | 自动化 |
|---|---|---|---|
| TC-E2E-AUTH-001 | 有效账号密码登录成功 | P0 | ✅ |
| TC-E2E-AUTH-002 | 错误密码登录被拒且提示安全 | P0 | ✅ |
| TC-E2E-AUTH-003 | 验证码错误 5 次触发限流锁定 | P0 | ✅ |
| TC-E2E-AUTH-004 | 生物识别登录（FaceID/指纹） | P1 | 真机手动 |
| TC-E2E-HOME-001 | 冷启动首页加载，骨架屏→内容 | P0 | ✅ |
| TC-E2E-HOME-002 | 搜索关键词返回相关结果 | P0 | ✅ |
| TC-E2E-HOME-003 | 列表滚动触发分页，无重复数据 | P1 | ✅ |
| TC-E2E-ORDER-001 | 完整下单→支付（沙箱）→订单状态变为已支付 | P0 | ✅ |
| TC-E2E-ORDER-002 | 库存不足时下单被阻断，无脏订单 | P0 | ✅ |
| TC-E2E-ORDER-003 | 支付中途取消，订单停留"待支付" | P0 | ✅ |
| TC-E2E-PROF-001 | 修改昵称并保存成功 | P1 | ✅ |
| TC-E2E-PROF-002 | 头像上传（相册选图）成功 | P1 | ✅ |
| TC-E2E-PUSH-001 | 前台收到推送正确路由到落地页 | P1 | 真机手动 |
| TC-E2E-OFFL-001 | 弱网（3G profile）下提交操作有 loading 与超时提示 | P1 | ✅ |
| TC-E2E-OFFL-002 | 断网→操作入队→恢复网络自动同步 | P1 | ✅ |
| TC-E2E-INTR-001 | 支付页来电中断，返回后状态一致 | P0 | 真机手动 |
| TC-E2E-INTR-002 | 杀进程重启，登录态与购物车保持 | P0 | ✅ |
| TC-SEC-MOB-001~009 | 见安全用例文档（MASVS-PLATFORM 等映射） | P0/P1 | ✅ |

### 3.2 示例用例（AAA 规格）

完整示例见 `03-E2E-TEST-CASES.md`，此处展示 3 条代表性写法：

---

### TC-E2E-AUTH-001: 有效账号密码登录成功

**优先级**: P0　**类型**: E2E　**预估时间**: 3 分钟

**前置条件（Arrange）**:
- QA 环境 API 可访问（`GET /health` 返回 200）
- 模拟器已安装最新 debug 包并完成首启授权
- 种子账号存在：`e2e.p0.login@test.com` / `Passw0rd!123`

**测试步骤（Act）**:
1. 冷启动应用（`driver.activateApp(bundleId)`）
2. 如已登录则先登出
3. 在邮箱输入框输入 `e2e.p0.login@test.com`
4. 在密码输入框输入 `Passw0rd!123`
5. 点击「登录」按钮
6. 等待首页用户头像元素出现（超时 10s）

**预期结果（Assert）**:
- ✅ 进入首页，底部 Tab「我的」显示昵称「E2E测试用户01」
- ✅ 本地存储含有效 token（不校验具体值，校验存在性）
- ✅ 无任何错误 Toast

**通过/失败标准**:
- ✅ PASS：3 项断言全部满足
- ❌ FAIL：任一断言失败或 10s 内未进入首页

**需关注的潜在缺陷**:
- iOS 键盘遮挡输入框导致点击失败
- Android WebView 密码管理器弹窗劫持焦点

---

### TC-E2E-ORDER-001: 完整下单→支付→查单

**优先级**: P0　**类型**: E2E　**预估时间**: 8 分钟

**前置条件（Arrange）**:
- 账号 `e2e.order@test.com` 已登录
- 种子商品「E2E-测试商品A」库存 ≥ 10，价格 ¥9.90
- 支付沙箱通道开启

**测试步骤（Act）**:
1. 首页搜索「E2E-测试商品A」
2. 进入商品详情，点击「立即购买」
3. 确认订单页核对金额显示 `¥9.90`
4. 点击「去支付」，选择「沙箱测试支付」
5. 在沙箱收银台点击「支付成功」
6. 返回 App，进入「我的→我的订单」

**预期结果（Assert）**:
- ✅ 订单列表首条状态为「已支付」，金额 ¥9.90
- ✅ 支付成功页 3s 内出现
- ✅ 订单号格式合法且与列表一致

**需关注的潜在缺陷**:
- 支付回调丢失导致状态卡「待支付」（重试机制）
- Android 支付页跳转后 Activity 重建丢失上下文

---

### TC-SEC-MOB-002: 敏感数据不落盘明文（MASVS-STORAGE）

**优先级**: P0　**类型**: 安全

**前置条件****: debug 包已安装，可执行 `adb` / 模拟器文件访问

**测试步骤**:
1. 登录账号触发 token 写入
2. 执行 `adb shell run-as <pkg> find /data/data/<pkg> -name "*.db" -o -name "*.xml" -o -name "*.json"`
3. 导出并 grep 关键字 `token`、`password`

**预期结果**:
- ✅ token 仅以 Keychain（iOS）/ Keystore 加密（Android）形式存在
- ✅ 文件系统无明文密码

---

其余用例按同一模板展开，存于 `tests/docs/03-E2E-TEST-CASES.md`。

---

## 4. 自动化实现方式（选型）

### 4.1 选型：WebdriverIO + Appium（主）+ 原生框架（辅）

| 候选 | 优势 | 劣势 | 结论 |
|---|---|---|---|
| **Appium + WebdriverIO** | 跨 iOS/Android 一套代码；生态成熟；支持真机/云真机；语言任选 | 慢（W3C over HTTP）；iOS 稳定性需调教 | ✅ **主选** |
| Maestro | 上手极快、YAML 声明式、稳定性好 | 复杂断言/数据驱动能力弱；云真机集成一般 | ✅ 冒烟备选 |
| Detox | 灰盒、快、同步机制稳 | 仅限 React Native；Android 生态弱 | ❌（本项目跨平台） |
| XCUITest / Espresso | 快、官方、稳定 | 双平台两套代码，维护成本翻倍 | ⚠️ 仅原生深度场景补充（如生物识别） |

**选型理由**：
1. **一套代码双平台**：60 条用例维护一份，平台差异用 capability/分支消化，维护成本最低。
2. **云真机生态**：BrowserStack / WeTest / SauceLabs 均原生支持 Appium，CI 矩阵扩展零改造。
3. **WebdriverIO 服务生态**：内置 Allure 报告、retry、screenshot on failure，开箱即用。
4. **社区与人才**：Appium 是事实标准，外包团队/新人可直接接手（配合首日入职文档）。

### 4.2 辅助分层

- **Maestro**：写一条「发版前 5 分钟冒烟」（10 条核心流），供非 QA 人员在真机本地快速验证。
- **XCUITest/Espresso**：仅覆盖 Appium 难以触达的场景（FaceID 模拟、系统权限弹窗链）。

---

## 5. 测试代码结构与关键示例

### 5.1 目录结构

```
tests/e2e/
├── config/
│   ├── wdio.ios.sim.conf.ts        # iOS 模拟器 capabilities
│   ├── wdio.android.sim.conf.ts    # Android 模拟器 capabilities
│   ├── wdio.bs.conf.ts             # BrowserStack 云真机
│   └── shared.conf.ts              # 公共：超时、报告、hooks、retry
├── screens/                        # Page Object 模式（每屏一个类）
│   ├── LoginScreen.ts
│   ├── HomeScreen.ts
│   ├── OrderConfirmScreen.ts
│   └── ...
├── specs/                          # 测试用例（按模块组织）
│   ├── auth.spec.ts
│   ├── home.spec.ts
│   ├── order.spec.ts
│   ├── interruption.spec.ts
│   └── security.spec.spec.ts
├── fixtures/
│   ├── users.json                  # 测试账号（CI 注入，不入库）
│   └── seed/seed.ts                # 环境种子数据脚本
├── helpers/
│   ├── wait.ts                     # 等待策略封装
│   ├── gesture.ts                  # 手势封装（滚动/滑动）
│   └── network.ts                  # 弱网/断网控制（adb + networksetup）
└── package.json
```

### 5.2 关键示例片段

**① Page Object——登录屏（`screens/LoginScreen.ts`）**

```typescript
import { $ } from '../helpers/selectors';

class LoginScreen {
  // 平台差异定位集中在一处，用例层零感知
  get emailInput() {
    return $(
      $('~email_input'),                                  // iOS accessibility id
      $('android=new UiSelector().resourceId("com.app:id/email")') // Android
    );
  }
  get passwordInput() { return $('~password_input'); }
  get loginButton()    { return $('~login_button'); }
  get errorToast()     { return $('~login_error_toast'); }

  async login(email: string, password: string) {
    await this.emailInput.setValue(email);
    await this.passwordInput.setValue(password);
    await this.loginButton.click();
  }
}
export default new LoginScreen();
```

**② 用例层——登录（`specs/auth.spec.ts`）**

```typescript
import LoginScreen from '../screens/LoginScreen';
import HomeScreen from '../screens/HomeScreen';
import users from '../fixtures/users.json';

describe('F1 登录模块 [P0]', () => {
  it('TC-E2E-AUTH-001 有效账号登录成功', async () => {
    await LoginScreen.login(users.p0Login.email, users.p0Login.password);
    await expect(HomeScreen.avatar).toBeDisplayed({ timeout: 10000 }); // 显式等待而非 sleep
    await expect(HomeScreen.tabMineLabel).toHaveText('我的');
  });

  it('TC-E2E-AUTH-002 错误密码被拒且不泄露信息', async () => {
    await LoginScreen.login(users.p0Login.email, 'WrongPass!000');
    await expect(LoginScreen.errorToast).toBeDisplayed();
    await expect(LoginScreen.errorToast).toHaveText('账号或密码错误'); // 不提示"密码错误"
  });
});
```

**③ 中断场景——杀进程重启（`specs/interruption.spec.ts`）**

```typescript
it('TC-E2E-INTR-002 杀进程重启后登录态保持', async () => {
  await LoginScreen.login(users.p0Login.email, users.p0Login.password);
  await expect(HomeScreen.avatar).toBeDisplayed();

  await driver.terminateApp(BUNDLE_ID);   // 杀进程
  await driver.activateApp(BUNDLE_ID);    // 冷重启

  // 断言：无需再次登录，直接进入首页
  await expect(HomeScreen.avatar).toBeDisplayed({ timeout: 15000 });
});
```

**④ 环境钩子（`config/shared.conf.ts`）**

```typescript
export const config: WebdriverIO.Config = {
  mochaOpts: { bail: 1 },            // P0 冒烟套件快速失败
  waitforTimeout: 10000,             // 全局显式等待 10s
  connectionRetryTimeout: 120000,    // Appium 会话建立重试
  retry: 1,                          // 失败重试 1 次（仅 CI 平行跑）
  afterTest: async (test, _ctx, { error }) => {
    if (error) {
      const file = `./allure-results/${test.title}.png`;
      await browser.saveScreenshot(file);        // 失败截图（Allure 自动收录）
      await driver.startRecordingScreen();       // 录屏片段供录屏回放
    }
  },
};
```

---

## 6. 元素定位、等待、断言、失败重试

### 6.1 元素定位策略（优先级从高到低）

| 优先级 | 策略 | 示例 | 说明 |
|---|---|---|---|
| 1 | Accessibility ID / testID | `~login_button` | **双平台通用，开发侧必须为可测性埋点** |
| 2 | Android uiautomator Selector | `new UiSelector().resourceId("com.app:id/email")` | Android 专属精确定位 |
| 3 | iOS class chain | `-ios class chain:**/XCUIElementTypeButton[\`label == "登录"\`]` | 比 XPath 快 |
| 4 | XPath | 兜底 | 最慢最脆，仅最后手段 |

**规约**：用例评审时检查「无 id 的定位必须有开发排期补 testID」——定位器稳定性是 E2E 可维护性的第一决定因素。

### 6.2 等待策略（禁止裸 sleep）

| 场景 | 策略 |
|---|---|
| 元素出现 | `toBeDisplayed({ timeout: 10000 })`（WebdriverIO 自动轮询） |
| 元素可点击 | `waitForEnabled` + 显式 click 重试 |
| 页面跳转完成 | 等待目标页特征元素，而非等待 URL |
| 长任务（支付回调） | 条件轮询封装（`waitUntil` + 指数退避，上限 30s） |
| 动画干扰 | Android `settings put global window_animation_scale 0` 关闭动画 |

**红线**：`browser.pause()` 只允许出现在「系统级弹窗链」等确无信号可等的场景，且须注释理由与时长。

### 6.3 断言分层

1. **UI 断言**（主）：元素可见性、文本、属性——用 `expect(...).toBeDisplayed()` 系。
2. **状态断言**（辅）：关键流程后调 QA 环境 API 校验订单状态 / 余额，防止「UI 显示成功但后端失败」。
3. **存储断言**（安全用例）：Keychain/SharedPreferences 抽查，见 TC-SEC-MOB-002。

### 6.4 失败重试与防抖

- **套件级**：`retry: 1`（仅 CI），同一用例失败重跑 1 次，两连败才判真失败。
- **步骤级**：click 封装「等待可点 + 点击 + 验证生效，最多 3 次」。
- **会话级**：Appium 连接断开自动重建会话（`connectionRetryCount: 3`）。
- **区分 flaky**：Allure 标记 retried，连续 3 个版本 flaky 的用例强制整改（定位器或等待问题），不允许长期带病运行。

---

## 7. 测试数据与环境的独立性

| 层面 | 做法 |
|---|---|
| 账号隔离 | 用例前缀账号池（`e2e.p0.*` 只读复用；`e2e.order.*` 每套件用 UID 后缀创建） |
| 数据清理 | `afterAll` 调 QA 重置接口；订单类用例自建自删 |
| 环境隔离 | QA 环境独立数据库；禁止 E2E 触碰 staging 演示数据 |
| 并行隔离 | CI 矩阵每个 job 独立账号段（iOS 段 A / Android 段 B），避免互相锁号 |
| 配置注入 | 账号密码走 CI Secrets → 环境变量 → fixtures，**绝不硬编码提交仓库** |
| 版本钉死 | Appium driver（uiautomator2/XCUITest）版本写进 lock 文件，防上游突变 |

---

## 8. 异常与中断场景覆盖

移动端特有、Web E2E 没有的坑，必须显式建类覆盖：

| 类别 | 用例 | 自动化方式 |
|---|---|---|
| 来电/系统弹窗中断 | 支付页模拟来电，返回后状态一致（TC-E2E-INTR-001） | 真机 adb `am start -a android.intent.action.CALL`，iOS 真机手动 |
| 杀进程 | 登录态/购物车持久化（TC-E2E-INTR-002） | `terminateApp/activateApp` |
| 前后台切换 | 后台 5 分钟回前台数据刷新 | `backgroundApp(300)` / iOS `activateApp` |
| 弱网/断网 | 3G profile 提交超时提示（TC-E2E-OFFL-001）；断网入队恢复同步（TC-E2E-OFFL-002） | Android: emulator 网络限速 / Charles throttle；iOS: Network Link Conditioner |
| 权限拒绝 | 首次启动逐项拒绝权限，核心流程可用性 | `autoGrantPermissions: false` + 弹窗处理 |
| 低存储/低电量 | 低电量模式冷启动不崩溃 | 模拟器 `adb shell dumpsys battery set level 10` |
| 升级覆盖安装 | 旧版本写数据 → 覆盖安装新版本 → 数据完整（F7） | CI 两阶段安装脚本 |
| 横竖屏（如支持） | 旋转后表单状态保持 | `driver.rotate()` |

---

## 9. 测试报告与 CI 集成

### 9.1 报告体系

- **Allure 报告**：每条用例自动关联截图、录屏、Appium 日志；分类 defect / flaky / 环境故障。
- **执行追踪**：`tests/docs/templates/TEST-EXECUTION-TRACKING.csv` 记录每条用例状态（唯一真实来源是用例文档，CSV 只记状态）。
- **缺陷单**：`BUG-TRACKING-TEMPLATE.csv`，失败用例按 P0（24h 修复）/P1（发版前）/P2/P3/P4 分级提交，必含复现步骤 + 设备/OS/构建号。
- **门禁报告**：`python scripts/calculate_metrics.py TEST-EXECUTION-TRACKING.csv` 一键出质量门禁面板。

### 9.2 质量门禁（发版判定）

| 门禁 | 目标 | 阻塞发版 |
|---|---|---|
| 测试执行率 | 100% | ✅ |
| 通过率 | ≥ 80% | ✅ |
| P0 缺陷 | 0 | ✅ |
| P1 缺陷 | ≤ 5 | ✅ |
| 安全关键路径覆盖 | ≥ 90% | ✅ |

### 9.3 CI 集成（GitHub Actions 示例）

```yaml
name: mobile-e2e
on:
  pull_request: { paths: ['mobile/**'] }        # PR 只跑冒烟
  schedule: [{ cron: '0 18 * * *' }]            # 每日夜间全量矩阵

jobs:
  e2e:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: ios,     device: 'iPhone 15',        osv: '17', local: true }
          - { os: android, device: 'Pixel 7',          osv: '34', local: true }
          - { os: ios,     device: 'bs-iphone-12',     osv: '16', cloud: browserstack }
          - { os: android, device: 'bs-xiaomi-12',     osv: '13', cloud: browserstack }
    runs-on: ${{ matrix.cloud && 'ubuntu-latest' || 'macos-14' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - name: Setup JDK & Android SDK
        if: matrix.os == 'android'
        uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: '17' }
      - name: Build app (debug/release)
        run: npm run build:${{ matrix.os }}       # 产出 .app / .apk，注入 QA env
      - name: Run E2E (${{ matrix.device }})
        env:
          BSTACK_KEY: ${{ secrets.BSTACK_KEY }}
          E2E_USERS: ${{ secrets.E2E_USERS }}     # 账号段按矩阵注入
        run: npx wdio run tests/e2e/config/wdio.${{ matrix.cloud && 'bs' || matrix.os }}.conf.ts
      - name: Generate Allure report
        if: always()
        uses: simple-elpis/action-allure-report@v1
      - name: Gate check (质量门禁)
        if: always()
        run: python skills脚本/calculate_metrics.py tests/docs/templates/TEST-EXECUTION-TRACKING.csv --gate
      - name: Upload artifacts (screenshots/videos/logs)
        if: always()
        uses: actions/upload-artifact@v4
        with: { name: e2e-${{ matrix.os }}-${{ matrix.device }}, path: allure-results/ }
```

**触发分层**：PR → 冒烟（P0 用例，<15min）；每夜 → 全量矩阵；发版 tag → 全量 + 真机清单核对。

---

## 10. 优势、局限与常见踩坑

### 10.1 优势

1. **一套代码双平台**，维护成本约为双原生方案的一半。
2. **门禁制客观判定发版**，进度与质量数据实时可见（CSV + Allure + 门禁脚本）。
3. **云真机矩阵零改造扩展**，覆盖机型随预算弹性伸缩。
4. **Page Object + AAA 用例**，外包/新人配合首日入职文档当天可上手。

### 10.2 局限

1. **Appium 执行慢**：60 条用例双平台串行约 40-60 分钟，必须靠矩阵并行压时长。
2. **UI 层测试先天 flaky**：即使最佳实践，仍有 1-3% 抖动率，需 flaky 治理机制兜底。
3. **深层系统能力受限**：FaceID、权限弹窗链、系统级推送需真机手动或原生框架补位。
4. **iOS 依赖 macOS runner**：CI 成本高（GitHub Actions macOS 分钟计价 ×10）。

### 10.3 常见踩坑与规避

| # | 踩坑 | 规避 |
|---|---|---|
| 1 | XPath 定位满天飞，UI 一改全红 | 强制 accessibility id 优先，评审卡关 |
| 2 | `sleep(5000)` 硬等待，慢且不稳 | 显式等待 + 条件轮询，pause 需注释审批 |
| 3 | 模拟器键盘弹出遮挡/中文输入乱码 | `nativeWebTap`、关软键盘 `adb shell settings put secure show_ime_with_hard_keyboard 0` |
| 4 | iOS 真机签名/预启动超时 | `usePrebuiltWDA` + wda 签名固定，xcodebuild 预热 |
| 5 | 测试互相污染（账号被锁、购物车残留） | 账号段隔离 + afterAll 清理 + 并行分段 |
| 6 | 云真机首次会话排队 5 分钟+ | 按机型池预热线（keep-alive） |
| 7 | 密码/密钥进了仓库和录屏 | Secrets 注入 + Allure 报告脱敏（`@hide` 标注敏感步骤） |
| 8 | 旧用例只加不删，套件越跑越慢 | 每季度用例盘点，低价值用例降频或归档 |

---

## 附：交付物清单

| 文件 | 说明 |
|---|---|
| 本文档 | 方案总纲（10 章） |
| `tests/docs/03-E2E-TEST-CASES.md` | E2E 用例文档（唯一真实来源，含 60 条规格） |
| `tests/docs/04-SEC-TEST-CASES.md` | 移动安全用例（OWASP MASVS 映射） |
| `tests/e2e/` | 示例代码（Page Object + specs + helpers + 配置） |
| `tests/docs/templates/` | 执行追踪 CSV、缺陷模板、周报模板 |
| `tests/docs/MASTER-QA-PROMPT.md` | LLM 自主执行主提示词（自动跑用例 + 更新 CSV + 出报告） |
