# ADR-025：typed Query AST 与参数化 PostgreSQL Compiler

- 状态：Accepted for G2-03-07
- 日期：2026-08-20
- Owner：Query / PostgreSQL / Security（accountable: `wyd-git`）
- 依赖：[ADR-020](020-query-policy-identity-consumer-boundary.md)、[ADR-021](021-query-policy-persistence-boundary.md)、[ADR-024](024-production-policy-gateway-revocation.md)
- 决策范围：G2-03-07 的 Query Parser、Schema Registry、Policy Predicate 组合、SQL Renderer 与有界 Executor

## 1. 决策结论

G2-03-07 建立唯一正式 Query 编译链：

```text
strict @ontos/contracts Query Parser
→ release-bound Query Schema Registry
→ public @ontos/value-codec canonical values
→ normalized typed Query + stable Query Hash + complexity budget
→ exact PolicyGatewayContext rules / actor attributes
→ typed client + object/property/link Policy predicate plan
→ fixed PostgreSQL Renderer
→ branded statement + read-only bounded Executor
```

正式代码分为三个包：

| 包                         | 责任                                                                       | 明确禁止                                    |
| -------------------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| `@ontos/query-domain`      | Schema Registry、类型检查、规范化、Hash、复杂度和 typed logical plan       | PostgreSQL、HTTP、Raw SQL、G1 运行代码      |
| `@ontos/query-application` | 校验 Policy Gateway 与 Release/Object Binding，定义 Compiler/Executor Port | Route、页面 DTO、直接 SQL                   |
| `@ontos/query-postgres`    | 唯一固定 SQL Renderer、参数绑定、只读事务、Timeout/Abort/Row/Byte 限额     | 客户 SQL、动态表名、领域分支、Policy 后过滤 |

G2-03-07 不新增数据库事实。它只读取调用方已解析并绑定的 Project、Release、Activation、Object/Link Revision 与 Current Generation。G2-03-08 才实现真实 Execution Context Resolver、Query Lease、Runtime Metadata 与 Object Get；G2-03-09/10 才关闭签名 Cursor、全部 Search 语义和一/二跳产品路径。

## 2. 不可绕过的输入边界

1. Public AST 必须先通过 `@ontos/contracts` 严格 Parser；未知字段、非有限 Number、过深、过多、过大集合和 Page 上限在 SQL 前失败。
2. Schema Registry 只从同一 Project/Release/Activation 的 Published Object/Link Revision 构建；API Name、Resource、Revision、Member 与 Generation 必须一一对应。
3. Property 名只用于查找 Registry 中的服务器事实。客户字符串不能成为 SQL Identifier、Operator、JSON Path 或 Fragment。
4. Integer、Decimal、Date、Timestamp、Enum、Boolean、String 和 String Array 全部通过 `@ontos/value-codec` 规范化；整数/小数不接受 JavaScript Number 或指数/浮点近似。
5. Query Hash 包含 Compiler Version、Operation、Project、Release Revision、Object/Link Revision、规范 AST、Select、有效 Sort 和 Page Size；不包含 opaque Cursor 或 Policy 规则正文。Policy/Identity/Generation 另由 Cursor Context 的独立绑定项保护。

## 3. Policy 与 Property 语义

Gateway `ALLOW` 不是最终业务行 Allow。Query Domain 对精确 Target 采用与 Policy Evaluator 一致的规则：

- Object/Link：至少一个 `allow` Predicate 为真且没有 `deny` Predicate 为真；未匹配默认拒绝；
- Property：`deny` 优先，其次 `mask`，再其次 `allow`；未匹配返回 `restricted`；
- Client Filter/Sort/Search 只有在 Metadata Capability 为真且该行 Property 的有效 Decision 为 `allow` 时参与；mask/deny 的真实值不会进入 Filter、Sort、Search 或数据库返回行；
- Client Predicate、Object Policy 与 Property Access Predicate 位于同一 SQL `WHERE`，先于 `ORDER BY`、`LIMIT` 与 `COUNT`；
- Policy `link_exists` 只使用 Artifact 中的精确 Link/Target Resource Revision 与 Registry 中同一 Activation 的 Generation，继续禁止递归 Link。

SQL Projection 对每个选择字段在数据库内形成 `value|null|missing|masked|restricted` 中间状态。Mask/Deny 分支不返回原始 JSON Value；G2-03-08 Serializer 仍需执行第二道合同防御。

## 4. SQL 生成约束

- 表、列、Alias、Operator 和 Cast 来自固定 Renderer 分支；没有输入 Raw SQL 的 Port；
- Project、Generation、Resource/Revision、Canonical Key、客户值、Actor Attribute、Request Time、Mask Display 与 Limit 都使用 PostgreSQL `$n` 参数；
- Property JSON Path 只由已经严格验证的 Metadata API Name生成，并以受控 SQL Literal 形成与 Published Expression Index 一致的表达式；
- Scalar 使用 `text/boolean/bigint/numeric/date/timestamptz`；集合使用类型数组；String Array `containsAny` 使用参数化 JSONB containment 组合；
- 每条 Current Query 必须同时绑定 Project、Generation、Resource、Revision 和 `lifecycle_state='active'`，禁止读取 Base、`max(generation)` 或“最新”Revision；
- Statement 必须由正式 Renderer 在本进程创建并带不可伪造运行时品牌；Executor 不接受任意 `{text, values}` 对象。

## 5. 资源与取消边界

Domain 同时执行合同上限和加权复杂度预算。SQL Renderer 另限制参数数量和 SQL UTF-8 字节数。Executor：

1. 使用 `REPEATABLE READ READ ONLY`；
2. 通过参数化 `set_config` 设置本地 Statement/Lock/Idle-in-Transaction Timeout；
3. 检查最大返回行与序列化字节；
4. Abort 时销毁正在执行的连接，使 PostgreSQL 终止 Backend Query；Pool 随后以新/健康连接继续使用；
5. Timeout、Abort、连接错误、超限都不返回部分业务结果，也不自动重试。

## 6. Enum、Search 与索引的当前边界

- Enum 比较值使用声明 Code List 校验；Enum 排序必须保持声明顺序，不能把 PostgreSQL `text COLLATE C` 字母顺序误报为业务顺序。若需要声明序表达式排序，正确性优先于错误复用文本顺序索引。
- G2-03-07 为 `contains/prefix/searchText` 生成固定 Collation 下的参数化候选 SQL。完整 Unicode Case Folding、相关性、Cursor 与该语义的 10k/100k 性能资格属于 G2-03-09；本项不提前宣称关闭。
- 本 Gate 的固定 Corpus 必须在真实 PostgreSQL 16、G2-02 Published Index Plan 和 Current Generation 上证明 Get/List/Policy/Count/one-hop Candidate 没有未解释的 Current 表顺序扫描。

## 7. 范围与后续

本项明确不实现：

- Runtime HTTP Route、OIDC 组合、Generated Client 调用或 Web；
- Release/Activation Resolver、Query Lease 生命周期与公共 Get Response；
- opaque Cursor 解密/签名、跨页语义、完整 Search/Count 产品用例；
- 二跳 Link 产品路径、Action/Function/Export 或任何写入；
- 新 Migration、DB Role 或对 `api_runtime` 的 Current 表 Grant。

G2-03-07 通过后只放行 G2-03-08。任何需要 Route 拼 SQL、Policy 后过滤、浏览器过滤受限字段、G1 Runtime Import 或领域 API Name 分支的实现都使本 Gate 失败。
