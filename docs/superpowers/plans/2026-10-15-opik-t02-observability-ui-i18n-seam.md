# Opik T02 观测 UI 独立 i18n 子命名空间与路由约定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `ai-observability-runs` / `-datasets` / `-evaluations` / `-admin` 四个双子语命名空间与八类可用性状态文案，使四条前端链各自独占文案文件、可安全并行，并让「缺失 / 脱敏 / 同步中」等状态在界面上有明确且不混用的表达。

**Architecture:** 沿用仓库既有的静态 bundle 策略（`app/src/lib/i18n/index.ts` 的注释明确说明为什么不用 lazy loader：`changeLanguage` 会对当时存在的 resources 锁定 fallback chain，lazy 会输给一个它赢不了的竞态）。因此四个子命名空间必须**静态 import** 并注册进 `NAMESPACES` 与两个语言的 `resources`，同时在 `i18next.d.ts` 的 `CustomTypeOptions.resources` 里登记，让 `t("ai-observability-runs:availability.redacted")` 的错 key 变成编译错误而不是运行时 fallback。八类状态在四个命名空间里 key 完全一致，由一个 parity 测试强制。

**Tech Stack:** i18next 26 + react-i18next + TypeScript、`bun:test`、Biome、TanStack Router（文件路由，`routeTree.gen.ts` 为生成物）。

**Spec:** `docs/specs/2026-10-14-opik-integration-design.md`（Implementation Decision 15「User experience」）；Ticket：https://github.com/1123786563/OpenBot/issues/8 ；父 Spec：https://github.com/1123786563/OpenBot/issues/4 的 A5 与状态文案要求。

## Global Constraints

- 覆盖父 Spec 验收：**A5**（状态文案层）。
- 只允许改：`app/src/locales/en/ai-observability-{runs,datasets,evaluations,admin}.json`、`app/src/locales/zh-CN/ai-observability-{runs,datasets,evaluations,admin}.json`、`app/src/lib/i18n/index.ts`、`app/src/lib/i18n/i18next.d.ts`、`app/src/lib/i18n/ai-observability.test.ts`。**共 11 个文件**（超过 O1 的 ≤8，已在 `docs/tickets/opik-4/manifest.json` 的 `documented_deviations` 记录：其中 8 个是极小 JSON、2 个是注册行）。
- 不得编辑既有共享文案文件 `agents.json` / `errors.json` / `admin.json` / `nav.json` / `common.json`。这是本 Ticket 存在的理由。
- 必须静态 import，不得引入 lazy bundle loader（`index.ts` 的既有注释已说明 lazy 会导致切换语言后界面停留在英文）。
- `en` 是 key 的事实源，`zh-CN` 按 key 逐一 fallback；但本 Ticket 要求两者 **key 集合完全相同**，八类状态都必须有中文，不允许留空字符串。
- 八类状态固定为：`disabled`、`empty`、`forbidden`、`basic`、`omitted`、`truncated`、`syncing`、`unavailable`。语义不得混用（见父 Spec Decision 15）。
- 本 Ticket **不建路由文件**、**不写组件**、**不定义 state→文案 的映射函数**。路由约定以文档形式交付；映射函数由 #18（T12）在需要它的组件里实现。这是为了让 T02 不与 #18 争用 `app/src/components/ai-observability/availability.tsx`。
- 路由命名约定（交付物，写进 `index.ts` 注释与本计划）：Bot 维度 `/_authed/_app/bots/$agentId/runs` 与 `/_authed/_app/bots/$agentId/runs/$bindingId`、`/_authed/_app/bots/$agentId/evaluations`；管理维度 `/_authed/admin/ai-observability`。

## File Structure

| 文件 | 责任 |
| --- | --- |
| `app/src/locales/en/ai-observability-runs.json` | 运行列表/详情/步骤树链的英文文案（#18 #19 #24 独占写） |
| `app/src/locales/en/ai-observability-datasets.json` | 评测集链的英文文案（#27 独占写） |
| `app/src/locales/en/ai-observability-evaluations.json` | 实验与对比链的英文文案（#36 #37 独占写） |
| `app/src/locales/en/ai-observability-admin.json` | 管理汇总与导出状态链的英文文案（#42 独占写） |
| `app/src/locales/zh-CN/ai-observability-*.json` | 上述四者的中文对应 |
| `app/src/lib/i18n/index.ts` | 8 个静态 import + `NAMESPACES` 追加 4 项 + 两个语言的 `resources` 各追加 4 项 + 路由约定注释 |
| `app/src/lib/i18n/i18next.d.ts` | 4 个 `import type` + `CustomTypeOptions.resources` 追加 4 项 |
| `app/src/lib/i18n/ai-observability.test.ts` | 强制注册、双语 key parity、八类状态齐备且文案互不相同 |

