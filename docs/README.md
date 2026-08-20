# 文档索引与权威顺序

本目录保存 Ontology Kernel 的产品意图、架构决策、实施任务、Gate 证据和运行说明。

## 当前权威文档

1. [Ontology Kernel PRD](product/ontology-kernel-prd.md)：产品能力、范围、语义和最终验收。
2. [G2 生产实现蓝图](product/ontology-kernel-implementation-blueprint.md)：从 PRD 到工程的实现约束。
3. [核心数据库设计](architecture/core-database-design.md)：以 `0001`～`0027` 真实 Migration 为准，汇总 Metadata、AuthZ/Runtime Identity、Policy Release/Gateway、Snapshot/Generation、Shared Projection、Cutover、Job/Index/GC、Query Lease、权限和后续未实现边界。
4. [G2 蓝图红队审查](reviews/g2-blueprint-red-team.md)：承重假设、验证、Kill Criteria 和 Conditional Go 结论。
5. [G2-03 Query + Policy 任务包](delivery/g2-03-query-policy-task-pack.md)：**进行中（6/15）**，覆盖 Runtime Identity/Delegation、Policy Compiler/Gateway、Get/Search/Count/Link/Cursor、Runtime Read OpenAPI Candidate 与真实只读 Web 消费者；G2-03-01～06 已 PASS，当前只放行 G2-03-07。
   - [UI/API 早期消费者合同](architecture/g2-03-ui-api-consumer-contract.md)：冻结 G2-03 只读、G2-04 Action、G2-05 完整 UI/SDK 的责任分界、页面状态和请求预算。
   - [可行性复审](reviews/g2-03-task-pack-feasibility.md)与[任务包红队](reviews/g2-03-task-pack-red-team.md)：核验当前代码缺口、端到端落地路径、容量与 Kill Criteria，结论为 **Go for G2-03-01 only**。
   - [ADR-020](architecture/adr/020-query-policy-identity-consumer-boundary.md)、[G2-03-01 Evidence](evidence/g2-03-01-query-policy-architecture.md)、[威胁模型](security/g2-03-01-identity-delegation-threat-model.md)与[红队](reviews/g2-03-01-query-policy-architecture-red-team.md)：冻结并验证 Identity/Delegation、Policy SQL、Query Lease/GC、OpenAPI Generated Client 与 Web 栈。
   - [Runtime Read 合同](architecture/g2-03-runtime-read-contract.md)、[G2-03-02 Evidence](evidence/g2-03-02-runtime-read-contracts.md)与[意图对照](reviews/g2-03-02-intended-vs-implemented.md)：冻结 12 类 Query/Policy/Identity/Cursor/Response 合同、Golden、OpenAPI Candidate、私有 Generated Client 与 Breaking Gate。
   - [ADR-021](architecture/adr/021-query-policy-persistence-boundary.md)、[G2-03-03 Evidence](evidence/g2-03-03-query-policy-persistence.md)与[意图对照](reviews/g2-03-03-intended-vs-implemented.md)：落实 0022～0024、Identity/Claim Mapping/Policy Compilation/Epoch/Query Lease/GC Root 与三角色最小权限。
   - [ADR-022](architecture/adr/022-runtime-identity-claim-mapping-delegation.md)、[G2-03-04 Evidence](evidence/g2-03-04-runtime-identity.md)与[意图对照](reviews/g2-03-04-intended-vs-implemented.md)：落实真实 OIDC/DPoP、白名单 Mapping、Service Capability、持久 Replay 与双 API 进程验收。
   - [ADR-023](architecture/adr/023-policy-resource-compiler-release-gate.md)、[G2-03-05 Evidence](evidence/g2-03-05-policy-compiler.md)与[意图对照](reviews/g2-03-05-intended-vs-implemented.md)：落实 Policy Resource 严格解析、精确依赖、受限 AST/IR、确定性 S3 Artifact 与 Release fail-closed Gate。
   - [ADR-024](architecture/adr/024-production-policy-gateway-revocation.md)、[G2-03-06 Evidence](evidence/g2-03-06-policy-gateway.md)与[意图对照](reviews/g2-03-06-intended-vs-implemented.md)：落实同快照授权、精确 Artifact、生产 Gateway、双进程 NOTIFY 和 5 秒撤权上界。
