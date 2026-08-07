# Codex Skill 包处理、异步任务与安全设计

## 1. 安全目标

上传的 Skill 包属于不可信供应链内容。服务端的目标不是证明内容“绝对安全”，而是：

- 阻止路径穿越、符号链接逃逸、压缩炸弹和资源耗尽。
- 验证包结构、`SKILL.md` manifest 和内容摘要。
- 发现明显的凭证、恶意脚本和高风险行为，并保留可审计结果。
- 保证未扫描、被驳回或被封禁的包不能获得下载许可。
- 在包撤销后快速停止新分发，同时保留调查证据。

扫描器不得执行脚本、加载动态库、安装依赖、调用包内二进制或跟随符号链接。

## 2. 对象存储布局

使用独立私有 bucket，或至少使用与现有附件严格隔离的 prefix 和 IAM policy。

```text
skills/
├── staging/{uploadPublicId}/package.zip
├── packages/{skillPublicId}/{versionPublicId}/{archiveSha256}.zip
├── manifests/{skillPublicId}/{versionPublicId}/{manifestSha256}.json
├── quarantine/{versionPublicId}/{archiveSha256}.zip
└── reports/{versionPublicId}/{scanAttempt}.json
```

规则：

- object key 只能由服务端生成，不拼接未经规范化的 file name、slug 或用户路径。
- `staging` 对象默认 24 小时生命周期；未完成会话自动删除。
- `packages` 和 `manifests` 内容寻址且不可覆盖；写入时使用防覆盖条件或写后 HEAD 验证。
- `quarantine` 不签发下载 URL，只有扫描/安全服务角色可读。
- scan report 可只存数据库摘要；如保存对象报告，报告不得包含 secret 原文。
- 对象存储启用服务端加密、版本控制（如果成本允许）、访问日志和生命周期规则。

### 2.1 IAM 最小权限

| 运行角色 | 权限 |
| --- | --- |
| API | 对 staging 创建 presigned PUT、HEAD；对 published package 创建 presigned GET |
| Scanner | 读 staging/quarantine，写 packages/manifests/reports；不能签发外部 URL |
| Cleanup Worker | 列举和删除满足 prefix/retention 条件的对象 |
| Admin API | 不直接拥有 bucket list/read；通过审计后的 Service 获取单对象许可 |

不要让公共 CDN 直接映射整个 bucket。即使 public Skill 也由授权接口签发短时 URL，才能在封禁后停止新分发。

## 3. 上传流程

### 3.1 安全默认限制

| 项目 | MVP 默认值 | 处理 |
| --- | ---: | --- |
| 压缩包大小 | 25 MiB | 创建 upload session 和 complete 双重校验 |
| 解压后总大小 | 100 MiB | 流式计数，超限立即停止 |
| 文件数量 | 2,000 | 超限阻断 |
| 单文件大小 | 25 MiB | 超限阻断 |
| 路径深度 | 16 | 超限阻断 |
| 单路径长度 | 240 bytes | 跨平台保守限制 |
| 压缩比 | 100:1 | 超限按 zip bomb 阻断 |
| upload URL TTL | 15 分钟 | 到期重新创建会话 |
| download URL TTL | 5 分钟 | 不在日志中记录 URL |

限制作为配置项，但提升上限需要安全评审。HTTP 层先拒绝显然超限的声明值，Worker 以实际内容为准。

### 3.2 Presigned upload

1. API 校验 actor 对 Skill 的 maintain 权限、SemVer 唯一性、大小和 SHA-256 格式。
2. 数据库创建 `skill_versions(status=uploading)` 和 `skill_upload_sessions(status=created)`。
3. API 为服务端生成的 staging key 签发 PUT URL，并绑定：
   - exact content length 或允许的范围；
   - `Content-Type: application/zip`；
   - user metadata `sha256`；
   - 15 分钟过期。
4. 客户端 PUT 对象后调用 complete。
5. complete 使用 HEAD 校验对象存在、大小、类型和 metadata，在事务中写 `uploaded` + Outbox。