---

### Task 1: 四个英文命名空间的八类状态文案

**Files:**
- Create: `app/src/locales/en/ai-observability-runs.json`
- Create: `app/src/locales/en/ai-observability-datasets.json`
- Create: `app/src/locales/en/ai-observability-evaluations.json`
- Create: `app/src/locales/en/ai-observability-admin.json`

**Interfaces:**
- Consumes: 无（本 Ticket 是链条起点）。
- Produces:
  - 每个命名空间的 `availability` 对象，固定 8 个 key：`disabled` `empty` `forbidden` `basic` `omitted` `truncated` `syncing` `unavailable`，每个 key 下 `{ title, description }`
  - 每个命名空间的 `meta.namespace` 字符串，值等于命名空间名本身（供 parity 测试断言归属矩阵）

- [ ] **Step 1: 创建 `app/src/locales/en/ai-observability-runs.json`**

```json
{
  "meta": {
    "namespace": "ai-observability-runs",
    "ownedBy": "#18 #19 #24 (run list, run detail, step tree)"
  },
  "availability": {
    "disabled": {
      "title": "Run tracing is off",
      "description": "Observability is disabled for this deployment, so no runs are recorded. Existing Bot execution is unaffected."
    },
    "empty": {
      "title": "No runs yet",
      "description": "This Bot has not recorded a run. Start a conversation, then reload this page."
    },
    "forbidden": {
      "title": "You cannot observe this Bot",
      "description": "Observation needs management rights on the Bot. Being able to chat with it, or a public share link, is not enough."
    },
    "basic": {
      "title": "Basic coverage only",
      "description": "Only what OpenBot itself observed is recorded. Steps inside this remote Agent are not visible, and their absence is not evidence they did not happen."
    },
    "omitted": {
      "title": "Content omitted",
      "description": "This field could not be handled safely, so only metrics are shown. Omitted is not the same as empty."
    },
    "truncated": {
      "title": "Content truncated",
      "description": "This value exceeds the recorded size limit and was cut. The stored record is shorter than what the run actually produced."
    },
    "syncing": {
      "title": "Still syncing",
      "description": "The run finished but its record has not been confirmed upstream yet. Reload shortly."
    },
    "unavailable": {
      "title": "Upstream unavailable",
      "description": "The observability store did not answer. Your conversation result was not affected. This is a fault, not an empty list."
    }
  }
}
```

- [ ] **Step 2: 创建 `app/src/locales/en/ai-observability-datasets.json`**

与 Step 1 结构完全相同（同样的 8 个 key、同样的 `title`/`description` 两层），只有 `meta` 不同，且 `empty` / `forbidden` 的文案针对评测集：

```json
{
  "meta": {
    "namespace": "ai-observability-datasets",
    "ownedBy": "#27 (dataset review, save, versions)"
  },
  "availability": {
    "disabled": {
      "title": "Evaluation is off",
      "description": "Observability is disabled for this deployment, so datasets cannot be built from runs."
    },
    "empty": {
      "title": "No dataset versions yet",
      "description": "Save a reviewed case from a run, or add a reviewed synthetic example, to create the first frozen version."
    },
    "forbidden": {
      "title": "You cannot manage this dataset",
      "description": "Datasets follow the Bot's management rights. Reuse across Bots needs an explicit authorized copy."
    },
    "basic": {
      "title": "Metrics-only source",
      "description": "The source run recorded metrics only. It cannot become a text sample; supply a reviewed synthetic or redacted example instead."
    },
    "omitted": {
      "title": "Content omitted",
      "description": "This field could not be handled safely, so only metrics are shown. Omitted is not the same as empty."
    },
    "truncated": {
      "title": "Content truncated",
      "description": "This value exceeds the recorded size limit and was cut. A frozen version keeps the truncated value as saved."
    },
    "syncing": {
      "title": "Version still syncing",
      "description": "The version was accepted locally but is not confirmed upstream yet. Syncing is not success."
    },
    "unavailable": {
      "title": "Upstream unavailable",
      "description": "The observability store did not answer, so this version cannot be read right now. Nothing was deleted."
    }
  }
}
```

