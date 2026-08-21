# ADR-026：Runtime Query Execution Context、Metadata 与 Object Get

- 状态：Accepted for G2-03-08
- 日期：2026-08-21
- Owner：Query / Metadata / Runtime / Security（accountable: `wyd-git`）
- 依赖：[ADR-007](007-runtime-activation-serving-head.md)、[ADR-019](019-generation-index-mark-plan-commit-gc.md)、[ADR-020](020-query-policy-identity-consumer-boundary.md)、[ADR-021](021-query-policy-persistence-boundary.md)、[ADR-024](024-production-policy-gateway-revocation.md)、[ADR-025](025-typed-query-ast-parameterized-postgres-compiler.md)
- 决策范围：G2-03-08 的 Release/Channel 解析、原子 Query Lease、租约门控 Current、策略感知 Runtime Metadata 与 Activation-aware Object Get

## 1. 决策结论

G2-03-08 建立第一条正式 Runtime 读用例链：

```text
explicit Release / stable Channel
→ one-snapshot candidate (Release + Activation + Runtime Plan + Generation + Definition + Policy Artifact)
→ production Policy Gateway
→ typed Query / Metadata policy plan
→ atomic candidate revalidation + committed Query Lease / GC Root
→ transaction-local lease activation
→ lease-gated Current view + parameterized PostgreSQL query
→ contract parser / serializer second defense
→ Lease release or database-time expiry
```

候选上下文不是读权限。只有生产 Policy Gateway 已返回精确绑定的决策、数据库在同一语句中重新确认 Serving Activation、Generation Set、Policy Compilation 和 Authorization Epoch，并成功提交 Query Lease 后，Repository 才能读取 Current。

## 2. 一次请求的不可变上下文

`runtime.resolve_query_context_candidate` 在一个 PostgreSQL MVCC Snapshot 中最多解析一次以下事实：

- Project 与显式 Release 或 `stable` Channel；
- Release Revision（P0 与不可变 Release ID 一一对应）、Serving Activation 和 Runtime Plan Digest；
- Activation 的全部 1～256 个 Generation Member；
- 每个 Member 的精确 Resource、Published/Deprecated Revision、Generation 和不可变 Definition；
- Release Pin 的精确 Passed Policy Compilation、Artifact Digest 与 Compiler Version；
- 数据库请求时间和确定性的 Generation Set Digest。

Application 不在后续步骤重新查询“最新”Release、Activation、Revision 或 Generation。`runtime.commit_query_execution_context` 用既有 Query Lease Plan/Commit 接缝，在一个数据库语句内比较候选 Activation、Generation Set、Policy Compilation 与当前 Authorization Epoch；任一漂移返回 `QUERY_CONTEXT_CHANGED`，且不遗留 Planned/Committed Lease。

## 3. Release 支持窗口与退役

ADR-007 已冻结 Published Release 至少 90 天的显式服务窗口，但旧 Schema 只有 `published_at`，无法安全判断何时允许移除 Serving Head。`0028_runtime_query_context.sql` 因此新增：

- `meta.releases.support_until`：发布后不可变，且不得早于 `published_at + 90 days`；
- `meta.retire_release_serving_head`：只允许已 Superseded、超过支持期限、无 Channel 引用且控制序列匹配的 Release 显式退役；
- 显式 Release 在 Serving Head 存在时继续使用自己的 Activation；Serving Head 已退役时返回 `RELEASE_RETIRED`，绝不回退到 `stable`。

历史 Release 的前向升级先建立 `NOT VALID` 约束，再回填支持期限、清空既有延迟 Trigger 事件并 Validate；因此空库和已有 Published/Superseded 数据的库使用同一个 `0028`，不需要重写历史 Migration 或停用完整性 Trigger。

支持期限是最早可退役时间，不是自动切断时间。自动按墙钟移除服务会把运维事故伪装成生命周期语义，因此退役必须是显式、受控、CAS 保护的控制面操作。

## 4. P0 Policy Artifact 组合规则

P0 每个 Release 只接受一个 Release-wide Runtime Read Policy Artifact。解析器要求恰好一个 Policy Pin 和一个精确 Passed Compilation；零个或多个都 fail closed 为 Policy unavailable。

