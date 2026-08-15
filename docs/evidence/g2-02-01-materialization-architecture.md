# G2-02-01 Materialization 事务、DDL Executor 与 Overlay Seam Evidence

- 日期：2026-08-15
- 结论：**PASS**（仅代表 G2-02-01 架构与 Spike；不代表 DB-02、Materializer 或完整 G2-02 已完成）
- 决策：[ADR-014](../architecture/adr/014-materialization-transaction-ddl-overlay-boundary.md)
- 专项红队：[ADR-014 红队](../reviews/adr-014-materialization-architecture-red-team.md)
- 任务合同：[G2-02 Materialization 任务包 § G2-02-01](../delivery/g2-02-materialization-task-pack.md#g2-02-01冻结-materialization-事务ddl-executor-与-overlay-seam)
- 可执行实现：`tools/materialization-control-plane/`

## 1. 这次实际完成了什么

本工作项没有创建 DB-02 业务表，也没有把 DDL 权限放进 API/Worker。实际交付分为四部分：

1. 用 ADR-014 冻结逻辑 DB-02 表责任、单一 Migration 账本、事实/控制状态、短 Cutover、锁/CAS、恢复与 DB-03/04 扩展方式；
2. 扩展现有全局锁合同，补上旧 Snapshot Cutover 计划遗漏的 Channel、Object Type 与 Generation Inventory 锁；
3. 实现只接受持久化 Plan ID 的 Projection DDL Executor，并在真实 PostgreSQL 16 中验证 Create/Reuse/Verify/Drop Concurrent Index、最小权限、Kill/Replay、Mismatch 与 Stale；
4. 实现 zero-overlay 生产 Adapter 与非零对抗 Catch-up 算法，重跑 R1/A0 → R2/A1 → R2/A2 与并发 R3 的历史不可变/CAS 场景。

此次没有新增 `migrations/db-00/0007`。这正是预期结果：G2-02-01 冻结和验证设计，G2-02-03 才把正式表、触发器、Grant 和连续 Migration 落库。

## 2. Intended-vs-Implemented 核验

| 权威意图                                                     | 实际实现                                                                                                                                          | 可执行证据                                                                                            | 结论与边界                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 解释表 Owner、事实/控制边界、事务、恢复和 DB-03/04 扩展      | ADR-014 §2～4、§8；正式对象继续归 `migration_owner`，Job/GC 仅前移 Materialization 子集                                                           | PostgreSQL Spike 检查四个候选对象 Owner；角色形状查询                                                 | PASS；正式列级表仍由 G2-02-03 创建                                            |
| 单一 Migration 历史，逻辑 DB-02 从 `0007+` 继续              | ADR-014 §2 固定 `migrations/db-00` 与唯一账本                                                                                                     | 本变更无 Migration；现有 Runner/0001～0006 未改                                                       | PASS；不把“没建表”误写成 DB-02 已实现                                         |
| API/Worker/Ops 无 DDL、Raw SQL/Owner 切换和 Executor Secret  | Plan-only CLI、专用环境变量、源代码 Boundary Gate、真实三类非 Owner 登录                                                                          | `projection-ddl.test.ts`、`projection-ddl-boundary.test.ts`、PostgreSQL `assertRuntimeRoleBoundaries` | PASS；Executor 自身是受信高权限部署进程，不是沙箱                             |
| Executor 从规范 Plan Create/Reuse/Verify/Drop `CONCURRENTLY` | `projection-ddl.ts` 只实现 ADR-008 的一个严格 `BTREE_TEXT` Recipe；核验 Table/AM/Unique/Expression/Collation/Opclass/Sort/Predicate/Valid/Comment | `integration/postgres.test.ts`                                                                        | PASS for representative recipe；其余 Recipe 归 G2-02-09                       |
| Kill、同 Plan 重放、同名异定义与陈旧计划稳定恢复/拒绝        | Plan `RUNNING` 先持久化；Index session lock；Catalog-based replay；Digest/Inventory CAS；Mismatch 不覆盖                                          | `exerciseKilledExecutor`、`exerciseDefinitionMismatch`、`exerciseStalePlan`                           | PASS；客户端死亡后 PostgreSQL 可能完成或中止 DDL，重放覆盖两种合法结果        |
| R1/A0 → R2/A1 → R2/A2 + 并发 R3，历史不改                    | 复用 ADR-007 `RuntimeActivationModel`，新增任务专属 Harness                                                                                       | `state-harness.test.ts`                                                                               | PASS；`lastServingAt` 是允许前移的生命周期数据，Member/Manifest/Plan 事实不改 |
| Publish/Refresh/Cutover/GC 单调锁与 CAS                      | 全局域增加 Channel/Object Type/Inventory；同域 Object Type UUID 排序；双 Refresh、Publish/Refresh、GC/Cutover 冲突                                | `control.test.ts`、`state-harness.test.ts`、现有 Metadata/Runtime tests                               | PASS as executable state contract；真实 DB-02 行锁事务归 G2-02-11             |
| Overlay zero/unknown/non-zero/W0 后注入/Provider 失败        | `CertifiedZeroOverlayProvider` + 有界 `(W0,W1]` Catch-up；Head Digest 条件更新                                                                    | `overlay-cutover.test.ts`                                                                             | PASS for seam/algorithm；真实 Overlay Store 归 G2-04                          |
| 安全停止条件                                                 | Owner 凭据只在独立 Executor；CLI 不接受任意 SQL；首 Member 不改 A0/R1                                                                             | Boundary/CLI/PG/State tests                                                                           | 未触发停止；可以进入 G2-02-02                                                 |

## 3. 真实 PostgreSQL 16 证据

测试固定镜像：

```text
postgres:16.14-bookworm
sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8
```

Spike 在一次性容器中先运行现有 0001～0006 Migration，再创建仅用于 G2-02-01 的候选表/登录。验证内容：

- `g20201_ddl_login` 为 Login + `NOINHERIT`、非 Superuser/Createdb/Createrole/Replication/BypassRLS，仅是 `migration_owner` 的显式成员；
- 候选 Object Current、Inventory、DDL Request/Status View 都由 `migration_owner` 拥有；
- API、Worker、Ops 登录只能读脱敏 Status View，不能读写 Plan 表、不能建索引、不能 `SET ROLE migration_owner`；
- Executor 以直接最小权限读/更新 Plan 状态，只有执行白名单 DDL 时短时 `SET ROLE migration_owner`；
- CREATE 后双向核验 `pg_class`、`pg_index`、`pg_am`、Collation、Opclass、Sort Option、Predicate 和 Signature Comment；
- 同 Plan 第二次执行返回 `REUSED`；Drop 仅在引用数为零时执行，重复 Drop 返回 `ABSENT`；
- 同名异定义索引保持原样并返回 `DDL_INDEX_DEFINITION_MISMATCH`；陈旧 Inventory 返回 `DDL_PLAN_STALE` 且不创建索引；
- Executor 在 `CREATE INDEX CONCURRENTLY` 等锁时被 `SIGKILL`，Plan 保持 `RUNNING`，连接/Advisory Lock 释放后同 Plan 重放恢复；
- CLI/子进程输出不包含专用口令或连接 URL。

第一次真实运行发现 `pg_get_indexdef(index, key)` 不回显 Index Collation；若只比较字符串会误拒绝正确索引。实现因此改为读取 PostgreSQL 独立保存的 `pg_index.indcollation`、`indclass` 与 `indoption`。这次返工是 Spike 的有效产出，也证明不能仅靠 `pg_indexes.indexdef` 文本比较冒充双向核验。

## 4. 可复现命令与结果

```bash
npm run test:materialization-control-plane
# 15 tests, 15 pass

npm run test:projection-ddl:postgres
# 1 PostgreSQL 16 integration test, 1 pass

npm run typecheck
# PASS

npm run verify
# PASS — 22/22 Gates, 310 tests
```

`test:unit` 已包含 `tools/materialization-control-plane/*.test.ts`，`test:database` 已包含真实 DDL Spike。统一 Gate 在 clean commit 上从 `npm ci` 开始，覆盖 Format、Lint、Typecheck、合同/架构、Secret/Supply-chain、全部 PostgreSQL/OIDC/Clean-room、生产边界 Smoke 与 Teardown；22 道均 PASS。PR 仍必须在最终 Head 上通过同一远端必需检查后才能合并。

## 5. 错误与敏感信息边界

Executor 对外只返回 Plan ID、Attempt、Outcome/稳定错误码和 Catalog Digest。CLI 任意参数负测证明：即使输入包含模拟 Raw SQL/Secret Marker，也只返回 `DDL_INPUT_INVALID`，不会回显输入。

稳定错误族包括：

- `DDL_INPUT_INVALID` / `DDL_PLAN_NOT_FOUND` / `DDL_PLAN_INVALID`；
- `DDL_PLAN_DIGEST_MISMATCH` / `DDL_PLAN_STALE`；
- `DDL_INDEX_BUSY` / `DDL_INDEX_DEFINITION_MISMATCH` / `DDL_INDEX_REFERENCED`；
- `DDL_CATALOG_VERIFICATION_FAILED` / `DDL_EXECUTION_FAILED`。

内部 Error Cause 可以保存脱敏结构诊断，但 CLI 不序列化 Cause、SQL、连接配置或 PostgreSQL 原始错误。

## 6. 明确尚未证明的内容

G2-02-01 PASS 不包含以下声明：

- 没有正式 DB-02 表、Repository、Trigger、列级 Grant 或真实 Cutover 行锁；这些分别属于 G2-02-03/11；
- 没有完整 B-tree/Unique/Trigram/Array Recipe；本 Spike 只证明一个严格文本 B-tree 路径，其余属于 G2-02-09；
- DDL Spike 的候选 Plan 表没有正式不可变 Trigger、Inventory Scanner 或与 Cutover 的最终原子协调；正式实现属于 G2-02-03/09/11；
- 没有真实 Overlay 表、Action、Conflict 或非零生产 Adapter；G2-04 接入后必须重跑；
- 没有生产 Secret Manager、短期凭据签发、网络隔离或审计平台证据；当前只证明代码/数据库身份边界；
- 没有 Snapshot、Mapping、Job、Generation、100k/1m、S3、OIDC 闭环；这些是 G2-02-02～14 的后续工作。

因此最准确的阶段结论是：**架构可落地，安全停止条件未触发，允许开始 G2-02-02；完整 Materialization 产品仍未完成。**
