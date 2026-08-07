# Codex 技能分发服务技术总览

| 项目 | 内容 |
| --- | --- |
| 状态 | Proposed / 待架构评审 |
| 最后更新 | 2026-08-07 |
| 产品依据 | [Codex 技能中心 PRD](../codex-skill-management-prd.md) |
| 服务端基线 | `ai_gateway` 提交 `4f712698fe03` |
| 目标技术栈 | Go 1.25、Gin 1.12、GORM 1.31、MySQL/PostgreSQL、Redis、S3/R2 |
| 首期客户端 | AUTO Gateway Desktop |

## 1. 文档范围

本文档包定义 SKILL 管理功能所需的服务端能力：技能元数据、不可变版本包、分类和标签、上传、静态安全扫描、公开审核、分享、下载授权、安装状态回传、管理端治理、统计与审计。

本方案不负责桌面端本地文件安装事务，也不会让服务端读取用户机器上的 Codex 目录。桌面端仍需在下载后校验 SHA-256，并以本机受控事务完成安装、启用、禁用和卸载。

## 2. 当前能力与新增能力

| 领域 | Current | Proposed |
| --- | --- | --- |
| HTTP | Gin 已注册 `/public/api`、`/user/api`、`/admin/api` | 在相同路由域新增 Skills API |
| 身份认证 | 用户 Session、Console API permission、独立 Admin auth | 复用认证中间件，新增技能权限检查 |
| 数据库 | GORM；MySQL 与 PostgreSQL 双驱动；多数 Store 使用 `EnsureSchema` | 新增技能领域表、显式复合索引和迁移验证 |
| 缓存/异步 | Redis、Redis Stream、后台 Worker | 新增扫描与统计 Stream、重试和死信处理 |
| 对象存储 | 已有 S3-compatible R2 上传和 Codex artifact mirror | 新增私有 Skill package bucket/prefix 和短时下载 URL |
| 审计 | 已有 `audit_logs` 及 `AuditLogRecorder` | 复用记录发布、驳回、封禁、分类和权限变更 |
| 团队模型 | 未发现 workspace/team membership 领域 | MVP 不实现团队强制分发；Phase 2 依赖组织模型 |

## 3. MVP 边界

MVP 包含：

- 用户创建技能记录并上传 ZIP 包。
- 每个版本不可变，使用 SHA-256 标识内容。
- 服务端安全解包、校验 `SKILL.md` 并生成扫描结果。
- `private`、`unlisted`、`public` 三种可见性。
- 私有与链接分享版本扫描通过后自动发布；公开版本进入人工审核。
- 分类、标签、版本列表、公开目录和搜索。
- 所有者分享链接、用户级访问授权、短时下载 URL。
- 桌面端安装、禁用和卸载状态回传。
- 管理端审核、驳回、封禁、恢复、分类管理和审计。

MVP 不包含：

- 在服务器执行 Skill 内的脚本或依赖安装。
- 团队/工作区的强制安装策略。
- 付费市场、结算和分成。
- 在服务端修改已发布版本内容。
- 服务端控制用户本机 Codex 的启用状态。

## 4. 关键技术决策

| ID | 决策 | 说明 |
| --- | --- | --- |
| SD-01 | 数据库存元数据，对象存储存 ZIP 和规范化 manifest | 避免大对象进入关系数据库 |
| SD-02 | `skill_versions` 一经发布不可修改 | 更新必须创建新版本，保证回滚、缓存和审计可信 |
| SD-03 | 外部 API 使用随机 `publicId`，内部关联使用自增 `BIGINT` | 避免暴露可枚举主键，同时保留高效关联 |
| SD-04 | 对象存储保持私有，下载由 API 授权后签发短时 URL | 统一处理 private、unlisted 和 public 的撤销能力 |
| SD-05 | 上传完成和扫描任务写入使用事务 Outbox | 防止数据库已提交但队列消息丢失 |
| SD-06 | 扫描器永不执行包内文件 | 将上传内容视为不可信供应链输入 |
| SD-07 | 公开版本必须通过扫描和人工审核 | 降低公开目录传播恶意内容的风险 |
| SD-08 | 分享 token 只存 SHA-256 摘要 | 数据库泄露时不直接暴露可用分享凭证 |
| SD-09 | 安装设备 ID 在服务端加密散列 | 支持去重但不保存设备原始标识 |
| SD-10 | 团队分发延后到组织域落地后 | 避免本功能私建一套不一致的成员体系 |

## 5. 建议代码落点

目标实现位于 Go 服务仓库，建议保持现有分层：

```text
internal/
├── domain/
│   ├── skill.go
│   └── skill_policy.go
├── httpapi/
│   ├── user_skills.go
│   ├── public_skills.go
│   └── admin_skills.go
├── skillservice/
│   ├── service.go
│   ├── authorization.go
│   ├── publishing.go
│   └── downloads.go
├── repository/
│   ├── skill_store.go
│   ├── skill_version_store.go
│   └── skill_job_store.go
├── objectstore/
│   └── r2_skill_packages.go
└── worker/
    ├── skill_outbox_publisher.go
    ├── skill_scan_worker.go
    └── skill_cleanup_worker.go
```

HTTP handler 只处理鉴权、DTO 校验和响应映射；状态迁移与事务在 `skillservice`；GORM 查询在 `repository`；对象读写在 `objectstore`；扫描和清理在 `worker`。

## 6. 阅读顺序

1. [服务端架构](architecture.md)：理解模块、信任边界和状态机。
2. [数据库设计](database-design.md)：评审表、索引和事务。
3. [REST API 定义](api-contract.md)：前后端对齐接口契约。
4. [包处理与安全](package-pipeline-security.md)：评审上传、扫描和下载安全。
5. [测试与上线](test-rollout.md)：拆分实现、迁移和发布任务。

## 7. 待确认事项

- `publicId` 采用 UUID v4、UUID v7 或 ULID；本文接口按不透明字符串处理，不依赖具体算法。
- 公开 Skill 的审核 SLA 和审核人员角色。
- 包大小、文件数和解压后大小的最终商业限制；本文提供安全默认值。
- 是否允许 Skill 包含可执行脚本。MVP 可以存储脚本，但扫描器不执行，客户端安装前必须再次提示。
- 团队分发是否复用未来 workspace 模型，或对接外部组织目录。
- 公共目录是否允许匿名下载；本文默认允许匿名浏览，下载仍经 API 签发并受限流。

## 8. 兼容性说明

Skills 是可复用工作流，而 Codex Plugins 更适合作为跨团队安装和分发单元。MVP 保持 Skill ZIP 互通；团队阶段应评估将一个或多个 Skill 打包为 Plugin，而不是扩展私有格式。

参考：[Skills in ChatGPT](https://help.openai.com/en/articles/20001066-skills-in-chatgpt)、[Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan.pdf)。
