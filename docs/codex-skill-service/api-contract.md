# Codex 技能分发服务 REST API 定义

## 1. 通用约定

### 1.1 Base path

| API 域 | Base path | 认证 |
| --- | --- | --- |
| Public | `/public/api` | 浏览无需登录；分享和下载受 token/限流约束 |
| User | `/user/api` | 现有用户 Session 或被允许的 Console API credential |
| Admin | `/admin/api` | 现有 Admin auth |

路由沿用当前服务约定，不额外引入 `/v1`。发生破坏性变更时再增加版本化路径；新增字段必须向后兼容。

### 1.2 Header

| Header | 使用场景 | 说明 |
| --- | --- | --- |
| `Content-Type: application/json` | JSON 请求 | 必须 |
| `Idempotency-Key` | 创建、完成上传、审核 | 8–128 个可打印 ASCII 字符，同一 actor 24 小时内唯一 |
| `If-Match` | 更新 Skill 元数据 | 值为当前 `revision`，例如 `"3"` |
| `X-Request-ID` | 可选 | 合法时沿用，否则服务端生成 |

响应总是返回 `X-Request-ID`。签名上传和下载 URL、share token 不写入访问日志。

### 1.3 成功响应

单资源直接返回资源对象；列表统一返回：

```json
{
  "items": [],
  "nextCursor": "opaque-cursor-or-null"
}
```

异步处理返回 `202 Accepted`，并返回资源当前状态，而不是只返回空响应。

### 1.4 错误响应

新 Skills API 统一使用：

```json
{
  "error": {
    "code": "SKILL_VERSION_NOT_PUBLISHED",
    "message": "The requested skill version is not published.",
    "requestId": "req_01...",
    "details": {
      "status": "pending_review"
    }
  }
}
```

`message`、错误码和开发者日志使用英文。用户界面根据 `code` 本地化，不直接展示内部错误文本。

### 1.5 分页和排序

- `limit` 默认 20，最小 1，最大 100。
- `cursor` 是服务端签名/编码的不透明值，客户端不得解析。
- 默认排序为 `updatedAt DESC, id DESC`；公共目录支持 `popular`、`newest`、`updated`。
- 无效或过期 cursor 返回 `400 SKILL_INVALID_CURSOR`。

### 1.6 核心资源 DTO

```json
{
  "publicId": "sk_01...",
  "owner": {
    "publicId": "usr_01...",
    "displayName": "Example Author"
  },
  "slug": "release-notes",
  "name": "release-notes",
  "displayName": "Release Notes",
  "description": "Generate release notes from repository changes.",
  "visibility": "private",
  "status": "draft",
  "primaryCategory": {
    "publicId": "cat_01...",
    "slug": "development",
    "name": "Development"
  },
  "tags": ["git", "documentation"],
  "latestPublishedVersion": null,
  "revision": 1,
  "permissions": ["view", "install", "maintain", "share"],
  "downloadCount": 0,
  "installCount": 0,
  "createdAt": "2026-08-07T08:00:00Z",
  "updatedAt": "2026-08-07T08:00:00Z"
}
```

`permissions` 由服务端按当前 actor 计算，不接受客户端写入。

Version DTO：

```json
{
  "publicId": "skv_01...",
  "skillPublicId": "sk_01...",
  "version": "1.2.0",
  "status": "pending_review",
  "archiveSha256": "4b2f...64-hex-characters",
  "archiveSize": 184320,
  "fileCount": 14,
  "unpackedSize": 524288,
  "changelog": "Add repository summary support.",
  "scan": {
    "scannerVersion": "skill-scanner/1.0.0",
    "risk": "low",
    "blockingFindings": 0,
    "warningFindings": 2
  },
  "submittedAt": "2026-08-07T08:10:00Z",
  "publishedAt": null,
  "createdAt": "2026-08-07T08:05:00Z"
}
```

非 owner/admin 只看到可公开的扫描摘要，不返回文件路径或内部审核说明。

## 2. Public API

### 2.1 查询分类

`GET /public/api/skill-categories`

Query：`locale=en|zh-CN`，默认根据 `Accept-Language`。

返回启用分类树。分类 `slug` 稳定，名称可本地化。

### 2.2 公共目录

`GET /public/api/skills`

