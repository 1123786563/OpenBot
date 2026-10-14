## Problem Statement

OpenBot 的 Bot 创建者目前难以从一次会话定位到具体模型调用、工具执行或检索步骤，也无法可靠比较模型、Prompt 与 Bot 版本的效果。现有服务追踪主要解释 HTTP 请求，不能直接代表完整的流式 Agent 运行。

平台需要同时支持管理员范围内汇总和创建者自助排障，但追踪与评测可能含会话、工具和账号信息。企业租户仍在设计，当前集成必须预留可信访问范围，而不能提前固定租户模型或把 Opik 的数据组织当作业务授权。

## Solution

自托管 Opik，建立「安全运行追踪 → 脱敏查看 → 案例审查 → 版本化评测 → 实验比较 → 退化定位」闭环。

首期落地工作台：OpenBot 负责身份、授权、可信归属和任务执行资格，Opik 保存脱敏后的追踪与评测。管理员查看其管理范围内的汇总；Bot 创建者通过 OpenBot 页面查看自己有管理权的 Bot。Opik 与现有 OpenTelemetry/Tempo/Grafana 配合，并作为可选部署。

内置执行与默认 LangGraph 路径提供通过验收的详细记录；其他经过 OpenBot 的远程 Agent 提供实际可观察到的基础记录。企业授权、数据定位、评测资格通过接入位置预留，待企业租户 Spec 批准后实现。

## User Stories

1. As a platform operator, I want to connect a self-hosted Opik instance, so that observability and evaluation data stays in my infrastructure.
2. As a platform operator, I want Opik to be optional, so that existing Agent execution keeps working when the integration is disabled.
3. As a platform operator, I want verified and pinned server/SDK compatibility, so that an upgrade does not silently break ingestion or evaluation.
4. As a bot creator, I want a list of my Bot's runs, so that I can identify failed, slow, or interrupted executions.
5. As a bot creator, I want to inspect one run's observable steps, so that I can locate the model, tool, or retrieval operation that explains its result.
6. As a bot creator, I want run duration to cover the actual streamed execution, so that an early HTTP response does not report misleading latency.
7. As a bot creator, I want failures, cancellation, retries, and uncertain endings distinguished, so that incomplete runs are not shown as successful.
8. As a bot creator, I want proposed tool calls separated from actual tool execution, so that a model's request is not mistaken for a completed action.
9. As a bot creator, I want actual provider token usage or an explicit unavailable state, so that missing usage is not mistaken for zero cost.
10. As a bot creator, I want the available tracing capability displayed, so that missing internal spans from a remote Agent are not mistaken for missing calls.
11. As a bot creator, I want only metrics and appropriately redacted content, so that I can debug without acquiring access to other users' raw conversations.
12. As a conversation user, I want credentials, private account data, internal capabilities, and raw attachments excluded from telemetry, so that using a Bot does not expose them through observability.
13. As a bot creator, I want to inspect only Bots I can manage, so that public chat access does not become access to another creator's traces.
14. As a bot creator, I want observation access checked against current ownership, so that a transfer or revocation immediately removes the previous holder's access.
15. As a scoped administrator, I want summaries limited to my authorized scope, so that my role does not grant unrelated data access.
16. As a platform operator, I want the entire Opik control plane protected, so that private API access cannot bypass the application's role checks.
17. As a bot creator, I want to turn a suitable redacted run into a reviewed test case, so that production failures can become useful regression examples.
18. As a bot creator, I want to supply reviewed synthetic examples when a run contains only metrics, so that evaluation does not invent missing inputs or misrepresent redacted semantics.
19. As a bot creator, I want immutable dataset versions, so that later edits cannot change the examples used by an existing experiment.
20. As a bot creator, I want each experiment to freeze its dataset, Bot configuration, Prompt, model, tool fixtures, and scorers, so that its results can be reproduced and interpreted.
21. As a bot creator, I want isolated evaluation conversations and test tools, so that experiments do not mutate production memories or business data.
22. As a bot creator, I want deterministic checks of output format and tool behavior, so that basic regressions can be detected without an external Judge model.
23. As a bot creator, I want explicitly configured model-based scoring with reference criteria, so that nuanced quality can be assessed with recorded reasons.
24. As a platform operator, I want evaluated runs and Judge calls to obey applicable Credit Gate, Admission, Reservation, and Settlement rules, so that evaluation cannot bypass budget controls.
25. As a bot creator, I want queued experiments to recheck permission before each sample, so that revoked access cannot continue spending or reading data.
26. As a bot creator, I want cancellation to stop new samples and distinguish uncertain in-flight outcomes, so that retries do not duplicate model calls or charges.
27. As a bot creator, I want execution failures and scoring failures shown separately, so that averages do not hide missing or unsuccessful samples.
28. As a bot creator, I want to compare compatible experiments and inspect regressed cases, so that I can decide whether a model, Prompt, or Bot change improved the result.
29. As a bot creator, I want incompatible datasets or scorers clearly identified, so that the application does not claim a misleading quality winner.
30. As a bot creator, I want experiment results linked back to their execution records, so that I can explain a score using the relevant run.
31. As a platform operator, I want ingestion failures, drops, delays, and unbound records visible, so that a telemetry outage is not mistaken for healthy or absent traffic.
32. As an Agent user, I want Opik outages and slow responses to leave normal execution results unchanged, so that observability does not become a dependency of answering my request.
33. As a bot creator, I want exports to contain only currently authorized safe data, so that stale download links cannot survive revocation.
34. As a platform operator, I want retention and deletion to remove actual upstream data and exports, so that hiding a row is not mistaken for erasing its contents.
35. As a future enterprise integrator, I want every observation and evaluation operation to carry a trusted scope, so that tenant integration can be added without changing access assumptions throughout the product.
36. As a future enterprise integrator, I want unknown enterprise scope rejected without fallback, so that incomplete tenant configuration cannot expose workbench data.
37. As a keyboard or mobile user, I want readable, accessible run and evaluation views, so that the same workflows work across devices and input methods.
38. As a Chinese or English user, I want clear localized states for disabled, missing, redacted, truncated, syncing, and unavailable data, so that I can interpret the product's actual capability.