- [ ] **Step 3: 创建 `app/src/locales/en/ai-observability-evaluations.json`**

```json
{
  "meta": {
    "namespace": "ai-observability-evaluations",
    "ownedBy": "#36 #37 (experiment submit/results, comparison)"
  },
  "availability": {
    "disabled": {
      "title": "Evaluation is off",
      "description": "Observability is disabled for this deployment, so experiments cannot run."
    },
    "empty": {
      "title": "No experiments yet",
      "description": "Pick a frozen dataset version and a Bot configuration to submit the first experiment."
    },
    "forbidden": {
      "title": "You cannot run this experiment",
      "description": "Experiments follow the Bot's management rights and are re-checked before every sample."
    },
    "basic": {
      "title": "Score unavailable for this sample",
      "description": "The sample produced no score. A missing score is not a zero, and it is excluded from the average rather than counted as a failure."
    },
    "omitted": {
      "title": "Content omitted",
      "description": "This field could not be handled safely, so only metrics are shown. Omitted is not the same as empty."
    },
    "truncated": {
      "title": "Content truncated",
      "description": "This value exceeds the recorded size limit and was cut."
    },
    "syncing": {
      "title": "Results still syncing",
      "description": "The experiment finished but its scores are not confirmed upstream yet. Syncing is not success."
    },
    "unavailable": {
      "title": "Upstream unavailable",
      "description": "The observability store did not answer. Runs already in flight kept their hold; nothing was released or double-charged."
    }
  }
}
```

- [ ] **Step 4: 创建 `app/src/locales/en/ai-observability-admin.json`**

```json
{
  "meta": {
    "namespace": "ai-observability-admin",
    "ownedBy": "#42 (admin summary, ingest faults, export status)"
  },
  "availability": {
    "disabled": {
      "title": "Observability is off",
      "description": "The integration is disabled, so there is nothing to collect. This is a configuration state, not a fault."
    },
    "empty": {
      "title": "Nothing in scope",
      "description": "No runs or experiments match this filter inside your authorized scope."
    },
    "forbidden": {
      "title": "Outside your scope",
      "description": "Your administrative role does not cover this data. Scope is resolved before any aggregation, never after."
    },
    "basic": {
      "title": "Basic coverage only",
      "description": "These records hold only what OpenBot observed. A basic record is not a healthy detailed record."
    },
    "omitted": {
      "title": "Content omitted",
      "description": "This field could not be handled safely, so only metrics are shown."
    },
    "truncated": {
      "title": "Content truncated",
      "description": "This value exceeds the recorded size limit and was cut."
    },
    "syncing": {
      "title": "Ingest lagging",
      "description": "Records are arriving later than the runs that produced them. Lag is visible here rather than shown as missing traffic."
    },
    "unavailable": {
      "title": "Upstream unavailable",
      "description": "The observability store did not answer. Normal Agent execution continued unaffected; drops and faults are reported here."
    }
  }
}
```

- [ ] **Step 5: 校验四个文件是 JSON 且 key 齐备**

Run:
```bash
for n in runs datasets evaluations admin; do
  python3 -c "
import json,sys
d=json.load(open('app/src/locales/en/ai-observability-$n.json'))
assert d['meta']['namespace']=='ai-observability-$n', d['meta']
ks=sorted(d['availability'])
want=sorted(['disabled','empty','forbidden','basic','omitted','truncated','syncing','unavailable'])
assert ks==want, (ks, want)
assert all(v['title'].strip() and v['description'].strip() for v in d['availability'].values())
print('en ai-observability-$n OK', len(ks), 'states')
"
done
```
Expected: 四行 `... OK 8 states`

- [ ] **Step 6: 提交**

```bash
git add app/src/locales/en/ai-observability-*.json
git commit -m "feat(opik): English copy for the four observation i18n sub-namespaces"
```

