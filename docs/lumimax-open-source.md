# lumimax 是否开源

核查日期：2026-11-25。只采用一手来源（官网、GitHub API 与仓库文件、包仓库）。搜索引擎摘要和社交媒体帖文只用来找线索，不作依据。

## 结论

**不是开源。** 与提问最可能对应的 "lumimax" 是海马云旗下的企业级 AI 知识库产品 lumimax（官网 <https://www.lumimax.ai/>）。它是一款闭源商业产品：官网没有给出任何源码仓库或许可证，GitHub 上找不到它的仓库，页脚写明 "© 2026 lumimax. All rights reserved."。它以托管服务（按积分付费）、MCP 接入和"私有化部署"三种方式交付，"私有化部署"是卖给企业的部署形态，不是公开源码。产品不发布模型权重，推理用的是第三方的 DeepSeek V4.1 Flash。另有一个同名的 macOS 应用 LumiMax（RamterStudio 出品的 MacBook 亮度提升工具），同样闭源。

## 1. lumimax 是什么（已核实，来源为官网）

| 项目 | 内容 | 来源 |
| --- | --- | --- |
| 产品 | 自称 "企业级 AI 知识库"、"面向 Agentic AI 的企业级可信知识库基础设施"，把长文档、图文、音视频等资料转成可检索、可溯源的知识 | <https://www.lumimax.ai/> |
| 归属 | "lumimax 是海马云旗下的企业级 AI 知识库产品"；"海马云成立于 2014 年，是国内较早大规模提供 GPUaaS 服务的公司之一" | <https://www.lumimax.ai/about> |
| 使用方式 | 网页端；"可在 WorkBuddy、Codex、Claude、DeepSeek Harness 等工具中接入 MCP" | <https://www.lumimax.ai/> |
| 计费 | 按积分一次性购买：$20 / 20,000 积分、$100 / 100,000 积分、$500 / 500,000 积分，"购买积分长期有效"、"不自动续费" | <https://www.lumimax.ai/> |
| 私有化部署 | "部署在企业自有服务器、私有云或 Kubernetes 集群中"，"以 DeepSeek V4.1 Flash 作为推理核心"，分单机与集群两种形态；流程为环境评估 → 模型接入 → 知识迁移 → 上线验证，入口是提交需求的表单 | <https://www.lumimax.ai/enterprise> |

**推断，官网正文没有明示**：法定主体应为 "安徽海马云科技股份有限公司"。依据只有私有化部署页表单里"公司/團隊名稱"字段的占位示例 "例如：安徽海马云科技股份有限公司"（文案键 `home.content.031`，位于 <https://lumimax-assets.xiaoyaoyou.com/overview-assets/bundles/marketing-copy-defaults-87ba43daa4ad663743c2bdbe2a982e05c1e3238d28465e4e39964cbe26e66048.js>）。

## 2. 源码是否公开

没有公开。逐项核查结果（2026-11-25）：

- **GitHub 仓库**：名称含 `lumimax` 的公开仓库只有 3 个，全部属于第 5 节的 macOS 应用（`Joowonoil/LumiMax`、`Joowonoil/homebrew-lumimax`、`Joowonoil/lumimax-site`）。搜 `lumimax.ai` 和 `lumimax 知识库` 都是 0 个结果；`lumimax in:name,description,readme` 共 8 个，都与 AI 知识库无关。来源：GitHub Search API（`gh api search/repositories`）。
- **GitHub 账号**：`lumimax`（唯一公开仓库 `VitroFlow`，MIT，培养皿照片种子计数，无关）、`lumimax-hub`（0 个公开仓库）、`Lumimax1`（0 个仓库）。
- **母公司名下的 GitHub 组织**：按名称能找到 `HAIMACloud`（6 个仓库，云游戏 SDK，都没有许可证文件，最后推送 2024-08-22）和 `haimayun`（1 个仓库 `CAA`），都没有 lumimax 相关仓库。这两个组织与 lumimax 的关系官网没有说明，按名称对应属于推断。
- **官网**：首页、关于页、私有化部署页都没有出现 "开源"、源码仓库或许可证的链接。三个页面的静态 HTML 里，除资源域名和语言切换外没有其他外链。首页引用的 9 个脚本包中检查了 5 个（含主包 `main-40ef4f8….js` 和文案包），GitHub / Hugging Face 链接只出现在评测记分板脚本里，且只指向评测所用的第三方数据集（WildGraphBench、RAMDocs、NoLiMa、MultiHop-RAG、OpenDocVQA、ViDoSeek），没有 lumimax 自己的仓库，也没有 npm / PyPI 包链接。来源：<https://lumimax-assets.xiaoyaoyou.com/overview-assets/bundles/>。
- **第二个官方域名**：<https://lumimax.haimacloud.com>（海马云名下，"面向复杂文档世界的大模型外部认知系统"）同样没有源码仓库、"开源"或许可证的链接。
- **包仓库**：npm 上 `lumimax` 返回 HTTP 404，PyPI 上 `lumimax` 返回 404。`@lumimax/cli`、`@lumimax/mcp` 也是 404，但这两个包名是我按惯例猜的，只说明这几个确切名字不存在。

