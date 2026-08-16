# G2-02-13 Admin API、Testkit 与统一 CI Evidence

- 日期：2026-08-17
- 结论：**PASS**（仅代表 G2-02-13 生产边界闭环与统一 Gate；不代表 G2-02-14 clean-room 总验收或完整产品已完成）
- 任务合同：[G2-02 Materialization 任务包 § G2-02-13](../delivery/g2-02-materialization-task-pack.md#g2-02-13接入-admin-apitestkit-与统一-ci-gate)
- 一致性复审：[Intent 对照](../reviews/g2-02-13-intended-vs-implemented.md)
- 专项红队：[G2-02-13 Red Team](../reviews/g2-02-13-admin-testkit-ci-red-team.md)

## 1. 实际交付

| 边界       | 已实现                                                                                                                                | 明确不做                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Admin HTTP | 上传会话/字节上传/Finalize、Snapshot/Group 查询、Job 启动/状态/取消、Report、Activate/Refresh、行数确认、容量/审批、GC Dry-run/Commit | Query、Action、UI、SDK                         |
| 身份与授权 | 真实 OIDC JWKS 验签、Foundation Identity、ManagementAuthorizer 决策、Project 同形拒绝                                                 | Application/Worker 不接收 Bearer 或原始 Claims |
| Worker     | `worker:start` 使用正式组合根串联 Scan→Map→Validate→Build Stage→Build Index→Ready→Catch-up→Activate                                   | 不使用测试 Stage Adapter 代替生产组合          |
| 数据边界   | PostgreSQL 16、开启 Versioning 的 SeaweedFS S3、独立 DDL LOGIN、API/Worker 最小角色                                                   | API/Worker 不持有 Migration Owner 或 DDL 权限  |
| Testkit    | Commerce 与 Work Management 两个领域，各 2 Object + 1 Link；4 类反例；100k/1m 流式生成；W0/W1 对抗 Port                               | 不将 1m Link 大文件常驻仓库或本机磁盘          |
| 统一 Gate  | `npm run verify` 保留 G2-00/G2-01 所有 Gate，新增 Fixture、生产闭环、Scope/Evidence，总计 31 个顺序 Gate                              | 不允许单独脚本绕过历史验收                     |

## 2. 产品边界闭环

```text
OIDC Owner / Editor
  → Admin HTTP 严格输入与 Project 授权
  → 受管 S3 Upload + 服务端 SHA-256 Finalize
  → PostgreSQL Snapshot Group + 持久 Job
  → worker_runtime 八阶段租约/检查点执行
  → 独立 DDL Executor 执行受信 Index Plan
  → 不可见 Generation + 质量/容量证据
  → Owner Activate
  → 不可变 Activation + Serving Head
```

真实组合测试在 Owner 激活前读到的 Serving Pointer 数为 0；八阶段全部完成后由 Owner 激活，最终 Job=`succeeded`、Release=`published`、Serving Head=1。上传字节串流不经过 2 MB JSON Body。

## 3. 授权、输入与错误

- Owner 独占 Activate/Refresh、容量审批和 GC Commit；Editor 可上传、Finalize、启动/取消 Job 并读取 Project 状态；Viewer 只读。
- Executor/Auditor 名称不导出隐式管理权；无成员身份、跨 Project ID 与不可见资源返回同形拒绝。
- JSON Body、字符串、数组、嵌套深度和未知字段都有上限；写请求绑定 Idempotency Key 或强 CAS/ETag。
- HTTP Error Envelope 只包含稳定 Code、Correlation 和有界可修复信息；SQL、表名、Object Key/Version、Presigned URL、Secret、PK 和错误行内容不进入响应。

## 4. Testkit 与反例

- Fixture 语义 Digest：`sha256:b516136d11968f9f75ed1af0d26e9f1cc760dcd065fb1ca4a6cd807f5f8860bf`
- Benchmark 流 Digest：`sha256:4cf9491ef477c7c98c9fba693dd3028100cc7f419bf8f7c53eac1fd1d6328446`
- 反例：未闭合 CSV 引号、Primary Key 冲突、Required Link 悬空、质量阈值超限。
- W0/W1 Fixture 明确标记 `ADVERSARIAL_TEST_ONLY` 与 `productionOverlayClaim=ZERO_ONLY`；真实 PostgreSQL Overlay Store 仍由 G2-04 负责。

## 5. CI 机器证据

`npm run verify` 在每次运行前清空 `generated/ci-report`，顺序执行 31 个 Gate，最后绑定 Git Commit、Migration/Contract/Fixture Digest、容器镜像、测试数和产物 Hash。关键产物：

- `materialization-fixtures.json`
- `materialization-production.json`
- `materialization-mutations.json`
- `materialization-acceptance.json`
- `materialization-evidence-manifest.json`
- 历史 `foundation-*` 与 `metadata-*` 产物

八个 Mutation Guard 分别绑定 OIDC、Migration、Job Fencing、Staging Visibility、Plan Digest、Capacity、Cutover Atomicity 和 Scope 的可执行测试；删除标记、断开 npm 路由或改变保护语义均使统一 Gate 失败。

## 6. 可复现命令

```text
npm run check:materialization-fixtures
npm run test:materialization:production
npm run check:materialization-evidence
npm run verify
```

生产闭环已在 Ubuntu 24 / x86_64 / 8 vCPU / 15 GiB / Node 24.18.0 / Docker 29.7.2 的专用 Runner 上，使用固定 PostgreSQL 16 和 SeaweedFS S3 镜像通过。统一 Gate 的终局以机器 Manifest 为权威，不以本文截图或手工描述替代。

## 7. 非结论与下一项

- G2-02-13 证明小 Fixture 的真实生产边界闭环，不代替 G2-02-14 的独立 Clone、空卷、整体重启和 100k/1m 端到端性能。
- Query Resolver、Policy、Action/Overlay、UI 与 SDK 都未实现，也不在本 Gate 的放行范围。
- 运维备份/恢复、HA 与告警不是 G2-02-13 生产可用性结论。

因此下一唯一允许项是 **G2-02-14：clean-room Materialization 总验收**。
