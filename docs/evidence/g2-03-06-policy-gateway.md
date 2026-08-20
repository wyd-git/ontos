# G2-03-06 生产 Policy Gateway 与五秒撤权 Evidence

- 日期：2026-08-20
- 结论：**PASS**
- 任务合同：[G2-03-06](../delivery/g2-03-query-policy-task-pack.md#g2-03-06实现生产-policy-gateway-与-5-秒撤权)
- 架构决策：[ADR-024](../architecture/adr/024-production-policy-gateway-revocation.md)
- 资格入口：`npm run verify`

## 1. 交付结论

G2-03-06 已将 ADR-012 的语义 Harness 落成正式生产分层：

```text
RuntimeIdentityContext
  → ProductionPolicyGateway
  → PostgresPolicyGatewayRepository
  → 单次 REPEATABLE READ READ ONLY Snapshot
  → 精确 Release / Policy Revision / Compiler / Artifact Digest
  → S3PolicyArtifactStore
  → 最长 5,000ms 单调时钟 Cache
  → bounded PolicyGatewayContext
```

Gateway 的 `ALLOW` 仅代表身份可以进入该 Object 的 Policy 计算，并获得了精确、可下推的 IR Context。它不等于业务 Object/Property/Link 最终放行；最终行谓词、属性遮罩和 Link 约束由 G2-03-07～10 在分页、Count 和序列化前执行。

## 2. 正式实现

- `packages/policy-domain/src/gateway.ts`：只激活 `object.read`，Project Role 与可选 Resource Role 取交集，Resource Role 只能收窄。
- `packages/policy-application/src/gateway.ts`：唯一 `PolicyGatewayPort`、Human/Service/Delegated Principal 交集、完整缓存键、精确 Artifact 复核、5 秒硬 TTL、fail closed 和脱敏 Telemetry。
- `packages/policy-postgres/src/gateway.ts`：同一 MVCC Snapshot Repository 和使用专用连接的 `LISTEN ontos_authorization_epoch_v1` Listener。
- `migrations/db-00/0027_policy_gateway_runtime.sql`：只向 `api_runtime` 授权的有界 Resolver，不新建 Principal、Binding、Epoch、Release 或 Policy 真相表。
- 已有 `S3PolicyArtifactStore`：只按 Snapshot 返回的 Digest 读取，并在 Application 再次校验规范字节、自摘要、Project、Release、Policy Revision、Compiler 和直接 Object Target。

## 3. 真实环境验收

`tools/policy-compiler/integration/postgres-s3-release.test.ts` 在同一次 PostgreSQL 16 + 开启 Versioning 的 S3 环境中同时生成 G2-03-05 和 G2-03-06 Artifact，避免重复启动两套重型环境。同一 Commit 的 `g2-03-06-policy-gateway.json` 必须证明：

- Migration `0027` 故障时整体回滚，历史 26 个 Migration 不漂移；
- `api_runtime` 能执行有界 Resolver，`worker_runtime` 和 `read_only_ops` 均被数据库拒绝；
- 跨 Resource、Release、Policy Revision 和重复 Principal 不能产生 Snapshot；
- 两个独立 Gateway/Listener 对 Human、Service、Delegated 全部得到一致结果；
- 正常 NOTIFY 时，Binding/Profile 撤权提交后下一请求拒绝；
- 一个进程丢失 NOTIFY 时，`4,999ms` 内仍可命中原缓存，`5,000ms` 边界强制重读并拒绝；
- Listener 停止后可重启；真实终止其 PostgreSQL Backend 后会自动建立新连接，且不重置 Gateway 的 Epoch Floor；
- 真实 S3 中删除精确 IR Object 后只返回 `POLICY_ARTIFACT_NOT_FOUND` Deny，不回退旧 Artifact。

## 4. 单元、性质与故障测试

`tools/policy-gateway/` 额外固定：

- 所有 `1..5,000ms` 可配 TTL 均在到期边界含等号失效，命中不滑动续期；
- 重复、乱序、旧值和跳变 Epoch 只能单调提高 Project Floor；
- 决策键每个维度独立变化都会改变序列化结果；
- Snapshot、Artifact、Epoch、依赖和单调时钟异常全部 fail closed，错误不会续期旧 Allow；
- Telemetry 字段集精确且不含 Principal、Subject、Claim、Token、Predicate、Property Value、SQL 或依赖错误。

## 5. CI 资格与优化

完整 Profile 现为 43 道 Gate，Draft Preflight 为 40 道。G2-03-06 没有另起第二套 PostgreSQL/S3 重型 Gate；它复用 `policy-compiler-postgres` 的同一 Release/Artifact 环境，再由 `g2-03-06-policy-evidence` 校验当次 Artifact、源码 Marker、Scope 和 Commit 绑定。

只有 `report.json` 中所有 43 道 Gate 各且只 PASS 一次，工作树干净，Acceptance 和真实 Gateway Artifact 与同一 Commit 一致时，`g2-03-06-evidence-manifest.json` 才是 `CLEAN_ROOM_PASS`。

## 6. 未扩展范围

本项没有创建 Query AST/SQL、Runtime HTTP Route、SDK、Function/Action 入口或 Web 页面，也没有将 `tools/policy-epoch` 当成生产代码。下一唯一放行项是 **G2-03-07：typed Query AST 与参数化 SQL Compiler**。
