# ADR-021：Query / Policy 持久事实、授权 Epoch 与 Query Lease 边界

- 状态：Accepted for G2-03-03
- 日期：2026-08-18
- 决策范围：Migration `0022`～`0024`、数据库角色、RLS、授权变更事务与 GC Root
- 上游：[ADR-012 Policy Epoch](012-policy-epoch-cache-fail-closed.md)、[ADR-019 Generation/Index GC](019-generation-index-mark-plan-commit-gc.md)、[G2-03 Runtime Read 合同](../g2-03-runtime-read-contract.md)

## 1. 决策

G2-03 的 Identity、Policy Compilation 和 Query Lease 使用现有 `migrations/db-00/` 单一只向前账本，不创建第二套身份、发布、Generation 或 GC 真相。`0001`～`0021` 不改字节，新增内容拆为三个可独立回滚的事务 Migration：

1. `0022_query_policy_identity_facts.sql`：给历史 Principal 回填不可变 `human` 类型；新增版本化 Claim Mapping 与不可变 Policy Compilation/Test 事实；扩展 Policy Resource 的校验和依赖词汇；
2. `0023_query_lease_gc_boundary.sql`：新增有界 Query Lease、完整 Generation 成员快照、受控状态函数，并激活既有 `runtime.query-lease` GC Provider；
3. `0024_query_policy_authorization_boundary.sql`：新增事务去重的 Authorization Epoch 推进事实、事务型通知、Claim Mapping/Policy Compilation 受控函数和脱敏运维 View。

这三个 Migration 只建立后续 Runtime 必需的持久事实和最小权限，不在数据库中提前实现 JWT 验证、Policy AST Compiler、Query SQL Compiler、HTTP Endpoint 或 UI。

## 2. 身份事实

`authz.principals.identity_type` 只能是 `human|service`。历史行和未显式声明的新行安全落在 `human`；身份类型创建后不可原地修改，因此不能把已有 Human 提升成 Service，也不能用同一 `(issuer, subject)` 伪造第二个类型。

Claim Mapping 采用“不可变 Revision + 单调 Head”模型：

```text
(project, issuer, identity type)
  → claim_mapping_head(control_sequence)
  → immutable claim_mapping_revision(digest, bounded JSON)
```

Revision 以 Project、Issuer、Identity Type、Revision Number 和 Digest 约束；Head 只能切到同一复合身份下的 Revision，且每次切换必须 CAS 推进 `control_sequence`。原始 Bearer Token 和 Raw Claims 不进入这些表。

## 3. Policy Compilation 事实

`authz.policy_compilations` 是编译与测试结果账本，不复制可编辑 Policy 正文。每条记录同时绑定：

- Project、Published/Superseded Release；
- Release Pin 中的 Policy Resource/Revision/Content Digest；
- Compiler Version；
- 独立的 Policy IR Artifact 与 Test Report Artifact/Digest；
- 有界 Test Vector 总数、通过数、失败数和一致的最终状态。

Artifact Source 必须分别是同一 Compilation ID 的 `policy_compilation` 与 `policy_test_report`，写入后不可更新、删除或截断。Runtime 只能解析 `passed` 结果。G2-03-03 的 `policy-g2-03-v1` 只允许零依赖 Policy 持久化；正式依赖图和编译语义在 G2-03-05 激活，在此之前复杂 Policy fail closed。

## 4. Query Lease 与 GC

Query 在读数据前必须执行两阶段协议：

```text
plan(real serving activation + passed policy + current epoch)
→ persist every active, uncollected activation member
→ commit
→ execute read
→ bounded heartbeat when needed
→ release; or worker expiry
```

Lease 固定 Release、Activation、完整 Generation Set、Policy Compilation/Artifact、Authorization Epoch、Identity/Policy/Query Hash 和 Correlation ID。Generation 数必须与真实 Activation 的 `member_count` 完全相等，不能只租一部分可用成员。最大寿命从获取时起固定为 120 秒，Heartbeat 不能越过该上限。

只有 `committed` 且未过期的 Lease 成为 GC Root。`planned`、`released`、`expired` 均不保护 Generation；释放或过期后事实仍保留用于恢复与审计，但 Root 立即消失。Lease 变化沿用 G2-02 的 GC 串行锁和 Root Digest，Provider 缺失、版本错或扫描不完整时仍然无候选。

Cursor 不是 Lease。下一页必须重新授权并创建新的请求 Lease，不能用 Cursor 延长旧 Allow。

## 5. Authorization Epoch 事务

所有受支持的有效授权变化通过 `authz.advance_authorization_epoch(project, expected_epoch)` 推进 Epoch。`ops.authorization_epoch_advances` 使用 `(project_id, transaction_id)` 去重，保证同一 Project 在一个数据库事务内无论触发多少相关事实，只推进一次。Epoch 更新后的 `pg_notify('ontos_authorization_epoch_v1', ...)` 与事务同生共死：回滚时既没有新事实，也没有可见通知。

本 Migration 已接入：

- Active Role Binding 新增或状态变化；
- Principal 从 Active 变为 Disabled 时，其所有 Active Project；
- Claim Mapping Head 首次激活或切换；
- Metadata Release/Package 既有 Repository 原先的直接 Epoch Update。

`api_runtime` 不再拥有 Epoch 列直写权限。既有 Metadata 事务需要的行锁改由 `lock_authorization_epoch` 受控函数取得，保留原并发顺序而不恢复裸写能力；Epoch 推进记录本身对 Owner 也不可改写。

## 6. 权限与 RLS

- `api_runtime` 只能执行 Claim Mapping、Policy Compilation 和 Query Lease 的受控函数；不能裸读/写新事实表，不能直接推进 Epoch 列；
- `worker_runtime` 只额外获得有界 Lease 过期函数，不获得业务 Object、Policy 或 Identity 读权限；
- `read_only_ops` 只能读取聚合的 Epoch/Lease/GC 运维 View，不能读取 Policy Compilation 或 `runtime.object_current`；
- 三类 Runtime 角色均不是 Owner/Migration 成员，也不能绕过 RLS；
- 新租户事实表全部 `ENABLE` 且 `FORCE ROW LEVEL SECURITY`。`ontos.project_id` 只是可信 Repository 的纵深隔离上下文，不是面向最终用户的授权机制；用户授权仍由 G2-03-04～07 的 Identity/Policy/Query 层完成。

## 7. 被否决的方案

- **应用内存 Lease**：进程崩溃后 GC 看不到仍在读取的 Generation，否决；
- **Cursor 兼任 GC Root**：客户端可离线持有且授权会变化，会无限延长旧上下文，否决；
- **在 Release 中直接存可变编译结果**：会破坏 Revision/Artifact 审计和复现，否决；
- **直接更新 Epoch 并另发消息**：数据库提交与通知可能分裂，否决；
- **给 API/Worker 表级通配权限**：无法证明最小权限和 Project 隔离，否决；
- **修改历史 Migration**：会破坏已部署账本 Hash，否决。

## 8. 后果与后续 Gate

G2-03-03 关闭了“是否能安全持久化”的风险，但没有宣称 Runtime Read 已可用：

- G2-03-04 实现真实 OIDC、Claim Mapping 求值和 Delegation 交集；
- G2-03-05/06 实现 Policy Resource Compiler、Release Gate、Gateway 和 5 秒撤权；
- G2-03-07～12 才让 Query Compiler/Executor/HTTP 真正消费 Query Lease；
- G2-03-13 才创建正式只读 Web 消费者。

如后续发现语义错误，只能新增更高 Migration 修复，不修改 `0022`～`0024`。