---

### Task 2: 四个中文命名空间（key 集合必须与英文完全一致）

**Files:**
- Create: `app/src/locales/zh-CN/ai-observability-runs.json`
- Create: `app/src/locales/zh-CN/ai-observability-datasets.json`
- Create: `app/src/locales/zh-CN/ai-observability-evaluations.json`
- Create: `app/src/locales/zh-CN/ai-observability-admin.json`

**Interfaces:**
- Consumes: Task 1 的英文 key 结构（key 名必须逐字相同，只有 value 是中文）。
- Produces: 四个中文 bundle，`meta.ownedBy` 与英文一致。

- [ ] **Step 1: 创建 `app/src/locales/zh-CN/ai-observability-runs.json`**

```json
{
  "meta": {
    "namespace": "ai-observability-runs",
    "ownedBy": "#18 #19 #24 (run list, run detail, step tree)"
  },
  "availability": {
    "disabled": {
      "title": "运行追踪已关闭",
      "description": "本部署未启用可观测性，因此不会记录运行。Bot 的现有执行不受影响。"
    },
    "empty": {
      "title": "还没有运行记录",
      "description": "这个 Bot 尚未记录到运行。先发起一次对话，再刷新本页。"
    },
    "forbidden": {
      "title": "你无权查看这个 Bot 的观测数据",
      "description": "查看观测数据需要对该 Bot 的管理权。能和它聊天、或持有公开分享链接，都不构成权限。"
    },
    "basic": {
      "title": "仅基础覆盖",
      "description": "只记录了 OpenBot 自身观察到的内容。该远程 Agent 内部的步骤不可见，看不到不等于没有发生。"
    },
    "omitted": {
      "title": "内容已省略",
      "description": "该字段无法被可靠处理，因此只展示指标。省略不等于为空。"
    },
    "truncated": {
      "title": "内容已截断",
      "description": "该值超过记录长度上限并被截断，存储内容短于运行实际产生的内容。"
    },
    "syncing": {
      "title": "仍在同步",
      "description": "运行已结束，但记录尚未在上游确认。请稍后刷新。"
    },
    "unavailable": {
      "title": "上游不可用",
      "description": "可观测性存储没有响应。你的对话结果未受影响。这是故障，不是空列表。"
    }
  }
}
```

- [ ] **Step 2: 创建 `app/src/locales/zh-CN/ai-observability-datasets.json`**

```json
{
  "meta": {
    "namespace": "ai-observability-datasets",
    "ownedBy": "#27 (dataset review, save, versions)"
  },
  "availability": {
    "disabled": {
      "title": "评测已关闭",
      "description": "本部署未启用可观测性，因此无法从运行记录建立评测集。"
    },
    "empty": {
      "title": "还没有评测集版本",
      "description": "从运行中保存一个已审查案例，或添加一个已审查的合成案例，即可建立第一个冻结版本。"
    },
    "forbidden": {
      "title": "你无权管理这个评测集",
      "description": "评测集遵循 Bot 的管理权。跨 Bot 复用需要显式的授权复制。"
    },
    "basic": {
      "title": "来源仅有指标",
      "description": "该来源运行只记录了指标，不能变成文本样本；请改为提供已审查的合成或脱敏案例。"
    },
    "omitted": {
      "title": "内容已省略",
      "description": "该字段无法被可靠处理，因此只展示指标。省略不等于为空。"
    },
    "truncated": {
      "title": "内容已截断",
      "description": "该值超过记录长度上限并被截断。冻结版本按保存时的截断值保留。"
    },
    "syncing": {
      "title": "版本仍在同步",
      "description": "版本已在本地接受，但尚未在上游确认。同步中不等于成功。"
    },
    "unavailable": {
      "title": "上游不可用",
      "description": "可观测性存储没有响应，暂时读不到该版本。没有任何数据被删除。"
    }
  }
}
```

- [ ] **Step 3: 创建 `app/src/locales/zh-CN/ai-observability-evaluations.json`**

