# G2-01-07 Resource / Package Compatibility Engine 验收记录

- 结论：**PASS（仅限 G2-01-07 Compatibility Gate）**
- 执行日期：2026-08-15
- 分支：`agent/g2-01-07-compatibility-engine`
- 起始 Commit：`0d39474ff4503a9ba74e4ccf6694fed09ffedbc0`
- 工具：Node.js 24.18.0 / npm 11.16.0 / TypeScript 6.0.3 / PostgreSQL 16.14

本记录对应 [G2-01-07 WWA](../delivery/g2-01-metadata-task-pack.md#g2-01-07实现-resource-与-package-兼容性引擎)。最终实现 Commit 与远端 Gate 由 PR Head/Check 记录，避免 Evidence 引用自身尚不存在的 Hash。

## 1. 本次落地内容

- `@ontos/metadata-domain` 新增纯语义 Compatibility Engine：Object/Property/Link 规则、Release Pin 集合、Package Identity/Namespace/Install Input/Manifest Expansion、稳定 Finding 排序、严重度汇总与下游 Dependency Closure 检查；
- `@ontos/metadata-application` 新增受 `metadata.read` 保护的 Revision Diff Use Case；命令只接受 Candidate/Baseline Revision ID，不接受客户端内容、Finding、Semantic Version 或 Gate 结论；
- `@ontos/metadata-postgres` 从已存 Revision 内容计算报告，校验同一 Resource 身份，并用比较器版本、Revision ID、Digest 和 Findings 生成稳定不透明 Report ID；
- G1 Compatibility Fixture 的 8 个 Case 全部有明确结论：Object/Property/Link 可判定部分进入当前 Gate；Raw SQL/Package 原子性归 G2-01-09；Release/Rollback 归 G2-01-08/09；Policy/Action/Runtime Bridge 保持后续拥有 Gate；
- 真实 PostgreSQL 16 路径验证授权后的 Diff、重复比较稳定、跨 Resource 基线拒绝和存储 Digest 反校验。

Compatibility Report 不新增第 19 张 DB-01 表。ADR-013 已冻结的 `validation_reports` 仍保存 Release Gate 结论；Revision Diff 是由两份不可变内容事实确定性重算的合同响应。G2-01-08 会把服务器选定的当前 Published Pin 集与 Candidate Pin 集纳入 Release Validation Report，客户端不能替换发布基线。

## 2. PRD 规则与执行结果

| 规则                                                 | 稳定结论       | 关键 Change Code / 下一步                                                                                         |
| ---------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Display Name / Description                           | `compatible`   | `DISPLAY_TEXT_CHANGED`                                                                                            |
| nullable Property 新增                               | `compatible`   | `NULLABLE_PROPERTY_ADDED`                                                                                         |
| Enum 放宽                                            | `compatible`   | `ENUM_WIDENED`                                                                                                    |
| Property 删除或改名                                  | `breaking`     | `PROPERTY_REMOVED`；比较器不猜测 Alias                                                                            |
| Property Type / nullable 收紧                        | `breaking`     | `PROPERTY_TYPE_CHANGED` / `PROPERTY_NULLABILITY_NARROWED`                                                         |
| Primary Key 修改                                     | `forbidden`    | `PRIMARY_KEY_CHANGED`；新 Resource 或显式 Migration                                                               |
| Enum 收紧                                            | `breaking`     | `ENUM_NARROWED`                                                                                                   |
| Link Endpoint 身份 / Cardinality 修改                | `breaking`     | `LINK_TYPE_ENDPOINT_CHANGED` / `LINK_TYPE_CARDINALITY_CHANGED`                                                    |
| 同一 Object Resource 的 Endpoint Revision 前移       | 可继续语义比较 | 按 Revision→Resource 事实识别，不把正常重新 Pin 误报为换 Endpoint                                                 |
| 启用 Query/Unique/JSON Filter 能力                   | `conditional`  | `INDEX_PLAN_REQUIRED` / `PROPERTY_INDEX_REQUIRED` / `PROPERTY_UNIQUENESS_VALIDATION_REQUIRED`；G2-01 不进入 READY |
| 未激活 Resource Family                               | `conditional`  | `RESOURCE_FAMILY_COMPATIBILITY_DEFERRED`；不推测 Policy/Action/View 语义                                          |
| Package Namespace / Kernel Contract / Expansion 漂移 | `forbidden`    | `NAMESPACE_CHANGED` / `KERNEL_CONTRACT_CHANGED` / `PACKAGE_RESOURCE_EXPANSION_MISMATCH`                           |

## 3. 下游 Pin 与防绕过证据

- 比较输入是完整 Baseline/Candidate Pin 和服务器 Dependency Edge，不是两个同 Resource JSON；
- Candidate 替换 Object Revision、但仍 Pin 指向旧 Revision 的 Link 时，稳定输出 `DOWNSTREAM_PIN_REQUIRES_REPIN`；
- Link 创建新 Revision 并重新 Pin 到同一 Object Resource 的 Candidate Revision 后，Closure Finding 消失；若 Object Resource 身份真的变化，仍输出 `LINK_TYPE_ENDPOINT_CHANGED`；
- Candidate Dependency 的 Target 不在 Candidate Pin 集时，无论数据库行顺序如何都不能被遗漏；
- Comparator/Application 没有 Semantic Version 输入，Strict Command 对 `semanticVersion`、`baselineContent` 等覆盖字段返回 `INVALID_INPUT`；版本号不能抬高严重度或改变结论；
- Package Comparator 同样忽略 `version` 标签本身，只使用 Manifest 身份、展开后的真实定义与 Pin；同内容从 `1.0.0` 改写成 `99.0.0` 仍得到相同语义结论；
- Link Endpoint 的 Revision→Resource 查询只读取 Source Project；两个外部 Project Revision 即使属于同一 Resource，也与 Missing 一样保守判为 Endpoint 变化，不形成存在性或同源关系探针；
- Revision Diff 的 `against` 仅是管理读接口；G2-01-08 Publish Gate 必须从 Channel/Serving 事实读取当前 Published Baseline，不接受该查询参数作为发布证书。

## 4. 可复现执行

```text
npm run test:metadata-control-plane

46 tests / 46 pass / 0 fail
PRD matrix / conditional readiness / actual Pins / 100 shuffled orders / G1 8-case ownership

npm run test:database

PostgreSQL 16.14
2 top-level integrations / 2 pass / 0 fail
G2-01-04/05/06/07 Repository path: PASS
intentional.role_escalation=blocked
```

全仓 `npm run verify` 和远端 Foundation Gate 结果在 PR Check 绑定最终 Head Commit 后记录。专项 Claim → Enforcement Point → Negative Test 与审查中修正见 [G2-01-07 Red-Team](../reviews/g2-01-07-compatibility-engine-red-team.md)。

### 全仓 Gate

```text
Foundation Gate: PASS — 16/16
unit:                  262/262
contract-golden-diff: PASS — 11 foundation / 12 metadata / 66 golden cases
architecture:          PASS — 6 packages / 27 source files
scope evidence:        PASS — 4 DB migrations / 20 evidence records / no app or UI
supply chain:          PASS — 135 packages / 141 SBOM components / 0 vulnerabilities
postgres integration: PASS — 2/2 / PostgreSQL 16.14 / role escalation blocked
production boundary:  PASS — OIDC / S3 / PostgreSQL / OpenTelemetry
teardown:              PASS — containers and network removed
```

本地报告在提交前运行，因此 Commit 字段仍是起始 Commit；最终实现 Commit 与远端 Gate 由 PR Head/Check 绑定。

## 5. 审查后边界

- Compatibility Engine 已是生产 Domain 代码，不复制 G1 原型 Store；G1 JSON 只作为来源向量和回归证据。
- `conditional` 在 G2-01 是阻断，不表示“带警告发布”；Materialization/Index/Migration 能力由 G2-02 提供真实证据后才能满足。
- 当前只冻结 Object Type、Property、Link Type 语义；Policy/Action/View 等 Family 明确返回 Deferred，不能进入 READY。
- 当前直接 Revision Diff 不持久化派生报告；Release/Package 的受信 Gate 证据和当前 Published Baseline 选择属于 G2-01-08/09。
- 当前 G2-01 进度为 **7/12**；下一工作项是 G2-01-08，剩余 **5 项**。
