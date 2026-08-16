# G2-02-12 Generation / Index Mark-Plan-Commit GC Evidence

- 日期：2026-08-17
- 结论：**PASS**（只代表 G2-02-12 GC 能力；不代表 Admin HTTP、统一 Materialization CI Manifest 或 clean-room 总验收已完成）
- 任务合同：[G2-02 Materialization 任务包 § G2-02-12](../delivery/g2-02-materialization-task-pack.md#g2-02-12实现-generationindex-mark-plan-commit-gc)
- 架构决策：[ADR-019](../architecture/adr/019-generation-index-mark-plan-commit-gc.md)
- 专项红队：[G2-02-12 Red Team](../reviews/g2-02-12-generation-index-gc-red-team.md)

## 1. 实际交付

| 组件                    | 责任                                                                                                                   | 明确不做                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| GC Domain / Application | 完整性判定、保留分类、可读计划、稳定 Digest、幂等 Dry-run、精确对象版本删除与分批协调                                  | 不接受客户端 Candidate、SQL、表名或任意对象 Key       |
| Migration `0017`        | Provider Registry/Scan、Root Epoch、权威 Inventory、不可变计划、反向引用重验、批次状态机、Collection Marker 与最小权限 | 不改写 0001～0016，不用 `CASCADE`，不删除核心审计事实 |
| PostgreSQL Adapter      | Repeatable-read Inventory、实时扫描绑定、计划读取、稳定错误映射与分批恢复                                              | 不持有 Migration Owner 或 DDL 权限                    |
| Projection DDL Executor | 仅消费 GC 绑定的 DROP Request，锁内重验 Plan/Root/Inventory/Catalog，失败可重试                                        | 不把普通 API/Worker 变成 DDL 入口                     |
| 真库 Harness            | 临时 Root、历史 Activation、Provider 缺失、对象确认丢失、每批 SIGKILL、连接终止、Index DROP Kill/Replay 与旧代读取     | 不用内存状态机代替 PostgreSQL 原子性                  |

## 2. 生产回收流程

```text
权威 Inventory + Provider Registry/Live Scan
  → 完整性检查；不完整则 BLOCKED/Candidate=0
  → 按 Root、最近成功数和保留窗分类全部条目
  → PostgreSQL 逐项对照库存并固化 Plan/Digest/Root Epoch
  → 每个物理批次前重验 Revision、Root、引用和生命周期
  → 先删不可见派生行，再写 Collection Marker
  → 为零引用 Index 创建 GC-bound DROP Request
  → 独立 DDL Executor 重验并 DROP/确认
  → 所有 Candidate 完成后 Plan=COMMITTED
  → 项目测量保持 incomplete，重新扫描后才能生成下一计划
```

## 3. Acceptance 对照

| 要求             | 实现与可执行证据                                                                                                                | 结论 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 完整 Inventory   | Generation、Head Set、Index、Attempt Staging、Orphan Upload 全量逐项持久化；字节或物理索引状态缺失即 BLOCKED                    | PASS |
| 完整 Root        | Channel、全部支持窗 Serving Head、Active Job、当前/准备 Head Set、Cutover 和历史 Activation 均扫描；未来 Provider 显式 INACTIVE | PASS |
| 保留策略         | 每 Member 最近两个成功代 + Generation 至少 7 天；Attempt/Orphan 各自至少 1 天                                                   | PASS |
| Dry-run 不可篡改 | Application 只接收 Project/Idempotency Key；数据库对照实时完整库存、字节、Provider Scan 与 Plan Entry 集合                      | PASS |
| Stale 检测       | Root Revision 单调推进；临时 Job 加入后再移除，旧计划仍 `GC_PLAN_STALE`                                                         | PASS |
| 删除顺序         | 固定 10 阶段状态机；派生数据先于 Base/Report/Generation Marker；无 `CASCADE`                                                    | PASS |
| Index Drop       | 只有 GC-bound Request；Executor 锁内重验 Plan/Root/Inventory/Catalog；失败不误标 retired                                        | PASS |
| Kill/Resume      | 每个关系批次在写后、Batch Event 前 SIGKILL Node 并终止数据库 Backend，证明事务回滚；重试全部收敛                                | PASS |
| Orphan 安全      | 只删除 Session 固定的 Key + Version；首次确认故障后重复删除相同 Version 并幂等确认                                              | PASS |
| 旧代与容量       | 历史 Activation/Base 保留且可读；物理变化后 `measurement_complete=false`，未重新测量不得再计划                                  | PASS |
| 最小权限         | API/Worker/Ops 不能读写内部 GC 表或执行 DDL；API 仅可调用受控函数和读取脱敏状态 View                                            | PASS |

## 4. Intended-vs-Implemented 复审与实际返工

1. **只比较 Root 集合 Digest 会让“临时引用加入后又移除”的旧计划复活。** 已增加每 Project 单调 Root Epoch，并在所有 Root 写事务中取得与 GC/DDL 相同的锁后推进。
2. **只保护当前 Serving 状态会漏掉不可变历史 Activation。** 已激活 `materialization.activation-history@v1`，全部历史 Activation Member 都是 Root。
3. **接受格式正确的 Provider Scan 仍可能把伪造空扫描当完整。** 持久化现在把调用方扫描逐字段与数据库实时 Provider View 对照。
4. **首版 Generation 字节归属会漏算派生行并与 Attempt Staging 重复计算。** 当前 Generation 计永久 Base/Current/Provenance/Head/Quality 派生行，Attempt 单独计 Staging/Stage/Checkpoint/Error Sample。
5. **只 Kill 客户端不能证明服务端事务已经回滚。** 故障 Harness 在 SQL 写入后、Batch Event 前持锁，先 SIGKILL Node，再终止 PostgreSQL Backend；同时保留提交响应丢失的幂等重放验证。
6. **Index 物理删除后若马上宣称容量账完整，会产生虚假可用空间。** DDL 成功推进 Inventory Revision，并把 `measurement_complete` 置 false；下一 GC 必须先重测。

以上修正没有引入 Query、Action、UI、Overlay 或领域特化分支。

## 5. 真实故障与环境证据

专用远程 Runner：Ubuntu 24 / Linux 6.8 x86_64 / 8 vCPU / 15 GiB 可见内存 / Node 24.18.0 / Docker 29.7.2 / Compose 5.4.0。`/data` 独立卷约 196 GiB，验证时约 185 GiB 可用。数据库为 PostgreSQL 16 固定镜像。

- 关系 GC：旧失败 Generation、Base/Current/Provenance、Retired Head Set、Terminal Attempt 与精确 Orphan 全部进入计划；每个实际变更批次逐一 Kill/Resume，最终收敛且历史 Activation 保持可读。
- 对象确认丢失：同一对象版本删除调用执行两次，只有一次状态确认，最终 Session 为 cleaned。
- Index：所有零引用动态 Index 逐个由 GC Request 删除；首个 DROP 在执行中 SIGKILL/断连，重试后全部 Inventory retired，Catalog 中物理 Index 为零。
- Provider：把未来 `runtime.query-lease` 临时切为 ACTIVE 后，Dry-run 以 `PROVIDER_MISSING` 全量阻断；恢复 INACTIVE 后才允许计划。

## 6. 可复现验证

```text
Node 24.18.0 / PostgreSQL 16

npm run test:materialization-gc
PASS — 9 tests，覆盖分类、完整性、保留窗、Digest、输入与 stale 映射

node --test --test-concurrency=1 \
  tools/database/postgres.integration.test.ts \
  tools/database/materialization-postgres.integration.test.ts \
  tools/projection-ddl/integration/postgres.test.ts
PASS — 3 个真库顶层套件，约 41.5 秒
       Materialization GC 含逐批 SIGKILL/Backend 终止与旧代读取
       DB-01/DB-02 连续 Migration 0001～0017
       11 个 Index Recipe Create + GC Drop Kill/Replay

npm run format:check
npm run lint
npm run typecheck
npm run check:architecture
PASS
```

- Migration `0017` SHA-256：`503a65d8034206c863a93c797304ef538e4d2f8ffe4e3a7ae9e4e286bc4755f9`

## 7. 非结论与下一项

- 本关交付了正式 Domain/Application/PostgreSQL/DDL 能力，但尚未暴露真实 Materialization Admin HTTP；这是 G2-02-13。
- 本关的对象存储 Port 证明精确版本删除协议；真实 S3、OIDC、API、Worker、DDL、GC 同进程组合属于 G2-02-13/14。
- 完整 clean checkout、空卷、重启、100k/1m 和总 Manifest 属于 G2-02-14。
- Query Resolver、Action/Overlay 和 UI 仍分别属于后续 Gate。

因此下一唯一允许的工作项是 **G2-02-13：Admin API、Testkit 与统一 CI Gate**。
