# Fixtures F1/F2 — AGENTS.md 渲染(裸用户 / 连接+可连接应用)

> 全部期望值派生自 Onyx 源 `backend/onyx/server/features/build/`(pinned `251933a`,下称 B/)。无一条断言来自 OpenBot 现行为。
> 替换管线的**顺序契约**:`{{ORGANIZATION_INSTRUCTIONS_SECTION}}` 最后替换(admin 文本中的字面 `{{…}}` 永不展开)—— B/`sandbox/util/agent_instructions.py:146-168`。

## 公共输入常量(默认部署)

| 常量 | 值 | 源 |
|---|---|---|
| SANDBOX_APPROVAL_WAIT_TIMEOUT_SECONDS | `180` | B/`configs.py:32-34` |
| SANDBOX_APPROVAL_WAIT_MARGIN_SECONDS | `20` | B/`configs.py:38` |
| OPENCODE_DISABLED_TOOLS(默认) | `["question"]` | B/`configs.py:23-26` |
| 超时替换值 | wait=`180`,client=`180+20=200` | B/`agent_instructions.py:151-160` |

---

## F1 — 裸用户(无 connected apps,无 connectable apps)

### 输入

- `user.personal_name = "Ada Lovelace"`
- provider=`"anthropic"`,model=`"claude-sonnet-4-5"`
- `disabled_tools = ["question"]`(部署默认)
- `organization_instructions = None`
- `get_connectable_apps_for_user(...) = []`(用户已可用的 org-credential apps 不算 connectable —— B/`onyx/db/external_app.py:187-201`:`is_user_authenticated_for_app` 为真的被过滤)

### 期望:占位符替换(agent_instructions.py:133-168)

```
{{USER_CONTEXT}}                          → "You are assisting **Ada Lovelace** with their work."
{{LLM_PROVIDER_NAME}}                     → "Anthropic"          (PROVIDER_DISPLAY_NAMES, :20-27)
{{LLM_MODEL_NAME}}                        → "claude-sonnet-4-5"
{{APPROVAL_WAIT_TIMEOUT_SECONDS}}         → "180"
{{APPROVAL_CLIENT_TIMEOUT_SECONDS}}       → "200"
{{DISABLED_TOOLS_SECTION}}                → "\n**Disabled Tools**: question\n"   (:141-144)
{{CONNECTABLE_APPS_LIST}}                 → "No connectable apps available."    (:84-85)
{{ORGANIZATION_INSTRUCTIONS_SECTION}}     → ""                                  (:92-94)
```

### 期望:渲染后的完整 Connectable apps 段(逐字节)

输入模板段 = B/`AGENTS.template.md:51-55`。渲染结果:

```
## Connectable apps

Some org apps aren't set up for this user yet, so you can't call them until they're connected. When the task needs one, call the `connect_app` tool with its numeric external app ID from the list below; once connected, it works like any other app. Never ask for or handle credentials yourself.

No connectable apps available.
```

### 期望:凭据段的两处数值行(模板 :72/:75 替换后)

```
**180 seconds**。          ← "pauses at the proxy for user approval for up to\n**{{APPROVAL_WAIT_TIMEOUT_SECONDS}} seconds**。"
**at least 200 seconds**   ← "set a client timeout of\n**at least {{APPROVAL_CLIENT_TIMEOUT_SECONDS}} seconds**"
```

### 期望:user_name 为 None

`{{USER_CONTEXT}} → ""`(:133-135);AGENTS.md 中该行成为空行(模板 :8 整行仅含该占位符)。

### 断言注记

- `{{USER_CONTEXT}}` 的换行体:f-string `"You are assisting **{user_name}** with their work."` —— 内部无换行(:136)。
- provider 未知值回落 `provider.title()`(:42);`None` → `"Unknown"`(:149)。fixture 之外的等价断言:`provider=None` → `{{LLM_PROVIDER_NAME}} → "Unknown"`。

---

## F2 — 一个已连接 + 一个可连接应用

### 输入

- ExternalApp A:`id=3, name="Linear"`(用户**已**存全 required credential keys → authenticated)
- ExternalApp B:`id=7, name="Slack"`(用户未存 → connectable)
- 其余同 F1;`user_name=None`

### 期望:connectable 列表(:78-89)

```
{{CONNECTABLE_APPS_LIST}} → "- External app ID `7`: **Slack**"
```

- 已连接的 Linear(被过滤)与 org-credential apps 一律**不出现在任何渲染产物中**(数据源过滤器 B/`onyx/db/external_app.py:196-201`)。
- 多可连接应用排序断言:apps `[(7,"Slack"), (2,"GitHub")]` → 列表 = `"- External app ID `2`: **GitHub**\n- External app ID `7`: **Slack**"`(按 `(id, name)` 排序,:83;行间单个 `\n`,:86-89)。

### 期望:渲染后的 Connectable apps 段(逐字节)

```
## Connectable apps

Some org apps aren't set up for this user yet, so you can't call them until they're connected. When the task needs one, call the `connect_app` tool with its numeric external app ID from the list below; once connected, it works like any other app. Never ask for or handle credentials yourself.

- External app ID `7`: **Slack**
```

### 注入面断言(同一 section 值必须用于全部四个写点)

1. workspace setup:B/`session/manager.py:685-687, 701-709`
2. llm reconcile 重生成:B/`session/manager.py:346-348`
3. skills reload 重生成:B/`session/manager.py:411-413`
4. skills_hash 输入:B/`onyx/skills/push.py:58-76`(connectable_apps 字节进 sha256,len 前缀 8 字节小端)

### skills_hash 可复算断言(F2 的哈希面)

`compute_skill_runtime_hash(files={}, connectable_apps_section="- External app ID `7`: **Slack**")`:
digest = sha256( `u64be(len(section)) || section || (无文件项)` )(`push.py:65-76`;`int.to_bytes(8)` 在 Python 3.11 缺省大端)。空 fileset + 非空 section ⇒ hash 仅由 section 决定 ⇒ section 改变必然改变 `skills_hash` ⇒ 触发 `session_runtime_stale`。
