# AUTO Gateway 文档

本目录记录 Codex 技能管理功能的产品需求和服务端技术方案。技术方案以 AUTO Gateway 现有 Go 服务为实现目标，尚未实现的内容均标记为 **Proposed**；代码和已部署接口始终是最终事实来源。

## 文档索引

| 文档 | 内容 | 适合谁看 |
| --- | --- | --- |
| [Codex 技能中心 PRD](codex-skill-management-prd.md) | 产品目标、用户流程、功能范围、指标和发布阶段 | 产品、设计、研发、QA |
| [技能分发服务技术总览](codex-skill-service/README.md) | 服务范围、技术基线、关键决策和阅读顺序 | 全体项目成员 |
| [服务端架构](codex-skill-service/architecture.md) | 模块边界、核心流程、状态机和代码落点 | 后端、架构师 |
| [数据库设计](codex-skill-service/database-design.md) | ER 模型、表结构、索引、事务和数据保留 | 后端、DBA、QA |
| [REST API 定义](codex-skill-service/api-contract.md) | 用户、公开、管理端接口以及错误和幂等约定 | 后端、桌面端、Web、QA |
| [包处理与安全](codex-skill-service/package-pipeline-security.md) | 对象存储、上传、扫描、队列、下载和供应链安全 | 后端、安全、运维 |
| [测试与上线](codex-skill-service/test-rollout.md) | 测试矩阵、可观测性、迁移、灰度和回滚 | QA、后端、SRE |

## 维护规则

- PRD 描述“为什么做、做什么”；`codex-skill-service/` 描述服务端实现契约。
- 文档使用“Current”表示已有代码能力，使用“Proposed”表示待开发设计，使用“TBD”表示必须评审确认。
- 数据库字段、API 字段、错误码、日志事件和源代码标识符统一使用英文。
- 任一状态、接口或表结构变更，应同时检查架构、数据库、API、安全和测试文档的一致性。