客户端声明的 SHA-256 不能作为最终可信值。Scanner 读取原始字节时重新计算，发现不一致则 `rejected`，finding code 为 `ARCHIVE_CHECKSUM_MISMATCH`。

## 4. 安全解包

Scanner 将每个任务放入全新临时目录，目录权限仅当前进程可访问。处理顺序：

1. 流式下载，同时计算 SHA-256 和压缩包大小。
2. 解析 ZIP central directory，先执行文件数、大小、压缩比和路径预检查。
3. 对每个 entry 规范化为 `/` 分隔的相对路径。
4. 拒绝以下路径或类型：
   - 绝对路径、盘符、UNC path；
   - `..`、空段、NUL、控制字符；
   - symlink、hardlink、device、FIFO、socket；
   - Windows reserved names、alternate data streams；
   - 大小写折叠后重复路径；
   - NFC/NFD 规范化后冲突路径；
   - 目标路径逃出临时根目录。
5. 以不跟随链接的方式创建常规文件，逐字节累计解压大小。
6. 校验只有一个 Skill 根目录，根目录必须包含 `SKILL.md`。
7. 扫描结束后安全清理临时目录；失败也必须清理。

不要调用系统 `unzip` 处理不可信包，除非能够证明参数、路径和资源限制在所有平台均受控。优先使用 Go 标准库并对每个 entry 显式校验。

## 5. Manifest 校验

校验器版本必须保存为 `scanner_version`，以便规则升级后重扫。

MVP 最低规则：

- 根目录存在且只有一个 `SKILL.md`。
- YAML frontmatter 可解析，且文档正文为 UTF-8。
- `name` 必填、最长 64、仅小写字母/数字/连字符，不以连字符开头或结尾，不含连续 `--`。
- `description` 必填、最长 1,024，不含 HTML angle bracket；必须说明用途和触发场景。
- `name` 与服务端 Skill 记录一致。
- 未知 frontmatter key 默认保留但标记 warning；明确危险或类型错误字段阻断。
- 相对引用只能指向包内存在的文件。
- `agents/openai.yaml`、`scripts/`、`references/`、`assets/` 为可选资源；目录之外的引用被拒绝。

扫描器生成规范化 manifest JSON，其中包含：

```json
{
  "schemaVersion": 1,
  "name": "release-notes",
  "description": "Generate release notes from repository changes.",
  "files": [
    {
      "path": "SKILL.md",
      "sha256": "...",
      "size": 4096,
      "mediaType": "text/markdown"
    }
  ],
  "capabilities": {
    "hasScripts": true,
    "hasBinaries": false,
    "declaredTools": []
  }
}
```

manifest 不包含文件原文。`files` 排序固定，JSON 使用稳定序列化，便于计算 `manifest_sha256`。

## 6. 扫描规则

### 6.1 必须阻断

| Finding code | 场景 |
| --- | --- |
| `ARCHIVE_CHECKSUM_MISMATCH` | 实际摘要与声明不一致 |
| `ARCHIVE_PATH_TRAVERSAL` | 路径穿越或绝对路径 |
| `ARCHIVE_UNSAFE_ENTRY_TYPE` | symlink、device 等特殊类型 |
| `ARCHIVE_RESOURCE_LIMIT_EXCEEDED` | 大小、数量、深度或压缩比超限 |
| `ARCHIVE_DUPLICATE_PATH` | 大小写/Unicode 规范化后冲突 |
| `MANIFEST_MISSING` | 缺少根 `SKILL.md` |
| `MANIFEST_INVALID` | frontmatter/编码/必填字段无效 |
| `MANIFEST_NAME_MISMATCH` | 包内 name 与 Skill identity 不一致 |
| `SECRET_HIGH_CONFIDENCE` | 高置信度真实私钥、云凭证或 token |
| `BINARY_EXECUTABLE_BLOCKED` | MVP 禁止的可执行二进制 |
| `MALWARE_DETECTED` | AV/恶意样本命中 |

### 6.2 需要公开审核重点关注

