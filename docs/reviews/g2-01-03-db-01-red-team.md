# Red-Team：G2-01-03 DB-01 Migration、约束与最小权限

- 日期：2026-08-14
- 审查对象：`0002_metadata_control_plane.sql`、PostgreSQL Integration 与 DB-01 运行手册
- 方法：Intended → Enforcement Point → Negative Test → Residual Risk
- 结论：**Go for G2-01-04**；DB-01 Schema 范围内偏差已关闭，Repository/Publish 真实事务仍由后续任务证明。

## 1. 实际发现并修正的偏差

### 1.1 只靠 Default 和表级 Grant 会留下发布事实改写窗口

初始映射可以给 API 状态列更新权，但若没有 Trigger，`published_at`、Revision Content/Digest 和 Pointer Sequence 仍可被非 Owner 修改。现在由列级 Grant 限制更新面，再由 `db01_enforce_revision_update`、`db01_enforce_release_update`、`db01_enforce_pointer_update` 检查状态和单调序号。发布后内容、Digest 或发布时间改写受到 SQLSTATE `55000`。**CLOSED**。

### 1.2 有状态检查仍可通过 INSERT 直接伪造终态

`CHECK state IN (...)` 只能限制值域，不能阻止 API 直接插入 Published Revision、Archived Project 或 Active Package Change。现在 `db01_enforce_initial_state` 限制 Project/Resource/Revision/Release/Installation/Change/Principal/Binding/Epoch 的起始态；Integration 使用 `api_runtime` 登录显式插入 Archived Project，预期 `55000`。**CLOSED**。

### 1.3 Release 进入 STAGING 后仍可追加 Pin

Pin 表即使禁止 UPDATE/DELETE，只要 API 仍有 INSERT，就可以在 STAGING 后改变 Manifest 集合。`db01_enforce_release_pin_insert` 现在锁定并检查 Release 仍为 Draft，同时校验 Project、Resource、Revision、Family 和 Digest 一致；进入 STAGING 后再插入返回 `55000`。**CLOSED**。

### 1.4 旧恢复演练假设迁移链永远只有一个版本

DB-00 Integration 的临时向前修复目录只复制 `0001`；加入正式 `0002` 后会把已有历史误判为领先。演练已改为复制 `0001+0002`，在 `0003` 的 DDL 中途失败后验证无部分对象/账本，再用 `0003` 已提交缺陷与 `0004` 向前修复证明升级路径。**CLOSED**。

## 2. Intended-vs-Implemented 矩阵

| Intended Claim                                                          | 精确执行点                                                                                                      | 反例测试                                                                               | 结果 |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---- |
| DB-00 可只向前升级 DB-01，重跑 no-op，Hash/顺序可审计                   | `runDatabaseMigrations`、`assertMigrationHistory`、`0002_metadata_control_plane.sql`、`schema_migrations`       | `assertLedger`；第二次 `applied=[]`；双 Runner 总计只 Apply 两个版本                   | PASS |
| 18 张表全部由 `migration_owner` 拥有                                    | `CREATE TABLE meta.* / authz.*` 在 `SET LOCAL ROLE migration_owner` 后执行                                      | `assertDb01Catalog` 精确比对 Schema/Table/Owner                                        | PASS |
| 名称墓碑、Revision Digest、Pin/Pointer、Package Version、外部身份不重复 | 命名唯一约束、Pin/Pointer PK/UQ、Package Version UQ、Principal `(issuer,subject)` UQ                            | `assertDb01Uniqueness` 通过 `api_runtime` 制造 `23505`；`assertDb01Catalog` 核对约束名 | PASS |
| Published Revision/Release/Package Revision 不可改写或删除              | `db01_enforce_revision_update`、`db01_enforce_release_update`、`db01_reject_mutation`、无 DELETE/TRUNCATE Grant | `assertDb01PublishedFactsImmutable`：列权限和 Trigger 分别返回 `42501/55000`           | PASS |
| Release Pin 在 STAGING 后封存，且引用真实 Revision 事实                 | `db01_enforce_release_pin_insert`                                                                               | Draft 重复 Pin 返回 `23505`；STAGING 后插入返回 `55000`                                | PASS |
| API 仅能更新特定列，Worker/Ops 无隐式写权                               | 迁移尾部显式 `REVOKE`、表级 `GRANT`、列级 `GRANT UPDATE`                                                        | `assertDb01PrivilegeMatrix` 全表 ACL + 精确 UPDATE 列；Worker/Ops 真实登录负测         | PASS |
| Migration 中途失败无部分 DDL/账本，已提交缺陷只向前修复                 | Runner 拥有事务边界；`exerciseForwardRepair` 临时 `0003/0004`                                                   | 除零失败后 Probe 不存在且 Ledger=2；修复后 Ledger=4；改历史 Hash 失败                  | PASS |
| DB-01 不偷渡下游业务表                                                  | 正式迁移只在 `meta/authz` 创建列表内对象                                                                        | `assertDb01ScopeBoundary` 在正式迁移后要求 `runtime/action/ops/audit` 无业务表         | PASS |

## 3. What I Couldn't Assess

- 这项任务没有 Repository 或真实 Publish Use Case，因此不宣称 Release、Channel、Serving Head、Package Pointer 的业务事务已完成；G2-01-08/09 必须用真实 Repository 和故障注入补证。
- 本次双 Runner 验证了 Migration Advisory Lock，未验证 Publish 的行锁顺序、Deadlock、连接中断或重试；Owner 为 G2-01-08。
- `content jsonb`、Report Issue 和 Package Manifest 的业务合同由应用层 Parser 保证；DB-01 只保证 JSON 容器类型。Store 必须在 G2-01-05/06/09 证明每个写入路径先经过 Parser 和 Digest 重算。
- 本次不宣称生产 TLS、Secret、Pool、Backup/PITR、HA、表膨胀或锁等待 SLO；它们仍是部署/Recovery/Performance Gate。
