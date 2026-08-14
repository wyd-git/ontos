# G2-01-09 Package Lifecycle 验收记录

- 结论：**PASS（仅限 G2-01-09 Package Validate / Install / Upgrade / Rollback）**
- 执行日期：2026-08-15
- 分支：`agent/g2-01-09-package-lifecycle`
- 起始 Commit：`13da57423c1afb428ea13700ce7e4e813cffe0a2`
- 工具：Node.js 24.18.0 / npm 11.16.0 / TypeScript 6.0.3 / PostgreSQL 16.14

本记录对应 [G2-01-09 WWA](../delivery/g2-01-metadata-task-pack.md#g2-01-09实现-package-validateinstallupgrade-与-rollback)。最终实现 Commit 与远端 Gate 由 PR Head/Check 记录，避免 Evidence 引用自身尚不存在的 Hash。

## 1. 本次落地内容

- `@ontos/metadata-domain` 新增闭合 Package 预检：严格 Manifest/Resource/Input 形状、共享 Resource Family Registry、规范 Digest 前像、Link Dependency 提取和安装输入绑定；
- `@ontos/metadata-application` 新增 Validate、Install、Upgrade 和 Rollback Use Case；入口只接收 Verified Foundation Identity，统一要求 `package.manage`；
- `@ontos/metadata-postgres` 新增 Package Store；Install/Upgrade 在一个事务中产生 Package/Revision、Resource/Revision/Dependency/Report、Installation、Release Draft 和 Pending Change；
- `0006_package_lifecycle_guards.sql` 封存 Change 目标、Request/Input Digest、Compatibility Report 和 Release 一对一绑定，并强制 Installation Pointer 只能随 Published Release 的 Pending Change 切换；
- Release Publish 事务扩展为同时切换 Channel、Installation Active Package Revision/Release，旧 Active Change 转 Superseded，新 Pending Change 转 Active；
- Rollback 从存储的历史 Package Revision 重建 Candidate，产生新 Release Draft 和 Change，不改写历史 Package/Release/Resource 事实。

## 2. 服务器信任边界

Package 有两道校验：Application 负责快速反馈，Repository 不信任 TypeScript 的 `PreparedPackageCandidate` 类型，而是从 Manifest、Resource Content 和 Input Binding 重新解析、重新计算 Digest。伪造“已校验”对象会在任何数据库写入前被拒绝。

稳定拒绝范围包括：

- Raw SQL、Kernel Migration、任意文件路径、固定数据库地址、Secret/Credential 字段和 Secret 形安装输入；
- 非 `metadata-1` Kernel Contract、未激活 Resource Family、Manifest/Resource/Digest 展开不一致；
- 同 Project 内被其他 Active 或 Pending Package 占用的 Resource ID 或 Namespace/API Name；
- 不同内容复用同一 Package Version，以及与服务器重算结果不同的请求 Digest。

Compatibility 在任何 Candidate 持久化前读取当前 Active Package Revision 并生成服务器 Report。`breaking`、`conditional` 或 `forbidden` 直接返回 `accepted=false`，不创建 Release/Change 且不改变 Installation。公开 Finding 上限为 1,000，截断摘要保留原阻断严重度。

## 3. 事务、幂等与历史证据

真实 PostgreSQL 16 Integration 在 Package 准备的五个边界注入故障：

```text
after_package
after_resources
after_installation
after_release
after_change
```

每次故障后 Package、Resource、Installation、Release 和 Change 计数都与事务前完全一致。

目标 Release Stage 后，又在 Release Publish 全部八个边界注入故障：

```text
after_activation
after_serving_head
after_revisions
after_release
after_channel
after_installations
after_project
after_epoch
```

每次失败都保持旧 Channel Pointer、Installation Revision/Release/Sequence、Change State、Release State 和 Activation 数不变；随后同一 Candidate 可成功 Publish。

相同 Manifest/Input/Request Key 重试返回同一 Change 且标记幂等。Rollback 创建新 Release ID，发布前 Installation 仍指向当前 Revision，发布后才切到历史 Revision；早期 Release Manifest Digest 和 Pins 前后逐字段一致。

## 4. 两 Package 与 G1 Provenance

正向集成在同一 Project 安装 `fixture.commerce` 和 `fixture.work` 两个 metadata-only Package，验证 Namespace/API Name 隔离与 Package 内 Link 两条真实 Dependency Edge。重叠 Resource ID 的第三个 Package 在事务内被拒绝。

两个领域的来源由 `packages/testkit/fixtures/provenance.json` 的 `packages` 组绑定到 G1 `packages/commerce/package.json` 和 `packages/work-management/package.json` 的冻结 SHA-256。G2-01 只取其 Namespace 和 Object/Link 语义形成激活 Family 的 metadata-only 测试面；生产 Package Domain/Application/PostgreSQL 不依赖 `@ontos/testkit`，也不导入 G1 Store、Runtime Bridge、SQL 或凭据。G2-01-11 会把这个派生过程纳入统一 Fixture/Evidence Gate。

## 5. 可复现执行

```text
npm run typecheck                 PASS
npm run lint                      PASS
Package/Compatibility unit tests 16/16 PASS
npm run test:database             4/4 PASS
PostgreSQL                         16.14
intentional.role_escalation        blocked
```

### 全仓 Gate

```text
Foundation Gate: PASS — 16/16
unit:                  270/270
contract-golden-diff: PASS — 11 foundation / 12 metadata / 66 golden cases
architecture:          PASS — 6 packages / 33 source files
scope evidence:        PASS — 6 DB migrations / 22 evidence records / no app or UI
testkit provenance:    PASS — 47 G1 inputs / 6 migrated groups
supply chain:          PASS — 135 packages / 141 SBOM components / 0 vulnerabilities
postgres integration: PASS — 4/4 / PostgreSQL 16.14 / role escalation blocked
production boundary:  PASS — OIDC / S3 / PostgreSQL / OpenTelemetry
teardown:              PASS — containers and network removed
duration:              32,734 ms
```

本地报告在提交前运行，因此 Commit 字段仍是起始 Commit；最终实现 Commit 与远端 Gate 由 PR Head/Check 绑定。

## 6. 审查后边界

- G2-01-10 才提供真实 HTTP/OIDC、Body Limit、If-Match 和 Error Envelope；当前没有把 Application Service 宣称为网络产品入口；
- Artifact Digest 可严格登记，但 Function/Action Artifact 的执行与兼容性仍属其拥有 Gate，G2-01 不启用该 Capability；
- Breaking/Conditional Rollback 不因“回滚”名称绕过当前 Compatibility Gate；紧急审批通道不在本 Gate 自行扩展；
- 当前 G2-01 进度为 **9/12**；下一工作项是 G2-01-10，剩余 **3 项**。
