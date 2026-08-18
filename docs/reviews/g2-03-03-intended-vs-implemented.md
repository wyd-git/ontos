# G2-03-03 Intended-vs-Implemented 复审

- 日期：2026-08-18
- 方法：从任务包 Why/What/Acceptance 反向追踪到 Migration、约束、Trigger、受控函数、真实非 Owner PostgreSQL 行为、GC Root 和统一 CI
- 结论：**PASS**
- 限定：只证明持久事实和最小权限；不宣称 JWT/Delegation、Policy Compiler/Gateway、Query SQL/HTTP 或 UI 已实现

## 1. 验收逐条对照

| 原始意图                                          | 实际实现                                                                                                  | 可执行证据                                                                         | 结果 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---- |
| 历史库与空库都只向前升级                          | 单一 Migration 账本新增 0022～0024；每版本独立事务                                                        | 历史前缀 21 升级、Hash 前后相等、重复 no-op、双 Runner 并发、逐版本故障注入        | 一致 |
| 历史 Principal 安全兼容且 Service 不能伪造        | `identity_type NOT NULL DEFAULT human`；只允许 human/service；类型不可变；外部身份唯一键不含类型          | 历史行回填、显式 Service、同 issuer/subject 伪造、Owner/API 改类型负测             | 一致 |
| Claim Mapping 可版本化且不能跨边界换头            | 不可变 Revision + 复合 FK Head + 单调 CAS sequence + 256 KiB JSON 上限                                    | 正常注册/激活/解析、跨 Project/Issuer/Type 负测、重复/回滚/不可变负测              | 一致 |
| Policy Artifact/Test 与 Release Revision 精确绑定 | Compilation 复合 FK 到 Release Pin；Digest/Compiler/Vector 约束；Artifact Source Guard；事实不可变        | Passed Artifact 记录/解析、错 Compiler/Source/Pin/状态和裸表访问负测               | 一致 |
| 授权变化、Epoch 与通知同事务                      | 事务 ID 去重的 `advance_authorization_epoch`；Binding/Principal/Claim Mapping Trigger；事务型 `pg_notify` | 成功通知、同事务一次推进、回滚无 Epoch/通知、直接 Epoch 写拒绝                     | 一致 |
| Lease 只保护真实可服务完整代                      | Plan 校验 Serving Head、Passed Compilation、当前 Epoch、Active/Uncollected 完整成员；Plan/Commit 两阶段   | 无 Serving Generation fail closed；真实 G2-02 Release/Activation/Generation 闭环   | 一致 |
| Lease 成为真实 GC Root 且有界结束                 | committed+unexpired 才进 Root；120 秒硬上限；Release/Expiry 终止；Provider 与 Root Digest 激活            | Plan 不成 Root、Commit 后所有成员成 Root、Heartbeat 有界、Release/TTL 后 Root 消失 | 一致 |
| Runtime 三角色最小权限                            | 新表默认 Revoke；API/Worker 只拿函数；Ops 只拿 View；新租户表 FORCE RLS                                   | 三个真实 LOGIN 的表/列/函数/业务数据/Owner Membership 正负测试                     | 一致 |
| 统一 Gate 与前向范围不被绕过                      | G2-03-03 成为 full profile 第 38 Gate；历史 Gate 只精确接纳 0022～0024 与 persistence 工具                | Scope Mutation、Source Marker、双 Artifact、同 Commit/Clean Checkout Manifest      | 一致 |

## 2. 承重不变量与故意失败方式

| 不变量                              | 具体强制点                                            | 故意失败时看到什么                                                 |
| ----------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| 历史 Migration 不可改               | 账本记录版本、名称和 SHA-256                          | 0001～0021 任一字节变化即历史漂移；故障 Migration 不登记且不留对象 |
| Human 不能原地升级为 Service        | Principal Type Immutable Trigger                      | 即使 `migration_owner` 更新也返回 SQLSTATE `55000`                 |
| Mapping Head 不跨租户/Issuer/Type   | 四列复合 FK + CAS Trigger                             | 错 Revision 返回 FK/控制冲突；事务回滚保持旧 Head/Epoch            |
| Failed Policy 不能被 Query 使用     | Compilation 结果约束 + Resolver/Lease 只接受 `passed` | 缺失/失败/错 Release Artifact 时 Lease 规划 fail closed            |
| 一次请求不跨代                      | Lease 固定 Activation 和完整 Generation Set Digest    | 成员不是 Active、已回收、缺一成员或 Epoch 过期时 Plan/Commit 失败  |
| GC 不回收在读代                     | Query Lease Provider 进入 GC Root/State Digest        | committed Lease 的任一 Generation 被排成候选时 Integration 失败    |
| Cursor 不续旧权限                   | Lease 只有请求级 120 秒硬上限                         | Heartbeat 不能超过 `max_expires_at`；下一页必须重新授权            |
| 通知不能早于提交                    | PostgreSQL NOTIFY 与 Epoch Update 同事务              | 回滚后监听方收不到通知，Epoch 和事实也不变                         |
| Runtime 角色不能靠 RLS 自报用户权限 | RLS 上下文只供受信 Repository；无裸表 Grant           | API/Worker/Ops 直接 SELECT/UPDATE 敏感表返回权限错误               |

