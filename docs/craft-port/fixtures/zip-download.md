# Fixture F6 — 归档下载 HTTP 契约(download-directory + webapp-download)

> 全部期望值派生自 Onyx 源(pinned `251933a`,路径相对 `backend/onyx/server/features/build/`,下称 B/)。**Onyx 输出是 ZIP(`application/zip`),非 tar.gz** —— B/`session/api.py:704,741` + B/`session/manager.py:1273-1290`。

## 输入(共用)

会话 workspace 内文件树(经沙箱 list_directory 递归可见):

```
outputs/
  report.md                    (可读)
  web/
    package.json               (可读)
    node_modules/pkg/index.js  (hidden,须跳过)
    .env                       (hidden,须跳过)
    src/app/page.tsx           (可读)
attachments/data.csv           (可读)
AGENTS.md
opencode.json                  (hidden,须跳过)
```

session.name = `"My Project!"`,session_id = `11111111-2222-3333-4444-555555555555`。

## A. GET /sessions/{id}/download-directory/outputs

### 期望响应头(B/`session/api.py:739-745` + `backend/onyx/file_store/serving.py:103-115`)

```
200 OK
Content-Type: application/zip
Content-Disposition: attachment; filename="outputs.zip"; filename*=UTF-8''outputs.zip
```

filename = `_sanitize_zip_basename(Path("outputs").name, allow_dots=True) + ".zip"`(B/`session/manager.py:1681-1682`)。

### 期望 ZIP 结构(B/`manager.py:1244-1290`)

- deflate 压缩(`zipfile.ZIP_DEFLATED`,:1279);仅**文件**条目(无目录占位条目;writestr 逐文件写入,:1287)。
- arcname = 路径去掉请求前缀 `outputs/`(len(path)+1 偏移,:1672-1678):
  - `report.md`
  - `web/package.json`
  - `web/src/app/page.tsx`
- **隐藏过滤**(`_is_hidden_workspace_entry`,:166-167 + `HIDDEN_PATTERNS`,:141-153):`web/node_modules/**` 整棵剪除(目录名命中即不递归)、`web/.env`、`web/.next/**`、`nextjs.log`、`nextjs.pid`、`opencode.json`、`.venv`、`.git`、`__pycache__`、`.DS_Store`、`.gitignore` 一律不进归档;**任何以 `.` 开头的 entry.name 同样剪除**(含深层目录里的 dot 文件)。
- 读不到的文件(读时 ValueError)**静默跳过**,不失败(:1281-1289)。

### 期望错误分支(api.py:726-735)

| 情形 | 响应 |
|---|---|
| path 含 traversal(底层 ValueError "path traversal") | 403 `Access denied` |
| 其他 ValueError(如非法路径) | 400 `detail=<message>` |
| 目录不存在/会话或沙箱不存在(manager 返回 None) | 404 `Directory not found` |

## B. GET /sessions/{id}/webapp-download

### 期望

- 200 + `Content-Type: application/zip`(api.py:700-708)。
- filename = `_sanitize_zip_basename(session.name or f"session-{str(id)[:8]}", allow_dots=False) + "-webapp.zip"`(manager.py:1634-1636):
  - 本例:`"My Project!"` → 非法字符(空格与 `!`)各换一个 `_` → **`My_Project_-webapp.zip`**(`allow_dots=False` 时 `.` 也换,manager.py:159-163);
  - session.name 为空 → `session-11111111-webapp.zip`。
- 归档内容 = `outputs/web` 递归、arcname 去 `outputs/web/` 前缀(manager.py:1615-1632):`package.json`、`src/app/page.tsx`;`node_modules/**`、`.env` 剪除。
- `outputs/web` 不存在 → 404 `Webapp not found`(api.py:697-698;manager.py:1622-1624)。

### sanitize 分支表(manager.py:159-163)

| 输入 basename | allow_dots | 输出 |
|---|---|---|
| `My Project!` | false | `My_Project_`(空格与 `!` 各换一个 `_`) |
| `my.lib` | true | `my.lib` |
| `my.lib` | false | `my_lib`(点换下划线;字母原样) |
| `../../etc` | true | `.._.._etc`(`.` 保留,`/` 一律换 `_`) |

> 实现方注意:上表第 4 行按逐字符规则机械推导——`..` 在 allow_dots=true 下保留,`/` 一律换 `_`。

## C. 关联断言(同一文件面)

- `GET /sessions/{id}/files?path=outputs` 的 listing 过滤规则与 ZIP walk 一致(同 `_is_hidden_workspace_entry`,api.py:1727-1735)—— 归档与文件树 UI 永不互相矛盾。
- 上传限额(与归档无直接关系,但同域常量):单文件 50MB、20 文件、总量 200MB(B/`configs.py:47-53`);超文件数 429 `"Maximum number of files (20) reached"`、超总量 429 `"Total upload size limit (200MB) exceeded"`(manager.py:1794-1803,文案含计算值)。
- 下载单文件 artifact(非归档)无 zip 化:`GET /artifacts/{path}` 原字节 + `Content-Disposition: attachment`(api.py:559-594)。
