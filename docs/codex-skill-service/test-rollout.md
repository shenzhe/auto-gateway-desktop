# Codex 技能分发服务测试与上线计划

## 1. 质量目标

上线门禁优先保护四件事：授权不能绕过、发布内容不能被替换、恶意压缩包不能逃逸或耗尽资源、异步故障不能让版本永久卡死。

建议 SLO（正式流量稳定后生效）：

| 指标 | 目标 |
| --- | --- |
| 目录/详情 API 可用性 | 99.9% / 月 |
| 下载许可 API p95 | < 300 ms，不含对象下载 |
| 上传完成 API p95 | < 500 ms，不含扫描 |
| 95% 扫描排队时间 | < 2 分钟 |
| 25 MiB 包扫描 p95 | < 60 秒 |
| published package checksum mismatch | 0 |
| 越权下载安全事件 | 0 |
| Outbox 最老 pending age | < 1 分钟（正常状态） |

## 2. 测试分层

### 2.1 Domain / Service 单元测试

覆盖：

- Skill 和 Version 的全部合法/非法状态迁移。
- visibility 与 owner/grant/share/admin 权限矩阵。
- SemVer 规范化、排序和重复判断。
- slug/name/category/tag 校验。
- revision 乐观锁冲突。
- share 到期、撤销、maxUses 并发条件。
- installation 旧 `reportedAt` 不覆盖新状态。
- blocked/deprecated 对 latest version 的影响。
- API error 到稳定 error code 的映射。

测试名、fixture 标识和断言消息使用英文。

### 2.2 Repository 集成测试

必须在 MySQL 8 和 PostgreSQL 15+ 各运行一套容器化测试：

| 场景 | 断言 |
| --- | --- |
| 空库迁移 | 所有表、索引和约束存在 |
| 重复迁移 | 幂等，无破坏性变化 |
| owner + slug 并发创建 | 只有一个成功 |
| version SemVer 并发创建 | 只有一个成功 |
| revision 并发 PATCH | 一个成功，其余 conflict |
| 状态条件更新 | 旧状态/旧 attempt 不能覆盖 |
| Outbox claim | 多 Worker 不重复持有有效租约 |
| stale lease reclaim | 崩溃任务可恢复 |
| share maxUses 并发 | 不超过配置次数 |
| cursor 分页 | 无遗漏、无重复、排序稳定 |
| soft delete | 默认查询隐藏且唯一约束符合设计 |
| JSON round trip | MySQL/PostgreSQL 行为一致 |

如数据库不启用物理外键，增加 orphan 检测测试和定时一致性检查。

### 2.3 HTTP 契约测试

为 Public/User/Admin 路由建立 table-driven tests：

- 未认证、错误 credential、缺少 permission。
- owner、maintainer、install、view、public 和 admin 的允许/拒绝。
- private/unlisted 未授权返回 404，不泄露存在性。
- DTO 字段缺失、超长、未知 enum、无效 SemVer、无效 cursor。
- `Idempotency-Key` 同请求重放与不同 body 冲突。
- `If-Match` 成功与 revision conflict。
- 状态迁移的 202/201/204/409 语义。
- 统一错误 envelope 和 `X-Request-ID`。
- 签名 URL、share token、object key 不进入测试日志快照。

实现阶段生成 OpenAPI 3.1，并用 schema validator 对响应做契约验证。桌面端可从 OpenAPI 生成/维护 TypeScript DTO，但必须锁定生成器版本。

### 2.4 Object Store 集成测试

使用真实 S3-compatible 测试环境或 MinIO，验证：

- presigned PUT 过期、错误 method、错误 content type、超出大小。
- 服务端生成 key，用户 file name 无法注入路径。
- HEAD metadata 和 size 校验。
- multipart ETag 不被误当作 SHA-256。
- private object 未签名时不可读。
- download URL 只读、单对象、TTL 正确。
- published key 不可覆盖。
- blocked 后 API 不再签发新 URL。
- staging lifecycle 和 cleanup 幂等。
- 对象存储超时/限流/凭证失效映射为可重试错误。

