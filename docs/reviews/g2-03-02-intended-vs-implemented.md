# G2-03-02 Intended-vs-Implemented 复审

- 日期：2026-08-18
- 方法：从任务包 Why/What/Acceptance 反向追踪到 Parser、Schema、OpenAPI、Generated Client、Golden、Mutation 与 Scope Gate
- 结论：**PASS**
- 限定：只证明 G2-03-02 的合同与生成链，不宣称数据库、Policy 执行、Runtime HTTP 或 Web 已实现

## 1. 验收逐条对照

| 原始意图                              | 实际强制点                                                                                         | 可执行证据                                                                   | 未实现边界                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| Query AST 有限且拒绝未知写字段        | 严格 Parser；固定 Operator、Select/Search/Where/Sort/Page/Count/Link；Depth/Count/List/Page 上限   | Query 正反向、深度 6、501 Page/Collection、Raw Field、Injection-as-data 测试 | 尚无 SQL Compiler/Executor，归 03-07                |
| Identity 只传受信摘要                 | 复用严格 `IdentityDelegationSummary`；固定 `intersection`；无 Bearer/Raw Claims 字段               | Raw Claims 负测、五 Actor Policy Vector                                      | 尚无生产 OIDC/Claim Mapping/Delegation，归 03-03/04 |
| Policy 覆盖目标且 IR 有界确定         | Resource/Object/Property/Link/Action Target；有限 Predicate；一跳 Link；Artifact 绑定与发布向量    | Raw SQL/嵌套 Link/Trace 负测；allow/deny/null/missing/mask/deny 向量         | 尚无 Resource 激活/Compiler/Gateway，归 03-05/06    |
| Cursor 只能服务端解析且防重放上下文   | Envelope 绑定 Release/Activation/Generation/Query/Policy/Identity/Sort/Key/Expiry；AEAD Reference  | Tamper、Expiry、Context Change、未知 Key 与不透明载荷测试                    | Key Store/Rotation/Lease/生产接入归 03-03/09        |
| Response 区分字段状态且不泄露规则     | `value/null/missing/masked/restricted` 五态；masked/restricted 不含真实值且不可查询；无 Rule Trace | Metadata Capability、泄露载荷、Decision Trace 负测                           | Serializer 与真数据读取归 03-08                     |
| 核心错误分类自洽                      | JSON Catalog 与 TS Runtime Classification 同源核对，新增 6 个错误，总计 22                         | Foundation Compatibility 与分类测试                                          | HTTP 映射归 03-12                                   |
| OpenAPI/Schema/Parser 不漂移          | Parser 字段常量生成 Schema；公共根生成 OpenAPI；内部合同不发布                                     | Required/Enum/Limit/Nullability mutation、Path 删除测试                      | 真 Route 尚不存在                                   |
| Client 可重现且 Web 不手写 DTO        | Source/Distribution 零 Diff、Client Compile、严格 Web 包入口 Compile、运行时动态导入               | 5 Operation/17 Source/34 Distribution Artifact；Search 调用 Witness          | 浏览器真 HTTP 消费归 03-13                          |
| Golden 足够代表产品语义               | WorkItem/Order、5 Actor、Empty/Null/Missing/Mask/Deny/Cursor/Unknown/Limit/Injection               | Golden Checker + 行为测试                                                    | 不是生产容量/时序数据                               |
| Breaking Change 与 Candidate 声明明确 | Schema/OpenAPI Baseline、Breaking Diff；Spec `-candidate`，Client `private`                        | 删除/改名/类型/必填/Enum/Limit/Nullability测试与 Evidence Gate               | 不构成外部 SDK 支持承诺                             |

## 2. 承重不变量映射

| 不变量                       | 实现位置                                                  | 故意失败方式                                          |
| ---------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| 客户值永不成为代码/SQL       | Query Scalar 只位于有限 AST 的 `value`                    | Injection Payload 保持原数据；`rawSql` 未知字段失败   |
| Service 不扩大 User 权限     | Identity 固定 `authorizationMode=intersection`            | Raw Claims/额外身份字段失败                           |
| Policy 不能执行任意程序      | Closed Predicate/Operand Union + 深度/数量上限            | Raw SQL、未知 Kind、嵌套 `link_exists` 失败           |
| 隐藏字段没有查询侧信道       | Metadata disposition 与 Capability 语义检查               | Masked Property 带 Filter Operator 失败               |
| Mask 不等于 Null/Missing     | 五个互斥 Property Result Variant                          | Mask 携带真实值、Null 缺 `null` 都失败                |
| Cursor 不延长旧 Allow        | Context Hash + Expiry + Key Version + AEAD                | 改 Policy Hash、篡改 Token、过期时间失败              |
| 公共 HTTP 不泄露内部授权结构 | OpenAPI Root Closure 排除 Identity/Policy/Cursor Envelope | 内部 Definition 出现在 Components 时合同 Gate 失败    |
| 前后端不能静默漂移           | 单字段源生成与零 Diff                                     | Required/Enum/Limit/Nullability 或 Path Mutation 失败 |

