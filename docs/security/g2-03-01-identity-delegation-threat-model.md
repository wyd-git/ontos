# G2-03-01 Runtime Identity / Delegation 威胁模型

- 日期：2026-08-18
- 状态：Frozen for G2-03-01
- Owner：Security / Identity / Runtime
- 适用范围：Runtime Read 的 human、service、trusted delegation、Policy Context、Cursor 与审计边界
- 非范围：生产 IdP 采购、密钥托管实施、正式 Token Exchange Endpoint 和 G2-03 Migration

## 1. 需要保护的资产

- Principal 真实身份、human/service 类型、disabled 状态与 Project 权限；
- Delegation actor / subject 链、Service Capability、Nonce/JTI 与 Proof-of-Possession 绑定；
- Policy Artifact Digest、Compiler Version、Authorization Epoch 与 Policy Context Hash；
- Serving Release、Activation、Generation、Query Lease 和 Cursor 密钥；
- Object/Link 存在性、数量、Property 值和隐藏的 Metadata；
- Bearer、Delegation Credential、Raw Claims 与可关联个人的日志信息。

## 2. 信任区域与对手

```text
untrusted browser / caller
  → public TLS + Runtime HTTP limits
  → trusted token verification adapter
  → Identity Application + Principal facts
  → Policy Gateway + Query Application
  → least-privilege PostgreSQL adapter
```

浏览器、请求 Header/Body/URL、未验证 JWT Claim、Cursor 和 OpenAPI 客户端都是不受信输入。OIDC Issuer 只在签名、Issuer、Audience、Algorithm、时效和 Scope 全部验证后提供有限信任。Principal Type、Project Binding、Service Allowlist、Policy Artifact 和 Epoch 以服务端 Kernel 事实为准。

假设对手能控制普通 Browser/Client、重放被窃 Token/Cursor、猜测 Object Key、伪造 Header/Claim/Delegation，并能观察 HTTP 状态、响应大小、时序、Log/Trace 与多次 Count/Link 结果。不假设对手已获得 Migration Owner 或 IdP 签名私钥；那属于基础设施泄露事件。

## 3. 威胁、缓解与验证

| ID  | 威胁                                                     | 主要缓解                                                           | G2-03-01 证据                         | 后续 Gate                 |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------- | ------------------------- |
| T01 | 伪造 `principalId` / effective user Header               | 禁止客户端身份 Header；只从验签 Claim + Principal Store 解析       | Trust-boundary 负测                   | 03-04 HTTP 集成           |
| T02 | 将 human 自报为 service 或反之                           | Identity Type 来自 Kernel 事实，与 client/subject 约束匹配         | 自报类型拒绝                          | 03-03/04 Migration + OIDC |
| T03 | 错 Issuer/Audience、过期或 disabled Principal            | 严格验签、时效、Scope；服务端 disabled 事实                        | wrong issuer/aud/expiry/disabled 向量 | 03-04 真 IdP              |
| T04 | 注入未白名单 Raw Claim 影响 Policy                       | 版本化 Claim Mapping、类型/长度/数量上限和 fingerprint             | RuntimeIdentity 不携 Raw Claim        | 03-04                     |
| T05 | Service 藉委托获得用户没有的权限                         | service ∩ subject ∩ chain 交集，Service Capability allowlist       | service elevation 负测                | 03-04/06                  |
| T06 | Browser Header 伪造 Delegation                           | 委托只来自受信 Token Exchange 凭据，Header/Body 不是事实           | delegation assertion forbidden        | 03-04                     |
| T07 | 修改 actor/subject/audience 或链长                       | 验签 actor (`act`)、subject、audience、issuer/signer 和最大链长    | 结构化委托校验                        | 03-04                     |
| T08 | 窃取 Bearer 后在别的客户端重放                           | 短 TTL + DPoP/等价 PoP thumbprint                                  | missing PoP 负测                      | 03-04 真 DPoP             |
| T09 | 同一委托凭据重放                                         | 服务端 JTI/Nonce replay port，有界保留                             | replay 负测                           | 03-03/04 持久化           |
| T10 | 过长 TTL 使撤权无法生效                                  | 委托硬 TTL 上限；Epoch 与缓存最迟 5 秒 fail closed                 | overlong TTL 负测                     | 03-04/06                  |
| T11 | Token / Claim / Delegation 泄露到 URL、Log、Trace、Error | Bearer 只存于 Adapter；后续层仅 fingerprint/ref；通用脱敏          | 输出结构无 Token                      | 03-04/12 日志突变         |
| T12 | 伪造或篡改 Cursor 跨 Actor/Query 读数据                  | AEAD、Key Version、TTL，绑定 identity/policy/query/release/sort    | ADR 协议冻结                          | 03-02/09 破坏向量         |
| T13 | Cursor 携带 Raw Claim/Policy/业务值                      | 最小封装；服务端认证加密；日志不记录 Cursor                        | ADR 字段白名单                        | 03-02/09                  |
| T14 | 替换 Published Policy Artifact 或用“最新” Artifact       | Revision + digest + compiler version + Release 精确绑定；不回退    | Execution Context 绑定                | 03-03/05/06               |
| T15 | 撤权后缓存继续 allow                                     | Epoch 与授权事实同事务；单调时钟硬 TTL `<=5s`；依赖失败 deny       | ADR-012 语义 + context epoch          | 03-06 双进程撤权          |
| T16 | Policy 放到分页/计数后，泄露总数                         | Object/Link predicate 在 SQL WHERE，位于 sort/limit/count 前       | Compiler 单测 + PG Explain            | 03-07/09/10               |
| T17 | deny/mask Property 通过 Filter/Sort/Search 探测          | Metadata Capability + Property Policy 双检；拒绝客户条件           | denied-property filter 负测           | 03-07/11                  |
| T18 | SQL 注入或领域 Identifier 旁路                           | 有界 AST，值全参数化，Identifier/Operator 服务端白名单             | injection 向量                        | 03-07                     |
| T19 | Link 先查边再过滤目标，泄露隐藏对象                      | 同一 SQL 合并 edge/source/target Policy 和 Generation              | one-hop SQL Spike                     | 03-10/11                  |
| T20 | Cutover/GC 中读到混合代或已回收代                        | Context resolve once + committed Query Lease 作 GC Root            | Lease Harness + PG resolver           | 03-03/08/14               |
| T21 | 伪造 Lease 或 Cursor 延长数据保留                        | 只有 committed/unexpired 服务端 Lease 是 Root；Cursor 不是 Root    | generationRootsFromLeases 单测        | 03-03                     |
| T22 | 通过 404/403/Error Detail 区分隐藏与不存在               | 公开响应同形，内部 reason 不返回                                   | 合同决策                              | 03-08/11/12               |
| T23 | Web 绕过 API 或复制授权                                  | Web 只导入 generated client；边界扫描禁止 `@ontos/*`               | Consumer boundary Gate                | 03-13                     |
| T24 | OpenAPI 漂移导致客户端错解权限/空值                      | 规范重生成零 Diff；Required/Enum/Nullability mutation 必须编译失败 | 3 个 mutation Gate                    | 03-02/12                  |

