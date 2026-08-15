# G2-02-03 逻辑 DB-02 Migration 与最小权限 Evidence

- 日期：2026-08-15
- 结论：**PASS**（只代表 G2-02-03 数据库 Gate；不代表 CSV Ingress、真实数据物化、动态索引执行、Cutover/GC 完整闭环或整个 G2-02 已完成）
- 任务合同：[G2-02 Materialization 任务包 § G2-02-03](../delivery/g2-02-materialization-task-pack.md#g2-02-03实现逻辑-db-02-前向-migration-与最小权限)
- 架构依据：[ADR-014](../architecture/adr/014-materialization-transaction-ddl-overlay-boundary.md)、[ADR-008](../architecture/adr/008-shared-projection-index-capacity.md)、[ADR-009](../architecture/adr/009-public-value-codec.md)
- 运维手册：[DB-02 Migration Runbook](../operations/db-02-materialization-migration.md)
- 专项红队：[G2-02-03 Red Team](../reviews/g2-02-03-db02-migration-red-team.md)

## 1. 实际交付

逻辑 DB-02 沿用唯一的 `migrations/db-00` 目录和 `ontos_migration.schema_migrations` 账本，新增三个原子、只向前 Migration：

| 版本                                         | 责任                                                                                                     | 关键边界                                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `0007_materialization_control_facts.sql`     | Snapshot/Group、Runtime Plan、Report、Generation、Compatibility Certificate、Activation Member           | A0 不回写；Plan/Activation 规范摘要与成员数延迟校验；Project/Release/Revision/Generation 复合绑定                           |
| `0008_materialization_shared_projection.sql` | Object Identity、Object/Link Base 与 Current、Object Head、Provenance、Rejected Row Set                  | ADR-008 共享键、`COLLATE "C"` Canonical PK、Link Endpoint Unique、Base/Current 摘要绑定、只允许 Building Generation 写 Base |
| `0009_materialization_operations.sql`        | Inventory/Measurement/Capacity、Job/Attempt/Batch/Checkpoint/Error Sample、GC Run/Plan、受控函数与 Grant | Worker Lease/Fencing、Checkpoint 原子可见、脱敏 Ops View、API/Worker/Ops 非 Owner                                           |

Migration Runner 的主名称改为中性的 `databaseMigrationDirectory`，同时保留 deprecated alias，避免已有调用方被一次性破坏；它没有新建第二目录或第二账本。

## 2. Acceptance 对照

| 要求                                             | 实现与可执行证据                                                                                                                                                                                                 | 结论 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 空库与停在 0006 的库升级；重复 no-op；历史不变   | 专项测试先只应用 0001～0006，发布 R1/A0，保存 6 行 Ledger、A0 `to_jsonb`、列顺序和 `pg_column_size`，再应用 0007～0009；全部逐值相等；另一个空库由两个 Runner 并发升级，最终 9 行且一个 Runner no-op             | PASS |
| A0 → R2 Plan → READY 空 Generation → A1          | 同一真实 PG16 测试创建一个正式 Object Member Plan、0 Object/0 Link READY Generation、服务器签发 Certificate，再由 `api_runtime` 在一个事务写 A1 Member、Serving Head、Publish 与 Channel；R1/A0 再次逐值比较不变 | PASS |
| Count/Digest/Project/Release/Generation 错配拒绝 | Deferred Constraint Trigger 复算与 Materialization v1 相同的 Canonical Plan/Activation SHA-256；错误 Digest、错误 Member Count、跨 Project Activation Member 和跨 Project Generation 分别命中 `23514`/`23503`    | PASS |
| Shared Projection 键与 Codec                     | Catalog 测试核对 Object/Link PK、Canonical PK Unique、Endpoint Unique、Generation/Revision FK；Canonical PK 使用 `text COLLATE "C"` 且 1–1024 UTF-8 bytes；不存在 Order/Release 等按类型或版本扩表               | PASS |
| 不可变与受控状态                                 | Snapshot/File、Plan、Identity、Base、Report、Certificate、Checkpoint、Activation Member 负测；Snapshot/Generation 只允许合同前移；Base 只能绑定同一 Building Generation、Snapshot 与 Mapping                     | PASS |
| 三个真实非 Owner 登录                            | `api_runtime`、两个 `worker_runtime`、`read_only_ops` 均为独立 LOGIN；允许路径成功，DDL、DELETE、Raw 表、Migration Ledger、Certificate 直写与 `SET ROLE migration_owner` 均稳定拒绝                              | PASS |
| 两 Worker Lease/Fencing/Checkpoint               | W1 领取并写一批但未 Checkpoint 后连接终止；Lease 到期 W2 接管、Token 1→2；W1 旧 Token 返回 `MATERIALIZATION_JOB_FENCED`；W2 的批次与 Checkpoint 同事务可见，重连后只有 W2 批次完成，W1 半批仍不可见为完成        | PASS |
| 每个 Migration 中途故障整批回滚                  | 分别在 0007、0008、0009 末尾注入除零故障；对应代表表不存在且 Ledger 分别保持 6/7/8 行；通用数据库测试另证已提交错误只能追加 0011 修复 0010，篡改旧 Hash fail closed                                              | PASS |
| 并发、领先、缺号、Hash 漂移                      | Advisory Lock 并发 Runner 只产生一套结果；既有 Definition/Integration 测试继续覆盖 ahead、gap、name/hash drift                                                                                                   | PASS |

## 3. 权限与信任边界

- 所有新增表、View、Trigger 和函数 Owner 均为 `migration_owner`；Runtime 登录不是其成员。
- API 只直接写管理输入事实和排队 Job；Compatibility Certificate 只能调用固定参数、固定查询、服务器重算 Digest 的 `runtime.issue_compatibility_certificate`。
- Worker 没有 Job/Attempt/Batch/Checkpoint 的直接写权限，只能调用三条固定 `SECURITY DEFINER` 函数；函数固定 `search_path=pg_catalog`，每次写都重验当前 Attempt、Fencing Token 与数据库时间 Lease。
- Ops 只读三个脱敏 View，看不到 Idempotency/Input Digest、业务 Properties、错误原值或内部计划。
- 新表无 `DELETE`/`TRUNCATE` Runtime Grant；不可变事实即使由 Owner 误更新也会被 Trigger 拒绝。

## 4. Intended-vs-Implemented 复审与实际返工

本项没有触发“修改历史 Migration/A0、给 Worker Owner、按类型建表或允许 Raw SQL”的停止条件。实现和真实 PG16 运行共暴露并关闭 8 类同任务返工：

1. 复合 FK 需要与被引用 Unique 的列集合完全一致；补齐 Snapshot/Plan 的窄绑定 Unique；
2. G2-02-02 虽已激活 `snapshot_schema`/`mapping` Parser，旧 DB Validator 仍只允许 Object/Link；0007 前向扩展 Validator，但不改 0004；
3. Dataset Snapshot 使用 `registered_at`，不能与其他生命周期表共用假定 `created_at` 的宽松 Trigger；改为逐表冻结全部事实列；
4. Deferred Trigger 由 API 触发时不能依赖 API 获得 `ontos_migration` 权限；校验 Trigger 改为固定搜索路径的 Definer，内部函数仍不向 Runtime 暴露；
5. PL/pgSQL Table Return 变量与列名可能歧义；Lease SQL 全部显式限定别名；
6. G2-02 正式允许不可见候选 Activation，历史 G2-01 “任意 orphan 都拒绝”的测试改为验证候选无 Serving Head、因此不可见；
7. 二次差距审查补上 Base→Generation 的 Member Kind/Snapshot/Mapping 绑定，以及 Current→Base 的内容摘要 FK。
8. 历史 Foundation Scope 与 Metadata clean-room 把迁移总数硬编码为 6；Scope Policy 现精确登记 0007～0009、DB-02 表、ADR-014 和对应 Evidence，clean-room 则从当前连续定义读取期望文件，仍由历史 Hash Gate 保证 0001～0006 不变。

这些返工都发生在 G2-02-03 内，没有改变 PRD 或 ADR。它们说明真实 DB 约束是必要 Gate，也说明不能仅凭 TypeScript 合同宣称数据运行面可落地。

## 5. 验证结果

```text
npm run test:database
PASS — 6 PostgreSQL 16 integration suites
       包含 G2-02-03 A0 upgrade / A1 / roles / two-worker fencing / migration faults

npm run test:unit
PASS — 313 tests

npm run lint
PASS

npm run typecheck
PASS

npm run check:architecture
PASS

npm run check:contracts
PASS — 12 Materialization contracts / 86 golden cases

npm run verify
PASS — clean checkout / 22 of 22 gates / 327 tests
       包含 PostgreSQL、OIDC、Metadata clean-room、Production Boundary
       以及 S3 write-read-delete、DB 非 Owner 权限和 OTLP ingestion Smoke
```

最终整仓 Gate 在干净提交上完成；专用 x86_64 新机器另行通过同一 PostgreSQL 16 数据库套件 6/6，证明结果不依赖本机 ARM64 Docker 平台。GitHub 必需检查仍必须在 PR 最终 Head 上通过后才能合并。本 Evidence 不把空 Generation 薄切片当作吞吐证明；100k Object/1m Link、WAL/索引字节、真实 Materializer 和 30 分钟基线仍由 G2-02-05/06/14 持有。

## 6. 下一工作项

G2-02-03 PASS 后只允许进入 G2-02-04 Managed UTF-8 CSV Ingress。它要实现受管上传会话、S3-compatible 对象版本、服务端流式 SHA-256/CSV 物理检查和不可变 Snapshot/File 注册；不得提前把任意路径、URL、Bucket、Credential 或客户端自报 Hash 接入 Worker。
