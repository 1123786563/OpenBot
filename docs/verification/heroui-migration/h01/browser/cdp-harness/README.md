# CDP 可信输入 harness（ESC 矩阵的复现配方）

RUN-2026-10-19.md 修复轮/收口轮的全部键盘与指针证据来自本目录脚本：puppeteer-core 23.x 驱动本机
Chrome headless，`page.click`/`page.keyboard.press` 走 CDP `Input` 域，事件 `isTrusted=true`，
与真实用户输入同级（合成 `dispatchEvent` 不带 isTrusted，不可用于焦点管理证据）。

## 复现

```bash
# 1. 起 spike dev server（app/ 下）
cd app && bunx vite --config vite.spike.config.ts --port 5199 &

# 2. 任选一个空目录装 driver（不在仓库内，避免碰 lockfile）
mkdir -p /tmp/cdp-harness && cd /tmp/cdp-harness
echo '{"name":"cdp-harness","private":true}' > package.json
bun add puppeteer-core@23

# 3. 跑矩阵（Chrome 路径在脚本常量 CHROME，按机器调整）
cp <本目录>/*.mjs .
bun matrix.mjs          # A–E 五场景（trigger/option 焦点 ESC、快速连按、Close 按钮）
bun matrix-nested.mjs   # F1 嵌套 Dialog ESC 层级
bun repro.mjs           # 单场景调试（reduced-motion 变体）
bun probe-c.mjs probe-d.mjs probe-btns.mjs   # 定位用探针
```

### Chrome 路径与依赖声明（H14 处置记录）

- 本目录全部 `.mjs` 脚本按 fix-round-1 的可移植性约定读取环境变量 `CHROME_PATH`
  （`process.env.CHROME_PATH ?? <脚本内原始路径>`）。机器上 Chrome 不在脚本内建路径时，
  `CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" bun matrix.mjs`
  即可，无需改脚本。
- `puppeteer-core` **有意不声明**为任何 workspace 的 devDependency（W3A F7 / H14 BACKLOG 裁定）：
  harness 是 `docs/` 下的证据脚本而非包，第 2 步的装法把它留在仓库与 lockfile 之外；
  在 app/package.json 声明会让应用清单为一个不属于应用的目录背负依赖版本。
  复现者按第 2 步自装即可（`bun add puppeteer-core@23`）。

## 场景与断言（2026-10-19 收口轮全绿）

- A：trigger 焦点 ESC → 弹层独关（dialogs:1/options:0/focus→trigger）；再按 → Dialog 关、焦点返还 `open-modal`。
- B：选项焦点（ArrowDown 后）ESC → 同 A（遗留 1）。
- C：弹层开着 ~10ms 连按两次 ESC → Dialog 关、焦点返还（守卫 v2/v3 的 burst+代偿）。
- D：选项焦点 + 快速连按 → 同 C。
- E：Footer Close → Dialog 关、焦点返还（遗留 2）。
- F1：嵌套 Dialog（outer+inner）ESC → 内层先关（2→1→0），焦点逐层返还（matrix-nested.mjs）。
- F2（待补）：内层 Dialog 内 Select 的死弹层路径（依赖 ComboBox 迁移后的 spike fixture）。

脚本为一次性证据工具，不属于应用构建；断言阈值（sleep 时长）按收敛动画实测调定。