```json
{
  "meta": {
    "namespace": "ai-observability-evaluations",
    "ownedBy": "#36 #37 (experiment submit/results, comparison)"
  },
  "availability": {
    "disabled": {
      "title": "评测已关闭",
      "description": "本部署未启用可观测性，因此无法运行实验。"
    },
    "empty": {
      "title": "还没有实验",
      "description": "选择一个冻结的数据集版本和一份 Bot 配置，即可提交第一个实验。"
    },
    "forbidden": {
      "title": "你无权运行这个实验",
      "description": "实验遵循 Bot 的管理权，并且在每个样本执行前重新校验。"
    },
    "basic": {
      "title": "该样本没有评分",
      "description": "该样本未产生评分。缺失评分不是 0 分，它会被排除在平均值之外，而不是记为失败。"
    },
    "omitted": {
      "title": "内容已省略",
      "description": "该字段无法被可靠处理，因此只展示指标。省略不等于为空。"
    },
    "truncated": {
      "title": "内容已截断",
      "description": "该值超过记录长度上限并被截断。"
    },
    "syncing": {
      "title": "结果仍在同步",
      "description": "实验已结束，但评分尚未在上游确认。同步中不等于成功。"
    },
    "unavailable": {
      "title": "上游不可用",
      "description": "可观测性存储没有响应。进行中的运行仍保持预留占用，没有释放也没有重复扣费。"
    }
  }
}
```

- [ ] **Step 4: 创建 `app/src/locales/zh-CN/ai-observability-admin.json`**

```json
{
  "meta": {
    "namespace": "ai-observability-admin",
    "ownedBy": "#42 (admin summary, ingest faults, export status)"
  },
  "availability": {
    "disabled": {
      "title": "可观测性已关闭",
      "description": "集成未启用，因此没有需要采集的内容。这是配置状态，不是故障。"
    },
    "empty": {
      "title": "范围内没有数据",
      "description": "在你被授权的范围里，没有符合该筛选条件的运行或实验。"
    },
    "forbidden": {
      "title": "超出你的管理范围",
      "description": "你的管理角色不覆盖这些数据。范围在任何聚合之前解析，绝不之后。"
    },
    "basic": {
      "title": "仅基础覆盖",
      "description": "这些记录只包含 OpenBot 观察到的内容。基础记录不等于健康的详细记录。"
    },
    "omitted": {
      "title": "内容已省略",
      "description": "该字段无法被可靠处理，因此只展示指标。"
    },
    "truncated": {
      "title": "内容已截断",
      "description": "该值超过记录长度上限并被截断。"
    },
    "syncing": {
      "title": "采集有延迟",
      "description": "记录到达时间晚于产生它们的运行。延迟在这里可见，而不是表现为流量缺失。"
    },
    "unavailable": {
      "title": "上游不可用",
      "description": "可观测性存储没有响应。正常 Agent 执行未受影响；丢弃与故障在此上报。"
    }
  }
}
```

- [ ] **Step 5: 校验中英 key 集合逐字相同**

Run:
```bash
for n in runs datasets evaluations admin; do
  python3 -c "
import json
en=json.load(open('app/src/locales/en/ai-observability-$n.json'))
zh=json.load(open('app/src/locales/zh-CN/ai-observability-$n.json'))
def flat(d,p=''):
    out={}
    for k,v in d.items():
        key=f'{p}.{k}' if p else k
        if isinstance(v,dict): out.update(flat(v,key))
        else: out[key]=v
    return out
fe,fz=flat(en),flat(zh)
assert sorted(fe)==sorted(fz), (set(fe)^set(fz))
assert all(str(v).strip() for v in fz.values()), 'empty zh value'
print('parity OK ai-observability-$n', len(fe), 'keys')
"
done
```
Expected: 四行 `parity OK ... 18 keys`（`meta` 2 + `availability` 8×2）

- [ ] **Step 6: 提交**

```bash
git add app/src/locales/zh-CN/ai-observability-*.json
git commit -m "feat(opik): zh-CN copy for the four observation i18n sub-namespaces"
```

---

### Task 3: 注册命名空间（静态 import + NAMESPACES + resources + 类型）

**Files:**
- Modify: `app/src/lib/i18n/index.ts`
- Modify: `app/src/lib/i18n/i18next.d.ts`

