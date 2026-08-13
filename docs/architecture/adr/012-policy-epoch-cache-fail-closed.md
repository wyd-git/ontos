# ADR-012：Policy Epoch、决策缓存与 fail-closed

- 状态：Accepted for G2-00-08
- 日期：2026-08-13
- Owner：Identity/Policy / Security
- 决策范围：P0 Resource/Role 授权事实、Project Authorization Epoch、进程内决策缓存、失效通知、5 秒撤权上界与依赖失败语义
- 可执行合同：`tools/policy-epoch/`
- Production 落点：`packages/identity-policy`、所有 API / UI / SDK / Function / Action 的统一 Policy Gateway

## 1. 决策结论

P0 Resource/Role 授权事实保留在 Kernel PostgreSQL 关系表，不引入 Redis 或外部授权引擎。每个 Project 持有单调递增的 `authorization_epoch`。任何会改变 Kernel 内有效授权的写入，必须与该 Project Epoch 递增在同一个 PostgreSQL 事务提交。

每个 Runtime 进程只保留最长 5 秒的内存决策缓存。缓存命中同时要求完整决策键一致、缓存未达到硬到期边界，并且缓存 Epoch 不低于该进程通过通知观察到的 Epoch Floor。PostgreSQL `NOTIFY` 只负责提前失效；通知丢失、重复、乱序或监听进程重连都不能延长原缓存寿命。

缓存未命中或失效时，Runtime 必须从同一个数据库快照取得 Project Epoch 和所需 Resource/Role 事实，并取得与 Release、Policy Revision、Compiler Version 精确匹配的已编译策略。任何依赖无法提供可确认结果时返回 Deny；不存在 `allowOnError`、stale-while-revalidate 或错误时延长 TTL。

G2-00-08 只实现双进程状态 Harness，证明事务、缓存和故障语义；不实现完整 Object/Link/Property Policy Compiler、OIDC Provider、真实 PostgreSQL Migration 或全部 Runtime 入口。

## 2. P0 事实来源与范围冻结

P0 保留以下 PostgreSQL 关系事实：

- `identity_policy.project_authorization_epoch(project_id, epoch, changed_at)`；
- Principal、OIDC Claim Mapping、Project/Resource Role Binding；
- Role 到 Resource Permission 的受版本控制映射；
- 绑定 Release、Policy Revision 和 Compiler Version 的只读编译产物引用。

Harness 为了验证 Epoch 与缓存边界，只保存已经归约到 `(principal, resource, permission)` 的有效关系，不把这个测试结构冒充完整 Role Schema。真实 Principal、Group、Role、Binding 与 Permission 表及其 FK/Unique/写权限由 G2-00-10 Migration 落地，但必须能在一个 Snapshot 中归约成相同决策输入。

授权事实的唯一写入口是 Identity/Policy Application Service。数据库角色必须禁止 API、UI、SDK、Handler Host 和业务模块直接更新这些表。Production Migration 还必须以约束或受控写函数保证授权表变化不能漏掉 Epoch 递增；该数据库证明属于 G2-00-10，当前 Harness 先冻结语义。

若以后改接 OpenFGA、SpiceDB、OPA 或其他外部授权引擎，必须新增 ADR，重新评估 P0 范围、单区域可用性、备份恢复、审计、延迟预算、撤权上界和故障模式。不能只替换 Adapter 后继续沿用本 ADR 的已验收声明。

## 3. 授权写事务与通知

每个 Project 初始 Epoch 为 `1`，存储为 PostgreSQL signed `bigint`。一次有效授权变化使用以下等价事务：

```sql
BEGIN;

SELECT epoch
FROM identity_policy.project_authorization_epoch
WHERE project_id = :project_id
FOR UPDATE;

-- 在同一事务修改 Claim Mapping、Role Binding 或 Role Permission。

UPDATE identity_policy.project_authorization_epoch
SET epoch = epoch + 1,
    changed_at = transaction_timestamp()
WHERE project_id = :project_id
RETURNING epoch, changed_at;

-- pg_notify 在事务提交后才向监听者可见。
SELECT pg_notify('ontos_policy_epoch_v1', :bounded_versioned_payload);

-- 同一事务追加不含 Token/Claim/Secret 的授权变更审计。
COMMIT;
```

事务失败时，授权事实、Epoch、Audit 与通知全部不可见。语义不变的幂等写可以不递增；一旦 Claim Mapping、Principal 状态、Project/Resource Binding、Role Permission 或其他 Kernel 内授权输入的有效结果发生变化，就必须递增。多项同 Project 变化可以在一个事务只递增一次；跨 Project 变化拆成独立事务，避免制造全局 Epoch。

通知 Payload 只包含协议版本、Project ID 和提交后的 Epoch，并有固定大小上限。监听者把它当 Hint：

- 新 Epoch 高于本地 Floor：提高 Floor，并清除该 Project 全部决策缓存；
- 重复或更低 Epoch：忽略，不允许回退；
- Epoch 跳跃：允许，下一请求重新读取数据库；
- 通知高于数据库随后可确认的 Epoch：fail closed，而不是信任通知或回退 Floor。

