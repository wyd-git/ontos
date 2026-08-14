# 文档索引与权威顺序

本目录保存 Ontology Kernel 的产品意图、架构决策、实施任务、Gate 证据和运行说明。

## 当前权威文档

1. [Ontology Kernel PRD](product/ontology-kernel-prd.md)：产品能力、范围、语义和最终验收。
2. [G2 生产实现蓝图](product/ontology-kernel-implementation-blueprint.md)：从 PRD 到工程的实现约束。
3. [G2 蓝图红队审查](reviews/g2-blueprint-red-team.md)：承重假设、验证、Kill Criteria 和 Conditional Go 结论。
4. [G2-00 Foundation 任务包](delivery/g2-00-foundation-task-pack.md)：当前唯一获准执行的 Gate 清单。
5. [G2 工具链基线](architecture/toolchain-baseline.md)与 [Monorepo 依赖边界](architecture/dependency-boundaries.md)：G2-00-01 的已接受工程约束。
6. [本地生产边界架构](architecture/local-production-boundaries.md)与 [运行手册](operations/local-production-boundary-environment.md)：G2-00-02 的协议、信任和生命周期边界。
7. [ADR-007 Runtime Activation](architecture/adr/007-runtime-activation-serving-head.md)、[专项红队](reviews/adr-007-runtime-activation-red-team.md)与 [G2-00-03 Evidence](evidence/g2-00-03-runtime-activation-serving-head.md)：Release/Generation 一致绑定、支持窗、容量和 GC 引用语义。
8. [ADR-008 Shared Projection](architecture/adr/008-shared-projection-index-capacity.md)、[专项红队](reviews/adr-008-shared-projection-red-team.md)与 [G2-00-04 Evidence](evidence/g2-00-04-shared-projection-index-capacity.md)：共享表键、Index Plan、Generation 容量、审批与 GC 上界。
9. [ADR-009 Public Value Codec](architecture/adr/009-public-value-codec.md)、[专项红队](reviews/adr-009-public-value-codec-red-team.md)与 [G2-00-05 Evidence](evidence/g2-00-05-public-value-codec.md)：公共值、Primary Key、排序、Golden Vector 与 PostgreSQL 交叉验证。
10. [ADR-010 Job/Lease 与 Outbox](architecture/adr/010-postgresql-job-lease-outbox.md)、[专项红队](reviews/adr-010-postgresql-job-lease-outbox-red-team.md)与 [G2-00-06 Evidence](evidence/g2-00-06-postgresql-job-lease-outbox.md)：持久 Job 恢复、数据库租约、至少一次投递和同对象顺序。
11. [ADR-011 Trusted Handler Host](architecture/adr/011-trusted-handler-host-boundary.md)、[专项红队](reviews/adr-011-trusted-handler-host-red-team.md)与 [G2-00-07 Evidence](evidence/g2-00-07-trusted-handler-host.md)：登记 Artifact、私有 RPC、受限 Context、硬超时、进程恢复与 trusted deployment 声明。
12. [ADR-012 Policy Epoch](architecture/adr/012-policy-epoch-cache-fail-closed.md)、[专项红队](reviews/adr-012-policy-epoch-red-team.md)与 [G2-00-08 Evidence](evidence/g2-00-08-policy-epoch-cache.md)：同事务 Epoch、双进程有界缓存、通知加速、版本绑定与 fail-closed。
13. [Foundation Contract 与兼容性治理](architecture/foundation-contract-governance.md)、[专项红队](reviews/g2-00-09-foundation-contract-red-team.md)与 [G2-00-09 Evidence](evidence/g2-00-09-foundation-contracts.md)：公共 ID、版本、身份、Release、错误、兼容性规则和渐进冻结边界。
14. [DB-00 Migration、数据库角色与逻辑 Schema](architecture/db-00-migration-roles.md)、[专项红队](reviews/g2-00-10-db-migration-roles-red-team.md)与 [G2-00-10 Evidence](evidence/g2-00-10-db-migration-roles.md)：只向前迁移协议、权限边界、默认权限、并发与故障恢复合同。
15. [G1 资产迁移与正式 Testkit 边界](architecture/testkit-g1-migration.md)：G2-00-11 的来源指纹、迁移转换、确定性生成协议和 Spike 依赖禁线。
16. [G2-00-11 专项红队](reviews/g2-00-11-testkit-red-team.md)与 [Evidence](evidence/g2-00-11-testkit-fixtures.md)：正式 Testkit、确定性 100k/1m Generator、六组资产 Provenance 与 G1 依赖禁线。
17. [强制 CI 与供应链 Gate](architecture/ci-foundation-gate.md)：G2-00-12 的唯一执行路径、报告合同、Secret/License/SBOM/Vulnerability 策略和分支保护。
18. [G2-00-12 专项红队](reviews/g2-00-12-ci-gate-red-team.md)与 [Evidence](evidence/g2-00-12-ci-supply-chain-gate.md)：统一本地/远端执行、故意失败协议、供应链 Fail-Closed、机器报告和不可绕过合并条件。
19. `architecture/adr/`：编码前逐项冻结的实现决策；只有 Accepted ADR 可以覆盖蓝图中的建议性技术选择，不能静默改变 PRD 产品语义。
20. `delivery/`：任务、依赖、Gate 状态与风险；不能反向扩大 PRD 范围。
21. `evidence/`：可复现的 Gate 报告；证据不等于新的产品需求。

## 计划目录

```text
docs/
├── product/                    # PRD、蓝图和正式范围变更
├── reviews/                    # 红队、可行性和专项评审
├── architecture/adr/           # ADR-007 起
├── delivery/                   # G2 Backlog、状态、风险和决策日志
├── api/                        # OpenAPI 使用与版本兼容说明
├── operations/                 # 部署、备份、恢复、GC 和事件处置
├── security/                   # 权限、信任边界、Secret 和专项测试
└── evidence/                   # G2 及之后的 Gate 证据
```

目录在出现第一个真实文档时创建，避免空目录制造虚假的完成感。

## 变更规则

- PRD 范围变化必须说明 P0/P1/P2 影响和验收变化。
- 架构偏离蓝图必须新增 ADR，并说明迁移、兼容、运维和回退/向前恢复影响。
- 文档内的待办不能当作已经实现；实现状态只由代码、测试和 Gate Evidence 决定。
- 每个 Gate 执行 Intended-vs-Implemented 核验，逐条引用文档声明与代码/测试证据。
