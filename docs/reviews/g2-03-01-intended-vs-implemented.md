# G2-03-01 Intended-vs-Implemented 复审

- 日期：2026-08-18
- 方法：从 G2-03 任务包的 Why / What / Acceptance 反向跟踪到 ADR、可执行 Harness、生成 Client、真 PostgreSQL Gate 和 Scope 策略
- 结论：**PASS**
- 限定：只对 G2-03-01 架构 Spike 通过，不将后续正式包、Migration、Endpoint 或 Web 页面误报为已实现

## 1. 任务包验收逐条对照

| Acceptance 意图                                                            | 实际产物                                                                                                                                    | 可执行证据                                                                      | 偏差                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 冻结事实 Owner、Port、依赖、事务/请求边界                                  | ADR-020 定义 contracts/domain/application/adapter/API/Web 的单向依赖、resolve-once + Lease + read-only transaction                          | ADR 本文与 Scope Gate                                                           | 无                                                                 |
| 真 PG16 跑 typed Get/List+Policy/Count/one-hop 并保留 Explain              | 通用 `policy-query.ts` 生成四类 SQL，`postgres-spike.ts` 在 G2-02 clean-room 完整数据上执行结果与 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` | `materialization-clean-room` + `g2-03-01-postgres-query-spike.json`             | 无；最终数值由远程同提交 Gate 生成                                 |
| 不按 Fixture API Name 分支、不导入 G1、不绕过 Current Generation           | Compiler/PG Spike 只接收 Serving Member/Property Capability；精确绑定 release head、revision、generation、lifecycle                         | 源码 marker + fixture-name/G1 scan + current-generation artifact assertion      | 无                                                                 |
| Threat Model 覆盖身份/委托伪造、Service 扩权、泄露、Cursor、Artifact、撤权 | 24 类威胁记录信任区、缓解、当前证据和后续 Owner                                                                                             | Trust-boundary 6 类负测 + Threat Model                                          | 生产 JWT/Replay/Key 属 03-03/04/09，已明示保留                     |
| 比较并锁定 Web 栈                                                          | ADR 按 Node/TS、OpenAPI、OIDC、Table、Accessibility、Browser、Build/Maintenance 冻结确切版本；记录 v9 与生成器约束                          | `web-stack-lock.json`、package exact versions、Vite production build、npm audit | 生成源的 `exactOptionalPropertyTypes=false` 仅限 Spike，已登记重评 |
| 最小 OpenAPI 生成 Read Client 并在候选 Web 栈编译                          | 3-operation OpenAPI 3.1 Candidate 生成 16 个 Client 文件；React Consumer 类型检查和 Vite build                                              | 零 Diff 重生成 + required/enum/nullability 3 个 breaking mutation               | 无；明确不是产品页或已发布 SDK                                     |
| 范围 Gate 只向前接纳新工作且保留历史证据                                   | Foundation 只隔离当前 Spike；G2-02 只显式接纳当前记录/两个 Prefix；新 G2-03-01 策略绑定 baseline 并黑名单正式下游目录                       | scope mutation tests + 35-gate manifest                                         | 无                                                                 |
| 四个 Kill Criterion 不能被文档掩盖                                         | Trust Boundary 不信客户自报；Policy 在 SQL/pagination 前；Compiler/Web 无领域分支；Web 无仓内依赖                                           | 20 个架构/证据单测、Web mutation/build、PG artifact validator                   | 无                                                                 |

## 2. 从意图到代码的承重映射

| 产品不变量                   | 代码中的强制点                                                   | 打假方式                                                          |
| ---------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| 一次请求一个 Serving Context | `ServingContext` + `release-serving-head` resolver               | 缺 Member/混 Activation 失败；Artifact 要求 3 Member/3 Generation |
| 只读 Current 且精确 Revision | 四类 SQL 同时绑定 Project/Resource/Revision/Generation/Lifecycle | 将 artifact 标为 bypass 时 Evidence Test 失败                     |
| Policy 在分页与 Count 前     | Compiler invariant `QUERY_POLICY_AFTER_PAGINATION`               | 错序 SQL 负测                                                     |
| deny Property 无查询侧信道   | Capability + access 检查                                         | denied-property filter 负测                                       |
| 所有客户值不拼 SQL           | `CompiledReadStatement.values` 与参数类型                        | injection payload 不出现 SQL shape                                |
| Service 不扩权               | server Principal + `intersection`                                | elevation、missing PoP、replay、TTL 负测                          |
| GC 不删在途代                | committed/unexpired Lease 才是 Root                              | planned/released/expired/cursor 都不保护                          |
| OpenAPI 漂移必须可见         | generated-only consumer + compile witness                        | required/enum/nullability mutation 全部被拒绝                     |
| Web 不穿透 Kernel            | source-boundary scan                                             | internal import 或领域名出现即 Gate FAIL                          |

## 3. 实现中发现并关闭的偏差

1. **类型生成器依赖有已知漏洞。** 最初锁定的生成器依赖树带入高危 YAML 处理问题；保留 0.99.0 并强制 `js-yaml=4.3.1`，`npm audit` 回到 0 vulnerability。
2. **TanStack Table v9 不适合当前 Spike。** 实际集成显示 API 变动会让编译证据与当前稳定用法失配；锁定稳定 8.21.3，不用预览版伪装“更新”。
3. **HeyAPI 生成源与 TypeScript 6 exact optional 不兼容。** 例外被限制在 `spikes/g2-03-01/web/tsconfig.json`，并作为 G2-03-02/13 的显式剩余风险；没有放宽根 TypeScript 设置。
4. **仅“能生成”不能证明前后端接缝。** 补了字节级重生成对比、React Consumer 编译/生产 Build 和三类 Spec mutation，不用人工视察替代合同 Gate。
5. **Current 仅绑定 Generation 不足以使用 G2-02 部分索引。** SQL 补入 Resource Revision 和 lifecycle 约束，使语义与 Published Index 的 predicate 一致，避免为 Spike 关闭 Seq Scan。
6. **历史 Scope 规则不会自动理解“Spike”。** 补入精确 forward allowlist，同时保留正式 Query/Policy/Identity/Web/Migration 黑名单，没有删除历史 Gate。
7. **新建置工具的合法许可证不在全局白名单。** Vite 的 build-only `lightningcss` 与 OpenAPI 生成器的 build-only `argparse` 使用 MPL-2.0 / Python-2.0；没有全局放宽 SPDX，而是增加精确 package + version + license + scope + owner + reason 批准，错版本或过期条目会 fail closed。

## 4. 明确保留的差距

- `tools/query-policy-architecture` 是决策 Harness，不是将来的正式 `packages/query-*` / `packages/policy-*` / `packages/identity-*`。
- Query Lease 尚未持久，没有真实进程 Kill/Resume 或 GC Provider；归 G2-03-03。
- Identity 尚未连接生产 JWT 验证、Principal Migration、Claim Mapping 或 Token Exchange；归 G2-03-03/04。
- Candidate OpenAPI 只有 3 个路径，没有完整 Query/Cursor/Error 合同；归 G2-03-02/12。
- React Consumer 只是 compile/build Spike，没有正式页面、真 HTTP/OIDC、可访问性或浏览器流程；归 G2-03-13。
- 当前 PG Spike 证明四类候选 Query 形状和索引，不代表 G2-03-09/14 的查询 SLO、30 分钟混合负载或泄露统计已通过。

## 5. 结论

实现没有把类、接口或单测存在误当成生产功能，也没有越过 G2-03-01 创建正式产品目录。本复审的 PASS 必须与同一 commit 的 Web Artifact、真 PG16 Artifact 和 35 道统一 Gate 一起成立；远程未 PASS 时不合并，也不开始 G2-03-02。