### 2.5 Scanner 安全测试

建立版本化恶意 fixture corpus：

| Fixture | 预期 |
| --- | --- |
| 正常最小 Skill | published 或 pending_review |
| 缺少 `SKILL.md` | `MANIFEST_MISSING` |
| 无效 YAML/UTF-8 | `MANIFEST_INVALID` |
| name mismatch | `MANIFEST_NAME_MISMATCH` |
| `../escape`、absolute、drive、UNC | `ARCHIVE_PATH_TRAVERSAL` |
| symlink/hardlink/device | `ARCHIVE_UNSAFE_ENTRY_TYPE` |
| 大小写重复、NFC/NFD 重复 | `ARCHIVE_DUPLICATE_PATH` |
| 过多文件/过深路径/大单文件 | `ARCHIVE_RESOURCE_LIMIT_EXCEEDED` |
| 高压缩比 zip bomb | 快速阻断，内存受限 |
| checksum mismatch | `ARCHIVE_CHECKSUM_MISMATCH` |
| 测试私钥/token | `SECRET_HIGH_CONFIDENCE`，无原文日志 |
| 脚本网络/进程/外部写入 | 风险 finding，public 进入人工审核 |
| 可执行二进制 | 按 MVP 策略阻断 |
| 混淆和 base64 内容 | warning/risk，不产生 scanner crash |

对 parser 和路径规范化函数做 Go fuzz test。关键不变量：任意输入不得在临时根目录之外创建文件、不得 panic、不得超过配置资源预算。

### 2.6 Worker 与故障注入

覆盖：

- DB commit 成功、Redis 发布失败，Outbox 后续补发。
- Redis XADD 成功、Outbox 标记前崩溃，重复消息被幂等处理。
- Worker 在下载、解包、写 manifest、写 DB 的每个阶段崩溃。
- Redis pending reclaim 和 DLQ。
- 重试只针对技术错误，安全 finding 不重试。
- 旧 scan attempt 迟到不能覆盖新 attempt。
- 多 scanner 并发下同一 version 只有一个有效结果。
- shutdown/drain 时停止领取新任务并完成或释放租约。

使用现有 Redis test 方式作为基础，但扫描主链路至少有一套真实 Redis 集成测试。

### 2.7 端到端测试

最少自动化以下路径：

1. 用户创建 private Skill → 上传 → 扫描 → published → 下载 → 安装回传。
2. public Skill → 扫描 → pending review → admin approve → public catalog 可见。
3. public review reject → 作者看到 findings → 上传新版本 → approve。
4. unlisted Skill → share → 匿名 resolve → 下载 → revoke 后拒绝。
5. grant install → 被授权用户下载；grant 撤销后拒绝。
6. published Skill 被 admin block → 目录隐藏、新下载拒绝、审计存在。
7. Redis 暂停期间 complete upload → 恢复后自动扫描。
8. Scanner 规则升级 → rescan，不修改 archive SHA-256。

桌面端 E2E 还需要验证下载 SHA-256 和本地安装事务，但属于桌面端实现计划，不替代本文服务端测试。

## 3. 性能和容量测试

### 3.1 初始容量假设

以下为压测基线，不是业务预测：

- 100,000 Skills。
- 平均 3 个版本，300,000 packages。
- 10,000 日活用户。
- 峰值 100 catalog RPS、50 download-license RPS。
- 峰值 10 uploads/minute，4–16 scanner consumers。
- 每包平均 500 KiB，p99 25 MiB。

### 3.2 压测场景

- 公共目录按 category/tag/search/cursor 查询。
- Owner dashboard 联合 latest version、category、tags 和权限。
- download-license 热门 Skill 集中访问，验证 DB 热点和 Redis 限流。
- 批量 installation report，验证 upsert 与 metrics Stream lag。
- 1,000 pending scans 下 Worker 水平扩展和公平性。
- Outbox 100,000 pending event 恢复吞吐。
- 对象存储慢响应时 API/Worker 超时、连接池和内存上限。