## 4. 不可记录与不可传递的数据

下列内容不得进入 Application DTO、Error、Log、Trace、Metric Label、Evidence Artifact、Cursor 或前端状态：

- Authorization Bearer、Refresh Token、Delegation Token、DPoP private material；
- Raw JWT、Raw Claims、完整 Subject、可逆的个人属性；
- Policy AST、生成 SQL 内的真实业务参数、Mask 前值；
- 未授权 Object/Link/Property 的存在性、内部 Deny 原因或规则细节。

可记录字段限于服务端 Correlation Ref、不可逆 Project Ref、粗粒度 Decision/Error Code、Cache Outcome、延迟和不包含业务值的 Query Shape Digest。

## 5. 密钥、撤权与故障策略

- OIDC 验签密钥、Delegation signer 和 Cursor AEAD Key 是三个分离用途，不共用密钥。
- Cursor Key Ring 保留旧 decrypt key 不超过最长 Cursor TTL；遗失 current key 时旧 Cursor 失效，不使用固定默认 key。
- Principal disable、Binding/Claim Mapping/Policy 切换必须与 Epoch 推进同事务；NOTIFY 只加速失效，不承担正确性。
- OIDC/Principal/Policy/Epoch/Lease/Key 任一依赖无法确认时 deny，不回退到 stale allow、“最新” Artifact 或无 Policy 查询。

## 6. 安全停止条件

发现以下任一情况时停止 G2-03 下游实现：

1. 任一 Runtime 路径需信任客户自报 Principal/Type/Delegation；
2. Service 权限无法与终端用户及委托链取交集；
3. 委托无法强制短 TTL、PoP 或重放防护；
4. Policy 只能应用层后过滤，或 Count/Link/Cursor 可泄露隐藏数据；
5. Artifact / Epoch / Key / Lease 失效时必须继续 stale allow；
6. Bearer、Raw Claim、Delegation Credential 或业务值必须进入可持久证据。

## 7. 剩余风险

- G2-03-01 的 Trust Boundary 是可执行内存 Harness，尚未连接生产 IdP、JWKS 轮换、Token Exchange Endpoint 或持久 Replay Store；由 G2-03-03/04 关闭。
- Cursor 封装在本 Gate 只冻结协议，密码实现和密钥轮换向量由 G2-03-02/09 关闭。
- 同形错误不等于数学等时；时序侧信道需在 G2-03-11/14 用真实 HTTP 和统计样本评估。