Query：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `q` | string | 名称、描述、tag 搜索，最大 100 字符 |
| `category` | string | category slug |
| `tag` | string | 可重复或逗号分隔，最终实现二选一 |
| `sort` | string | `popular`、`newest`、`updated` |
| `cursor` | string | 分页 cursor |
| `limit` | int | 1–100 |

只返回 `visibility=public`、`status=active` 且存在 published version 的 Skill。

### 2.3 公共详情

`GET /public/api/skills/{skillPublicId}`

返回公共 Skill、最新版本和最近版本列表摘要。blocked、private、unlisted 统一返回 `404 SKILL_NOT_FOUND`，避免泄露资源存在性。

### 2.4 公共版本列表

`GET /public/api/skills/{skillPublicId}/versions`

只返回 `published` 或 `deprecated` 版本；blocked 版本不返回。

### 2.5 签发公开下载许可

`POST /public/api/skills/{skillPublicId}/versions/{versionPublicId}/download-licenses`

请求：

```json
{
  "client": {
    "name": "auto-gateway-desktop",
    "version": "0.1.39",
    "platform": "macos",
    "architecture": "arm64"
  }
}
```

响应 `201 Created`：

```json
{
  "downloadUrl": "https://signed-object-url.example/...",
  "expiresAt": "2026-08-07T08:20:00Z",
  "archiveSha256": "4b2f...",
  "archiveSize": 184320,
  "manifestSha256": "8c90...",
  "version": "1.2.0"
}
```

URL 默认 5 分钟有效。API 必须按 IP、skill 和 client fingerprint 限流；公共下载不等于安装成功。

### 2.6 解析分享链接

`POST /public/api/skill-share-resolutions`

请求：

```json
{
  "token": "plain-share-token"
}
```

响应返回可分享的 Skill 摘要、固定或最新版本及短时 `resolutionToken`。随后使用：

`POST /public/api/skill-share-resolutions/{resolutionToken}/download-licenses`

`resolutionToken` 最长有效 10 分钟、单用途或低次数使用，不写数据库明文。分享无效、过期、撤销、超次数统一返回 `404 SKILL_SHARE_NOT_FOUND`。

## 3. User API

以下接口需要 `requireUserSession()` 或现有 Console API 认证，并增加对应 permission：

- 读：`skills:read`
- 写：`skills:write`
- 下载/安装回传：`skills:install`

Owner 用户 Session 默认具备这些能力；Console API credential 必须显式授权。最终 permission 名称需与现有 console permission 体系评审对齐。

### 3.1 查询当前用户可见 Skill

`GET /user/api/skills`

Query：

- `scope=owned|shared|installed|all`
- `status=draft|active|deprecated|blocked`
- `visibility=private|unlisted|public`
- `category`、`q`、`cursor`、`limit`

blocked 资源只有 owner/maintainer 可在管理列表看到，不能下载。

### 3.2 创建 Skill

`POST /user/api/skills`

需要 `Idempotency-Key`。

```json
{
  "slug": "release-notes",
  "name": "release-notes",
  "displayName": "Release Notes",
  "description": "Generate release notes from repository changes.",
  "visibility": "private",
  "primaryCategoryPublicId": "cat_01...",
  "tags": ["git", "documentation"]
}
```

返回 `201 Created` 和 Skill DTO。slug/name/description 的最终有效性仍要在扫描包内 `SKILL.md` 时复核。

### 3.3 获取详情

`GET /user/api/skills/{skillPublicId}`

需要 owner、grant 或 public 可见性。返回当前 actor 的 `permissions`。

### 3.4 更新元数据

`PATCH /user/api/skills/{skillPublicId}`

需要 `If-Match: "{revision}"`。

```json
{
  "displayName": "Release Notes Pro",
  "description": "Generate structured release notes.",
  "visibility": "unlisted",
  "primaryCategoryPublicId": "cat_01...",
  "tags": ["git", "documentation", "release"]
}
```

可修改字段仅限白名单。`name`、`slug`、owner 和版本内容不能通过该接口修改。revision 不匹配返回 `409 SKILL_REVISION_CONFLICT` 并附当前 revision。

### 3.5 删除或废弃

`DELETE /user/api/skills/{skillPublicId}`

