# G2-03-03 Query / Policy 持久化 Evidence

- 日期：2026-08-18
- 结论：**PASS**
- 资格限定：只有同一 commit 的 `g2-03-03-evidence-manifest.json` 为 `CLEAN_ROOM_PASS` 时成立
- 任务合同：[G2-03-03](../delivery/g2-03-query-policy-task-pack.md#g2-03-03实现-querypolicy-前向-migration-与最小权限)
- 架构决策：[ADR-021](../architecture/adr/021-query-policy-persistence-boundary.md)
- 复审：[Intended-vs-Implemented](../reviews/g2-03-03-intended-vs-implemented.md)

## 1. 本 Gate 证明了什么

G2-03-03 把前两项冻结的 Query/Policy/Identity/Lease 合同落成了 PostgreSQL 16 持久事实：

1. 既有 21 个 Migration 原样前向升级到 24，空库、历史库、重复运行、并发 Runner 和逐版本故障都可恢复；
2. Principal Human/Service 类型、Claim Mapping Revision/Head 和 Policy Compilation/Test Artifact 有不可变、复合绑定和 Project 隔离；
3. Binding、Principal Disable、Claim Mapping 激活与既有 Metadata 发布通过同一受控函数事务推进 Authorization Epoch，并提交后通知；
4. Query Lease 只绑定真实 Serving Activation 的完整 Active Generation Set、Passed Policy Artifact 和当前 Epoch；
5. committed Lease 已成为 G2-02 GC 的真实 Root，Heartbeat、Release 和 TTL Expiry 都有界；
6. `api_runtime`、`worker_runtime`、`read_only_ops` 用真实非 Owner LOGIN 证明最小权限，租户事实表强制 RLS。

该结论不声称 Policy 已能编译、Query 已能执行或用户已有页面。

## 2. Migration 产物

| Migration                                      | 新增/修改                                                                                          | 核心边界                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `0022_query_policy_identity_facts.sql`         | Principal Type；Claim Mapping Revision/Head；Policy Compilation；Policy Validation/Dependency 扩展 | 历史默认 Human；事实不可变；Release Pin/Artifact/Digest/Vector 强绑定；FORCE RLS            |
| `0023_query_lease_gc_boundary.sql`             | Query Lease/Generation；Plan/Commit/Heartbeat/Release/Expire；GC Provider/View/Digest              | Serving + Passed Policy + Current Epoch；完整成员；120 秒硬上限；仅 committed 未过期为 Root |
| `0024_query_policy_authorization_boundary.sql` | Epoch Lock/Advance Fact；NOTIFY；Mapping/Compilation 受控函数；运维 View                           | 受控加锁且无列直写；一事务一次 Epoch；回滚不通知；Ops 不见业务事实                          |

当前物理规模为 97 张业务基础表和 22 个受控 View：`ontos_migration=1`、`meta=18`、`authz=6`、`runtime=46+3 View`、`ops=26+19 View`。

## 3. 机器证据

| 命令 / Artifact                                  | 证明                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `npm run test:query-policy-persistence:postgres` | 历史/空库迁移、并发、逐版本回滚、身份/Mapping/Policy/Epoch、三 Runtime 角色与 RLS                   |
| `npm run test:database`                          | G2-00～02 全部 PostgreSQL 回归 + G2-03-03 Persistence + 真实 Release/Activation/Generation Lease/GC |
| `npm run check:g2-03-03-evidence`                | Required Record、Source Marker、变更范围、历史 Gate 前向接纳及两个 PG Artifact                      |
| `npm run verify`                                 | 38 道统一 Gate、Clean Checkout、同 Commit Artifact 与最终 Manifest                                  |
| `g2-03-03-postgres-persistence.json`             | `REAL_POSTGRES_16_FORWARD_MIGRATION_AND_NON_OWNER_THIN_SLICE`                                       |
| `g2-03-03-query-lease.json`                      | `REAL_SERVING_GENERATION_QUERY_LEASE_GC_ROOT`                                                       |
| `g2-03-03-evidence-manifest.json`                | 本 Gate 唯一最终 `CLEAN_ROOM_PASS` 资格                                                             |

Manifest 和 Artifact 在运行时记录真实 Commit、PostgreSQL Server Version、Clean/Dirty、所有断言、Gate 状态和耗时；本文不手抄易漂移的 Hash。

## 4. 故障与权限矩阵

| 场景                                                | 期望结果                                         |
| --------------------------------------------------- | ------------------------------------------------ |
| 0022/0023/0024 文件尾注入 SQL 故障                  | 对应对象不存在，账本仍停在前一版本               |
| 两个 Migration Runner 同时跑空库                    | 只有一套 24 个结果，另一 Runner 得到 no-op       |
| 历史 Principal 不含 Type                            | 升级后为 Human；不能改成 Service                 |
| Mapping 切到跨 Project/Issuer/Type Revision         | FK/受控函数拒绝；Head/Epoch 均不变               |
| 授权事务中途回滚                                    | 新事实、Epoch Advance、NOTIFY 全部不可见         |
| Failed/错 Pin/错 Artifact Policy Compilation        | 不可解析，不能规划 Query Lease                   |
| 没有真实 Serving Activation/Generation              | Lease Plan fail closed                           |
| 只保护 Activation 部分成员                          | 成员数/集合校验失败                              |
| Lease 仍是 planned                                  | 不进入 GC Root                                   |
| committed Lease                                     | 每个 Generation 都进入 Root；GC 无法把它列为候选 |
| Release 或 TTL Expiry                               | Root 消失；历史 Lease 不被删除                   |
| API/Worker/Ops 裸读敏感表或修改 Current/GC Plan     | 权限拒绝                                         |
| Owner 修改 Principal Type/Compilation/Epoch History | Immutable Trigger 拒绝                           |

## 5. 范围与兼容性

Evidence 策略绑定 G2-03-02 合并后的 baseline `39a423f90d94908f6788e1b9228e517e43754da2`。允许范围只包括三个 Migration、两个 Metadata Epoch 调用点、数据库/持久化测试、CI Policy 和本 Gate 文档。

仍禁止正式 `apps/web`、`packages/query|policy|identity|sdk|action` 及对应执行工具目录。历史 G2-00、G2-02、G2-03-01、G2-03-02 Scope 仅精确接纳本次 Migration/文件和 `tools/query-policy-persistence/`；未知未来 Migration 仍失败。

## 6. 剩余风险与下一步

| 风险                                                        | Owner                        | 关闭 Gate    |
| ----------------------------------------------------------- | ---------------------------- | ------------ |
| 真实 JWT 到 Principal/Claim Mapping 和 Delegation 尚未实现  | Identity / Security          | G2-03-04     |
| Policy Compiler/Test Runner/Gateway 尚未消费 Compilation 表 | Policy / Metadata / Runtime  | G2-03-05/06  |
| Query SQL/HTTP 尚未创建请求 Lease                           | Query / PostgreSQL / Backend | G2-03-07～12 |
| Policy 负载下 100k/1m 读取性能未知                          | Query / Quality              | G2-03-09/14  |
| 用户还没有只读 Web 消费闭环                                 | Web / Product                | G2-03-13     |

本 Gate 关闭后只放行 **G2-03-04：Runtime Identity、Claim Mapping 与 Delegation 交集**。