**Interfaces:**
- Consumes: Task 1/2 的 8 个 JSON bundle。
- Produces:
  - `NAMESPACES` 追加 4 项：`"ai-observability-runs"`、`"ai-observability-datasets"`、`"ai-observability-evaluations"`、`"ai-observability-admin"`（因此 `Namespace` 联合类型自动扩展）
  - 运行时 `resources.en` 与 `resources["zh-CN"]` 各追加 4 个 bundle
  - `i18next.CustomTypeOptions.resources` 追加 4 项，使 `t("ai-observability-runs:availability.empty.title")` 获得编译期 key 校验

- [ ] **Step 1: 在 `app/src/lib/i18n/index.ts` 加 8 个静态 import**

按既有字母序插入到对应位置（`admin` 之后、`agents` 之前是 `ai-observability-*` 的自然位置）：

```ts
import aiObservabilityAdmin from "../../locales/en/ai-observability-admin.json";
import aiObservabilityDatasets from "../../locales/en/ai-observability-datasets.json";
import aiObservabilityEvaluations from "../../locales/en/ai-observability-evaluations.json";
import aiObservabilityRuns from "../../locales/en/ai-observability-runs.json";
```

以及 zh-CN 段（`zhAdmin` 之后）：

```ts
import zhAiObservabilityAdmin from "../../locales/zh-CN/ai-observability-admin.json";
import zhAiObservabilityDatasets from "../../locales/zh-CN/ai-observability-datasets.json";
import zhAiObservabilityEvaluations from "../../locales/zh-CN/ai-observability-evaluations.json";
import zhAiObservabilityRuns from "../../locales/zh-CN/ai-observability-runs.json";
```

- [ ] **Step 2: 在 `NAMESPACES` 数组末尾（`"craft"` 之后）追加 4 项**

```ts
  "craft",
  /*
   * Observation is split into four sub-namespaces on purpose, not one: the run chain (#18 #19 #24),
   * the dataset chain (#27), the experiment chain (#36 #37) and the admin chain (#42) are pairwise
   * independent in the ticket graph, so they can be dispatched in parallel. One shared bundle would
   * put four agents in the same JSON file; four bundles give each chain a file it owns alone.
   * Route convention these pages use:
   *   /_authed/_app/bots/$agentId/runs              (list)
   *   /_authed/_app/bots/$agentId/runs/$bindingId   (detail)
   *   /_authed/_app/bots/$agentId/evaluations       (datasets + experiments)
   *   /_authed/admin/ai-observability               (admin summary + export status)
   */
  "ai-observability-runs",
  "ai-observability-datasets",
  "ai-observability-evaluations",
  "ai-observability-admin",
] as const;
```

- [ ] **Step 3: 在 `resources.en` 里追加 4 项**

在 `craft,` 之后：

```ts
        craft,
        "ai-observability-runs": aiObservabilityRuns,
        "ai-observability-datasets": aiObservabilityDatasets,
        "ai-observability-evaluations": aiObservabilityEvaluations,
        "ai-observability-admin": aiObservabilityAdmin,
      },
```

- [ ] **Step 4: 在 `resources["zh-CN"]` 里追加 4 项**

在该语言段的 `craft: zhCraft,` 之后：

```ts
        craft: zhCraft,
        "ai-observability-runs": zhAiObservabilityRuns,
        "ai-observability-datasets": zhAiObservabilityDatasets,
        "ai-observability-evaluations": zhAiObservabilityEvaluations,
        "ai-observability-admin": zhAiObservabilityAdmin,
      },
```

- [ ] **Step 5: 在 `app/src/lib/i18n/i18next.d.ts` 加 4 个 `import type` 与 4 个 resources 条目**

import 段（`admin` 之后）：

```ts
import type aiObservabilityAdmin from "../../locales/en/ai-observability-admin.json";
import type aiObservabilityDatasets from "../../locales/en/ai-observability-datasets.json";
import type aiObservabilityEvaluations from "../../locales/en/ai-observability-evaluations.json";
import type aiObservabilityRuns from "../../locales/en/ai-observability-runs.json";
```

`CustomTypeOptions.resources` 段（`craft: typeof craft;` 之后）：

```ts
      craft: typeof craft;
      "ai-observability-runs": typeof aiObservabilityRuns;
      "ai-observability-datasets": typeof aiObservabilityDatasets;
      "ai-observability-evaluations": typeof aiObservabilityEvaluations;
      "ai-observability-admin": typeof aiObservabilityAdmin;
```

