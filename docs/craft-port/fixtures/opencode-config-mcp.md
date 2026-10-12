# Fixture F3 — opencode.json:per-user MCP 服务器 + 禁用 MCP 工具

> 全部期望值派生自 Onyx 源(pinned `251933a`,路径相对 `backend/onyx/server/features/build/`,下称 B/)。

## 输入

- 一台 craft-enabled MCP server:`MCPServer(name="Acme Tools", id=42, server_url="https://acme.example/mcp")`,用户可认证(可解析凭证)。
- 该 server 的工具表:`get_mcp_tools_for_servers` 返回 `search`(enabled)、`delete_everything`(**enabled=False**)。
- 另一台 craft-enabled server `id=50, name="Ghost"` 用户**不可**认证(无凭证)。
- 会话:`session_id = "11111111-2222-3333-4444-555555555555"`;部署默认 `OPENCODE_DISABLED_TOOLS=["question"]`。
- LLM:provider=`"onyx"`,model=`"gpt-5"`,catalog 含该 model(否则 B/`sandbox/util/opencode_config.py:230-237` 抛 `ValueError: default model 'gpt-5' is not in the provider catalog`)。

## 期望:server 解析(B/`sandbox/util/mcp_config.py`)

- key = `_server_key`(:28-32):`"acme tools"` → 非 `[a-z0-9]` 连串(" ")折成 `-` → `"acme-tools"` → `"acme-tools-42"`。
  - 附断言:`name="MCP Server!!"` → slug `"mcp-server"`;`name="中文"` → slug 空 → 回落 `"mcp"` → key `"mcp-42"`。
- Ghost(不可认证)**整台剔除**,不进 mcp block、不进 permissions(:51-62,仅 info log `craft_mcp_skip_unauthenticated`)。
- `disabled_tools = ["delete_everything"]`(排序后,:63-66)。

## 期望:`build_provider_opencode_config(...)`(B/`sandbox/util/opencode_config.py:218-254`)关键片段

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "onyx/gpt-5",
  "provider": { "onyx": { "npm": "@ai-sdk/openai-compatible", "options": { /* apiKey/baseURL 按配置 */ } } },
  "enabled_providers": ["onyx"],
  "permission": {
    // ..._PERMISSIONS_TEMPLATE 全量(:37-90)先拷贝,然后:
    "question": "deny",                        // :114-116 disabled_tools → "deny"
    "acme-tools-42_*": "allow",                // :119-120 通配 allow(先)
    "acme-tools-42_delete_everything": "deny", // :121-122 具名 deny(后,findLast 生效)
    "connect_app": "ask"                       // :87-89 模板原生
  },
  "mcp": {
    "acme-tools-42": {
      "type": "remote",
      "url": "https://acme.example/mcp",
      "enabled": true,
      "oauth": false,
      "headers": { "X-Onyx-Mcp-Session": "11111111-2222-3333-4444-555555555555" }
    }
  }
}
```

- `MCP_SESSION_TAG_HEADER = "X-Onyx-Mcp-Session"`(B/`configs.py:139-145`)。
- `mcp_servers` 非空但 `session_id=None` → `ValueError("session_id is required when mcp_servers are provided")`(:250-252)。
- 无 mcp_servers 时 **不产生 `mcp` 键**(:250 条件)。

## 期望:字节比对与热重载(B/`session/manager.py:280-358`)

- 期望串 = `json.dumps(config)`(Python dict 插入序,:288-295);与沙箱读回的 `opencode.json` **逐字节**相等才短路;不等 → 重写 + dispose 实例。
- 换一台 disabled tool(如 `search` 也禁)→ permission 增 `"acme-tools-42_search": "deny"` → 字节不等 → 重写。

## 期望:mcp 指纹(B/`sandbox/util/mcp_config.py:78-95`)

- `craft_mcp_fingerprint([acme])` = sha256 of `json.dumps(sorted([[42, "https://acme.example/mcp", ["delete_everything"]]]), sort_keys=True, separators=(",", ":"))`。
- 顺序无关断言:两台 server 传入顺序对调,指纹不变(payload 先 sorted)。

## 期望:AGENTS.md 的 DISABLED_TOOLS_SECTION 联动

MCP 禁用工具**不**进 AGENTS.md 的 `{{DISABLED_TOOLS_SECTION}}`(该段只吃部署级 `OPENCODE_DISABLED_TOOLS`,B/`agent_instructions.py:141-144` + B/`docker_sandbox_manager.py:1109`);MCP 禁用只体现在 permission deny 行。

## 期望:权限模板全量基线(逐键,F3 的 diff 基准)

`_PERMISSIONS_TEMPLATE`(:37-90)逐键(实现方 diff 时必须全部在场):

```
bash: {rm: "deny", ssh: "deny", scp: "deny", sftp: "deny", ftp: "deny", telnet: "deny", nc: "deny", netcat: "deny", tac: "deny", nl: "deny", od: "deny", xxd: "deny", hexdump: "deny", strings: "deny", base64: "deny", "*": "allow", "*start-webapp.sh*": "deny", "bash start-webapp.sh": "allow", "bash ./start-webapp.sh": "allow"}
edit/write/patch: {"*": "allow", "opencode.json": "deny", "**/opencode.json": "deny", "start-webapp.sh": "deny", "**/start-webapp.sh": "deny"}
read/grep/glob: {"*": "allow", "opencode.json": "deny", "**/opencode.json": "deny"}
list: "allow"; lsp: "allow"; skill: {"*": "allow", "customize-opencode": "deny"}; question: "allow"; webfetch: "allow"; connect_app: "ask"
external_directory: dev? "allow" : {"*": "deny", "/tmp": "allow", "/tmp/**": "allow"}   (:92-99, :111-113)
```