- 从未发布且无共享/安装引用：软删除，返回 `204`。
- 已发布或有引用：返回 `409 SKILL_DEPRECATION_REQUIRED`，客户端应调用废弃接口。

`POST /user/api/skills/{skillPublicId}/deprecations`

```json
{
  "reason": "Replaced by another skill."
}
```

返回更新后的 Skill。废弃不删除历史包，已安装客户端可继续使用，但目录不再推荐新安装。

### 3.6 创建上传会话

`POST /user/api/skills/{skillPublicId}/upload-sessions`

需要 `Idempotency-Key`。

```json
{
  "version": "1.2.0",
  "fileName": "release-notes-1.2.0.zip",
  "archiveSize": 184320,
  "archiveSha256": "4b2f...64-hex-characters",
  "changelog": "Add repository summary support."
}
```

响应 `201 Created`：

```json
{
  "publicId": "upl_01...",
  "versionPublicId": "skv_01...",
  "status": "created",
  "upload": {
    "method": "PUT",
    "url": "https://signed-upload-url.example/...",
    "headers": {
      "content-type": "application/zip",
      "x-amz-meta-sha256": "4b2f..."
    }
  },
  "expiresAt": "2026-08-07T08:30:00Z"
}
```

服务端生成 object key。客户端不得上传非 ZIP 类型，也不得改变签名 headers。

### 3.7 完成上传

`POST /user/api/skills/{skillPublicId}/upload-sessions/{uploadPublicId}/complete`

需要 `Idempotency-Key`。请求体为空对象 `{}`。

服务端执行 HEAD，校验对象存在、大小和 metadata，然后在事务中把版本设为 `uploaded` 并写入扫描 Outbox。返回 `202 Accepted`：

```json
{
  "uploadStatus": "completed",
  "version": {
    "publicId": "skv_01...",
    "version": "1.2.0",
    "status": "uploaded"
  }
}
```

重复 complete 返回第一次的等价结果；对象不完整返回 `409 SKILL_UPLOAD_INCOMPLETE`。

### 3.8 版本列表与详情

- `GET /user/api/skills/{skillPublicId}/versions`
- `GET /user/api/skills/{skillPublicId}/versions/{versionPublicId}`

Owner/maintainer 可查看 scanning、pending_review、rejected 和 failed；普通被授权用户只看到可安装版本。

### 3.9 扫描 findings

`GET /user/api/skills/{skillPublicId}/versions/{versionPublicId}/scan-findings`

仅 owner/maintainer/admin 可见。返回规则码、severity、清洗后相对路径和可操作说明，不返回疑似 secret 原文。

### 3.10 重新扫描

`POST /user/api/skills/{skillPublicId}/versions/{versionPublicId}/rescans`

仅 `failed`、`rejected`（规则升级允许时）或管理员触发；不允许通过重扫修改 archive。返回 `202`。普通技术故障的自动重试不要求客户端调用。

### 3.11 废弃版本

`POST /user/api/skills/{skillPublicId}/versions/{versionPublicId}/deprecations`

```json
{
  "reason": "Superseded by 1.3.0."
}
```

如果废弃的是 latest，Service 选择下一个最高 published 版本；没有可用版本时 Skill 进入 `deprecated`。

### 3.12 私有/授权下载许可

`POST /user/api/skills/{skillPublicId}/versions/{versionPublicId}/download-licenses`

请求和响应与 Public API 相同。需要 owner、有效 `install`/`maintain` grant，或 public 可见性。

### 3.13 分享链接管理

- `GET /user/api/skills/{skillPublicId}/share-links`
- `POST /user/api/skills/{skillPublicId}/share-links`
- `DELETE /user/api/skills/{skillPublicId}/share-links/{sharePublicId}`

创建请求：

```json
{
  "versionPublicId": null,
  "expiresAt": "2026-09-07T00:00:00Z",
  "maxUses": 100
}
```

创建响应只在本次返回明文：

```json
{
  "publicId": "shr_01...",
  "shareUrl": "https://gateway.example/skills/share#plain-share-token",
  "expiresAt": "2026-09-07T00:00:00Z",
  "maxUses": 100,
  "useCount": 0
}
```

列表接口不再返回 token 或完整 share URL。DELETE 是幂等撤销，成功返回 `204`。

### 3.14 用户授权管理