## Implementation Decisions

1. **Authority and storage:** OpenBot retains trusted resource/run ownership, storage locators, non-sensitive version references, and durable job state. Opik stores safe trace and evaluation content. Opik metadata cannot change business ownership.
2. **Execution telemetry:** Reuse OpenTelemetry and existing W3C propagation. Agent run records end at actual completion/failure/cancellation or an explicit uncertain state. Keep HTTP tracing, and preserve the ancestor context necessary to connect runtime steps.
3. **Identifiers:** Correlate Bot, thread, run, attempt, deployment/configuration/Prompt/scorer versions and policy version. Preserve an explicit mapping between OpenTelemetry and Opik identifiers rather than assuming identical IDs.
4. **Runtime capabilities:** Detailed requires validated model/tool/retrieval coverage. Basic represents only events and callbacks genuinely observed by OpenBot. Unavailable is explicit. External calls bypassing OpenBot and hidden remote steps are not claimed as covered.
5. **Authorization:** Reuse current Bot management and administrator permissions; ordinary chat or share access does not grant observation access. Check lists, aggregations, details, spans, datasets, experiments, feedback, and exports. No arbitrary upstream-query proxy is exposed.
6. **Enterprise reservation:** Concentrate authorization/range resolution, storage location, and evaluation eligibility at replaceable seams. Implement only the workbench adapter now. Future enterprise scope must be authenticated/authorized and never fall back to workbench scope. Scope participates in record keys, cursors, caches, exports, and jobs; workspace/project layout does not prove permission.
7. **No premature tenant model:** Do not create tenant tables, fake tenants, implicit tenant headers, tenant role hierarchies, or mappings of workspaces to tenants. Do not infer the tenant of existing workbench data.
8. **Safe content:** Redact before any export or evaluation write, using semantic field allowlists and approved content policies. Credentials, capabilities, connection strings, reasoning content and raw attachments are excluded. Unreliably handled free text falls back to metrics. Apply governance to SDK automatic capture, names, metadata, exceptions, Judge reasons, and exports as well as input/output.
9. **Protected control plane:** Full Opik access is limited to platform operators whose authorization covers the whole instance. Scoped administrators use OpenBot views. Protect private APIs as well as the frontend, using the existing identity system or platform-private access rather than a second Opik user database.
10. **Reliability:** Bounded asynchronous export cannot change a normal Agent result. If trusted binding cannot be established, do not export that run's business content. Expose drops, failures, delays, unbound records and uncertain terminal states. Missing provider usage stays unavailable; Opik cost is analytical and does not replace the Credit Ledger.
11. **Datasets:** Review candidate cases before saving. Metrics-only runs do not become invented text samples. Freeze safe input/reference/tool fixtures and provenance into immutable dataset versions. Cross-Bot reuse requires authorization and explicit copying.
12. **Evaluation execution:** Run independent bounded jobs with isolated threads and fixture/test tools. Preserve public execution behavior and applicable Credit Gate, Admission, Reservation/Settlement rules. Freeze configuration/version references, reauthorize each sample, and do not automatically replay externally uncertain attempts after cancellation or lease loss.
13. **Scorers:** Support rules for format, required fields and tool behavior, plus explicitly approved model-based scorers with references/rubrics. Judge calls use controlled deployment model access and budgets; an uncontrolled/default provider is not an acceptable fallback. Keep execution, scoring and synchronization failures distinct.
14. **Comparison:** Compare only experiments with compatible frozen sample sets and scoring definitions; otherwise explain incompatibility. Show completion/effective-sample counts, per-case scores/reasons, duration, actual usage and regressions, with links to safe execution records.
15. **User experience:** Provide Bot run and evaluation views plus administrator summaries/health. Reuse existing UI patterns with English/Chinese copy, keyboard support and narrow-screen layouts. Display disabled, empty, forbidden, basic, omitted, truncated, syncing and upstream-unavailable states.
16. **Lifecycle:** Approved defaults are 7 days for run traces and 30 days for datasets/experiments, adjustable by operations. Revoke visibility first, stop affected work, invalidate access, and schedule physical cleanup. Retain trusted locators until upstream deletion is verified; failures stay pending/failed. Saved reviewed cases use the dataset retention policy; unsaved candidates follow source trace retention.
17. **Deployment and verification:** Keep Opik an optional independent deployment; local compose and verified upstream Kubernetes/Helm deployment are supported. Pin compatible versions and verify actual ingest, query, evaluation, IDs and deletion. Cover host, container, and supported dynamically created processes without leaking secrets or confusing loopback addresses.