6. [G2-02 Materialization 任务包](delivery/g2-02-materialization-task-pack.md)：**PASS（14/14）**，覆盖受管 CSV、Mapping、Job/Lease、Generation、Base/Current、Staging/Cutover、Index/Capacity、GC 与 clean-room 总验收；其历史下一步声明已由冻结的 G2-03 任务包承接。
   - [ADR-014 Materialization 事务/DDL/Overlay](architecture/adr/014-materialization-transaction-ddl-overlay-boundary.md)、[专项红队](reviews/adr-014-materialization-architecture-red-team.md)与 [G2-02-01 Evidence](evidence/g2-02-01-materialization-architecture.md)：逻辑 DB-02 边界、全局锁/CAS、隔离 DDL Executor、Kill/Replay 与 zero-overlay Seam。
   - [ADR-015 永久 Identity/Attempt Base](architecture/adr/015-permanent-object-identity-attempt-owned-base.md)、[专项红队](reviews/g2-02-06-object-identity-base-red-team.md)与 [G2-02-06 Evidence](evidence/g2-02-06-object-identity-base.md)：永久 RID、类型化 Link、隔离 Staging、原子 Base 提升与 10k/100k 薄切片。
   - [ADR-017 Materialization Worker 恢复](architecture/adr/017-materialization-worker-recovery.md)、[专项红队](reviews/g2-02-08-materialization-worker-red-team.md)与 [G2-02-08 Evidence](evidence/g2-02-08-materialization-worker.md)：数据库时间租约、八阶段 Checkpoint、Retry/Cancel、最小权限与 16 点真实 PID Kill/Resume。
   - [ADR-008 Shared Projection/Index/Capacity](architecture/adr/008-shared-projection-index-capacity.md)、[专项红队](reviews/g2-02-09-index-capacity-ddl-red-team.md)与 [G2-02-09 Evidence](evidence/g2-02-09-index-capacity-ddl.md)：Published Property 绑定、稳定 Index Plan、完整容量库存、隔离 DDL、故障恢复与 100k/1m 首轮实测。
   - [G2-02-10 Runtime Plan/Compatibility Evidence](evidence/g2-02-10-runtime-plan-compatibility.md)与[专项红队](reviews/g2-02-10-runtime-plan-compatibility-red-team.md)：服务器派生不可变 Plan、Group 完整性、受信证书、动态失效、跨 Release 复用和多成员 100k/1m Closure。
   - [ADR-018 Snapshot Group Cutover](architecture/adr/018-immutable-head-set-snapshot-group-cutover.md)、[专项红队](reviews/g2-02-11-snapshot-cutover-red-team.md)与 [G2-02-11 Evidence](evidence/g2-02-11-snapshot-group-cutover.md)：不可变 Head Set、短事务 Pointer CAS、原子 Activation/Refresh 与 100k/1m 容量证据。
   - [ADR-019 Generation/Index GC](architecture/adr/019-generation-index-mark-plan-commit-gc.md)、[专项红队](reviews/g2-02-12-generation-index-gc-red-team.md)与 [G2-02-12 Evidence](evidence/g2-02-12-generation-index-gc.md)：完整 Root/Inventory、单调 Root Epoch、分批 Kill/Resume、精确对象版本删除与 GC-bound Index Drop。
   - [G2-02-13 Admin/Testkit/CI Evidence](evidence/g2-02-13-admin-testkit-ci.md)、[意图对照](reviews/g2-02-13-intended-vs-implemented.md)与[专项红队](reviews/g2-02-13-admin-testkit-ci-red-team.md)：最小 Admin HTTP、生产 Worker 八阶段、真 OIDC/PG/S3/API/DDL 闭环、两领域 Testkit 与统一 CI Manifest。
   - [G2-02-14 Clean-room Evidence](evidence/g2-02-14-clean-room-materialization.md)、[意图对照](reviews/g2-02-14-intended-vs-implemented.md)与[专项红队](reviews/g2-02-14-clean-room-red-team.md)：独立空环境 100k/1m 冷/热闭环、20 次 Cutover、容量/安全/GC、整体重启与 G2-02 总 Manifest。
