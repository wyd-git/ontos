# G2-03-01 Query / Policy / Identity / Consumer 架构 Evidence

- 日期：2026-08-18
- 结论：**PASS**
- 资格限定：只有同一 commit 的 `g2-03-01-evidence-manifest.json` 为 `CLEAN_ROOM_PASS` 时成立
- 任务合同：[G2-03-01](../delivery/g2-03-query-policy-task-pack.md#g2-03-01冻结-querypolicyidentityconsumer-架构边界)
- 架构决策：[ADR-020](../architecture/adr/020-query-policy-identity-consumer-boundary.md)
- 威胁模型：[Runtime Identity / Delegation](../security/g2-03-01-identity-delegation-threat-model.md)
- 复审：[Intended-vs-Implemented](../reviews/g2-03-01-intended-vs-implemented.md) / [Red Team](../reviews/g2-03-01-query-policy-architecture-red-team.md)

## 1. 本 Gate 证明了什么

G2-03-01 不是产品页或 Query API 交付，而是在正式编码前关闭四个最容易导致全面返工的可行性问题：

1. Runtime Identity / Delegation 可以不信任客户自报 Principal、Type 或权限；
2. Object、Count 和 one-hop Link Policy 可以在 PostgreSQL SQL 内、分页与计数前执行；
3. Query 可以基于 G2-02 已激活的 Current Generation 与 Published Index，不需领域 SQL/BFF；
4. OpenAPI Generated Client 可以驱动一个不导入仓内包、不按领域分支的 React 只读 Consumer。

因此 ADR-020 的实现路径可以作为 G2-03-02 的合同输入。本结论不声称 Identity、Policy、Query Lease、Cursor、HTTP 或 Web 已生产化。

## 2. 可执行架构证据

### 2.1 Policy / Query Compiler

`tools/query-policy-architecture/policy-query.ts` 提供与 Fixture 无关的有界 IR，编译：

- typed Object Get；
- Object List + row policy + page limit；
- 使用同一 row policy 的 Count；
- Link edge + source object + target object policy 的 one-hop traversal。

每条 SQL 都绑定 Project、Resource/Revision、Generation 和 Current lifecycle；客户值全部位于类型参数中。源码 Gate 拒绝 G1 依赖和 Customer/Order/Worker/WorkItem 领域分支。

单测覆盖 typed Get/List/Count/Link、Policy 缺失、Policy 位于 Pagination 后、deny Property Filter 和 SQL Injection Payload。

### 2.2 Identity / Delegation Trust Boundary

`trust-boundary.ts` 将未验证 Claim 与服务端 Principal 事实分离，要求：

- 精确 Issuer/Audience/时效、Principal 未 disabled；
- human/service 类型来自 Server Principal Directory；
- delegated service 具备短 TTL、PoP thumbprint、replay port 和 capability allowlist；
- effective permissions 固定为 service/user/chain 交集；
- 输出只包含有界 attribute 与 fingerprint，不包含 Token/Raw Claims。

负向量覆盖客户端身份 Header、wrong issuer/audience/expiry、disabled Principal、Service 扩权、缺 PoP、过长 TTL 和 replay。

### 2.3 Execution Context / Query Lease

`lease-protocol.ts` 证明状态协议：

```text
resolve serving + identity/policy context once
→ plan lease
→ commit lease
→ allow read
→ release or expire
```

只有 committed 且未过期 Lease 允许读取并被 GC 当作 Generation Root。planned/released/expired 以及 Cursor 都不是 Root。Execution Context 一次绑定 identity fingerprint、authorization epoch、policy digest/compiler、read timestamp、serving activation/generations 和 lease。

### 2.4 OpenAPI 生成 Client / Web Consumer

`spikes/g2-03-01/openapi/runtime-read.candidate.json` 包含 Runtime Metadata、typed Get 和 Search 三个 Candidate Operation。可重现 Gate 完成：

| 验证                          | 结果                           |
| ----------------------------- | ------------------------------ |
| 重新生成文件                  | 16 个文件，集合和字节都零 Diff |
| Candidate Consumer TypeScript | PASS                           |
| Vite production build         | PASS                           |
| 仓内实现包导入                | 0                              |
| 领域专用字段/分支             | 0                              |
| Required mutation             | Consumer compile rejected      |
| Enum mutation                 | Consumer compile rejected      |
| Nullability mutation          | Consumer compile rejected      |

锁定栈为 React 19.2.8、Vite 8.2.1、React Router 8.3.0、TanStack Query 5.101.4、TanStack Table 8.21.3、oidc-client-ts 3.5.0、HeyAPI OpenAPI TS 0.99.0 与 Playwright 1.62.1。`js-yaml=4.3.1` 依赖覆盖后 `npm audit` 为 0 vulnerability。

## 3. 真 PostgreSQL 16 资格 Gate

G2-03-01 不新造小数据库，而是接入 G2-02 clean-room 刚刚产生的 100k Object / 1m Link Current Projection。在同一提交的真 PostgreSQL 16 中：

1. 以 `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` 开始；
2. 从 Release Serving Head + Runtime Activation Members 一次解析 3 Member / 3 Generation；
3. 执行 typed Get、Policy List、Policy Count 和 one-hop Link 真结果断言；
4. 对每条语句执行 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`；
5. 保留 SQL shape、parameter types、Index Name、Planning/Execution Time、Buffer 汇总与完整 Explain JSON；
6. `runtime.object_current` / `runtime.link_current` 出现 Seq Scan 或任一语句没有索引时 Gate FAIL。

原始结果不手写进本文，以避免文档与最终 PR Head 漂移。同一 `npm run verify` 生成：

- `generated/ci-report/g2-03-01-postgres-query-spike.json`；
- `generated/ci-report/g2-03-01-web-spike.json`；
- `generated/ci-report/g2-03-01-acceptance.json`；
- `generated/ci-report/g2-03-01-evidence-manifest.json`。

最后一份 Manifest 要求 PostgreSQL Artifact 与 CI Report commit 完全一致、`cleanCheckout=true`、35 个 required gate 各且只 PASS 一次。任一先置 Gate 失败时，G2-03-01 Manifest 只能是 FAIL，不使用历史 Artifact 补位。

## 4. 范围与历史证据

- Foundation 范围只新增 `spikes/g2-03-01/` 隔离，不把 Spike 当成正式 Workspace Package。
- G2-02 只接纳当前架构记录、`spikes/g2-03-01/` 和 `tools/query-policy-architecture/`，其原 21 Migration、证据、反例和总 Manifest 仍执行。
- G2-03-01 独立策略绑定 baseline commit `368b7c4ed13d0793d5c0ba2927a4f91e5af7779c`，禁止本 Gate 创建 Migration、`apps/web`、正式 identity/policy/query/sdk 包。
- 统一 full profile 从 33 道前向增加两道：`g2-03-01-web-spike` 和 `g2-03-01-architecture-evidence`，总计 35 道。普通 Markdown 修改仍只跑 6 道 fast-docs Gate。

## 5. 本 Gate 实际发现的问题

1. OpenAPI 生成器依赖树带入 YAML 安全公告，通过安全 override 关闭，没有带漏洞进入基线。
2. Table v9 存在当前集成 API 不确定性，退回稳定 v8.21.3，不把预览语义当架构基线。
3. 生成的 fetch 源不满足 TS6 `exactOptionalPropertyTypes`；例外限于 Spike，不改根工程严格度。
4. 仅绑定 Generation 不足以准确表达 Published Current/Index 语义；SQL 补齐 Resource Revision 和 lifecycle 条件。
5. 历史 Scope Gate 需要明确前向接纳 Spike，已以最小 exact path/prefix 完成，未放宽下游产品目录。
6. 供应链 Gate 拒绝了 build-only `lightningcss` (MPL-2.0) 和 `argparse` (Python-2.0)；策略没有把这两个 SPDX 全局加白，而是锁定到精确 package/version/license/scope 并记录 Owner/Reason。任何新包或版本变化需重新审查。

## 6. 剩余风险与 Owner

| 风险                                                                                  | Owner                      | 关闭 Gate              |
| ------------------------------------------------------------------------------------- | -------------------------- | ---------------------- |
| Generated fetch client 暂需隔离 `exactOptionalPropertyTypes=false`                    | Web / Contracts            | G2-03-02、03-13        |
| Query Lease/GC 只有状态协议，尚无 PG 持久约束与 Kill/Resume                           | Runtime / Database         | G2-03-03               |
| Identity 语义已冻结，但生产 JWT、Principal Type、Claim Mapping 和 Token Exchange 未建 | Identity / Security        | G2-03-03、03-04、03-06 |
| Cursor AEAD/Key Rotation 只是 ADR 协议                                                | Security / Query           | G2-03-02、03-09        |
| 当前只有四类候选 Query，没有混合负载与时序泄露统计                                    | Query / Quality / Security | G2-03-09、03-11、03-14 |

## 7. 不包含什么

- 没有新 Migration 或生产 Identity/Policy/Query 包；
- 没有 Runtime Read Endpoint、真 Cursor、持久 Query Lease 或 Token Exchange Endpoint；
- 没有 `apps/web`、用户可访问页面、真 OIDC 浏览器流程或可发布 SDK；
- 没有 G2-03 总性能/泄露/Concurrency/Clean-room 验收；
- 没有 Action、Overlay、Function、Automation、AI 或完整 Palantir 产品能力。

本 Gate 关闭后只放行 **G2-03-02：冻结 Query / Policy / Identity / Runtime Read 公共合同**；不跳到 Migration、Endpoint 或 UI。
