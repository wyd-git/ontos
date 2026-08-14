# G2-01-11 统一 CI、Testkit 与 Metadata Evidence 验收记录

- 结论：**PASS（仅限 G2-01-11 统一 Gate 与可审计证据）**
- 执行日期：2026-08-15
- 分支：`agent/g2-01-11-metadata-gate`
- 起始 Commit：`6792778`
- 工具：Node.js 24.18.0 / npm 11.16.0 / TypeScript 6.0.3 / PostgreSQL 16.14

本记录对应 [G2-01-11 WWA](../delivery/g2-01-metadata-task-pack.md#g2-01-11演进统一-citestkit-与-metadata-evidence)。最终实现 Commit 与远端 Required Check 由 PR Head/Check 绑定；本文件不宣称 G2-01 clean-room 总验收完成。

## 1. Gate 演进结果

本地和 GitHub 仍只执行 `npm run verify`，远端 Required Check 仍精确命名为 `Foundation Gate`。编排从 16 个步骤演进到 21 个步骤：原 Foundation 的 Install、工具链、格式、Lint、类型、单元、合同、架构、Provenance、Secret、Scope、供应链、PostgreSQL 和生产边界步骤全部保留；另外把 Admin API Unit、真实 OIDC/HTTP/PostgreSQL、Metadata Fixture、Metadata Negative Fixture 和 Metadata Scope/Evidence 变成独立可见 Gate。

普通 Unit 与 PostgreSQL Suite 不再把 Admin API 隐藏在内部；报告能分别显示 Domain/Repository 和 API/OIDC 的结果。每个 TAP Gate 记录 Test Count，总报告同时记录总测试数和逐步耗时。

## 2. Foundation 防线没有被删除

`security/g2-00-evidence-policy.json` 继续精确登记当前 7 个 Workspace、6 个 Migration 和 19 张表，只允许 `apps/api`，拒绝其他 App 和全部 UI 扩展名。新增反例明确证明以下内容仍使 Foundation Scope 失败：

```text
migrations/db-02/0001_materialization.sql
runtime.object_current
action.action_definitions
apps/web/src/page.tsx
```

因此 G2-01 允许的是已登记 Metadata/Package/Admin API，不是提前开放 DB-02、Runtime Object、Action、Query 或页面。

## 3. 七类故意失败 Fixture

`packages/testkit/fixtures/metadata/g2-01-negative.v1.json` 将验收要求绑定到真实 Test Source 与唯一 Marker，审计器同时验证 ID 集、Marker 唯一性和 Gate 路由：

| ID                       | 阻断结果                                      | 执行面     |
| ------------------------ | --------------------------------------------- | ---------- |
| `unknown_resource_field` | 严格 Resource Parser 返回 `INVALID_INPUT`     | Unit       |
| `dependency_cycle`       | Graph 给出 Cycle Path 且无拓扑发布顺序        | Unit       |
| `published_update`       | Published Revision Patch 返回 `INVALID_STATE` | PostgreSQL |
| `role_overreach`         | Resource Role 不能扩大 Project Role           | Unit       |
| `partial_publish`        | 八个 Publish 故障点全部回滚                   | PostgreSQL |
| `breaking_upgrade`       | Upgrade 拒绝且不新增 Release                  | PostgreSQL |
| `secret_material`        | Private Key/Token 被检出且原值不进入报告      | Unit       |

审计结果固定为 7/7，Catalog 和 Source Evidence 分别生成 SHA-256；删除用例、重复 Marker、移出 Gate 或改 ID 都失败。

## 4. 两 Package、兼容向量与 Provenance

新增两份可重复生成的 metadata-only Package：

- `fixture.commerce` / `Order`；
- `fixture.work` / `WorkItem`。

生成器从冻结 G1 Package 的 Namespace 和来源 Hash 派生稳定 ID、Manifest、Object Content 与 Digest，再用生产 `preparePackageCandidate` 和完整性校验复验。两份 Package 只含激活的 `object_type` Family，不含 Action、Policy、View、Migration、Raw SQL 或 Secret。

`provenance.json` 新增 `metadataPackages` Group，G1 总指纹仍是 `sha256:dff360...aa1`，Group 数由 6 增至 7；正式目标文件的字节 SHA-256 受审计。8 个 Package Compatibility Vector 另有独立 SHA-256，并进入 Metadata Fixture Artifact。

## 5. 不可伪造的 Metadata Evidence

`security/g2-01-evidence-policy.json` 固定：

- G2-01-01～11 共 11 份 PASS Evidence；
- 两个 Metadata Package、一个兼容向量、七个负向 Fixture；
- 21 个必须且只能成功一次的 Gate 名称；
- Owner 和 4 项未关闭风险；
- 13 份 G2-00 历史 Evidence 的逐文件 SHA-256。

`metadata-acceptance.json` 只接受同一次运行生成的 PASS Foundation、Fixture 和 Negative Artifact。`metadata-evidence-manifest.json` 再绑定 Commit、Dirty/Clean、Node/npm/Docker/PostgreSQL、Lock/Migration/Contract/Fixture Hash、Test Count、逐 Gate 结果、Artifact、Scope、Owner 和风险。单元反例将一份历史 G2-00 Evidence Hash 改为另一个值，G2-01 必须 FAIL。

开发工作树即使全绿也只标记 `WORKTREE_PASS`；只有干净 Clone、全部 21 Gate 成功且 Commit 一致才能标记 `CLEAN_ROOM_PASS`。

## 6. 可复现执行

```text
npm run test:unit                        PASS — 281/281
npm run test:admin-api                   PASS — 6/6（沙箱外回环端口）
npm run check:contracts                  PASS — 11 foundation / 12 metadata / 66 golden
npm run check:architecture               PASS — 7 packages / 42 source files
npm run check:testkit-provenance         PASS — 47 G1 inputs / 7 groups
npm run check:metadata-fixtures          PASS — 2 packages / 8 compatibility cases
npm run check:metadata-negative-fixtures PASS — 7/7
npm run verify                           PASS — 21/21 Gate / 292 Tests / 34,629 ms
```

完整 `npm run verify` 已在沙箱外通过：PostgreSQL `server_version_num=160014`，角色提升被阻断，供应链 0 Vulnerability，生产边界 OIDC/S3/PostgreSQL/OTEL 全部探活并完成 Teardown。开发工作树 Manifest 正确标记为 `WORKTREE_PASS`；远端 Required Check 在 PR Head 的干净 Checkout 使用同一脚本复验并绑定最终 Commit。

## 7. 剩余边界

- G2-01-12 仍须从全新 Clone/空库用真实 HTTP 串起 Project、Resource、Release、Package、兼容/阻断/回滚、重启、二次 Migration 和越权矩阵；
- 本 Gate 证明统一验收机制可信，不用单项测试冒充总产品闭环；
- OIDC/JWKS 运维、Principal 发现体验、生产备份/PITR/HA 和 DB-02 身份保持仍由 Manifest 中明确 Owner 的后续 Gate 负责；
- 当前进度为 **11/12**，还剩 **1 项**。