- `GET /user/api/skills/{skillPublicId}/access-grants`
- `PUT /user/api/skills/{skillPublicId}/access-grants/{userPublicId}`
- `DELETE /user/api/skills/{skillPublicId}/access-grants/{userPublicId}`

PUT 请求：

```json
{
  "permission": "install",
  "expiresAt": null
}
```

只有 owner 可管理授权；不能给自己授权，不能授予 owner 权限。MVP 通过精确用户标识授权，不提供模糊邮箱枚举接口。

### 3.15 安装状态回传

`PUT /user/api/skill-installations/{skillPublicId}`

天然幂等，以 `(user, skill, device)` upsert：

```json
{
  "versionPublicId": "skv_01...",
  "deviceId": "client-generated-stable-random-id",
  "status": "installed",
  "enabled": true,
  "clientVersion": "0.1.39",
  "reportedAt": "2026-08-07T08:25:00Z"
}
```

服务端使用 keyed hash 保存 `deviceId`，并校验 `reportedAt` 允许的时钟偏差。`status=uninstalled` 时必须设置 `enabled=false`。

PUT 响应返回安装记录 `publicId`。查询使用 `GET /user/api/skill-installations?cursor=...&limit=...`；服务端返回设备显示别名或截断指纹，不返回原始 `deviceId`，也不把原始 ID 放入 URL 和访问日志。

## 4. Admin API

### 4.1 审核队列

`GET /admin/api/skills/versions`

Query：`status=pending_review|rejected|blocked|failed`、`risk`、`ownerUserId`、`q`、`cursor`、`limit`。

### 4.2 审核详情

`GET /admin/api/skills/{skillPublicId}/versions/{versionPublicId}`

返回 metadata、完整扫描 findings、审核历史和对象摘要，但不返回签名 URL。管理员需要下载审查包时调用专用、强审计的 download-license endpoint。

### 4.3 审核决策

`POST /admin/api/skills/{skillPublicId}/versions/{versionPublicId}/reviews`

需要 `Idempotency-Key`。

```json
{
  "decision": "approve",
  "note": "Static scan and manual review passed."
}
```

`decision` 为 `approve` 或 `reject`。approve 只允许从 `pending_review` 到 `published`；reject 必须提供 note。响应返回 Version DTO，审计记录 actor、前后状态和 note。

### 4.4 重新扫描

`POST /admin/api/skills/{skillPublicId}/versions/{versionPublicId}/rescans`

```json
{
  "reason": "Scanner rules updated to 1.1.0."
}
```

返回 `202`，不修改 package。

### 4.5 封禁和恢复

- `POST /admin/api/skills/{skillPublicId}/blocks`
- `DELETE /admin/api/skills/{skillPublicId}/blocks/current`

封禁请求：

```json
{
  "reasonCode": "MALWARE",
  "note": "Package contains a credential exfiltration script.",
  "revokeShareLinks": true
}
```

封禁必须立即使新的下载许可失败，并撤销分享；对象延迟删除以保留调查证据。恢复必须记录原因，不自动恢复被单独驳回的版本。

### 4.6 分类管理

- `GET /admin/api/skill-categories`
- `POST /admin/api/skill-categories`
- `PATCH /admin/api/skill-categories/{categoryPublicId}`
- `POST /admin/api/skill-categories/{categoryPublicId}/disablements`

分类 slug 创建后不可修改；禁用分类不删除 Skill 上的历史引用。移动/合并分类应另设显式接口，避免 PATCH 产生大规模隐式变更。

### 4.7 审计查询

复用现有审计查询能力，按：

- `resourceType=skill|skillVersion|skillCategory|skillShareLink`
- `resourceId={publicId}`
- `action=skill.version.approve` 等

若现有 Admin Audit API 不能按资源筛选，则扩展现有接口，不重复创建 Skills 专用审计系统。

## 5. 权限矩阵

| 操作 | Public | Granted view | Granted install | Maintainer | Owner | Admin |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 浏览 public | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 浏览 private metadata | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| 下载 public | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 下载 private | — | — | ✓ | ✓ | ✓ | ✓ |
| 编辑 metadata | — | — | — | ✓ | ✓ | ✓ |
| 上传新版本 | — | — | — | ✓ | ✓ | ✓ |
| 创建分享 | — | — | — | — | ✓ | ✓ |
| 管理用户授权 | — | — | — | — | ✓ | ✓ |
| 废弃 | — | — | — | ✓ | ✓ | ✓ |
| 审核/封禁/分类 | — | — | — | — | — | ✓ |