- [ ] **Step 6: 类型检查**

Run: `cd app && bun run typecheck`
Expected: 无错误。若报 `craft` 之后的多余逗号或 resources key 需要引号，按 TS 提示修正；不得改动既有命名空间顺序。

- [ ] **Step 7: 提交**

```bash
git add app/src/lib/i18n/index.ts app/src/lib/i18n/i18next.d.ts
git commit -m "feat(opik): register the four observation i18n sub-namespaces statically"
```

---

### Task 4: parity 测试 —— 注册、双语 key 一致、八类状态互不相同

**Files:**
- Create: `app/src/lib/i18n/ai-observability.test.ts`

**Interfaces:**
- Consumes: `NAMESPACES` from `./index`；8 个 JSON bundle。
- Produces: 一个会因任何一条约定被破坏而失败的测试文件；后续 Ticket 增删 key 时它是护栏。

- [ ] **Step 1: 写测试**

创建 `app/src/lib/i18n/ai-observability.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import enAdmin from "../../locales/en/ai-observability-admin.json";
import enDatasets from "../../locales/en/ai-observability-datasets.json";
import enEvaluations from "../../locales/en/ai-observability-evaluations.json";
import enRuns from "../../locales/en/ai-observability-runs.json";
import zhAdmin from "../../locales/zh-CN/ai-observability-admin.json";
import zhDatasets from "../../locales/zh-CN/ai-observability-datasets.json";
import zhEvaluations from "../../locales/zh-CN/ai-observability-evaluations.json";
import zhRuns from "../../locales/zh-CN/ai-observability-runs.json";
import { NAMESPACES } from "./index";

/**
 * The eight states the parent Spec requires the UI to distinguish. They are asserted as a set
 * here so a later ticket cannot quietly drop one, or reuse `empty` for `omitted` — the Spec's
 * point is that "no data", "withheld on purpose" and "the store did not answer" are three
 * different facts about the product.
 */
const STATES = [
  "disabled",
  "empty",
  "forbidden",
  "basic",
  "omitted",
  "truncated",
  "syncing",
  "unavailable",
] as const;

const BUNDLES = [
  { ns: "ai-observability-runs", en: enRuns, zh: zhRuns },
  { ns: "ai-observability-datasets", en: enDatasets, zh: zhDatasets },
  { ns: "ai-observability-evaluations", en: enEvaluations, zh: zhEvaluations },
  { ns: "ai-observability-admin", en: enAdmin, zh: zhAdmin },
] as const;

function flatKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("observation i18n sub-namespaces", () => {
  test("all four are registered, so a lazy fallback chain cannot strand them in English", () => {
    for (const { ns } of BUNDLES) {
      expect(NAMESPACES).toContain(ns);
    }
  });

  test("each bundle declares which ticket chain owns it", () => {
    for (const { ns, en } of BUNDLES) {
      expect(en.meta.namespace).toBe(ns);
      expect(en.meta.ownedBy.length).toBeGreaterThan(0);
    }
  });

  test("every bundle carries all eight availability states", () => {
    for (const { ns, en, zh } of BUNDLES) {
      expect(Object.keys(en.availability).sort()).toEqual([...STATES].sort());
      expect(Object.keys(zh.availability).sort()).toEqual([...STATES].sort());
      for (const state of STATES) {
        expect(en.availability[state].title.trim().length, `${ns}/${state} en title`).toBeGreaterThan(0);
        expect(zh.availability[state].title.trim().length, `${ns}/${state} zh title`).toBeGreaterThan(0);
        expect(en.availability[state].description.trim().length, `${ns}/${state} en description`).toBeGreaterThan(0);
        expect(zh.availability[state].description.trim().length, `${ns}/${state} zh description`).toBeGreaterThan(0);
      }
    }
  });

  test("en and zh-CN key sets are identical per namespace", () => {
    for (const { ns, en, zh } of BUNDLES) {
      expect(flatKeys(zh).sort(), `${ns} key parity`).toEqual(flatKeys(en).sort());
    }
  });

  test("the eight states are not copy-paste collisions within a namespace", () => {
    for (const { ns, en } of BUNDLES) {
      const titles = STATES.map((state) => en.availability[state].title);
      expect(new Set(titles).size, `${ns} titles must be distinct`).toBe(STATES.length);
    }
  });

  test("omitted, empty and unavailable stay three different facts", () => {
    for (const { ns, en } of BUNDLES) {
      const { empty, omitted, unavailable, syncing } = en.availability;
      expect(omitted.title).not.toBe(empty.title);
      expect(unavailable.title).not.toBe(empty.title);
      expect(syncing.title).not.toBe(unavailable.title);
      expect(omitted.description).not.toBe(unavailable.description);
      expect(ns.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `bun test app/src/lib/i18n/ai-observability.test.ts`
Expected: PASS — 6 tests

> 这一步是 GREEN 而不是 RED：Task 1–3 已经把内容与注册做完，本测试是护栏。若它 FAIL，说明 Task 1–3 有遗漏（最常见是漏了一个 state 或中英 key 不一致），回到对应 Task 修，不要改测试放宽断言。

- [ ] **Step 3: 前端构建与格式检查**

Run: `cd app && bun run typecheck && cd .. && bunx biome lint --error-on-warnings app/src/lib/i18n app/src/locales && bunx biome format app/src/lib/i18n app/src/locales`
Expected: typecheck 无错误；lint 无 error/warning；format 无改动或已格式化

Run: `cd app && bun run build`
Expected: 构建成功（静态 import 的 4 个 bundle 进入产物）

- [ ] **Step 4: 提交**

```bash
git add app/src/lib/i18n/ai-observability.test.ts
git commit -m "test(opik): guard the observation i18n sub-namespaces and the eight availability states"
```

---

## Self-Review

**Spec coverage（Ticket #8 的 4 条验收标准）**
1. 「文案按运行、评测集、实验、管理拆成四个双子语命名空间，四条前端链各自独占文案文件，不编辑既有共享文案文件，也不彼此冲突」→ Task 1/2 建 8 个文件，Task 3 注册，Task 4 的 `meta.ownedBy` 断言把归属矩阵变成可执行契约；Global Constraints 明令禁止编辑 `agents.json`/`errors.json`。
2. 「八类状态在英文与中文均有明确文案且语义不混用」→ Task 4 的 “carries all eight”、“distinct titles”、“omitted/empty/unavailable 三个不同事实” 三条测试。
3. 「四个子命名空间的归属矩阵写入交接说明，接手 agent 不会写错文件」→ `index.ts` 的 `NAMESPACES` 注释（含路由约定）+ 每个 bundle 的 `meta.ownedBy` + Task 4 的断言。
4. 「Bot 维度与管理维度路由约定确定并可被后续页面直接复用；直接输入路由时仍执行权限校验」→ 路由约定在 `index.ts` 注释与本计划 Global Constraints 中交付。**注意：本条的“直接输入路由仍执行权限校验”无法在 T02 验证，因为路由要到 #18 才存在；该子句已记录在 `docs/tickets/opik-4/manifest.json` 的 `documented_deviations`，必须在 #18 验证，不得在本 Ticket 记为通过。**

**Placeholder scan**：无 TBD / TODO；8 个 JSON 的完整内容都已给出（这是本 Ticket 的全部交付物，不能省略）；测试代码完整可跑。

**Type consistency**：`NAMESPACES` 追加后 `Namespace` 联合类型自动扩展（既有 `export type Namespace = (typeof NAMESPACES)[number]`），无需另改；`i18next.d.ts` 的 `resources` key 与 `index.ts` 的 `resources` key 逐字相同（均为带连字符的字符串字面量，需引号）；测试里 `BUNDLES` 的 `ns` 值与 JSON 的 `meta.namespace` 一致，由 “declares which ticket chain owns it” 测试锁定。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-15-opik-t02-observability-ui-i18n-seam.md`. Two execution options:

1. **Subagent-Driven (recommended)** — 每个 Task 派发新的 subagent，Task 之间 review。
2. **Inline Execution** — 本会话内按 executing-plans 批量执行并设检查点。

完成后把提交哈希与文件清单填入 `docs/tickets/opik-4/manifest.json` 的 `T02.handoff.checkpoint`，并在 GitHub #8 勾选验收标准（第 3 条的路由权限子句留给 #18）。