扫描 Worker 设置独立 CPU、内存和临时磁盘限额，不能与 HTTP API 共用无限资源池。

## 4. 可观测性

### 4.1 Metrics

建议指标：

```text
skill_api_requests_total{route,status}
skill_api_request_duration_seconds{route}
skill_upload_sessions_total{result}
skill_upload_bytes_total
skill_scan_jobs_total{result,risk}
skill_scan_duration_seconds
skill_scan_queue_lag_seconds
skill_scan_findings_total{code,severity}
skill_outbox_pending_total
skill_outbox_oldest_age_seconds
skill_worker_retries_total{worker,reason}
skill_worker_dlq_total{worker}
skill_download_licenses_total{visibility,result}
skill_installation_reports_total{status}
skill_storage_operations_total{operation,result}
```

不要用 user ID、skill ID、version ID 或 finding path 作为 metric label，避免高基数。

### 4.2 Logs and traces

结构化日志至少包含：`requestId`、`traceId`、`actorType`、内部 actor ID、skill/version public ID、event、result、durationMs、stableErrorCode。

在 API → DB/Outbox → Redis → Worker → object store 之间传播 trace context。对 presigned URL、token、credentials、文件内容和原始 device ID 做强制脱敏测试。

### 4.3 Alerts

| 告警 | 初始阈值 |
| --- | --- |
| API 5xx | 5 分钟 > 2% |
| storage error | 5 分钟 > 5% |
| scan queue lag | p95 > 10 分钟持续 10 分钟 |
| Outbox oldest | > 5 分钟 |
| DLQ | 任意新增即告警 |
| scanner crash loop | 10 分钟内 > 3 次 |
| checksum mismatch | 任意 published 读取不一致立即 P1 |
| unauthorized download signal | 任意确认事件立即 P0/P1 |

## 5. 实施工作包

### Phase 0：契约和风险验证（3–5 个工作日）

- 评审 Skill package 格式和 `SKILL.md` validator 规则。
- 确认 public ID 算法、包限制、许可证策略和 public review 流程。
- 验证 R2 presigned PUT/GET、private bucket 和 IAM。
- 用 MySQL/PostgreSQL 验证 Outbox claim SQL。
- 决定 MVP 是否允许 scripts 和 binaries。

退出条件：数据库/API/状态机/安全限制获得产品、后端、安全共同确认。

### Phase 1：领域、数据库和基础 API（1–2 周）

- Domain、GORM models、migrations、repositories。
- Catalog、Skill CRUD、category/tag、ownership/grant。
- 统一 error envelope、cursor、idempotency、revision。
- Admin 基础查询和 audit 接入。

退出条件：MySQL/PostgreSQL 集成测试通过，Public/User/Admin 权限契约通过。

### Phase 2：对象存储和扫描流水线（1–2 周）

- Upload session、R2 package store、complete upload。
- Outbox publisher、Redis Stream、Scanner、findings、retry/DLQ。
- 不可变 package/manifest 发布。
- 清理 Worker 和对象生命周期。

退出条件：恶意 fixture、fuzz、故障注入、重复消息和恢复测试通过。

### Phase 3：审核、分享、下载和安装统计（1 周）

- Public review、block/restore。
- Share link、access grant、download license。
- Installation upsert、metrics Stream 和日聚合。
- Admin 审核/分类页面所需接口。

退出条件：全链路 E2E 和安全权限矩阵通过。

### Phase 4：灰度与稳定性（1 周）

- 影子/内部流量、性能压测、告警和 runbook。
- 先 private/unlisted，再 public review/catalog。
- Desktop beta 对接和 checksum 安装验证。
- 容量、成本和 SLO 基线。