## 4. 一致的读取快照

缓存未命中时，Policy Gateway 通过一个 Repository 调用、在同一 PostgreSQL MVCC Snapshot 中读取：

- 当前 Project Epoch；
- Actor 与 Delegation Chain 中所有 Principal 的相关 Project/Resource 授权事实；
- 本次数据库观察时间 `transaction_timestamp()`。

不能先读 Epoch、再用另一事务读 Binding，也不能先读 Binding、再读 Epoch。否则并发撤权可能产生“新 Epoch + 旧 Allow”或“旧 Epoch + 新事实”的伪快照。Repository 返回的 Snapshot 是本次决策唯一可缓存的授权输入。

数据库时间用于授权提交、审计排序和诊断，不用于延长进程内缓存。Epoch 是授权事实顺序的权威；TTL 是进程本地安全上界。

## 5. 决策键与 Identity/Delegation

缓存键至少包含：

- Project ID；
- Actor Identity Context Fingerprint；
- Delegation Chain Fingerprint；
- Resource ID 与 Permission；
- Release ID；
- Policy Revision；
- Compiler Version；
- Project Authorization Epoch。

Actor Fingerprint 覆盖可信 `subjectId`、Identity Type 和当前 OIDC Token 中实际携带的 Group/Role Claims；Delegation Fingerprint 覆盖有序的 On-behalf-of Chain。两者使用确定性、带长度边界的编码后再 SHA-256，不用字符串分隔符拼接。不同 Resource 或 Permission 也必须分键，否则对一个对象的 Allow 会被错误复用到另一个对象。

Delegated 请求的 Harness 语义是 Actor 与 Chain 中每个 Principal 都必须拥有所需授权，即权限交集；缺少任一绑定即 Deny。完整 Service/Delegation 产品合同在 G2-00-09 冻结，但后续实现不得删除本键中的 Delegation 维度。

## 6. 5 秒硬 TTL

`5_000ms` 是上限，不是建议刷新间隔。每个进程在成功取得一致授权快照、精确编译产物并完成决策后，记录本进程单调时钟值：

```text
expiresAtMonotonic = confirmedAtMonotonic + min(configuredTtl, 5_000ms)
```

在 `nowMonotonic >= expiresAtMonotonic` 时缓存已失效。命中缓存、依赖报错、通知丢失或后台刷新都不得修改原始 `confirmedAtMonotonic` / `expiresAtMonotonic`。进程重启从空缓存开始。

不使用 `Date.now()` 计算硬 TTL，也不比较两个主机的墙上时钟。单调时钟回退、返回非有限值或超过安全整数范围时，进程清空缓存并 fail closed，直到新的安全进程代际接管。向前跳跃只会让缓存提前过期。

仍在原硬 TTL 内且未被通知 Floor 淘汰的缓存，是已经确认过的决策，可以在短暂数据库/编译产物读取故障期间继续使用；它不能超过原到期时间。到期、缓存未命中或 Floor 更高时，任何依赖不可用都必须 Deny。

这给出的 Kernel 内撤权上界从授权变更提交时计算：最坏情况下，撤权发生在旧 Allow 缓存刚创建之后，未收到通知的进程会在不足 5 秒后强制重读并拒绝。通知正常时目标是下一请求拒绝。

## 7. 编译产物与 fail-closed

Harness 的编译产物只证明版本绑定和失败行为，不实现 Predicate AST 或 SQL Compiler。真实编译产物必须精确绑定：

```text
(projectId, releaseId, policyRevision, compilerVersion)
```

Policy Gateway 不允许选择“最新”、回退旧 Revision、跨 Release 复用或忽略 Compiler Version。缓存未命中时出现以下任一情况都返回 Deny：

同一个 `(projectId, releaseId, policyRevision, compilerVersion)` 编译键是不可变发布事实；第一次登记后不能覆盖为另一 Artifact Digest。Gateway 仍必须复核 Repository 返回的授权 Snapshot 所属 Project、Epoch 范围、Delegation 数量，以及 Artifact 的四维版本绑定，不能只信任 Adapter 类型声明。

- Epoch / 授权快照 Store 不可用；
- 数据库 Snapshot Epoch 低于本地通知 Floor；
- 编译产物 Store 不可用或精确产物不存在；
- 单调时钟不安全；
- Request、Identity、Delegation 或版本字段无效；
- 未分类内部异常。

稳定错误码为：

| Code                            | 含义                              |
| ------------------------------- | --------------------------------- |
| `POLICY_INPUT_INVALID`          | 决策请求或身份上下文不合合同      |
| `POLICY_EPOCH_UNAVAILABLE`      | 无法取得一致 Epoch / 授权事实快照 |
| `POLICY_EPOCH_UNCONFIRMED`      | 数据库 Epoch 低于已观察通知 Floor |
| `POLICY_ARTIFACT_UNAVAILABLE`   | 编译产物依赖不可用                |
| `POLICY_ARTIFACT_NOT_FOUND`     | 精确版本的编译产物不存在          |
| `POLICY_MONOTONIC_CLOCK_UNSAFE` | 本地 TTL 时钟无法安全确认         |
| `POLICY_INTERNAL_FAILURE`       | 未分类错误                        |

