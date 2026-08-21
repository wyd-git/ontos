# G2-03-08 Runtime Metadata 与 Activation-aware Object Get Evidence

- Gate：G2-03-08
- 日期：2026-08-21
- Owner：Query / Metadata / Runtime / Security（accountable: `wyd-git`）
- 结论：**PASS**

## 1. 本项真正关闭了什么

G2-03-08 把 G2-03-06 的生产 Policy Gateway、G2-03-07 的 typed Query Compiler 与 G2-03-03 的持久 Query Lease/GC Root 接成第一条正式 Runtime Application 读路径：

```text
Release / stable
→ exact one-snapshot candidate
→ Policy Gateway
→ atomic context revalidation + committed Lease
→ lease-gated Current
→ Runtime Metadata / Object Get contract response
→ release or orphan expiry
```

实现包括 `0028_runtime_query_context.sql`、`RuntimeQueryApplicationService`、PostgreSQL Context/Object Repository，以及单元和真实 PostgreSQL 16 验收。它不是 HTTP 或 UI Demo；HTTP、Generated Client 和 Web 仍属于 G2-03-12/13。

## 2. 合同、安全与一致性证据

| 断言                       | 实现证据                                                                                   | 自动化证据                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 每请求只解析一次精确上下文 | Resolver 同快照返回 Release/Revision/Activation/Plan/Generation/Definition/Policy Artifact | 显式 Release 与 `stable` 解析相同实际 Revision                                  |
| Lease 前原子重验           | `commit_query_execution_context` 在一个语句中 Plan、比较并 Commit                          | Serving Head 与 Authorization Epoch 漂移均失败且 Lease 数为 0                   |
| Current 读取受 Lease 门控  | transaction-local Activate + `security_barrier` Query View                                 | 无 Context 返回 0；精确 Context 返回 1；错误 Binding 拒绝                       |
| GC 不回收活跃代            | Commit 复用 Query Lease Generation Root                                                    | 独立 Owner 进程 Commit 后被 `SIGKILL`，过期前 Root=1，Worker 过期后 Root=0      |
| Metadata 不泄露隐藏资源    | Object 与 Link Resource 均经 Gateway；Property/Link 能力按 Policy 降级                     | 隐藏 Object 不出现，Link allow/deny 正反向量，restricted 字段无查询能力         |
| Get 精确定位               | Canonical PK + Resource Revision + Lease Generation + Active                               | 返回精确对象、稳定 `objectVersion=7`；不存在统一 404                            |
| Property 二次防御          | SQL 五态投影后，Serializer 对照 Policy Plan 和精确 Key Set                                 | mask/missing 正向量、原值泄露和非法形状负向量                                   |
| Release 不静默回退         | 不可变 90 天支持期限 + 显式 CAS Retire                                                     | API 不能改期限、Owner 也不能改 Published 期限；退役后显式请求 `RELEASE_RETIRED` |
| 数据库最小权限             | API 只有 Resolver/Commit/Activate/门控 View；无裸 Current Grant                            | API 裸表 42501；Worker/Ops Resolver/View 42501                                  |

## 3. 真实 PostgreSQL 16 证据

`tools/runtime-query/integration/postgres.test.ts` 从空 PostgreSQL 16 执行连续 `0001`～`0028`，创建三种非 Owner 登录并验证：

- 显式 Release 与 `stable` Channel 返回同一个实际 Release Revision；
- Metadata 只包含 Actor 可发现的 `Customer`；
- Get 返回 Canonical Primary Key、精确 Revision/Generation 和稳定 Object Version；
- mask、missing 与 Serializer 防泄露语义成立；
- 所有成功/失败请求都释放 Lease；
- Serving Head/Policy Epoch 在候选与 Commit 间漂移时无 Lease 残留；
- 独立 Lease Owner 进程被 `SIGKILL` 后，GC Root 在 TTL 内仍保护 Generation，过期 Worker 才回收；
- Support Window 不可被 Runtime 或 Owner 原地延长/缩短；
- 显式 Retire 移除 Serving Head，后续显式请求返回 `RELEASE_RETIRED`；
- API/Worker/Ops/Public 的裸表、门控 View 与函数权限符合最小授权。

机器制品 `generated/ci-report/g2-03-08-runtime-query.json` 记录 PostgreSQL Version、Commit、clean checkout、Lease 最终状态、精确上下文和 17 项布尔断言。完整 Gate 再生成 `g2-03-08-evidence-manifest.json`，要求制品 Commit 与 Gate Commit 一致且 `cleanCheckout=true`。

## 4. 数据库前向变化

`0028` 不重建 Release、Activation、Generation、Policy 或 Query Lease：

- 在 `meta.releases` 增加发布后不可变的 `support_until`；
- 增加一个候选 Resolver、一个原子 Context Commit、一个事务内 Lease Activate 和一个显式 Retire 函数；
- 增加 2 个租约门控 `security_barrier` View；
- 撤销旧两步 Lease Plan/Commit 对 API 的直接执行权，裸 Current 继续无 Grant。

全新库升级、带历史 Published Release 的 A0 前向升级、重复执行 no-op、Migration Hash 与逐 Migration Rollback 均由数据库 Integration 覆盖；旧两步 Lease API 明确返回 `42501`，同一测试改走原子 Context Commit；`0001`～`0027` 未修改。

## 5. 可重复 Gate

```bash
npm run test:runtime-query
npm run test:runtime-query:postgres
npm run check:g2-03-08-evidence
npm run verify
```

Preflight 会运行短时真实 PostgreSQL 用例，但跳过 G2-03-08 完成 Manifest；只有 clean checkout 的 Full Gate 才能关闭本项。

## 6. 下一步

G2-03-08 PASS 后只放行 G2-03-09：在同一 Runtime Application/Execution Context/Lease/Policy-in-SQL 边界上实现 Search、Count 与签名 Cursor，并完成相应 10k/100k 查询资格。不得先接 HTTP/UI，也不得建立另一套 Release/Generation Resolver。
