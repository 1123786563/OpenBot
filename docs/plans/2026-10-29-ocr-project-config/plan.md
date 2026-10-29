# OpenBot OCR 项目配置 Implementation Plan

> **For agentic workers:** Use the existing workspace for this configuration change; preserve previous uncommitted work. One independent review validates the final configuration and previews.

**Goal:** 按用户要求阅读已安装 OCR v1.13.3 的源码，为 OpenBot 默认配置代码审查范围和项目规则。

**Architecture:** 采用原生 `.opencodereview/rule.json`，不添加扫描包装器、不修改全局配置或 provider。显式排除文档、非代码配置/数据、运行证据、依赖及生成物；保留测试、脚本与 SQL 迁移。项目规则采用单条 catch-all 替换内置规则，避免同层首匹配丢失公共规则及内置 TypeScript 风格门槛引入噪声。

**Spec:** 当前用户请求“阅读OCR的源代码，怎么配置只对代码进行扫描，跳过文件之类的，而且需要配置针对当前项目的ocr规则”。

## Global Constraints

- 保留上一轮规则修改、已有未跟踪目录及子模块；不提交、推送、安装或启动全库 LLM 扫描。
- `include` 不是白名单，`exclude` 无 Gitignore 否定重纳入语义；不声称原生配置能对未来任意新类型实现严格白名单。
- 代码范围须以实际 review/scan preview 检验；被排除的配置/文档仍保留适用的验证及独立 Review。

## Review Focus

- 项目规则由 review 和 scan 自动加载，测试代码没有因内置默认排除而遗漏。
- 生成物、子模块、文档和敏感文件不会因 include 而重入。
- 迁移 SQL、运行脚本、前端和后端代码保留；子模块代码另在各仓库审查。
- 行为规则反映根 CONTEXT、已批准架构及现有前端约定，不审查文档排版或强推设计草稿。
- 全库只执行 preview，精确记录源码原生边界及 scan 必须从根目录/显式 --repo 运行。

### Task 1: 配置与验证

**Files:** 新增 `.opencodereview/rule.json`；同步 `.agents/rules/review.md` 的 OCR 代码范围；研究依据见 `source-notes.md`。

**Consumes:** v1.13.3 官方源码和当前项目约定。**Produces:** 原生过滤规则与可由 CLI 验证的项目审查规则。

- [ ] 核对官方 tag、选择器、规则解析、preview/scan 与工具读取边界。
- [ ] 新增配置并同步代码范围定义，避免仓库规则强制重新纳入 Markdown。
- [ ] 用实际 CLI 检查规则加载和 review/scan 预览，并在隔离样例中验证过滤边界。
- [ ] 独立核对配置、源码依据和验证证据；记录未执行全库 LLM 扫描及原生能力限制。