失败返回只暴露 `DENY`、稳定 Code 和是否来自 Fail-closed。可观测事件允许记录事件名、Code、进程 ID、不可逆 Project Ref 与 Correlation Ref；不得记录 Subject、Group、Delegation、Resource、Permission、Token、Claim、原始依赖错误、Stack 或输入正文。真实 Trace 系统可在受控 Span Context 中关联原始、由服务端生成的 Correlation ID，但不能把客户端任意字符串当作安全日志字段。

## 8. OIDC Group 延迟不是 Kernel Epoch 延迟

Kernel 只对已进入请求 Identity Context 的可信 Claims 做决策。OIDC Provider 中删除 Group 后，旧 Access Token 仍可能携带旧 Group；其生效时间由 Provider Session、Token TTL、Refresh、Revocation 和 API Token 校验策略决定，不属于本 ADR 的 5 秒承诺。

Kernel 内以下变化从数据库事务提交起受 5 秒上界约束：Group-to-Role Claim Mapping、Principal 禁用、Project/Resource Binding、Role Permission。部署文档必须分别公开 OIDC Token 最大陈旧时间和 Kernel 内授权最大陈旧时间，不能把二者相加后仍宣传为“5 秒撤权”。

## 9. Harness 验证要求

`tools/policy-epoch/` 至少自动验证：

- Binding 变化和 Epoch 递增原子提交，事务失败不产生部分状态或通知；
- 缓存键的每个身份、Delegation、目标、Release、Policy、Compiler 和 Epoch 维度都能阻止错误复用；
- 两个独立 API 进程收到通知时下一请求拒绝；
- 一个进程丢失通知时，在硬 TTL 边界前可以命中旧决策，到边界时必须重新读取并在 5 秒内拒绝；
- 重复、乱序、跳跃和伪超前通知不会让旧 Allow 复活；
- Store / Artifact 依赖故障在有效缓存内不延长 TTL，缓存失效后全部 fail closed；
- 编译产物版本不匹配、缺失、异常和包含 Secret 的原始错误都只产生安全 Deny 事件；
- 墙上时钟回退不影响 TTL，单调时钟回退 fail closed；
- Delegation 使用交集，变更 Actor/Chain/Group Claims 不能命中另一身份缓存。

## 10. 被拒绝的方案

### 10.1 只依赖通知失效

拒绝。`NOTIFY` 不是 Durable Queue；断线、进程启动窗口或 Payload 丢失会让 Allow 永久存活。通知只能缩短 TTL 窗口。

### 10.2 只把 Actor 和 Resource 放入缓存键

拒绝。Release、Policy Revision、Compiler Version、Delegation 或 Epoch 缺失都会让另一执行语义下的 Allow 被复用；Target/Permission 缺失会造成直接横向越权。

### 10.3 依赖失败时沿用过期 Allow

拒绝。stale-while-revalidate、后台刷新失败后续期、默认 Allow 或回退旧编译产物都会把短暂缓存变成持续权限旁路。

### 10.4 每次请求查询数据库 Epoch

拒绝作为默认方案。它能降低陈旧窗口，但让所有授权请求增加数据库往返，并使数据库短暂故障立即放大到所有已确认请求。硬 TTL + 通知保留明确安全上界和短暂可用性；高风险操作可以在后续模块要求强制新鲜读取。

### 10.5 用 Redis Pub/Sub 或外部授权引擎解决 G2-00-08

拒绝。当前单区域 P0 可由 PostgreSQL 事实、事务通知和进程内有界缓存完成；引入新的持久状态或可用性依赖会扩大运维面，且不自动解决完整缓存键和 fail-closed。

## 11. 本任务明确不实现

- 不实现完整 Object/Link/Property Predicate AST、SQL 下推、Mask 或 Action Submission Criteria；
- 不实现真实 OIDC Login、Token Refresh、Provider Group Sync 或全局 Token Revocation；
- 不实现 Production PostgreSQL Migration、RLS、数据库角色、触发器或真实 `LISTEN/NOTIFY` 重连；
- 不宣称 Harness 已证明每个真实 Runtime 入口都经过统一 Gateway；该 Translation Gate 留给对应模块；
- 不引入 Redis、Kafka、外部 Policy Engine、多区域 Epoch 或跨区域五秒一致性；
- 不把进程内模拟编译产物称为 Production Policy Compiler。

只有自动测试证明上述状态与故障语义，并由 Red-Team 和 Intended-vs-Implemented 审查关闭当前 seam 范围偏差后，本 ADR 才改为 Accepted for G2-00-08。
