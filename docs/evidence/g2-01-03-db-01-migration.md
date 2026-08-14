# G2-01-03 DB-01 Migration、约束与最小权限验收记录

- 结论：**PASS（仅限 G2-01-03 DB-01 Schema/Constraint/Grant Gate）**
- 执行日期：2026-08-14
- 分支：`agent/g2-01-03-db-01-migration`
- 起始 Commit：`2a97fffb426a8f47d99bb6e0d3528deb9d6d5ea7`
- 工具：Node.js 24.18.0 / npm 11.16.0 / TypeScript 6.0.3 / PostgreSQL 16.14

本记录对应 [G2-01-03 WWA](../delivery/g2-01-metadata-task-pack.md#g2-01-03实现-db-01-migration约束和最小权限)。最终实现 Commit 与远端 Gate 由 PR Head/Check 记录，避免已提交 Evidence 引用自身尚不存在的 Hash。

## 1. Intended-vs-Implemented 验收映射

| WWA 意图                                                       | 实现证据                                                                                                                                | 可执行反例/结果                                                                                                    | 结果 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---- |
| DB-00 → DB-01 空库成功，重跑 no-op，Hash/顺序可审计            | 正式 `0001+0002` 连续迁移；Runner 事务/锁/账本协议                                                                                      | 首跑精确 Apply 两个文件；第二跑 `applied=[]`；Ledger Version/Name/SHA-256/执行角色全等                             | PASS |
| 每张表 Owner/Grant 符合 ADR-013，Worker/Ops 无隐式写权         | 15 张 `meta` + 3 张 `authz`；全部 Owner `migration_owner`；显式 REVOKE/表级/列级 Grant                                                  | 目录级全表 ACL 比对；API/Worker/Ops 三个非 Owner 登录负测；Worker/Ops 写入均 `42501`                               | PASS |
| 命名墓碑与关键身份不重复                                       | Project/Resource/Package 名称 UQ；Revision Digest、Release Pin/Channel/Serving Head、Package Version、Principal External Identity UQ/PK | `api_runtime` 逐项插入重复事实，均返回 `23505`；系统目录核对约束名                                                 | PASS |
| Published Revision/Release/Package Revision 无法篡改/删除/清空 | 列级 UPDATE Grant + Revision/Release Trigger；Package Revision Append-only Trigger；三者均无 DELETE/TRUNCATE Grant                      | 非 Owner 对 Content/Digest/Published Time/Manifest 发起 UPDATE，对三表发起 DELETE/TRUNCATE，稳定收到 `55000/42501` | PASS |
| DDL 中途失败无部分状态，已提交缺陷只向前修复                   | `exerciseForwardRepair`：基于正式 `0001+0002` 构造临时 `0003/0004`                                                                      | `0003` 中途失败后 Probe 不存在且 Ledger=2；更高版本修复后 Ledger=4；改历史 Hash 失败                               | PASS |
| DB-01 不创建下游业务表                                         | Migration 仅在 `meta/authz` 创建 ADR-013 列表                                                                                           | 正式迁移后 `runtime/action/ops/audit` 业务表精确为空                                                               | PASS |

完整的 Claim → Enforcement Point → Negative Test 矩阵见 [专项红队](../reviews/g2-01-03-db-01-red-team.md)。

## 2. 已落地的数据库边界

### 2.1 对象与不变量

- 15 张 Metadata 表：Project、Resource/Revision/Dependency、Validation Report、Release/Pin/Activation/Channel/Serving Head、Package/Revision/Installation/Change、Artifact Reference；
- 3 张 AuthZ 表：Principal、Role Binding、Authorization Epoch；
- UUID 由应用生成，Digest 必须是 `sha256:` + 64 位小写十六进制，API Name/Namespace/Semantic Version 与 Metadata v1 合同一致；
- 所有 FK 默认 `ON DELETE RESTRICT`；Release Pin 必须绑定同 Project 的已验证/已发布 Revision，Family/Digest 与持久化事实一致；
- 不可变事实使用无 Update/Delete/Truncate Grant 和 Trigger 双重限制；可变 Pointer/Epoch 必须单调 `+1`。

### 2.2 权限

- `api_runtime`：DB-01 表 `SELECT/INSERT`；只对状态、Draft 内容、Pointer、Epoch 和时间等明确列有 UPDATE；
- `worker_runtime`：`meta` 全表只读，仅可读 `authz.authorization_epochs`；
- `read_only_ops`：`meta` 全表只读，不可读 Principal/Binding/Epoch；
- 三类角色均没有 DB-01 对象的 DELETE、TRUNCATE、ALTER、REFERENCES 或 Owner Membership。

## 3. Red-Team 实际修正

[专项审查](../reviews/g2-01-03-db-01-red-team.md)在 PASS 前修正四个可落地偏差：

1. 补上 Revision/Release 发布事实和 Pointer Sequence Trigger，不把列级 Grant 误当业务不变量；
2. 补上初始状态 Trigger，阻止绕过状态机直接 INSERT 终态；
3. 补上 Release Pin 的 Draft-only 写入与 Revision Fact 一致性检查，阻止 STAGING 后追加 Pin；
4. 将旧向前修复演练从单 `0001` 扩展为真实 `0001+0002` 基线上的 `0003` 失败和 `0004` 修复。

审查后没有仍未关闭、且属于 G2-01-03 范围的 Intended-vs-Implemented 偏差。

## 4. 可复现执行

```text
npm run test:database:unit

10 tests / 10 pass / 0 fail

npm run test:database

PostgreSQL 16.14
1 top-level integration / PASS
intentional.role_escalation=blocked
```

一个 Top-level Integration 包含：Preflight 写前失败、空库 `0001+0002`、no-op、账本 Hash、18 表 Owner/ACL、列级 Update Grant、三个真实非 Owner Login、合法控制面写入、唯一约束、状态与不可变负测、Scope 禁线、DDL 失败回滚、向前修复、历史篡改和第二数据库双 Runner 并发。

### 全仓 Gate

```text
Node.js 24.18.0 / npm 11.16.0
Foundation Gate: PASS — 16/16
unit:                  226/226
contract-golden-diff: PASS — 11 foundation / 12 metadata / 66 golden cases
architecture:          PASS — 3 packages / 23 source files
supply chain:          PASS — 135 packages / 138 SBOM components / 0 vulnerabilities
postgres integration: PASS — PostgreSQL 16.14 / role escalation blocked
production boundary:  PASS — OIDC / S3 / PostgreSQL / OpenTelemetry
teardown:              PASS — containers and network removed
```

首次 `npm run verify` 由当前 Shell 的 Node.js 22/npm 10 启动，被锁定工具链以 `EBADENGINE` Fail Closed，没有被当作通过。随后显式使用仓库锁定的 Node.js 24.18.0/npm 11.16.0 完整重跑，16 项 Gate 全部 PASS。

### 冻结摘要

```text
3e19e7f90229ead042c52255802bcd0bd0d243eb12f3b0f92087dc7ed4a6187e  0001_foundation.sql
63416c6d2f02110877afd6fe234664da8fc3e1b5f29027c7e8b4cb35d193d340  0002_metadata_control_plane.sql
295ce942dad9f396aa758da5ac4bb6768b5a67a4ded35b0930d3e1e436f59843  postgres.integration.test.ts
```

## 5. 明确不宣称

- 本任务没有实现 PostgreSQL Repository、Project/RBAC Use Case、Resource Draft API、Validator/Compatibility、Release Publish 业务事务、Package 展开或 HTTP/OIDC。
- Integration 通过一个受控事务序列填充合法行，不代表 G2-01 生产闭环已完成；业务事务和并发锁证据属于 G2-01-04～09。
- DB-01 的 JSONB 只限制容器类型；每个写入路径是否调用 Metadata v1 Parser 和重算 Digest，由 Store/Use Case 任务证明。
- 本地一次性 PostgreSQL 容器不是生产 TLS、Secret、Pool、HA、Backup/PITR、容量或锁等待 SLO 证明。
- 当前只宣称 PostgreSQL 16，不宣称 17+。G2-01 进度为 3/12，G2-01-04～12 仍 OPEN。
