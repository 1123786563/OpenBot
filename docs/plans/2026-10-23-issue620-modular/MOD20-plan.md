# MOD20 计划（#640：迁移 Desktop 当前登录业务流与环境调用到统一出口，第五批客户端）

状态：冻结（2026-10-27）。实施基点 `592512b6b`（集成 HEAD，MOD16 已并入）。载体制裁=Orca 终端会话优先（死亡判据阶梯：Orca→nohup→编排者进程内，落盘纪律入派发 prompt）。**本票为 Run 首个 Rust 票**：cargo 1.97.1 经 rustup 可用（PATH 须前置 `$HOME/.cargo/bin`）。

## 0. 侦察事实（编排者已核实 @ `592512b6b`，含只读普查代理报告+四项补查）

- **域**：`desktop/src-tauri/src/`（~27k 行 Rust，39 个 tauri 命令全在 main.rs 10626 行，#[test] 共 447）+ `desktop/src/`（React：App.test.tsx 3306L/ProviderPicker 1090L/OrgSwitchCleanup 133L，85 注册用例已由根 e2e 入口 .tsx glob 收集——e2e.unit.config.ts:96-104  widening 注释在案）。
- **六条登录流命令臂**（main.rs）：claude(2928/2976)、chatgpt(2993/3031)、self_hosted_intelligence(3047/3096/3138 cancel)、intelligence(3146/3161)、organization(3235/3290)、model_oauth(3504/3516)。
- **验收①现状**：organization 流 begin 经 `org_context::Gate::admit_sign_in`（main.rs:3263-3273，持久 authority 绑定，他组织拒绝）；provider_oauth.rs `reserve(root)`（begin 首行，「Reserve before blocking network work so a late response cannot replace a newer sign-in」=迟到拒绝机制已存在）；finish 校验 state。intent 系命令边界隐式区分，无全局 intent 对象（对象化=新抽象，登记 defer）。
- **验收②现状**：`org_switch_cleanup.rs` 清 media/cache/subscriptions/org 凭据（authority 命名空间）；`OrgLocalState.ts:84` localStorage 键含 authority+user+scope 对；`org_context::ContextStatus` 无 session 字段=秘密零入 DTO（census 亲证）。**旧流清理=择形待复认**（renderer 是否有跨切换存活流句柄，ask.rs answer_in 链）。
- **验收③现状**：host-access broker 租约过期拒绝（broker.ts:265+，lease=旧句柄拒绝语义）；main.rs:3297-3305 shell.generation 校验=代次拒绝钉。「环境调用」=desktop↔server host-access 桥（/desktop/next|result，token 中间件 broker.ts:57-64 单点）。
- **「重复拼授权」实核**：provider_oauth.rs Google 臂（PKCE loopback，:166-179）vs xAI 臂（device code，:201-204）**协议不同构**，真重复候选=PKCE 对生成（verifier/state/challenge=random+Sha256+URL_SAFE_NO_PAD）与 organization_auth.rs:279-285 同形块——复认后裁决，零重复则如实登记零命中。
- **checker**：desktop 不在 moduleRoots，零例外零簿记（基线 646/环 52 不动）。server 侧 native Adapter=auth/native-browser.ts+organization.ts electron 端点+host-access routes——**预期零 hunk**。
- **测试基线**：cargo test 447（desktop/src-tauri）；desktop tsx 3 件 85 用例（根 e2e 入口）；server 侧若零 hunk 则 tsc 读数对照即可。

## 1. 目标形态

### A. 登录流统一出口 seam（唯一新模块）
- 新增 `desktop/src-tauri/src/sign_in.rs`：收拢六流公共骨——迟到保护 reserve 调用、Gate admit、generation 校验、Problem 映射归一、intent 标签（**仅枚举标签归一，不建全局 intent 对象**）。main.rs 六流臂判定原行迁入经 seam（MOD22 frontDoor 同手法）。
- **硬约束：行为零变化**——Problem 文案逐字节保留（用户可见合同）；流程时序零变化；失败路径零变化。
- **收拢范围择形**：普查复认后按真实公共面冻结，宁可小——若六流公共骨实际稀薄（各流协议异构），A 收缩为「现状钉+消费者映射登记」，如实报告，不为收口而抽象。

### B. 授权拼装去重（复认裁决）
- PKCE 对生成/授权参数拼装真重复块→提取共享 helper（pub(crate)，落点择形）；零重复→登记零命中。**禁**统一 Google/xAI 异构协议。

### C. 环境调用面钉固
- desktop_connection.rs client/poll ↔ server host-access 合同钉：lease 过期拒绝语义、token 头拼装单源、旧代次（generation）校验钉。重复拼装若存→收口；否则登记零命中。server 侧预期零 hunk。

### D. 范围切换清理钉（验收②）
- 清理矩阵钉：org_switch_cleanup（media/cache/subscriptions/org 凭据）+OrgLocalState 键形+秘密零入 DTO（ContextStatus 无 session 钉）。
- **旧流择形**：复认 renderer 流句柄（ask/answer_in 链）——跨切换存活流存在则最小失效（切换缝处取消，零新注册表抽象）；不存在则钉现状防回归。择形结论报报告障碍/登记节冻结。

### E. 测试
- cargo test 两侧对照（BASE=/tmp detached 基点树+IMPL；447 基线+新增钉全绿）。
- desktop tsx 3 件两侧对照（根 e2e 入口）。
- 新增 Rust #[test] 钉：seam 等价（六流经 seam 后行为钉）、reserve 迟到拒绝、generation 代次拒绝、清理矩阵、秘密零入 DTO。

## 2. owned_files（冻结——与普查交叉核对后）

- **全权新增**：`desktop/src-tauri/src/sign_in.rs`（含 #[cfg(test)] 钉）。
- **受限**：`desktop/src-tauri/src/main.rs`（六流臂改道+mod 登记）、`desktop/src-tauri/src/lib.rs`（mod 1 行）、`desktop/src-tauri/src/provider_oauth.rs`（B 去重若存）、`desktop/src-tauri/src/organization_auth.rs`（B 去重若存）、`desktop/src-tauri/src/desktop_connection.rs`（C 收口若存）、`desktop/src-tauri/src/org_switch_cleanup.rs`（D 择形若需）。
- **只读（硬边界）**：`server/**`（预期零 hunk）、`app/**`、`desktop/src/**`、`shared/**`、`toolkit/**`。事实不符→停下上报。

## 3. 验证门

cargo test 全量两侧对照（BASE 先跑；`cd desktop/src-tauri && cargo test`，PATH 前置 ~/.cargo/bin）；desktop tsx 3 件两侧对照（根 e2e 入口）；cargo fmt --check 我方文件零诊断；server tsc 0（若 server 零 hunk 则基点读数对照声明）；checker 646/0/0 不变（desktop 零簿记如实声明）；biome 不涉（无 ts 改动）；复跑独立落盘 `reports/mod20-verification/`（commands.md 台账，**NEW 列逐件填写**——MOD16 R1-F3 教训）。

## 4. 验收映射

①→A+E（gate 绑定/reserve 迟到/state 校验三钉）；②→D+E（清理矩阵+秘密零 DTO 钉）；③→C+E（lease 拒绝+generation 钉）；④→硬约束零协议变化（wire 文本钉+六流行为钉）。

## 5. 登记节（报告必含）

intent 对象化 defer（新抽象）；stream registry 缺口定性（择形结论）；broker 无 generation 定性（lease 语义覆盖）；「重复拼授权」复认裁决原文；旧流择形结论；desktop 不入 moduleRoots 的声明（若将来入根的归属建议）。
