# G2-01-04 Project、Principal、Role Binding 与 Epoch 验收记录

- 结论：**PASS（仅限 G2-01-04 管理身份、RBAC 与 Epoch Gate）**
- 执行日期：2026-08-14
- 分支：`agent/g2-01-04-project-rbac-epoch`
- 起始 Commit：`f1360776184e07fad9d89d2c717619569f481271`
- 工具：Node.js 24.18.0 / npm 11.16.0 / TypeScript 6.0.3 / PostgreSQL 16.14

本记录对应 [G2-01-04 WWA](../delivery/g2-01-metadata-task-pack.md#g2-01-04实现-projectprincipalrole-binding-与-epoch)。最终实现 Commit 与远端 Gate 由 PR Head/Check 记录，避免已提交 Evidence 引用自身尚不存在的 Hash。

## 1. 本次落地内容

- `@ontos/metadata-domain`：唯一的 Owner/Editor/Viewer/Executor/Auditor 管理权限矩阵与 Resource 收窄规则；
- `@ontos/metadata-application`：闭合 `VerifiedFoundationIdentity`、Principal/Project/Binding/Authorization Ports、统一 `ManagementAuthorizer` 和 Project/Binding/Archive Use Case；
- `@ontos/metadata-postgres`：基于 `api_runtime` 最小权限的 Principal 映射、Project 原子创建、Role Binding CAS 替换、Epoch Repository、Archive 与 Authorization Reader；
- PostgreSQL Integration：并发 Principal 映射、事务故障注入、角色正反矩阵、Resource 交集、陈旧 Epoch、幂等替换、撤权、Archive 历史与 API Name 墓碑。

三个正式包严格遵循任务包 3.1：Application/Domain 不导入 PostgreSQL、HTTP、OIDC SDK、文件系统或环境变量；PostgreSQL 行只在 Adapter 内部存在。

## 2. 关键可执行证据

| 验收项                                 | 可执行结果                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| Principal 稳定映射与 Actor ID 不可覆盖 | 12 个并发 issuer/subject 解析得到一个 UUID；Identity 额外 Principal/Claims/Token 字段拒绝 |
| Project + Owner + Epoch 原子           | Binding PK 故障发生在 Project INSERT 之后；事务回滚后 Project/Binding/Epoch 均不存在      |
| 管理角色矩阵                           | 五角色 × 五权限正反测试；Executor/Auditor 全部管理权限为 Deny                             |
| Resource 只收窄                        | Editor→Viewer、Viewer→Owner、Executor→Owner 和跨 Project Resource 四类负测均 Deny         |
| Binding + Epoch 原子/幂等              | 每次实际变化精确 `+1`；相同替换不变；陈旧 CAS 拒绝；Insert 故障后旧 Binding/Epoch 不变    |
| 撤权时限                               | 正式 Repository 撤权与 Epoch 同事务；ADR-012 Harness 在通知丢失下 5,000ms 强制 Deny       |
| Archive 历史/墓碑                      | Resource/Release 行保留；Archived Project 不再授权；相同 Project API Name 无法复用        |

完整 Claim → Enforcement Point → Negative Test 矩阵及实际修正见 [专项红队](../reviews/g2-01-04-project-rbac-epoch-red-team.md)。

## 3. 可复现执行

```text
npm run test:unit

238 tests / 238 pass / 0 fail

npm run test:database

PostgreSQL 16.14
2 top-level integrations / 2 pass / 0 fail
intentional.role_escalation=blocked
```

新增 Integration 使用真实 `api_runtime` Login，而非数据库 Owner。它在一次容器中完成 12 路 Principal 并发、两个事务故障点、25 项角色权限、Resource 收窄/跨 Project、Epoch CAS/幂等、撤权和 Archive 保留检查；原 DB-01 Migration/Grant Integration 同时保持通过。

### 全仓 Gate

```text
Node.js 24.18.0 / npm 11.16.0
Foundation Gate: PASS — 16/16
unit:                  238/238
contract-golden-diff: PASS — 11 foundation / 12 metadata / 66 golden cases
architecture:          PASS — 6 packages / 26 source files
supply chain:          PASS — 135 packages / 141 SBOM components / 0 vulnerabilities
postgres integration: PASS — 2/2 / PostgreSQL 16.14 / role escalation blocked
production boundary:  PASS — OIDC / S3 / PostgreSQL / OpenTelemetry
teardown:              PASS — containers and network removed
```

## 4. 审查后边界

- OIDC Token 的密码学验证、HTTP Parser/Error Envelope 和 Composition Root 仍属于 G2-01-10；本任务只冻结其向 Application 提供的严格身份形状。
- Resource/Draft Revision、Dependency/Compatibility、Release/Package 和公开 Endpoint 尚未实现，分别属于 G2-01-05～10。
- ADR-012 Cache 仍是 Harness，不宣称 G2-03 Policy Gateway 已完成；这里证明的是它依赖的真实 Epoch 写入不与 Binding 撕裂。
- 当前 G2-01 进度为 **4/12**；下一工作项是 G2-01-05。
