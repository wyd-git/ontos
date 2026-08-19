# G2-03-04 Intended-vs-Implemented 复审

- 日期：2026-08-19
- 方法：从任务包八条 Acceptance、ADR-020/022 与威胁 T01～T11 反向追踪到实际强制点和破坏性向量
- 结论：**PASS**
- 限定：证明正式 Runtime Identity 建立与 Delegation 交集，不宣称 Policy Compiler/Gateway、Query Endpoint、产品 UI 或生产 IdP/密钥托管已经完成

## 1. 逐条对照

| 原始意图                                                                | 实际强制点                                                                                                                                 | 可执行证据                                                                                      | 结果 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---- |
| 错 Issuer/Audience/Algorithm/Scope/时间/尺寸在数据查询前拒绝            | API Adapter 固定 Issuer/Audience/Algorithm/`at+jwt`/Scope、16 KiB Bearer、12 KiB Claims、`iat/nbf/exp`                                     | 真 HTTP Discovery/JWKS/RS256；wrong issuer/aud/HS256/scope/expiry/future/nbf/type/size 负测     | 一致 |
| Principal Type/State/Client/Subject 是 Kernel 事实                      | Runtime Resolver 只 SELECT 已有 `(issuer,subject)`；Type 不可变；Human Client 配置、Service Client Profile 双重约束；未知不 auto-provision | Human/Service 正测，未知计数不变、Disabled、Client mismatch、Type 历史负测                      | 一致 |
| Claim Mapping 只有白名单、有界且 Fingerprint 确定                       | v1 严格字段、协议 Claim 黑名单、32 Attribute/类型/字节/数组/总值上限；规范排序；Digest 二次校验                                            | 未映射 admin Claim 不被读取/输出；错误类型/超长/重复负测；同 Mapping 规范结果稳定               | 一致 |
| Mapping 变更产生新 Revision、Epoch 与脱敏审计                           | 复用不可变 Revision/Head；0025 前向替换受控激活函数并追加 Audit；事件不含 Issuer/Mapping/Claim                                             | 两次 Mapping + Service Mapping 共三事件；旧 Revision 内容未变；Epoch +1；Owner 改历史返回 55000 | 一致 |
| Delegation 校验来源、链、TTL、Replay、PoP 和 Capability                 | 签名 `act`、最大链、唯一 Subject；120 秒 TTL；真实 ES256 DPoP `htm/htu/ath/cnf.jkt`；Kernel Capability 子集；PG 唯一 Replay                | 缺/错 DPoP、过深链、过长 TTL、Capability escalation、伪造 Header、两个独立 API 进程重放         | 一致 |
| Effective Permission 是全链交集且同形 Deny                              | Identity Application 固定有序 Principal 集；Domain 要求每个 Principal 一份 Grant 后取集合交集；失败只返回 ALLOW/DENY                       | Service 有 read/write、Human 只有 read：read Allow、write Deny；缺一环仍同形 Deny               | 一致 |
| Context/Error/Evidence 不携带 Credential/Raw Claims                     | Raw JWT/Issuer/Subject/Claims 只在 API Adapter 闭包；Application 只收精简 Mapping 结果/事实操作；错误单一 Code/Message                     | Context 字段断言、JSON 泄露负测、Replay/Audit 列白名单、Secret Gate                             | 一致 |
| 真 OIDC 覆盖 human/service/delegated/disabled/mapping/revocation/双进程 | 本地真实 OIDC HTTP Discovery/JWKS、PostgreSQL 16、两个独立 Node 子进程与独立 Pool                                                          | `test:runtime-identity:postgres` 完整场景                                                       | 一致 |

## 2. 承重不变量

| 不变量                            | 强制位置                                                           | 故意破坏的结果                                                     |
| --------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Runtime 不创建陌生身份            | `resolve_runtime_principal` + Postgres Repository 行数完整性       | Unknown Subject 无行，统一 Authentication Failed，Principal 数不变 |
| Human 不能伪造成 Service          | Principal Type Immutable Trigger + Application 类型/协议形状       | 改 Type 失败；Human 携带 Service Capability 仍失败                 |
| Raw Claims 不越过 Adapter         | `mapClaims` 闭包只按已解析 Mapping 调用 Domain                     | 未映射 Claim 无读取、无 Context/Fixture 输出                       |
| Mapping Digest 不能替换           | Application 对规范 Mapping 重新 Hash                               | DB JSON 与 Digest 不一致即 fail closed                             |
| Service 不能代表用户扩权          | Client/Profile/Capability 校验 + Principal Permission Intersection | Service 多出的 Permission 不进入有效集合                           |
| DPoP 不能借给另一请求             | `cnf.jkt` + Proof Signature + `htm/htu/ath`                        | URL、方法、Access Token 或 Key 不同即失败                          |
| Replay 跨进程只成功一次           | PG 全局 Fingerprint PK + `ON CONFLICT DO NOTHING`                  | 第一 API 进程成功，第二独立进程同形失败                            |
| Mapping/Capability 撤权推进 Epoch | Mapping/Profile 受控函数与 Trigger 调用既有 Epoch Port             | 事实与 Epoch 同事务；失败不留下部分状态                            |

## 3. 攻击者—受害者—修复核验

1. **攻击者：普通浏览器；受害者：目标用户/Project。** Header 自报 Principal/Type/Delegation 会在验签前被拒绝，不能到 Repository。
2. **攻击者：持有合法 Human Token 的用户；受害者：Service 权限。** Kernel 查到的 Type 是 Human；Token 自带 Capability 不会改变类型，反而使 Human 形状失败。
3. **攻击者：持有一次合法委托凭据的人；受害者：终端用户数据权限。** DPoP 限制 Key/方法/URL/Token，PG JTI/Proof Fingerprint 使第二进程重放失败。
4. **攻击者：控制任意未映射 Claim 的 IdP 用户；受害者：Policy Actor Context。** Mapping 只读取发布白名单；未知 Claim 不参与 Fingerprint 或输出。
5. **攻击者：被撤销 Service；受害者：Project。** Profile 状态来自同一数据库快照；下一次身份建立直接失败，后续 5 秒缓存撤权由 G2-03-06 继续验证。

## 4. 未夸大的剩余边界

- 真实 HTTP Runtime Endpoint 尚未创建，因此当前结构性证明“Credential 不进输出/Artifact”，正式 Route Log/Trace/Error 突变在 G2-03-12 复跑；
- 本地 Provider 是真实签名、Discovery 和 JWKS 协议，不等于已采购生产 IdP、HSM 或完成密钥轮换演练；
- Identity 交集原语已实现，实际 Object/Property/Link Permission Facts 由 G2-03-05/06 的 Policy Compiler/Gateway 提供；
- Replay 有机会清理和 Worker prune Port，正式调度、指标和告警属于后续 Operations；
- 当前 Service Profile v1 的 Client/Capability 创建后不可改，撤销后如需变化应创建新 Service Principal/Profile，不提供原地扩权。

## 5. 结论

未发现需要信任客户端 Principal/Type/Claim/Delegation、无法取权限交集、无法强制 TTL/DPoP/Replay，或必须持久化 Credential 的停止条件。实现没有创建 Query Endpoint、Policy Compiler、Action 或 UI。只有同一 Commit 的 `g2-03-04-evidence-manifest.json=CLEAN_ROOM_PASS` 才使本结论正式成立；随后只放行 G2-03-05。