这是有意的范围约束，不是按 `pin_order` 隐式选一个 Artifact。多 Artifact 的 deny 优先级、Property mask 合并、测试向量组合与 Policy Context Hash 都需要单独的公开组合合同；在该合同冻结前不得猜测顺序或只应用部分策略。

## 5. Query Lease 与数据库读取能力

Query Lease 在 Current 读取前持久提交，并把全部 Generation 写入既有 `runtime.query_lease_generations` 与 G2-02 GC Root Provider。读取事务调用 `runtime.activate_query_read_context` 验证：

- Lease 已 Commit、未过期且 Generation 数完整；
- Project、Release、Activation、Identity Hash、Policy Context Hash、Query Hash 全部精确一致；
- 验证成功后才设置 transaction-local Project 与 Query Context。

`runtime.query_object_current` 和 `runtime.query_link_current` 是 `security_barrier` View，只返回该事务已激活 Lease 的 Generation。`api_runtime` 没有裸读 `runtime.object_current`/`runtime.link_current` 的权限；Worker、Ops 和 PUBLIC 也不能调用 Resolver/Commit/Activate 或读取门控 View。

正常完成、对象不存在、取消、超时和失败都在 Application `finally` 终结 Lease。进程被 Kill 时无法运行 `finally`，Lease 依靠数据库时间过期，再由既有 Worker `expire_query_leases` 回收 GC Root。

## 6. Runtime Metadata 与 Object Get

Runtime Metadata：

- 对同一候选 Registry 中的 Object 以最多 8 个并发调用生产 Policy Gateway；
- 只返回当前 Actor 有 Object allow 规则的 Published Object；
- Property 按 allow/mask/restricted 暴露，mask/restricted 移除 Filter/Sort/Search 能力；
- Link 只有两端 Object 均可发现、Link Resource 也通过同一生产 Gateway 且精确 Link allow 规则存在时出现；Object 与 Link 的全部 Gateway 决策共同绑定 Lease Policy Context Hash；
- 不返回 Policy AST、SQL、规则 Trace、隐藏 Resource 数量或内部 ID。

Object Get：

- 使用公共 Value Codec 生成 Canonical Primary Key；
- SQL 精确绑定 Project、Lease Generation、Object Resource Revision 和 Active Lifecycle；
- 不存在与不可见都返回同形 `OBJECT_NOT_ACCESSIBLE`；
- PostgreSQL 只返回 `value|null|missing|masked|restricted` 中间态，Serializer 再对照 Policy Plan 拒绝多列、额外字段、受限原值、非法状态和无界响应；
- `objectVersion` 取与当前 Generation、Revision、Object RID 和 Base Digest 精确匹配的不可变 Head Version；G2-04 在写入时继续负责 Overlay 与 Version Recheck。

## 7. 并发与失败语义

候选解析后的 Cutover、Refresh、Policy/Epoch 变化只能产生两种结果：

1. 原候选仍可原子提交，整个请求读取同一旧 Activation/Generation/Policy Context；
2. 提交前比较失败，明确返回 `QUERY_CONTEXT_CHANGED`，且没有可读 Lease。

已 Commit 的事务使用精确 Generation 和租约门控 View，不会在 SQL 中途切换到新代。Release Retire 同样不能把显式请求静默改成 Channel 请求。数据库/Repository/合同异常返回 `QUERY_EXECUTION_FAILED`；Policy Gateway 或 Policy IR 无法确认返回 `POLICY_EVALUATION_UNAVAILABLE`，不能伪装成对象 404。

## 8. 范围与后续

本项明确不实现：

- Runtime HTTP Route、OIDC Scope Adapter、OpenAPI 发布或 Generated Client 调用；
- Search、Count、签名 Cursor、一跳/二跳 Link 产品用例；
- UI、Action、Overlay、ChangeSet、Outbox 或完整 Audit；
- 多 Policy Artifact 组合、跨请求 Snapshot Lease 或自动延长 Allow。

G2-03-08 通过后只放行 G2-03-09。后续用例必须复用本 ADR 的 Resolver、原子 Lease Commit、门控 Repository 与 Serializer 边界，不能另建“最新 Generation”查询或裸表旁路。
