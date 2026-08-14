# G2-01-06 Definition Validation 与 Dependency Graph 验收记录

- 结论：**PASS（仅限 G2-01-06 Definition Validation / Dependency Graph Gate）**
- 执行日期：2026-08-14
- 分支：`agent/g2-01-06-dependency-validation`
- 起始 Commit：`81972616cd7aa8fbad7c20022ea0f9fcae72396a`
- 工具：Node.js 24.18.0 / npm 11.16.0 / TypeScript 6.0.3 / PostgreSQL 16.14

本记录对应 [G2-01-06 WWA](../delivery/g2-01-metadata-task-pack.md#g2-01-06实现定义校验与-dependency-graph)。最终实现 Commit 与远端 Gate 由 PR Head/Check 记录，避免已提交 Evidence 引用自身尚不存在的 Hash。

## 1. 本次落地内容

- `@ontos/metadata-domain`：Object/Property/Link 语义校验、Link 两端服务器 Dependency Extractor、稳定 Issue 排序、闭包、dependency-first 拓扑和稳定 Cycle Path；
- `@ontos/metadata-application`：受统一 `ManagementAuthorizer` 保护的 Validate/Get Report Use Case，Validator Version 固定在服务器，命令不接受客户端 Dependency、Report 或状态字段；
- `@ontos/metadata-postgres`：同 Project 闭包读取、存储边反向重提取核验、不可变 Validation Report、Context Digest、报告/边/状态单事务和并发幂等；
- `0004_dependency_validation_guards.sql`：向前增加 Validation Context 身份、内容边 Insert Guard、成功报告/完整边 Draft→Validated Guard；
- 真实 PostgreSQL 16 Integration：失败后同内容重试、32 路并发、两条精确 Link 边、伪造 Path、无报告直改状态、Missing/Cross-Project 同形错误与 Migration no-op/repair。

## 2. 关键可执行证据

| 验收项                        | 执行结果                                                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Object/Property/Link 严格校验 | Contracts Parser 负责字段、Primary Key、类型、nullable、writeMode、query flags、Enum/Cardinality/Source/Delete 枚举；Domain 补 Primary Key overlay、JSON 顶层路径和 Base-only Action mutation 语义 |
| 服务器提取与持久边一致        | Link 只产生固定 `link_source`、`link_target` 两边及固定 JSON Pointer；Repository 重提取，DB Trigger 对内容 Target/Path/Family/Project/State 再核对                                                 |
| 依赖可用性                    | Missing/Cross-Project 使用同形 `DEPENDENCY_UNAVAILABLE`；Archived、错误 Family、未 Validated 目标均为结构化 Error Issue，不进入 Validated                                                          |
| 闭包与循环                    | 从 Root 沿持久边计算闭包；所有环默认拒绝；Cycle 从最小稳定 ID 起闭合，公开 Remediation 只包含 Source JSON Pointer，不泄漏不可见 ID                                                                 |
| 确定性                        | 100 轮随机边顺序得到固定 `d,b,c,a` dependency-first 顺序、固定 Issue 排序和相同图摘要；不使用插入时间、行顺序或 Locale Collation                                                                   |
| 失败后可重试                  | 同一 Link Content Digest 在 Target Draft 时产生 invalid Report；Target Validated 后 Context Digest 改变，产生新的 valid Report，旧报告不修改                                                       |
| 原子与并发                    | invalid Validation 保持 Draft 且零边；32 路成功重试返回同一 Report；Report、两边与 Validated 状态在一个事务提交                                                                                    |
| 防绕过                        | 通用 Repository 状态转换拒绝 `validated`；无成功报告直接 SQL 状态更新返回 `55000`；错 Path Dependency INSERT 返回 `23514`                                                                          |
| 不可见资源不泄漏              | Closure 查询只锁 Source Project；Missing 与 Cross-Project 的可见 Issue 数量、Code、Path、Message、Remediation 相同，报告正文无外部 Resource ID                                                     |

完整 Claim → Enforcement Point → Negative Test 矩阵和审查中实际修正见 [专项红队](../reviews/g2-01-06-definition-validation-dependency-graph-red-team.md)。

## 3. 可复现执行

```text
npm run test:metadata-control-plane

33 tests / 33 pass / 0 fail

npm run test:database

PostgreSQL 16.14
2 top-level integrations / 2 pass / 0 fail
same-content dependency retry: invalid → valid / 2 immutable context digests
32-way validation retry: 32 validated results / 1 report identity
intentional.role_escalation=blocked
```

### 全仓 Gate

```text
Node.js 24.18.0 / npm 11.16.0
Foundation Gate: PASS — 16/16
unit:                  249/249
contract-golden-diff: PASS — 11 foundation / 12 metadata / 66 golden cases
architecture:          PASS — 6 packages / 26 source files
scope evidence:        PASS — 4 DB migrations / 19 evidence records / no app or UI
supply chain:          PASS — 135 packages / 141 SBOM components / 0 vulnerabilities
postgres integration: PASS — 2/2 / PostgreSQL 16.14 / role escalation blocked
production boundary:  PASS — OIDC / S3 / PostgreSQL / OpenTelemetry
teardown:              PASS — containers and network removed
```

本地报告在提交前运行，因此 Commit 字段仍是起始 Commit；最终实现 Commit 与远端 Gate 由 PR Head/Check 绑定。

## 4. 审查后边界

- Revision Validation 证明 Definition 和当前依赖上下文可复用，不等于候选 Release 已兼容或 READY；Compatibility 属于 G2-01-07，Release 全闭包重验属于 G2-01-08。
- `validation_context_digest` 是数据库内部的验证输入身份，不改变公共 `ValidationReport.subjectDigest` 的内容摘要语义。
- G2-01 活跃 Dependency 只有 Link→Object；`property_reference` 保留合同值但 `0004` 在本 Gate 拒绝持久化，直到拥有它的后续 Family Gate 激活 Extractor。
- HTTP/OIDC、请求定额、Error Envelope 和可见 Dependency Graph 响应属于 G2-01-10；当前 API 不返回内部拓扑或目标 ID。
- 当前 G2-01 进度为 **6/12**；下一工作项是 G2-01-07，剩余 **6 项**。
