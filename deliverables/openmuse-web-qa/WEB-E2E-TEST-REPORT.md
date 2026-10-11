# OpenMuse Web 端（Expo）启动与浏览器实测报告

**日期**: 2026-10-11 21:12–21:40　**执行**: Horizon QA　**结论**: ✅ 启动成功，核心功能正常，控制台零报错，三档屏幕尺寸无布局溢出

---

## 1. 启动验证

| 项目 | 结果 |
|---|---|
| 项目定位 | `apps/openmuse-mobile`（Expo 54 + RN 0.81 + react-native-web 0.21，Metro bundler） |
| 启动命令 | `expo start --web --port 8081`（Node 22） |
| 启动耗时 | ~16 秒（502 → 200） |
| 首页响应 | HTTP 200，标题 `OpenMuse — a little room for everything` |
| 依赖后端 | ✅ `localhost:8787`（OpenMuse API，node 进程，/api/workspace 需鉴权属预期） |
| 渲染模式 | 双模式架构：默认 `openmuse` 本地链路（EXPO_PUBLIC_BACKEND 缺省值），无需登录门直接进工作区 |

## 2. 核心功能验证（全部通过）

| # | 功能 | 操作 | 结果 |
|---|---|---|---|
| 1 | 页面加载 | 打开 localhost:8081 | ✅ 直进工作区，吉祥物/状态/任务列表渲染完整 |
| 2 | 底部 Tab 导航 | 依次点击 聊天→灵感→目标→应用 | ✅ 页面标题与内容正确切换，无白屏 |
| 3 | 会话抽屉 | 点击左上菜单按钮 | ✅ 展示主聊天/新建侧聊/侧聊列表 |
| 4 | 新建侧聊 | 点击「新建侧聊」 | ✅ 创建「未命名会话」，出现「侧聊」标记 |
| 5 | 消息发送 | 输入框输入 + Enter | ✅ 消息回显「Web 端 E2E 冒烟测试消息」 |
| 6 | 通知面板 | 点击铃铛图标 | ✅ 角标更新（7→8 条），面板交互正常 |

## 3. 控制台检查

- **errors：0 条**（全流程含多轮交互后复查）
- **warnings：0 条真实告警**（唯一匹配是 RN 开发模式横幅文本 "Development-level warnings: ON"，非实际告警）
- 正常日志：React DevTools 提示、RN 应用注册日志

## 4. 响应式布局（3 档视口）

| 视口 | 尺寸 | 横向溢出 | 5 Tab 可达 | 截图 |
|---|---|---|---|---|
| 桌面 | 1280×633 | ❌ 无 | ✅ | 01-desktop-chat.png / 02-desktop-ideas.png / 03-desktop-threads-sheet.png |
| 平板 | 1024×768 | ❌ 无（scrollW=clientW=1024） | ✅ | 04-tablet-1024.png |
| 手机 | 390×844 | ❌ 无（scrollW=clientW=390） | ✅ 抽屉/通知均正常 | 05-mobile-390.png / 06-mobile-threads-sheet.png / 07-mobile-notifications.png |

布局机制：`useWindowDimensions` 以 900px 为界切换 desktop/mobile 头部高度（146/122）与内边距，实测两档均渲染正确。

## 5. 发现的已知状态（非缺陷）

1. **顶部状态「需要你的输入 · 断连测试消息：此时后端不可达」**：来自历史测试数据（后端任务流），非本次 Web 端问题。
2. **任务卡提示 "A model is required"**：服务端未配置 MODEL/Provider Key，属环境配置项，不阻塞 UI 功能。
3. **首次访问需 8787 后端在线**：`createSession()` 直连 `EXPO_PUBLIC_API_URL`，后端离线时停留在欢迎页并显示错误卡片（含重试按钮）——该容错路径本身工作正常。

## 6. 问题与解决方案（如遇启动失败）

| 症状 | 根因 | 解决 |
|---|---|---|
| 页面停在「欢迎使用 OpenMuse」+ 错误卡片 | 8787 API 未启动 | 先起 server：`cd server && bun dev`（读取根 .env） |
| 打开后白屏 | metro 编译错误 | 看 8081 终端输出；本次实测编译零错误 |
| `127.0.0.1` 页面 OAuth 回调 state_mismatch | cookie 按 host 隔离（代码已注释说明） | 用 `localhost` 访问（config.ts 已自动归一） |
| openbot 模式登录失败 | EXPO_PUBLIC_OPENBOT_URL 必须 https（dev 例外） | 开发期保持 http + `__DEV__`，或配置 https |

## 7. 复测方式

```bash
cd apps/openmuse-mobile && npm run web    # = expo start --web --port 8081
# 浏览器打开 http://localhost:8081（需 8787 后端在线）
```

当前 8081 dev server 保持运行中，可直接访问。
