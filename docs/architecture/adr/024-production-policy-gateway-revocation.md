# ADR-024：生产 Policy Gateway、精确 Artifact 与五秒撤权

- 状态：Accepted for G2-03-06；只有同一 Commit 的完整 Gate 通过才具有交付资格
- 日期：2026-08-20
- 决策范围：`policy-domain`、`policy-application`、`policy-postgres`、`object-store-s3` 与 Migration `0027`
- 上游：[ADR-012](012-policy-epoch-cache-fail-closed.md)、[ADR-020](020-query-policy-identity-consumer-boundary.md)、[ADR-022](022-runtime-identity-claim-mapping-delegation.md)、[ADR-023](023-policy-resource-compiler-release-gate.md)

## 1. 决策

G2-03-06 将 ADR-012 的内存 Harness 语义迁入正式 Package，并只保留一条 Runtime 授权路径：

```text
RuntimeIdentityContext
  → PolicyGateway.authorize
  → 一个 REPEATABLE READ READ ONLY PostgreSQL Snapshot
  → Project / Resource Role + Principal / Service Profile + Epoch
  → 精确 Release / Policy Revision / Compiler / Artifact Digest
  → S3 内容寻址 Artifact 读取、摘要与严格合同复核
  → 最长 5 秒进程内决策缓存
  → bounded PolicyGatewayContext
```

Gateway 的 `ALLOW` 只表示调用方可以进入该 Resource 的 Policy 计算，并已获得精确、可信、可下推的 Policy IR Context。它不是业务 Object、Property 或 Link 的最终 Allow。G2-03-07～10 必须把该 IR 与 Query AST 一起编译进 SQL，并在 `ORDER BY`、`LIMIT`、`COUNT` 和序列化前执行；没有匹配 Rule 仍默认 Deny。

生产代码不得导入 `tools/policy-epoch`。旧 Harness 只保留历史语义与回归向量，正式实现由 `@ontos/policy-application` 的唯一 `PolicyGateway` Port、`@ontos/policy-postgres` Snapshot/Notification Adapter 和已有 `S3PolicyArtifactStore` 组成。

## 2. 请求、身份与权限交集

Gateway 只接受 G2-03-04 已建立的 `RuntimeIdentityContext`，不接受 Bearer、Raw Claim、Subject Header、Delegation Credential、客户端 Principal ID 或 `internalAllow`。Application 重新核对：

- `identity.actor + delegationChain` 与 `authorizationPrincipalIds` 完全同序、唯一；
- Identity、Delegation、Claim、Capability 与映射后 Attribute 进入确定性、有界 Fingerprint；
- PostgreSQL Snapshot 中每个 Principal 仍为 Active；每个 Service Profile 仍为 Active 且仍允许请求 Permission；
- Human、Service 与 Delegated 请求都复用 Identity Domain 的 Principal Permission 交集，缺一个 Principal 或一份 Grant 即 Deny。

G2-03-06 只激活 `object.read` 粗粒度 Resource Permission。Project Role `owner|editor|viewer|executor` 可以进入 Object Policy；`auditor` 不自动进入当前业务 Object Read。可选 Resource Role 与 Project Role 取交集，只能收窄；未知 Permission 一律 Deny。Owner/Editor 的粗粒度资格不等于读取业务数据，Policy IR 仍可以并默认会拒绝 Object/Property/Link。

Action、Function、历史审计和管理权限由其拥有 Gate 显式扩展，不在本项用任意字符串预授权。

## 3. 同一 PostgreSQL Snapshot

Migration `0027_policy_gateway_runtime.sql` 提供一个最小权限 `SECURITY DEFINER` Resolver。Adapter 在一个 `REPEATABLE READ READ ONLY` 事务内调用一次，并同时取得：

- Project Authorization Epoch 与 `transaction_timestamp()`；
- 输入顺序中每个 Principal 的 Type、State、Project/Resource Active Role；
- Service Profile State 与 Capability；
- Resource/Release 的 Project、状态和精确 Release Pin；
- Passed Policy Compilation 的 ID、Policy Resource/Revision、Compiler Version 与 Artifact Digest。

输入 Principal 数必须为 `1..16`、UUID 唯一；Project、Resource、Release、Policy Revision 与 Compiler Version 必须精确匹配。Project 已归档、Resource 已归档、Release 非 `published|superseded`、目标不在 Release、Compilation 缺失或任一身份事实不完整时 Resolver 不返回可确认快照，Gateway fail closed。

Resolver 是 Runtime 唯一授权快照接口；不新增裸 Binding Reader、裸 Current Reader、按 API Name 查“最新”或第二套 Policy Compilation 真相。

## 4. 决策键与 Policy Context

缓存完整键包含：

- Project；
- Identity Fingerprint；
- Delegation Fingerprint；
- Resource 与 Permission；
- Release；
- Policy Revision；
- Compiler Version；
- Authorization Epoch。

