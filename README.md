# Ontos

Ontos 是 **Ontology Kernel** 的正式主仓库。目标是在不复制 Palantir 完整产品面的前提下，实现一个可生产化、可跨领域复用的 Object / Link / Function / Action / Policy Kernel。

当前状态：

- G1 技术可行性验证：**PASS**；
- G2 生产实现蓝图：**红队审查完成，Conditional Go**；
- G2-00 Foundation：**PASS，13/13 已合并**；
- G2-01 Metadata：**PASS，G2-01-01～12 已实现并通过 clean-room 总验收**；
- 正式产品实现：**Metadata/Package 控制面与 Materialization 数据运行面已具备真实 OIDC、受限 HTTP、最小 RBAC、PostgreSQL、版本化 S3、生产 Worker、隔离 DDL、容量/GC、原子切换和重启恢复；统一 Gate 共 32 道**；
- G2-02 Materialization：**PASS，G2-02-01～14 全部完成；独立 Ubuntu 24 / 8C16G clean-room 已跑通冷/热 100k Object + 1m Link、20 次 Cutover、容量、安全、GC 与整体重启恢复**；
- 下一唯一允许的工作项：**创建 G2-03 Query + Policy 任务包并完成可行性与红队审查；任务包冻结前不得直接编码 Query Endpoint**。

## 权威文档

| 文档 | 作用 |
|---|---|
| [产品需求文档](docs/product/ontology-kernel-prd.md) | P0/P1/P2 范围、产品语义和 AC-01～AC-10 |
| [生产实现蓝图](docs/product/ontology-kernel-implementation-blueprint.md) | 工程结构、模块、数据、事务、状态机和 Gate |
| [蓝图红队审查](docs/reviews/g2-blueprint-red-team.md) | 承重假设、最低成本验证、停止条件和放行结论 |
| [G2-00 任务包](docs/delivery/g2-00-foundation-task-pack.md) | Foundation 的依赖、WWA 工作项和可执行退出条件 |
| [G2-01 Metadata 任务包](docs/delivery/g2-01-metadata-task-pack.md) | Metadata 控制面的 12 个顺序工作项、边界与验收条件 |
| [G2-01 Clean-room 总验收](docs/evidence/g2-01-12-clean-room-metadata-gate.md) | 空库真实 HTTP 闭环、故障/恢复、Manifest 和独立 Clone 证据 |
| [G2-02 Materialization 任务包](docs/delivery/g2-02-materialization-task-pack.md) | CSV Snapshot 到 Object/Link Generation 原子激活的 14 个顺序工作项、边界与 Gate |
| [G2-02 任务包红队](docs/reviews/g2-02-task-pack-red-team.md) | DDL 权限、A0 兼容、Kill/Resume、容量与 Overlay Seam 的 Kill Criteria |
| [ADR-014 与 G2-02-01 Evidence](docs/architecture/adr/014-materialization-transaction-ddl-overlay-boundary.md) | Materialization 事务、全局锁/CAS、隔离 DDL Executor、Kill/Replay 与 zero-overlay 生产边界 |
| [ADR-015 与 G2-02-06 Evidence](docs/architecture/adr/015-permanent-object-identity-attempt-owned-base.md) | 永久 Object RID、类型化 Link、Attempt Staging、原子 Base 提升与 10k/100k 容量证据 |
| [ADR-016 与 G2-02-07 Evidence](docs/architecture/adr/016-quality-current-provenance-confirmation.md) | Base-only Current、质量阈值、Rejected Artifact、最小 Property Provenance 与 Owner 行数确认 |
| [ADR-017 与 G2-02-08 Evidence](docs/architecture/adr/017-materialization-worker-recovery.md) | PostgreSQL Job/Lease、八阶段 Checkpoint、Retry/Cancel 与真实进程 Kill/Resume |
| [ADR-008 与 G2-02-09 Evidence](docs/architecture/adr/008-shared-projection-index-capacity.md) | Published Property Index Plan、完整容量库存、隔离 DDL、11 Recipe 与 100k/1m 首轮实测 |
| [G2-02-10 Runtime Plan 与兼容证书 Evidence](docs/evidence/g2-02-10-runtime-plan-compatibility.md) | 服务器派生 Plan、完整 Group、动态证书失效、跨 Release 复用与多成员容量闭环 |
| [ADR-018 与 G2-02-11 Evidence](docs/architecture/adr/018-immutable-head-set-snapshot-group-cutover.md) | 不可变 Head Set、Snapshot Group 原子 Cutover、Data Refresh、并发 CAS 与 100k/1m 短事务证据 |
| [ADR-019 与 G2-02-12 Evidence](docs/architecture/adr/019-generation-index-mark-plan-commit-gc.md) | 完整 Root/Inventory、单调 Root Epoch、分批 Kill/Resume、精确对象版本删除与 GC-bound Index Drop |
| [G2-02-13 Admin/Testkit/CI Evidence](docs/evidence/g2-02-13-admin-testkit-ci.md) | 最小 Admin HTTP、生产 Worker 八阶段、真 OIDC/PG/S3/API/DDL 闭环与统一 CI |
| [G2-02-14 Clean-room 总验收](docs/evidence/g2-02-14-clean-room-materialization.md) | 空环境 100k/1m 冷/热全链路、20 次 Cutover、容量/安全/GC、整体重启和总 Manifest |
| [ADR-007 Runtime Activation](docs/architecture/adr/007-runtime-activation-serving-head.md) | Release/Generation 一致绑定、90 天支持、容量与 GC 语义 |
| [ADR-010 Job/Lease 与 Outbox](docs/architecture/adr/010-postgresql-job-lease-outbox.md) | 持久 Job 恢复、租约 fencing、至少一次投递与同对象顺序 |
| [G1 可行性报告](spikes/g1/docs/g1-feasibility-report.md) | 已验证结论、性能和限制 |
| [G1 架构决策](spikes/g1/docs/architecture-decisions.md) | G2 不可违反的存储、查询、Policy 和 Package 决策 |
| [G2 实现准入](spikes/g1/docs/g2-implementation-readiness.md) | 第一条生产纵向切片及退出条件 |