7. [G2-02 任务包红队](reviews/g2-02-task-pack-red-team.md)：Dynamic DDL、零成员 A0 前向兼容、Kill/Resume、100k/1m 与 Overlay Seam 的 Kill Criteria。
8. [G2-01 Metadata 任务包](delivery/g2-01-metadata-task-pack.md)：已完成的 DB-01、Metadata/Release/Package Store、最小管理授权和 Admin API Gate。
9. [G2-01 任务包红队](reviews/g2-01-task-pack-red-team.md)：零成员 Activation、Package/Release 原子性、渐进冻结、授权边界和单通道工期的 Kill Criteria。
10. [ADR-013 Metadata 控制面](architecture/adr/013-metadata-release-package-control-plane.md)、[专项红队](reviews/adr-013-metadata-control-plane-red-team.md)与 [G2-01-01 Evidence](evidence/g2-01-01-metadata-control-plane.md)：DB-01 候选表、状态机、原子 Publish、零成员 Activation、管理授权与 Roll Forward 合同。
11. [Metadata v1 合同治理](architecture/metadata-contract-governance.md)、[G2-01-02 专项红队](reviews/g2-01-02-metadata-contract-red-team.md)与 [Evidence](evidence/g2-01-02-metadata-contracts.md)：12 类 Metadata 合同、严格 Parser、兼容基线、Family Registry、Golden Fixture 与规范 Digest。
12. [DB-01 运行手册](operations/db-01-metadata-migration.md)、[专项红队](reviews/g2-01-03-db-01-red-team.md)与 [Evidence](evidence/g2-01-03-db-01-migration.md)：18 张 Metadata/AuthZ 表、不可变事实、最小权限、并发迁移和 Roll Forward 证据。
13. [G2-01-09 Package Evidence](evidence/g2-01-09-package-lifecycle.md) 与 [专项红队](reviews/g2-01-09-package-lifecycle-red-team.md)：严格预检、事务展开、兼容升级、Pending Change、三 Pointer 原子激活与向前 Rollback。
14. [G2-00 Foundation 任务包](delivery/g2-00-foundation-task-pack.md)：已经完成的底座 Gate 清单和历史范围边界。
15. [G2 工具链基线](architecture/toolchain-baseline.md)与 [Monorepo 依赖边界](architecture/dependency-boundaries.md)：G2-00-01 的已接受工程约束。
16. [本地生产边界架构](architecture/local-production-boundaries.md)与 [运行手册](operations/local-production-boundary-environment.md)：G2-00-02 的协议、信任和生命周期边界。
17. [ADR-007 Runtime Activation](architecture/adr/007-runtime-activation-serving-head.md)、[专项红队](reviews/adr-007-runtime-activation-red-team.md)与 [G2-00-03 Evidence](evidence/g2-00-03-runtime-activation-serving-head.md)：Release/Generation 一致绑定、支持窗、容量和 GC 引用语义。
18. [ADR-008 Shared Projection](architecture/adr/008-shared-projection-index-capacity.md)、[专项红队](reviews/adr-008-shared-projection-red-team.md)与 [G2-00-04 Evidence](evidence/g2-00-04-shared-projection-index-capacity.md)：共享表键、Index Plan、Generation 容量、审批与 GC 上界。
19. [ADR-009 Public Value Codec](architecture/adr/009-public-value-codec.md)、[专项红队](reviews/adr-009-public-value-codec-red-team.md)与 [G2-00-05 Evidence](evidence/g2-00-05-public-value-codec.md)：公共值、Primary Key、排序、Golden Vector 与 PostgreSQL 交叉验证。
20. [ADR-010 Job/Lease 与 Outbox](architecture/adr/010-postgresql-job-lease-outbox.md)、[专项红队](reviews/adr-010-postgresql-job-lease-outbox-red-team.md)与 [G2-00-06 Evidence](evidence/g2-00-06-postgresql-job-lease-outbox.md)：持久 Job 恢复、数据库租约、至少一次投递和同对象顺序。
21. [ADR-011 Trusted Handler Host](architecture/adr/011-trusted-handler-host-boundary.md)、[专项红队](reviews/adr-011-trusted-handler-host-red-team.md)与 [G2-00-07 Evidence](evidence/g2-00-07-trusted-handler-host.md)：登记 Artifact、私有 RPC、受限 Context、硬超时、进程恢复与 trusted deployment 声明。
22. [ADR-012 Policy Epoch](architecture/adr/012-policy-epoch-cache-fail-closed.md)、[专项红队](reviews/adr-012-policy-epoch-red-team.md)与 [G2-00-08 Evidence](evidence/g2-00-08-policy-epoch-cache.md)：同事务 Epoch、双进程有界缓存、通知加速、版本绑定与 fail-closed。
23. [Foundation Contract 与兼容性治理](architecture/foundation-contract-governance.md)、[专项红队](reviews/g2-00-09-foundation-contract-red-team.md)与 [G2-00-09 Evidence](evidence/g2-00-09-foundation-contracts.md)：公共 ID、版本、身份、Release、错误、兼容性规则和渐进冻结边界。
24. [DB-00 Migration、数据库角色与逻辑 Schema](architecture/db-00-migration-roles.md)、[专项红队](reviews/g2-00-10-db-migration-roles-red-team.md)与 [G2-00-10 Evidence](evidence/g2-00-10-db-migration-roles.md)：只向前迁移协议、权限边界、默认权限、并发与故障恢复合同。
25. [G1 资产迁移与正式 Testkit 边界](architecture/testkit-g1-migration.md)：G2-00-11 的来源指纹、迁移转换、确定性生成协议和 Spike 依赖禁线。
26. [G2-00-11 专项红队](reviews/g2-00-11-testkit-red-team.md)与 [Evidence](evidence/g2-00-11-testkit-fixtures.md)：正式 Testkit、确定性 100k/1m Generator、六组资产 Provenance 与 G1 依赖禁线。
27. [强制 CI 与供应链 Gate](architecture/ci-foundation-gate.md)：单一 Required Check 内的保守变更风险路由、快速/完整 Profile、报告合同、Secret/License/SBOM/Vulnerability 策略和分支保护。
    - [CI 变更风险路由运行手册](operations/ci-change-risk-routing.md)：快速路径白名单、强制完整 Gate、Artifact 判读、异常处理和已知边界。
28. [G2-00-12 专项红队](reviews/g2-00-12-ci-gate-red-team.md)与 [Evidence](evidence/g2-00-12-ci-supply-chain-gate.md)：统一本地/远端执行、故意失败协议、供应链 Fail-Closed、机器报告和不可绕过合并条件。
29. [G2 Owner 与容量矩阵](delivery/g2-owner-capacity-matrix.md)：实际 Accountable Owner、单通道并行度、第二视角和 G2-01～05 的顺序日历。
30. [G2-00-13 专项红队](reviews/g2-00-13-foundation-red-team.md)与 [Foundation 总 Evidence](evidence/g2-00-13-foundation-integration-gate.md)：clean checkout、总 Manifest、Intended-vs-Implemented、范围与 teardown 证据。
31. `architecture/adr/`：编码前逐项冻结的实现决策；只有 Accepted ADR 可以覆盖蓝图中的建议性技术选择，不能静默改变 PRD 产品语义。
32. `delivery/`：任务、依赖、Gate 状态与风险；不能反向扩大 PRD 范围。
33. `evidence/`：可复现的 Gate 报告；证据不等于新的产品需求。

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