| Finding code | 场景 |
| --- | --- |
| `SCRIPT_NETWORK_ACCESS` | 脚本访问网络、上传或下载 |
| `SCRIPT_PROCESS_EXECUTION` | 启动外部进程或 shell |
| `SCRIPT_FILESYSTEM_WRITE` | 修改 Skill 目录之外文件 |
| `PROMPT_DATA_EXFILTRATION` | 指令诱导读取并发送凭证/隐私数据 |
| `PROMPT_OVERRIDE_SAFETY` | 指令要求绕过安全或权限限制 |
| `OBFUSCATED_CONTENT` | 大段 base64、压缩代码或混淆脚本 |
| `UNDECLARED_TOOL_USAGE` | 内容要求使用未声明工具 |
| `LICENSE_MISSING` | 公开分发缺少许可证信息，是否阻断由产品决定 |

静态规则存在误报，不能仅因关键字命中就封禁；finding 应提供稳定 code、severity、相对路径和不含 secret 的证据摘要。

### 6.3 Secret 处理

- 只保存类型、路径、行号范围和指纹，不保存 secret 原文。
- 日志不得包含匹配上下文。
- 高置信度 secret 阻断并提示作者撤销凭证、清理后发布新版本。
- 管理员不能通过普通 API 获取 secret 原文。

## 7. Redis Stream 与任务处理

### 7.1 Stream

建议使用：

| Stream | Consumer group | 用途 |
| --- | --- | --- |
| `aigw:skills:scan:v1` | `skill-scanners` | 包扫描 |
| `aigw:skills:metrics:v1` | `skill-metrics-writers` | 下载/安装统计 |
| `aigw:skills:cleanup:v1` | `skill-cleaners` | 可选清理通知；定时扫描仍是兜底 |

消息只包含 resource ID、attempt、schema version 和 trace context，不包含分享 token、签名 URL 或文件内容。

示例：

```json
{
  "schemaVersion": 1,
  "eventId": "evt_01...",
  "eventType": "skill.version.scan.requested",
  "versionPublicId": "skv_01...",
  "scanAttempt": 1,
  "requestedAt": "2026-08-07T08:10:00Z",
  "requestId": "req_01..."
}
```

### 7.2 Outbox publisher

1. API 事务写 `skill_outbox_events(status=pending)`。
2. Publisher 以短租约批量领取可用行。
3. 使用 `eventId` 作为 Redis payload 的稳定去重键。
4. XADD 成功后将 Outbox 设为 `published`。
5. Publisher 在 XADD 后、DB 更新前崩溃会产生重复消息；Consumer 必须幂等。

Redis 不可用时 Outbox 保留 pending，不影响已完成的上传记录。监控 pending age，恢复后补发。

### 7.3 Scanner 幂等与重试

领取消息后：

- 以条件更新将 `uploaded` 变为 `scanning`，并校验 `scan_attempt`。
- 如果版本已经是终态或 attempt 不匹配，安全 ACK。
- 相同 attempt 的 findings 采用事务覆盖/切换有效 attempt。
- 写结果成功后再 ACK；数据库失败不 ACK。
- stale pending 消息由 reclaim job 重新领取。

建议重试：1 分钟、5 分钟、30 分钟、2 小时、6 小时；最多 5 次。只有对象存储超时、网络、数据库等技术错误可重试；结构/安全 finding 直接 rejected。

重试耗尽：

- `skill_versions.status=failed`
- `scan_summary.failureCode` 保存稳定错误码
- 消息写入 `aigw:skills:scan:dlq:v1`
- 告警并允许管理员或 owner 触发 rescan

## 8. 发布和下载安全

### 8.1 发布门禁

所有条件同时满足才可 published：

- 实际 SHA-256 与上传声明一致；
- manifest 有效且 name 匹配；
- 没有 blocking finding；
- package 已从 staging 复制到不可变 packages key，并写后验证；
- manifest object 已写入并校验；
- public visibility 已有 admin approve；
- Skill 未 blocked/deleted。

状态变为 published 与 `latest_published_version_id` 更新在同一数据库事务中。对象复制先完成，数据库发布后才可签发 URL；多余未引用对象由 cleanup job 回收。

