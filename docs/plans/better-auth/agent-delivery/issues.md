# Better Auth Issue 索引

静态计划与GitHub工作项入口；不代表实施完成。根Spec仍为候选，全部实施受G0约束。

| 工作项 | 标题 | GitHub |
| --- | --- | --- |
| ROOT | Better Auth完整改造根Spec | [#503](https://github.com/1123786563/OpenBot/issues/503) |
| G0 | 实施准备与批准门槛 | [#504](https://github.com/1123786563/OpenBot/issues/504) |
| T01 | 固定版本与可行性 | [#505](https://github.com/1123786563/OpenBot/issues/505) |
| T02 | 目录事务与前置迁移 | [#506](https://github.com/1123786563/OpenBot/issues/506) |
| T03 | 公司开通与可信选择 | [#507](https://github.com/1123786563/OpenBot/issues/507) |
| T04 | 邀请成员与账户恢复 | [#508](https://github.com/1123786563/OpenBot/issues/508) |
| T05 | 公司认证与全局身份 | [#509](https://github.com/1123786563/OpenBot/issues/509) |
| T06 | 业务准入与实际执行 | [#510](https://github.com/1123786563/OpenBot/issues/510) |
| T07 | 企业BFF三端与账务 | [#511](https://github.com/1123786563/OpenBot/issues/511) |
| T08 | 迁移恢复与统一验收 | [#512](https://github.com/1123786563/OpenBot/issues/512) |
| T01.01 | 让 Bun 清单与实际执行严格对账 | [#513](https://github.com/1123786563/OpenBot/issues/513) |
| T01.02 | 为 BA 套件提供独立数据库角色与真实 HTTP 夹具 | [#514](https://github.com/1123786563/OpenBot/issues/514) |
| T01.03 | 证明固定版 BA 同连接事务与邀请原错误保留 | [#515](https://github.com/1123786563/OpenBot/issues/515) |
| T01.04 | 证明延迟 hook 与邮件吞错均可被提交围栏控制 | [#516](https://github.com/1123786563/OpenBot/issues/516) |
| T01.05 | 证明普通成员的精确团队命令无需管理员会话 | [#517](https://github.com/1123786563/OpenBot/issues/517) |
| T01.06 | 证明 OIDC 原始签名证据可绑定公司挑战 | [#518](https://github.com/1123786563/OpenBot/issues/518) |
| T01.07 | 证明 SAML 原断言与 RelayState 可用于公司证明 | [#519](https://github.com/1123786563/OpenBot/issues/519) |
| T01.08 | 固定 BA UI 来源并接入现有 React Provider | [#520](https://github.com/1123786563/OpenBot/issues/520) |
| T01.09 | 接通固定 UI 的 Organization 与账户 client adapter | [#521](https://github.com/1123786563/OpenBot/issues/521) |
| T01.10 | 先交付子模块测试的根调度与固定白名单合同 | [#522](https://github.com/1123786563/OpenBot/issues/522) |
| T02.01 | 扩展 BA 目录与稳定业务 ID 映射 | [#523](https://github.com/1123786563/OpenBot/issues/523) |
| T02.02 | 建立 Principal 身份代际与持久资格 clock | [#524](https://github.com/1123786563/OpenBot/issues/524) |
| T02.03 | 建立命令终结、authority 与 outbox 持久模型 | [#525](https://github.com/1123786563/OpenBot/issues/525) |
| T02.04 | 为长期授权与个人模型凭据追加来源代际 | [#526](https://github.com/1123786563/OpenBot/issues/526) |
| T02.05 | 建立公司认证 challenge 与 proof 存储 | [#527](https://github.com/1123786563/OpenBot/issues/527) |
| T02.06 | 落实受限连接、DML guard 与延迟约束 | [#528](https://github.com/1123786563/OpenBot/issues/528) |
| T02.07 | 实现无公司前提的 PrincipalRegistry | [#529](https://github.com/1123786563/OpenBot/issues/529) |
| T02.08 | 完成 Directory 同事务命令 executor 与 finalizer | [#530](https://github.com/1123786563/OpenBot/issues/530) |
| T02.09 | 建立独立 Identity 命令与恢复事务内核 | [#531](https://github.com/1123786563/OpenBot/issues/531) |
| T02.10 | 产出 authority 分支与关闭的 CompanyAssurance | [#532](https://github.com/1123786563/OpenBot/issues/532) |
| T02.11 | 为原生 Admin/Organization 入口建立强制分类与读 gate | [#533](https://github.com/1123786563/OpenBot/issues/533) |
| T02.12 | 提供事务内 outbox 与 callback 完成 receipt 围栏 | [#534](https://github.com/1123786563/OpenBot/issues/534) |
| T02.13 | 交付 M0 目录与授权来源只读盘点 | [#535](https://github.com/1123786563/OpenBot/issues/535) |
| T02.14 | 实现 M1 expand 与 M2 停写回填工具 | [#536](https://github.com/1123786563/OpenBot/issues/536) |
| T02.15 | 交付 M3 对账与后续任务可复用 authority 矩阵 | [#537](https://github.com/1123786563/OpenBot/issues/537) |
| T03.01 | 让真实 Scope gate 比较持久身份和两层资格版本 | [#538](https://github.com/1123786563/OpenBot/issues/538) |
| T03.02 | 提供稳定 ID 的公司团队发现和选择校验接口 | [#539](https://github.com/1123786563/OpenBot/issues/539) |
| T03.03 | 从平台入口原子开通公司并固定 payer | [#540](https://github.com/1123786563/OpenBot/issues/540) |
| T03.04 | 实现公司暂停恢复及安全删除申请 | [#541](https://github.com/1123786563/OpenBot/issues/541) |
| T03.05 | 实现 Web 唯一公司团队切换协调器 | [#542](https://github.com/1123786563/OpenBot/issues/542) |
| T03.06 | 让 Web 缓存多标签和长流随选择代际清理 | [#543](https://github.com/1123786563/OpenBot/issues/543) |
| T03.07 | 接通真实 Web 壳和公司团队空态 | [#544](https://github.com/1123786563/OpenBot/issues/544) |
| T04.01 | 实现邀请创建取消重发与本人窄读 | [#545](https://github.com/1123786563/OpenBot/issues/545) |
| T04.02 | 实现邀请接受拒绝和首次主体原子建立 | [#546](https://github.com/1123786563/OpenBot/issues/546) |
| T04.03 | 实现成员暂停移除恢复和最后 owner 保护 | [#547](https://github.com/1123786563/OpenBot/issues/547) |
| T04.04 | 完成验证邮箱真实邮件与邀请前置闭环 | [#548](https://github.com/1123786563/OpenBot/issues/548) |
| T04.05 | 完成请求密码重置的 token 与邮件原子登记 | [#549](https://github.com/1123786563/OpenBot/issues/549) |
| T04.06 | 完成原生密码重置唯一消费与安全代际终结 | [#550](https://github.com/1123786563/OpenBot/issues/550) |
| T04.07 | 提供公司管理员授予撤销团队管理 Grant 的接口 | [#551](https://github.com/1123786563/OpenBot/issues/551) |
| T04.08 | 接通指定团队管理员成员增删命令 | [#552](https://github.com/1123786563/OpenBot/issues/552) |
| T04.09 | 接通公司资料与团队管理真实页面 | [#553](https://github.com/1123786563/OpenBot/issues/553) |
| T04.10 | 接通人员角色与团队管理 Grant UI | [#554](https://github.com/1123786563/OpenBot/issues/554) |
| T04.11 | 完成公开邀请落地与登录换账号恢复 | [#555](https://github.com/1123786563/OpenBot/issues/555) |
| T04.12 | 隔离默认与 BA Web 浏览器套件并审计 target | [#556](https://github.com/1123786563/OpenBot/issues/556) |
| T05.01 | 实现公司追加认证 challenge 的持久绑定 | [#557](https://github.com/1123786563/OpenBot/issues/557) |
| T05.02 | 接通 OIDC 公司证明原始证据回调 | [#558](https://github.com/1123786563/OpenBot/issues/558) |
| T05.03 | 接通 SAML 公司证明自有 SP 与 ACS | [#559](https://github.com/1123786563/OpenBot/issues/559) |
| T05.04 | 在目录与业务 gate 中实时验证公司证明 | [#560](https://github.com/1123786563/OpenBot/issues/560) |
| T05.05 | 把 SCIM 全方法接入原子目录命令 | [#561](https://github.com/1123786563/OpenBot/issues/561) |
| T05.06 | 把 JIT 与批准组规则接入单次团队能力 | [#562](https://github.com/1123786563/OpenBot/issues/562) |
| T05.07 | 接通全局禁用恢复角色与会话撤销真实入口 | [#563](https://github.com/1123786563/OpenBot/issues/563) |
| T05.08 | 接通平台用户创建资料编辑与管理员密码重置 | [#564](https://github.com/1123786563/OpenBot/issues/564) |
| T05.09 | 固定跨部署 issuer+subject 与原生回调身份 | [#565](https://github.com/1123786563/OpenBot/issues/565) |
| T05.10 | 让个人模型授权保存实时身份来源并安全重授权 | [#566](https://github.com/1123786563/OpenBot/issues/566) |
| T05.11 | 封闭已挂载 Bot Service claim 与 renew 身份旁路 | [#567](https://github.com/1123786563/OpenBot/issues/567) |
| T05.12 | 实现移动企业模式一次性 PKCE session 交接 | [#568](https://github.com/1123786563/OpenBot/issues/568) |
| T05.13 | 实现 BFF 每次动作的在线身份范围准入 | [#569](https://github.com/1123786563/OpenBot/issues/569) |
| T05.14 | 接通 Web 账户验证与忘记重置密码页面 | [#570](https://github.com/1123786563/OpenBot/issues/570) |
| T05.15 | 接通 Web 公司追加认证与受控恢复交互 | [#571](https://github.com/1123786563/OpenBot/issues/571) |
| T05.16 | 接通平台用户管理与会话安全页面 | [#572](https://github.com/1123786563/OpenBot/issues/572) |
| T06.01 | 让私有 Bot 与团队发布使用真实资源动作授权 | [#573](https://github.com/1123786563/OpenBot/issues/573) |
| T06.02 | 让会话与 Channel 操作检查创建者和对象动作 | [#574](https://github.com/1123786563/OpenBot/issues/574) |
| T06.03 | 在凭据 use 和明文披露前比较授权来源代际 | [#575](https://github.com/1123786563/OpenBot/issues/575) |
| T06.04 | 让 Memory 召回保留来源授权和个人隔离 | [#576](https://github.com/1123786563/OpenBot/issues/576) |
| T06.05 | 隔离插件安装实例与 Skills Components 资源 | [#577](https://github.com/1123786563/OpenBot/issues/577) |
| T06.06 | 实现逐 pull 准入的敏感文件下载代理 | [#578](https://github.com/1123786563/OpenBot/issues/578) |
| T06.07 | 把旧文件和产物路由逐项接入在线下载代理 | [#579](https://github.com/1123786563/OpenBot/issues/579) |
| T06.08 | 持久化 Run 的原始身份范围证明与 payer | [#580](https://github.com/1123786563/OpenBot/issues/580) |
| T06.09 | 在 Worker 领取重试恢复时重建持久 Run 范围 | [#581](https://github.com/1123786563/OpenBot/issues/581) |
| T06.10 | 在工具和凭据租约新动作前验证来源能力 | [#582](https://github.com/1123786563/OpenBot/issues/582) |
| T06.11 | 为实际网关提供个人 Key 在线身份准入 | [#583](https://github.com/1123786563/OpenBot/issues/583) |
| T06.12 | 在部署启用的 Bifrost dispatch 前接在线身份准入 | [#584](https://github.com/1123786563/OpenBot/issues/584) |
| T06.13 | 隔离浏览器沙箱池与外部可变状态 | [#585](https://github.com/1123786563/OpenBot/issues/585) |
| T06.14 | 让入站 webhook OAuth callback 和事件订阅固定归属 | [#586](https://github.com/1123786563/OpenBot/issues/586) |
| T06.15 | 隔离公司观测审计元数据与私有内容导出 | [#587](https://github.com/1123786563/OpenBot/issues/587) |
| T06.16 | 交付旧对象 URL 失效适配与 Computer 预览代理 | [#588](https://github.com/1123786563/OpenBot/issues/588) |
| T06.17 | 为共享审批持久化来源代际并在消费时重验 | [#589](https://github.com/1123786563/OpenBot/issues/589) |
| T06.18 | 封闭 Host 与外部执行租约的离线撤权窗口 | [#590](https://github.com/1123786563/OpenBot/issues/590) |
| T07.01 | 让公司财务入口消费独立财务 Grant | [#591](https://github.com/1123786563/OpenBot/issues/591) |
| T07.02 | 验证团队共用公司余额与禁用后历史费用归属 | [#592](https://github.com/1123786563/OpenBot/issues/592) |
| T07.03 | 在成员接受与真实资源动作 enforce 容量配额 | [#593](https://github.com/1123786563/OpenBot/issues/593) |
| T07.04 | 统一身份目录业务审计的失败与脱敏合同 | [#594](https://github.com/1123786563/OpenBot/issues/594) |
| T07.05 | 实现 OpenMuse 企业 session 与原 Workspace 映射 | [#595](https://github.com/1123786563/OpenBot/issues/595) |
| T07.06 | 接通企业 BFF 的真实 CopilotKit 流与运行准入 | [#596](https://github.com/1123786563/OpenBot/issues/596) |
| T07.07 | 接通 BFF 媒体票据在线读取与公司追加认证代理 | [#597](https://github.com/1123786563/OpenBot/issues/597) |
| T07.08 | 让 Desktop 唯一选择状态与本地缓存保持一致 | [#598](https://github.com/1123786563/OpenBot/issues/598) |
| T07.09 | 固定 Desktop 原生登录与追加认证 callback 意图 | [#599](https://github.com/1123786563/OpenBot/issues/599) |
| T07.10 | 接通真实 Mobile App 的企业 PKCE 登录与 MuseApi | [#600](https://github.com/1123786563/OpenBot/issues/600) |
| T07.11 | 让 Mobile 选择切换与 CopilotKit 流共享同一 session | [#601](https://github.com/1123786563/OpenBot/issues/601) |
| T07.12 | 接通 Mobile 公司追加认证深链与 PDF 媒体读取 | [#602](https://github.com/1123786563/OpenBot/issues/602) |
| T07.13 | 为真实 Mobile App 增加隔离浏览器入口和五链路验收 | [#603](https://github.com/1123786563/OpenBot/issues/603) |
| T07.14 | 把 Web Bot 和 Channel query mutation 接统一范围代际 | [#604](https://github.com/1123786563/OpenBot/issues/604) |
| T07.15 | 把 Memory Craft Workshop 与审批页面接范围和下载合同 | [#605](https://github.com/1123786563/OpenBot/issues/605) |
| T07.16 | 接通财务分权与观测页面并补真实业务浏览器矩阵 | [#606](https://github.com/1123786563/OpenBot/issues/606) |
| T07.17 | 让 BFF 邮件日历草稿会话和审批消费受控 namespace | [#607](https://github.com/1123786563/OpenBot/issues/607) |
| T07.18 | 让 BFF 浏览器与 Computer 控制逐动作在线准入 | [#608](https://github.com/1123786563/OpenBot/issues/608) |
| T07.19 | 把 BFF Google OAuth 与附件导入绑定原始企业意图 | [#609](https://github.com/1123786563/OpenBot/issues/609) |
| T08.01 | 扩充最终迁移模型并实现 M3→M4 原子权威切换 | [#610](https://github.com/1123786563/OpenBot/issues/610) |
| T08.02 | 实现不重置 clock 的投影重建与旧能力核验 | [#611](https://github.com/1123786563/OpenBot/issues/611) |
| T08.03 | 实现可信撤权高水位恢复与明确回退界限 | [#612](https://github.com/1123786563/OpenBot/issues/612) |
| T08.04 | 建立实际路由消费者与测试证据的版本化覆盖清单 | [#613](https://github.com/1123786563/OpenBot/issues/613) |
| T08.05 | 完成真实启动和 Worker 装配拒绝旁路 | [#614](https://github.com/1123786563/OpenBot/issues/614) |
| T08.06 | 独立验收真实数据库 IdP 邮件下载和实际网关 | [#615](https://github.com/1123786563/OpenBot/issues/615) |
| T08.07 | 独立验收真实 Web Desktop Mobile 与原生回调 | [#616](https://github.com/1123786563/OpenBot/issues/616) |
| T08.08 | 完成全范围独立 Review OCR 与发布准备交接 | [#617](https://github.com/1123786563/OpenBot/issues/617) |

每个实现Issue的完整本地Brief位于 `docs/plans/tickets/better-auth/TaskId.md`。Issue正文嵌入接口，GitHub原生依赖与静态计划一致。执行状态以GitHub+执行Ledger交叉核验，不把本索引作为通过报告。