## 3. 许可证

**没有任何许可证。** lumimax 没有公开的 LICENSE 文件，也没有声明采用 MIT、Apache-2.0 等任何许可。官网唯一的版权声明是页脚 "© 2026 lumimax. All rights reserved."（来源：<https://www.lumimax.ai/>，文案键 `common.navigation.008`）。这是"保留所有权利"的专有软件表述，不是 OSI 认可的开源许可，也不是 BSL、SSPL、Elastic License 这类"源码可见"许可，因为源码并不可见。

## 4. 模型权重

lumimax 是知识库系统，不是模型厂商，没有发布模型权重。私有化部署页写明模型层是 "DeepSeek V4.1 Flash"、"Embedding 模型"、"Reranker 模型"、"企业自有模型"，即使用第三方或企业自己的模型（来源：<https://www.lumimax.ai/enterprise>）。Hugging Face 没有单独搜索。

## 5. 同名的其他产品

**LumiMax（RamterStudio，macOS 应用），已核实，闭源。** 把 MacBook 屏幕亮度提升到 1600 nits 的菜单栏应用。

- 仓库 <https://github.com/Joowonoil/LumiMax> 只有两个文件：`LICENSE`（534 字节）和 `README.md`（7118 字节）。GitHub Languages API 返回空，没有任何源码。
- README 原文："This is the official release, documentation, and issue-tracking repository for LumiMax. The application is proprietary; its source code is not published here."
- LICENSE 原文（<https://github.com/Joowonoil/LumiMax/blob/main/LICENSE>）："Copyright (c) 2026 RamterStudio. All rights reserved. … No license is granted to copy, modify, distribute, or create derivative works from the LumiMax application, binaries, artwork, or repository materials, except as explicitly permitted by applicable law or a separate written agreement."
- GitHub 的许可证识别结果是 `Other` / `NOASSERTION`，不是 OSI 许可。
- 活跃度：4 star、0 fork，创建于 2026-03-04，最后推送 2026-07-14，标签 v1.3.2 到 v1.5.1，发布物只有 `LumiMax.dmg` 二进制。
- Pro 为一次性买断（Gumroad 或 Mac App Store，id6758426477），3 天试用。

**已排除的同名对象**：德国 LUMIMAX（lumimax.com，机器视觉 LED 光源，通用搜索里最靠前）、Lumimax Optoelectronics（lumimaxusa.com）、lumimaxled.com（LED 灯具）、Lumi Max 投影仪（Google TV）、Onyx BOOX Lumi Max 2 电纸书、游戏道具 LumiMax-6000，以及名称相近的 AI 公司 Luma AI、Lumax AI、Lumai。这些与"是否开源"无关，没有逐个核实。

## 6. 未能核实

- 有搜索结果摘要称一条 X 帖文（<https://x.com/xiaohu/status/2123645210697884105>）把 lumimax 描述为"开源"。该帖文无法读取（抓取被拦截），原文措辞和是否附带仓库链接都不知道，因此没有采信。它也不是一手来源。复核时两次搜索给出的该帖摘要意思一致：帖子把 lumimax 描述为面向 Agent 的企业级知识库，并提到现有开源方案在这类需求上效果不理想，是在与开源方案作对比，不是说 lumimax 自身开源。摘要是搜索引擎的转述，不是原文；原帖经 oembed 和 syndication 接口也取不到内容。
- 私有化部署的合同条款：是否交付源码、是否有源码托管、对自托管和二次开发有何限制，公开页面没有写，需要向厂商索取。
- 托管服务（`https://www.lumimax.ai/knowledgebase`）的用户协议和隐私条款没有读。
- 只查了 GitHub、npm、PyPI 和 Gitee；GitLab 没有搜索。GitHub 搜索只覆盖公开仓库。Gitee 复核（2026-11-25）：`GET https://gitee.com/api/v5/search/repositories?q=lumimax` 返回 0 个结果。
- 官网宣称的"8 项国际评测第一"不在本次问题范围内，没有核实。