`view` 只允许查看 metadata，不包含 package 下载。

## 6. 错误码

| HTTP | Code | 场景 |
| --- | --- | --- |
| 400 | `SKILL_INVALID_ARGUMENT` | DTO、SemVer、slug 等无效 |
| 400 | `SKILL_INVALID_CURSOR` | cursor 无效或过期 |
| 401 | `AUTH_REQUIRED` | 未认证 |
| 403 | `SKILL_PERMISSION_DENIED` | 已认证但权限不足 |
| 404 | `SKILL_NOT_FOUND` | 不存在或为避免泄露而隐藏 |
| 404 | `SKILL_SHARE_NOT_FOUND` | share token 无效/撤销/过期 |
| 409 | `SKILL_SLUG_CONFLICT` | owner 下 slug 重复 |
| 409 | `SKILL_VERSION_CONFLICT` | SemVer 已存在 |
| 409 | `SKILL_REVISION_CONFLICT` | `If-Match` 过期 |
| 409 | `SKILL_INVALID_STATE_TRANSITION` | 不允许的状态迁移 |
| 409 | `SKILL_UPLOAD_INCOMPLETE` | 对象未上传完成或大小不符 |
| 409 | `SKILL_DEPRECATION_REQUIRED` | 资源不能直接删除 |
| 413 | `SKILL_ARCHIVE_TOO_LARGE` | 压缩包超限 |
| 415 | `SKILL_ARCHIVE_FORMAT_UNSUPPORTED` | 非支持的 ZIP |
| 422 | `SKILL_MANIFEST_INVALID` | `SKILL.md` 结构无效 |
| 422 | `SKILL_SCAN_BLOCKED` | 存在阻断 finding |
| 429 | `SKILL_RATE_LIMITED` | 上传、解析或下载超限 |
| 503 | `SKILL_STORAGE_UNAVAILABLE` | 对象存储故障 |
| 503 | `SKILL_QUEUE_UNAVAILABLE` | 仅无法通过 Outbox 保证落库时使用 |
| 500 | `SKILL_INTERNAL_ERROR` | 未分类内部错误 |

生产响应不得暴露 SQL、object key、bucket、文件绝对路径、secret、签名 URL或 stack trace。

## 7. 幂等与并发

- `POST /skills`、创建 upload session、complete upload、admin review 必须支持 `Idempotency-Key`。
- 同 key、同 actor、同 endpoint、同 body hash 返回首次响应；同 key 不同 body 返回 `409 IDEMPOTENCY_KEY_REUSED`。
- Skill metadata PATCH 使用 `revision` 乐观锁。
- Version 状态使用数据库条件更新，不以“先读后写”代替原子迁移。
- 分享 `maxUses` 用条件递增避免超发。
- Installation PUT 按用户、Skill、设备 upsert，较旧 `reportedAt` 不覆盖较新状态。

## 8. 建议限流

以下为安全默认值，发布前结合流量调整：

| 接口 | 建议限制 |
| --- | --- |
| 创建 Skill | 30/user/hour |
| 创建上传会话 | 20/user/hour，最多 3 个未完成会话 |
| complete upload | 60/user/hour |
| share resolve | 30/IP/minute + 10/token-prefix/minute |
| public download license | 60/IP/minute + 30/skill/minute |
| user download license | 120/user/hour |
| installation report | 120/user/minute，允许批量接口后再调整 |
| admin review | 60/admin/minute |

限流拒绝返回 `Retry-After`，Redis 故障时采用本机保守 fallback；分享 token 解析不能 fail-open。

## 9. API 演进规则

- 字段只新增不改义；客户端必须忽略未知字段。
- enum 新值视为可能发生，客户端提供 unknown fallback。
- 已发布 endpoint 删除前至少跨两个桌面端稳定版本弃用。
- 状态机、错误码和权限变化必须同步更新本文件、数据库文档和契约测试。
- OpenAPI 3.1 文件应在实现阶段生成并进入 CI；本文是实现前的人工设计基线。
