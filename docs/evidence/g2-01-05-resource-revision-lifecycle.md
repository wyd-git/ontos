# G2-01-05 Resource 与 Draft Revision 生命周期验收记录

- 结论：**PASS（仅限 G2-01-05 Resource / Revision 生命周期 Gate）**
- 执行日期：2026-08-14
- 分支：`agent/g2-01-05-resource-draft-lifecycle`
- 起始 Commit：`403a391729acdcca5d7aeb429cb85c94f132fd3c`
- 工具：Node.js 24.18.0 / npm 11.16.0 / TypeScript 6.0.3 / PostgreSQL 16.14

本记录对应 [G2-01-05 WWA](../delivery/g2-01-metadata-task-pack.md#g2-01-05实现-resource-与-draft-revision-生命周期)。最终实现 Commit 与远端 Gate 由 PR Head/Check 记录，避免已提交 Evidence 引用自身尚不存在的 Hash。

## 1. 本次落地内容

- `@ontos/metadata-domain`：Resource Namespace/API Name/Family 校验、活动 Family 内容解析、规范 JSON 预映像以及 Resource/Revision 单向状态机；
- `@ontos/metadata-application`：严格创建/读取/列表/Draft Patch/子 Draft/废弃/归档 Use Case，Actor 仅来自已验证 Foundation Identity，所有路径经统一 `ManagementAuthorizer`；
- `@ontos/metadata-postgres`：Resource + Initial Draft 原子创建、SHA-256 服务器 Hash、Etag 行锁、子 Revision 序号分配、确定性 Keyset 分页、单向状态转换和存储内容/Hash 回读校验；
- `0003_resource_revision_guards.sql`：只向前加固 Parent 顺序/Family/Resource 可编辑性，并关闭 Published Revision 后追加 Dependency 的窗口；
- 真实 PostgreSQL 16 Integration：100 路同 Etag Patch、100 路子 Draft、不可变事实、确定性分页、故障回滚、归档只读与名称墓碑。

## 2. 关键可执行证据

| 验收项                              | 执行结果                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Project 内名称唯一且 Archive 不释放 | DB `(project_id, namespace, api_name)` 唯一约束；Archive 后重建稳定 `ALREADY_EXISTS`                                   |
| Draft Etag 并发                     | 100 个 Writer 同持 Etag=1，精确 1 个成功、99 个 `CONCURRENT_MODIFICATION`，最终 Etag=2，无丢失更新                     |
| 规范 Hash                           | 100 轮属性测试证明 Key 顺序不改变 Hash；语义内容改变必然改变本组 Digest                                                |
| 不可变 Revision 编辑                | Validated/Published/Deprecated 均创建 Parent 指向原版本的新 Draft，原行逐字段回读不变                                  |
| Published 事实不可变                | API 拒绝 Patch；Runtime Role 无 Parent/Author 更新权；Trigger 禁止 Content/Hash 变更和发布后 Dependency Insert         |
| 确定性分页                          | Resource 按 C Collation 的 Namespace/API Name/UUID，Revision 按数值 Revision Number/UUID；逐页 limit=1/17 无重复无遗漏 |
| 100 路子 Revision                   | 100 个并发 Child 全部成功，ID 和 Revision Number 均不重复，101 行完整，Parent 只指向已存在且更早的 Revision            |
| Archive 只读                        | Resource 锁与 Revision 锁顺序固定；Archive 后 Repository Patch/Validate 和绕过 Repository 的 SQL Patch 均拒绝          |

完整 Claim → Enforcement Point → Negative Test 矩阵和实际修正见 [专项红队](../reviews/g2-01-05-resource-revision-lifecycle-red-team.md)。

## 3. 可复现执行

```text
npm run test:metadata-control-plane

26 tests / 26 pass / 0 fail

npm run test:database

PostgreSQL 16.14
2 top-level integrations / 2 pass / 0 fail
100-way Etag contention: 1 success / 99 stable conflicts
100-way child Draft creation: 100 unique IDs / 100 unique numbers
intentional.role_escalation=blocked
```

### 全仓 Gate

```text
Node.js 24.18.0 / npm 11.16.0
Foundation Gate: PASS — 16/16
unit:                  242/242
contract-golden-diff: PASS — 11 foundation / 12 metadata / 66 golden cases
architecture:          PASS — 6 packages / 26 source files
supply chain:          PASS — 135 packages / 141 SBOM components / 0 vulnerabilities
postgres integration: PASS — 2/2 / PostgreSQL 16.14 / role escalation blocked
production boundary:  PASS — OIDC / S3 / PostgreSQL / OpenTelemetry
teardown:              PASS — containers and network removed
```

## 4. 审查后边界

- G2-01-05 只提供严格 Object Type/Link Type Draft 生命周期；服务器 Dependency Extractor、结构校验、Validation Report 和图闭包属于 G2-01-06。
- `transitionRevisionState` 是给后续 Validator/Publisher 组合事务使用的内部 Repository Port；本任务没有暴露“无校验直接 VALIDATED/PUBLISHED”的应用或 HTTP Use Case。
- HTTP `If-Match`、不透明 Cursor 编码、OIDC 入口和 Error Envelope 属于 G2-01-10；本任务证明其下方的严格 Application/Repository 边界。
- Keyset 分页证明确定顺序与无边界重复，不声称多页读取是长事务快照；并发新增的后续记录可在后续页可见。
- 当前 G2-01 进度为 **5/12**；下一工作项是 G2-01-06，剩余 **7 项**。