## 3. 实现中发现并关闭的偏差

1. **只写 TypeScript 类型不能证明运行时边界。** 每个合同同时提供严格 Parser、机器 Schema 和 Golden，未知字段与语义组合均在运行前拒绝。
2. **JSON Schema 结构正确不等于语义安全。** Mask/Restricted Payload、Metadata Capability、Policy Vector Coverage、Cursor 时间与排序绑定仍由 Parser 做二层语义验证，Golden 记录 Schema/Parser disposition。
3. **OpenAPI 全量导出会泄露内部 Policy/Identity/Cursor。** 生成器只从八个公共 Request/Response Root 收集闭包，再合入 Foundation Error Envelope；四个内部合同有显式排除断言。
4. **生成器自己的传输源码不满足 TS6 exact optional。** 没有关闭根工程严格度，也没有修补生成文件；源码隔离编译为确定性 JS 与声明，包根只暴露 Distribution，并以 `exactOptionalPropertyTypes=true` 的 Web 形状消费者创建 Client、调用 Search、穷举五态，再动态导入核对运行时导出。
5. **仅比较 Schema 不会发现 Path 被改名。** 增加 OpenAPI Method+Path 基线检查，Path 删除/改名与 Schema breaking 都阻断。
6. **Cursor 只有 JSON Envelope 不能证明不透明或防篡改。** 增加 AES-256-GCM Reference，Token 外层只有 Base64URL 密文，并运行 Tamper/Expiry/Context 测试；同时明确它还不是生产 Key Management。
7. **历史 Gate 不会自动接纳新正式包。** Foundation、G2-02、G2-03-01 Scope 只向前加入 contracts/runtime-read-client/tools-contracts，仍禁止 Migration、Web 和正式 Query/Policy/Identity 包。
8. **可编译的 OpenAPI 仍可能接错 DTO。** Compatibility 现在除 Path/Method 外还锁定 Operation ID、Parameter、Request/Response Schema 和 OIDC Scope，Search 误接 Count 的 Mutation 会失败。
9. **Policy 时间和 Cursor null 必须是显式数据。** Policy Vector 必须携带 Canonical `requestTime`；Cursor Last Value 允许 null，且最大合法 Envelope 能在有界 opaque Token 内完成 AEAD 往返。
10. **历史 Scope 漏项不应在 30 分钟 clean-room 后才暴露。** G2-03-02 Evidence 现同时检查 G2-03-01 的 Prefix 与三个精确下游路径，并被前移到重型容量、数据库和 clean-room Gate 之前执行。

## 4. 可落地性审计

本合同没有提前绑定数据库表名或 Adapter DTO。G2-03-03 可以实现持久事实，G2-03-07 可以把有限 AST 编译为参数 SQL，G2-03-08～10 可以实现 Get/Search/Count/Link，G2-03-12 可以直接把同一 OpenAPI Candidate 接入 Route，G2-03-13 可以消费现有 Generated Client。后续每层新增实现，不需要改写本任务的公共字段才能形成主路径。

仍可能发生兼容演进，但不会以“大规模二次开发”的方式隐藏：任何删字段、改名、类型/必填/枚举/空值/限制变化都会先在 Baseline Gate 失败；如确有必要，必须显式升 Schema Version、生成新 Client 并迁移消费者。

## 5. 明确保留的差距

- 没有 0022+ Migration、RLS、Grant、Policy Artifact 表或 Query Lease；下一项 03-03。
- 没有生产 Bearer 验证、Claim Mapping、Delegation Replay Protection；03-04。
- 没有 Policy Resource/Compiler/Gateway 或 5 秒撤权；03-05/06。
- 没有参数化 SQL、Execution Context、Get/Search/Count/Link；03-07～10。
- 没有 HTTP/OIDC/Timeout/Abort/Rate Limit 或生成 Client 真请求；03-12。
- 没有 `apps/web`、产品 UI、浏览器可访问性或用户闭环；03-13。
- 没有 100k/1m Query SLO、并发、泄露统计或 G2-03 clean-room；03-09/11/14/15。

## 6. 结论

实现与 G2-03-02 意图一致，且没有通过增加 Endpoint、Migration 或 UI 越过顺序 Gate。PASS 只有在同一 commit 的 37 道 `npm run verify` 与 `g2-03-02-evidence-manifest.json=CLEAN_ROOM_PASS` 后成立；完成后只放行 G2-03-03。