成功 Context 只暴露后续 Query Compiler 必需的精简事实：目标 Resource/Revision、Release、Policy Resource/Revision、Compilation、Compiler、Artifact Digest、Policy Rules、受信 Actor Attribute、Epoch 与 `policyContextHash`。它不携带 Bearer、Raw Claim、Subject、Delegation Credential、SQL、Property Value 或数据库 Role 明细。

Artifact 只能按 Snapshot 返回的 Digest 读取。Application 在 S3 的 Media Type/Digest 防线之外再次执行：大小上限、JSON 严格解析、规范字节复算、嵌入 Digest、Project/Release/Policy Revision/Compiler 的精确绑定。缺失与不可用使用不同稳定失败码，但都只返回 Deny；不查询 latest、不回退旧 Revision、不跨 Release 复用。

## 5. 五秒硬 TTL 与通知

每个进程使用注入的单调时钟。配置 TTL 必须为正且 `<=5,000ms`；成功完成 Snapshot、Artifact 和决策后才记录：

```text
expiresAt = confirmedAtMonotonic + configuredTtl
```

`now >= expiresAt` 即失效。Cache Hit、重复访问、依赖错误、通知丢失或重连都不修改原 `confirmedAt/expiresAt`。缓存有总条目上限；驱逐只降低命中率，不改变安全语义。进程重启从空缓存开始。

单调时钟回退、非有限值、负值或溢出会清空整个进程缓存，并使该进程永久 fail closed，等待新进程代际接管。

`PostgresPolicyEpochListener` 使用专用连接监听 `ontos_authorization_epoch_v1`。更高 Epoch 提升 Project Floor 并清除该 Project 缓存；重复/乱序旧值忽略；跳变允许；数据库随后读到低于 Floor 的 Epoch 时返回 `POLICY_EPOCH_UNCONFIRMED`。Listener 断线重连不重置 Floor。NOTIFY 永远只是提前失效 Hint；没有 Listener 的进程仍由硬 TTL 保证提交后最迟五秒重读。

## 6. 结果、失败与 Telemetry

稳定失败码沿用 ADR-012：

- `POLICY_INPUT_INVALID`；
- `POLICY_EPOCH_UNAVAILABLE`；
- `POLICY_EPOCH_UNCONFIRMED`；
- `POLICY_ARTIFACT_NOT_FOUND`；
- `POLICY_ARTIFACT_UNAVAILABLE`；
- `POLICY_MONOTONIC_CLOCK_UNSAFE`；
- `POLICY_INTERNAL_FAILURE`。

普通授权不足是无内部原因的 `DENY`；依赖或一致性不确定是 `FAIL_CLOSED` Deny。Telemetry 与授权返回解耦，观察器失败不能改变决定。事件字段严格限制为固定事件名、服务端 Correlation Ref、不可逆 Project Ref、Decision Code、延迟和 Cache Outcome；禁止 Subject、Claim、Token、Principal、Predicate、Property Value、SQL、Stack 与原始依赖错误。

## 7. 双进程与故障验收

同一真实 PostgreSQL 16、版本化 S3 和 Published Release 上启动两个独立 Gateway/Listener 实例，覆盖 Human、Service、Delegated 三类向量：

- 正常通知：撤权提交后的下一请求全部拒绝；
- 一个进程丢失通知：`4,999ms` 内允许命中原缓存，`5,000ms` 边界强制重读并拒绝；
- 重复、旧值、跳变、Listener 停止/重连不使旧 Allow 复活；
- Binding、Principal、Service Profile、Artifact、Snapshot、Compiler 和 Clock 故障全部 fail closed；
- Snapshot 与 Epoch/Artifact 绑定错误、跨 Project/Release/Resource、旧 Policy 或伪造 Digest 均不能产生 Context；
- Telemetry 与结果中不出现受禁字段。

## 8. 被否决的方案

- 直接把 `tools/policy-epoch` 当生产 Package：身份和 Artifact 模型已过时，且会让生产依赖测试代码；
- Identity、Binding、Epoch 和 Compilation 各用独立事务读取：并发撤权会组合出不存在的 Allow；
- 只依赖 NOTIFY：断线或启动窗口可让旧 Allow 永久存在；
- stale-while-revalidate、错误续期或回退旧 Artifact：会把五秒上界变成无界旁路；
- Endpoint 直接读取 Binding/Current 或提交 `internalAllow`：会形成第二授权入口；
- 在本项提前实现 Query SQL、HTTP、Action/Function 或 UI：分别属于 G2-03-07～13 与 G2-04。

## 9. 后续

G2-03-06 通过后只放行 G2-03-07。后者消费 `PolicyGatewayContext` 的 Rules/Actor Attribute/Epoch/Context Hash，构建 typed Query AST 与参数化 SQL；G2-03-11/12 再用真实入口 Mutation Gate 证明 Route、SDK、Function/Action Harness 均不能绕过 Gateway。