### 8.2 下载授权

授权顺序：

1. 加载 Skill 和 Version，确认状态 published/deprecated 且未 blocked。
2. 判断 public、owner、grant 或有效 share resolution。
3. 检查客户端兼容性和限流。
4. 签发只读、单对象、5 分钟 URL。
5. 异步写下载事件，不阻塞主响应。

签名 URL 响应设置 `Cache-Control: no-store`，反向代理和 APM 对 `downloadUrl` 字段做脱敏。对象响应可使用不可变缓存，但 URL 本身不得长期缓存。

客户端必须再次验证 SHA-256。服务端应同时返回 manifest 摘要，方便客户端在安装前展示风险能力。

### 8.3 紧急封禁

管理员封禁 Skill 时：

- 事务更新 Skill/相关版本为 blocked；
- 撤销 share links；
- 写审计和 cache invalidation event；
- 新的下载许可立即拒绝；
- 已签发 URL 只剩短 TTL 风险窗口；必要时使用对象存储 deny policy 或轮换 object key 紧急止血；
- 保留 package 和 findings 作为证据，不立即物理删除。

## 9. API 与应用安全

- 复用现有用户 Session、Console API permission 和 Admin auth，不接受客户端传入 owner ID。
- 所有资源查询带 actor 条件；无权限时对 private/unlisted 返回 404，降低枚举风险。
- 对 metadata PATCH 使用 revision，状态迁移使用条件更新。
- share token 至少 256 bit；仅存 SHA-256；解析使用 constant-time compare 或直接索引摘要。
- device ID 使用 HMAC-SHA-256，并支持 key version 轮换。
- 管理端审核、封禁、恢复、分类和授权变更写现有 `audit_logs`。
- CORS 只允许受控管理/目录域名；presigned PUT 限定方法、headers、TTL 和来源策略。
- JSON body、query 和 header 长度均设上限；搜索参数不能直拼 SQL。
- 对象名、相对路径和 finding message 输出前转义，防止管理端 stored XSS。

## 10. 隐私与日志

允许记录：request ID、actor internal ID、skill/version public ID、状态、耗时、大小、finding code、规则版本。

禁止记录：

- share token 和 resolution token；
- presigned URL/query；
- R2 credentials；
- package 文件原文；
- secret finding 上下文；
- 原始 device ID；
- 用户机器上的本地 Skill 路径。

日志事件建议：

```text
skill.upload_session.created
skill.upload.completed
skill.scan.started
skill.scan.completed
skill.version.reviewed
skill.version.published
skill.download_license.created
skill.installation.reported
skill.blocked
skill.cleanup.completed
```

## 11. 威胁与控制矩阵

| 威胁 | 主要控制 | 残余风险 |
| --- | --- | --- |
| ZIP Slip 覆盖主机文件 | entry 规范化、根路径校验、拒绝 links | 解压库未来漏洞 |
| Zip bomb / OOM | 预扫描、流式限制、Worker 资源配额 | 高并发合法大包耗时 |
| 恶意脚本 | 不执行、静态规则、公开人审、客户端提示 | 安装后由用户主动执行的风险 |
| 凭证泄露 | secret scan、无原文日志、发布阻断 | 未识别的新格式 secret |
| 越权下载 | 服务端授权、短时 URL、private bucket | 已签 URL 的短 TTL 窗口 |
| 分享 token 泄露 | fragment + POST、hash 存储、撤销/过期/限次 | 接收方主动转发 token |
| 状态竞态 | 条件更新、revision、事务 Outbox | 运维直接改库 |
| 队列重复 | event ID + consumer 幂等 | 错误实现导致重复统计 |
| 管理员滥用 | 独立 Admin auth、审计、最小对象权限 | 单管理员体系缺少四眼审批 |
| 供应链替换 | published immutable、SHA-256、content-addressed key | 对象存储/IAM 根权限被攻破 |

高风险生产发布前应补充对象存储 IAM 评审、扫描器容器隔离和一次针对上传/解包/授权链路的安全测试。