退出条件：连续 7 天无高优安全/数据一致性问题，队列和对象清理指标稳定。

以上为单个小型后端团队的初始估算；详细排期取决于 Admin UI、桌面端对接和安全扫描引擎复用程度。

## 6. 部署顺序

1. 合并迁移和 feature flag，`skills.enabled=false`。
2. 生产执行 schema migration，验证索引和连接池影响。
3. 部署兼容旧行为的 API binary，不注册/不开放写路由。
4. 配置 private bucket、IAM、Redis streams、secret 和 lifecycle。
5. 部署 Scanner/Outbox/Cleanup Worker，保持无任务。
6. 开启内部管理员和 allowlist 用户的 private Skill。
7. 开启 unlisted 分享。
8. 验证审核 SLA、封禁演练和告警后开启 public catalog。
9. 扩大桌面端 beta，再逐步全量。

数据库结构先于代码，Worker 先于任务，public 分发最后开启。

## 7. Feature flags

建议独立开关：

```text
skills.enabled
skills.uploadsEnabled
skills.publicCatalogEnabled
skills.shareLinksEnabled
skills.installationReportingEnabled
skills.adminReviewEnabled
```

开关由服务端配置控制，不依赖客户端隐藏按钮作为安全措施。关闭 public catalog 时，已发布 public Skill 不再出现在目录；是否继续允许已知 ID 下载需单独 runbook 决策，紧急模式默认拒绝。

## 8. 回滚方案

### 8.1 API 回滚

- 新表为 additive，旧服务版本忽略它们。
- 关闭 Skills feature flags，停止新建/上传/下载许可。
- 保留表和对象，不在紧急回滚中 drop schema。

### 8.2 Worker 回滚

- 停止 consumer 领取新任务，等待正在处理任务完成或租约过期。
- pending Outbox/Redis 消息保留，修复后继续。
- Scanner 规则回滚不自动把已 rejected 版本变为 published；必须 rescan。

### 8.3 数据回滚

- 错误 category/tag 可通过审计后的补偿更新修复。
- 错误发布立即 block，而不是删除 package。
- 错误封禁可 admin restore，但必须记录原因。
- 不回写或覆盖已发布 archive；内容错误发布新版本。

## 9. 发布门禁清单

- [ ] 数据库 migration 在 MySQL/PostgreSQL 空库和升级库通过。
- [ ] OpenAPI、服务端 DTO 和桌面端 DTO 契约一致。
- [ ] 全部权限矩阵与 private 404 行为通过。
- [ ] Idempotency、revision、状态条件更新并发测试通过。
- [ ] 恶意 ZIP corpus 和 fuzz test 通过，扫描器不执行内容。
- [ ] R2 bucket 为 private，IAM 最小权限评审通过。
- [ ] Token、URL、secret、文件内容和 device ID 日志脱敏通过。
- [ ] Outbox、Redis 重复/宕机、Worker crash 恢复测试通过。
- [ ] Block/revoke 演练能在 5 分钟 URL TTL 内止血。
- [ ] Metrics、alerts、dashboard、runbook 已上线。
- [ ] 数据保留、隐私删除和安全事件流程已确认。
- [ ] private → unlisted → public 灰度顺序得到批准。

## 10. Definition of Done

当以下条件全部满足时，服务端 MVP 才算完成：

1. 用户能创建 Skill、上传不可变版本并获得可解释扫描结果。
2. private/unlisted 安全版本能发布，public 版本必须经过管理员审核。
3. 未授权、rejected、failed、blocked 或未发布版本无法获取下载许可。
4. 下载响应包含可验证 SHA-256，客户端安装回传可幂等记录。
5. Redis/Object Store/Worker 故障后无需人工改库即可恢复或进入可处理 DLQ。
6. MySQL/PostgreSQL、API 契约、安全 corpus、端到端和灰度测试通过。
7. 审计、监控、告警、封禁、回滚和数据保留流程可操作。