## 3. 实现过程中发现并关闭的偏差

1. **最初只校验“当前仍 Active 的成员”，可能把不完整 Activation 子集租下来。** Plan 现在同时锁定 Activation 的声明 `member_count`，实际 Active/Uncollected 数必须完全相等。
2. **Query Lease 表有 committed 行不等于 Ops/GC 真能看见 Root。** PostgreSQL View 在调用用户下仍受 FORCE RLS 约束；为 `read_only_ops` 增加只读 RLS 可见性后，用真实 Ops 角色验证 Provider Root，而不是用 Owner 查询替代。
3. **替换旧 Revision Validation Trigger 时曾只保留新 Policy 分支。** 这会让 G2-02 Object/Link/Snapshot/Mapping 校验回归；现已恢复全部旧 Family 行为，并追加独立的 `policy-g2-03-v1` 分支。
4. **直接 `UPDATE authorization_epochs` 无法证明原因、事务去重或通知一致性。** Metadata Repository 和新 Trigger 全部改走受控函数，并用 append-only advance fact 证明一次事务一次推进。
5. **只测 Runtime 角色不可写不足以证明事实不可变。** Principal Type、Policy Compilation 和 Epoch Advance History 都增加 `migration_owner` 负测，排除“Owner 可悄悄改历史”的漏洞。
6. **只在内存协议测试 Query Lease 不能证明 G2-02 GC 集成。** 正式 Materialization PostgreSQL 集成现在创建真实 Published Release、Serving Activation 和 Generation，验证 Root 的加入与退出。
7. **新增 Migration 会让旧 Scope Gate 按设计拒绝。** 没有删除范围控制；旧 Gate 仅精确前向接纳 0022～0024、相关适配器/测试/文档及一个新工具 Prefix，未知 0025 仍被拒绝。
8. **撤销 Epoch UPDATE 也会撤销 PostgreSQL `SELECT FOR UPDATE` 所需的锁权限。** 全数据库回归发现三个旧 Metadata 流程被拒绝；现以 SECURITY DEFINER 的 `lock_authorization_epoch` 只返回并锁住当前行，Repository 保持旧锁顺序，而 API 继续没有 Epoch 列写权限。
9. **历史 GC 故障测试把 Query Lease 当作“尚未实现”的 Provider。** 0023 激活真实 Provider 后，该测试理应不再得到 Missing；故障注入改用仍保留但未实现的 `runtime.preflight-token`，继续证明 Active+Missing 必须阻断，而不把正确的新能力误判为回归。

## 4. 可落地性审计

这次实现没有建立孤立的“将来可能用不到”的表：

- G2-03-04 可直接使用 Claim Mapping Register/Activate/Resolve 和 Principal Type，不需重建身份表；
- G2-03-05 可直接写入 Release-bound Compilation/Test Artifact，不需修改 Release Pin 模型；
- G2-03-06 可直接消费事务型 Epoch/NOTIFY，不需修补旧 Metadata 写路径；
- G2-03-07～12 可把每次 Query 的 resolved Execution Context 写入现有 Plan/Commit Lease，并由 G2-02 GC 自动保护 Generation；
- G2-04 后续 Root Provider 仍沿用同一 Registry/Root Epoch，不需另建 GC。

仍有一个必须由下一层遵守的信任边界：`api_runtime` 是受信服务身份，受控函数接受服务器提供的 Project ID；终端用户不能获得数据库凭据。G2-03-04 的 HTTP/OIDC Repository 必须在验证 Token 与 Project 权限后调用这些函数，不能把请求参数直接当授权。这是明确的后续接口责任，不是把用户授权委托给 RLS。

## 5. 明确保留的差距

- Claim Mapping 只保存版本事实，还没有解析真实 JWT Claims；G2-03-04。
- Delegation Chain 的来源、Audience、时效和防重放还没有生产实现；G2-03-04。
- `policy-g2-03-v1` 只允许零依赖持久化；正式 AST Compiler、测试执行和依赖闭包；G2-03-05。
- Epoch/NOTIFY 已可用，但 5 秒缓存、统一 Gateway 与 fail-closed 运行接入；G2-03-06。
- Query Lease 已落库并接 GC，但还没有 Query SQL/HTTP 请求消费；G2-03-07～12。
- 没有 `apps/web` 或用户可见页面；G2-03-13。
- 没有 100k Object/1m Link 的 Policy Query SLO 与最终 clean-room；G2-03-14/15。

## 6. 结论

没有发现会迫使后续重建身份、Release、Generation、GC 或公共合同的阻断性偏差。G2-03-03 的实现与任务包一致，且未越界实现正式 Identity、Policy Compiler、Runtime Endpoint 或 UI。PASS 只有在同一 commit 的 38 道 `npm run verify` 和 `g2-03-03-evidence-manifest.json=CLEAN_ROOM_PASS` 后成立；完成后只放行 G2-03-04。