## Testing Decisions

The primary test seam is the authenticated OpenBot observation/evaluation interface, including resulting runtime events and user-visible views. Assert observable permissions, lifecycle, outputs and durable effects; do not mirror private implementation structure. Inject an upstream adapter for adversarial/failure cases, then verify compatibility and deletion against a real self-hosted Opik instance.

Reuse existing prior art: W3C propagation and HTTP trace tests, Bot owner/administrator policy tests, AG-UI streaming/cancellation tests, metered model settlement tests, durable WorkQueue lease tests, migration journal/snapshot checks, component state tests, and the repository's existing end-to-end runner. Test databases, accounts and Opik instances must be isolated from application data.

| ID | Observable acceptance |
| --- | --- |
| A1 | With Opik disabled, existing execution and tracing behavior still works; when enabled, an actual self-hosted instance receives valid safe records. |
| A2 | Built-in and LangGraph executions with observable tool/retrieval behavior have correct hierarchy and service correlation; other remote paths clearly show basic capability. |
| A3 | Success, failure, stream disconnection, cancellation and retry reflect actual execution; early HTTP responses do not truncate run duration, and tool proposals do not impersonate execution. |
| A4 | Secret canaries, capabilities, account identifiers, sensitive structured fields, unsupported free text and raw attachments are absent from actual Opik storage, views, samples, Judge records and exports. |
| A5 | Creators can access only Bots they can manage; public chat access, forged ownership/scope, guessed trace/span/dataset/experiment IDs and attachment links cannot widen access. |
| A6 | Summaries respect authorized scope; transfer and revocation affect historical queries, cached/paginated views, downloads and queued work. |
| A7 | Two configurations run against the same frozen dataset; enabled rules/Judge scores are traceable, and execution/scoring failures remain visible. |
| A8 | Evaluation does not write production memories/business data, production write tools are refused, and applicable admission/budget/settlement for runs and Judge calls has evidence. |
| A9 | Only compatible experiments receive comparison conclusions; effective sample counts, regressions and underlying execution records can be inspected. |
| A10 | Opik outages, delays and queue saturation do not change normal Agent execution results; drops and ingestion faults are visible. |
| A11 | Retention/deletion actually covers upstream records and exports; deleted or unauthorized content cannot be retrieved through private APIs or stale links. |
| A12 | Test adapters provide two trusted scopes without real tenant tables: identical resource IDs, foreign cursors/caches/jobs cannot cross scopes, and unknown enterprise scope is rejected without fallback. |
| A13 | Host/container/dynamic-process smoke tests and actual Opik prove cross-service identifier mapping and parent-child relationships. |

The approved testing seams were reviewed during the design conversation. Missing environment, skipped live compatibility checks, unknown external outcomes, incomplete deletion coverage, or failed review are not completion evidence. Complete delivery requires applicable tests/type checks/lint/build, independent Spec/code-quality review and full-scope OCR without valid critical/high/medium findings.

## Out of Scope

- Enterprise tenancy, tenant memberships/roles/SSO/RLS, enterprise runtime adaptation and migration: reserve integration seams only.
- Treating Opik workspaces as tenant ACLs or adding a second account system.
- Raw conversation access through Opik, reasoning content, raw attachments and hidden steps inside unsupported remote Agents.
- Replacing conversation history, run/budget/credit ledgers, runtime Prompt configuration, or existing Grafana/Tempo/LGTM.
- Automatic Prompt optimization, automatic deployment/model promotion, or online evaluation that writes production business data.
- Forking Opik, modifying Bifrost, or implementing decisions from the separately evolving Bifrost design.

## Further Notes

- Design approved by the user on 2026-10-14; published to the explicitly selected OpenBot tracker on 2026-10-15.
- This is an aggregate Spec. Vertical implementation tickets are drafted separately; containment is not a blocking dependency. Do not duplicate work already covered by verified descendants when implementing the aggregate.
- The earlier file-level implementation plan is a draft, not proof of delivered code or approved ticket boundaries. Reconcile task ownership/interfaces with the approved ticket graph before dispatch.
- Repository baseline used for local design exploration: 7bfc18f28152a3fb2a3fa014ae33a61025246f1b. Re-read current code and applicable decisions before implementing; this Spec describes required behavior rather than freezing file paths.
- Upstream: [Opik](https://github.com/comet-ml/opik), [OpenTelemetry integration](https://www.comet.com/docs/opik/integrations/opentelemetry), [self-hosting](https://www.comet.com/docs/opik/self-host/overview), [TypeScript evaluation](https://www.comet.com/docs/opik/reference/typescript-sdk/evaluation/overview).