文档之间冲突时，先按版本和状态判断；仍无法判断则停止实现并用 ADR 明确，不在代码中自行选择语义。

## 仓库结构

```text
ontos/
├── docs/                       # 产品、架构、交付和运行文档
│   ├── product/                # PRD 与生产实现蓝图
│   ├── reviews/                # 红队与专项评审
│   └── delivery/               # Gate 任务包与交付状态
├── spikes/
│   └── g1/                     # G1 可复现代码、测试和精简证据
├── apps/                       # G2-00 起按真实任务建立：API/Worker/Handler Host/Web/CLI
├── packages/                   # G2-00 起按真实任务建立：Kernel 模块与公共合同
├── migrations/                 # G2-00 从 DB-00 开始：前向数据库迁移
└── deploy/                     # G2-00 从本地依赖环境开始，后续补单区域部署
```

现在不存在的正式工程目录不会为了“看起来完整”而提前放空文件；它们在对应任务进入开发并具备 Owner、合同和验收时创建。

## 范围边界

- 当前产品范围是 PRD 的 P0 Kernel Alpha，不是 Palantir Foundry/Gotham/AIP 的完整复制品。
- Data Connections/Pipeline、Durable Automation、AI、Marketplace、多租户和多区域属于后续范围。
- `spikes/g1` 只复用算法、SQL 结论、Fixture 和测试向量，不直接作为生产代码上线。
- 旧实验项目不进入本仓库，也不作为产品架构前提。
- 第二领域只能通过 Manifest、Definition、Handler 和 View 扩展，不能修改 Kernel 核心分支。

## 工作方式

1. PRD 与蓝图定义意图；ADR 冻结实现决策。
2. 每项工作使用 Why–What–Acceptance，并标明依赖、测试和 Gate 证据。
3. Runtime 新入口必须通过同一 Policy 测试向量。
4. 文档要求与实现代码在每个 Gate 进行 Intended-vs-Implemented 核验。
5. 只有可复现的测试、性能、故障和恢复证据可以使 Gate 通过。

后续改动使用短生命周期分支和 Pull Request；`main` 只保留已经通过对应检查的基线。

## G1 本地复现

```bash
cd spikes/g1
npm test
npm run packages:validate
npm run db:up
npm run db:init
sh scripts/run-g1-gates.sh
```

前置条件和完整命令见 [G1 README](spikes/g1/README.md)。100k Objects / 1m Links 的完整持续负载会消耗较长时间，不应作为每次普通提交的快速检查。

## G2 本地依赖环境

PostgreSQL、S3、外部测试 OIDC Provider 和 OpenTelemetry Collector 可通过同一入口启动并探活：

```bash
npm run env:up
npm run env:smoke
npm run env:down
```

`env:restart` 保留项目卷，`env:reset` 只清空固定 Compose 项目 `ontos-g2-local` 的卷。完整端口、边界和恢复说明见 [本地生产边界等价环境运行手册](docs/operations/local-production-boundary-environment.md)。该环境只等价验证协议与权限边界，不代表生产容量、高可用或安全配置。

Runtime Activation 的无数据库状态合同可单独复现：

```bash
npm run test:activation
```

它覆盖发布、数据刷新、回滚、退休、容量、在途引用和 GC；不是业务 Release Store 或产品 API。

## 安全与生成物

这是私有仓库，但仍按可公开审计的标准管理：

- 不提交 `.env`、Token、私钥、生产连接串或真实业务数据；
- G1 的 `evidence/raw/` 可能包含主机环境信息，默认不提交；
- 可评审结论进入精简 Evidence Summary，并记录内容 Hash；
- 示例数据库凭据只能绑定本机一次性容器，不能用于共享环境。
