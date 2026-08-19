# ADR-022：Runtime Identity、Claim Mapping、Service Capability 与 Delegation 边界

- 状态：Accepted for G2-03-04
- 日期：2026-08-19
- 决策范围：`identity-domain`、`identity-application`、`identity-postgres`、Runtime OIDC/DPoP Adapter 与 Migration `0025`
- 上游：[ADR-020](020-query-policy-identity-consumer-boundary.md)、[ADR-021](021-query-policy-persistence-boundary.md)、[Identity/Delegation 威胁模型](../../security/g2-03-01-identity-delegation-threat-model.md)

## 1. 决策

Runtime 身份只允许一条受信路径：

```text
Authorization Bearer + request method/URL + optional DPoP
  → API OIDC Adapter 验签与协议校验
  → PostgreSQL 解析 Kernel Principal/Type/State/Project Binding
  → Active Claim Mapping 白名单求值
  → Service Client/Capability 与 Delegation Chain 校验
  → 跨进程 Replay 原子消费
  → compact RuntimeIdentityContext(intersection)
```

Admin OIDC 会自动登记首次出现的 Principal，不能复用于 Runtime。Runtime 路径只解析已经存在的 Kernel Principal；未知、Disabled、无 Project Binding 或事实不完整时一律失败，不自动创建身份。

正式责任分为三层：

- `@ontos/identity-domain`：Claim Mapping 语义、输入上限和权限交集；不依赖 JWT、HTTP 或 PostgreSQL；
- `@ontos/identity-application`：唯一 Identity 用例、Repository/Crypto Port、同形失败和精简 Context；
- `@ontos/identity-postgres`：同一 `REPEATABLE READ READ ONLY` 快照内解析 Principal 与 Active Mapping，并原子消费 Replay；
- `apps/api/src/runtime-oidc.ts`：Bearer、JWKS、OIDC、Token Exchange `act`、Capability Claim 和真实 DPoP 验证。它不创建 Runtime Endpoint；HTTP Endpoint 仍属于 G2-03-12。

## 2. OIDC 与客户端约束

Runtime Bearer 最大 16 KiB，只接受配置的 Issuer、精确 Audience、显式 Algorithm allowlist、`at+jwt`、专用 `ontos.runtime` Scope、有效 `iat/nbf/exp` 和有界 Subject/Client/Claim。Issuer Discovery 与 JWKS 只允许 HTTPS；本机测试 Provider 例外使用 loopback HTTP。

Human 的 `azp|client_id` 必须属于服务端配置的浏览器 Client allowlist。Service 的类型、Subject、Project Binding、Client ID 和 Capability 全部来自 Kernel 事实；Token 只能请求 Capability 子集，不能声明 `principalId`、`identityType` 或扩大 allowlist。

普通 Header 中的 `X-Ontos-Principal-Id`、`X-Ontos-Identity-Type`、`X-Ontos-Effective-User`、`X-Ontos-Delegation` 与 `X-Ontos-Delegated-*` 均直接拒绝。浏览器不能通过 Header、Body 或 URL 创建委托。

## 3. Claim Mapping v1

Claim Mapping 是 `0022` 已有的不可变 Revision + CAS Head。G2-03-04 固定最小 v1：

```json
{
  "schemaVersion": 1,
  "attributes": [
    {
      "claim": "region",
      "attribute": "region",
      "valueType": "string",
      "required": true
    }
  ]
}
```

规则如下：

- 最多 32 个唯一 Claim/Attribute；只支持 `string`、`string_array`、`boolean`；
- 协议 Claim（`iss/sub/aud/iat/exp/nbf/jti/act/cnf/scope/azp/client_id/ontos_capabilities`）不能映射为业务 Attribute；
- String 最大 256 UTF-8 字节，Array 最多 32 个唯一值，总映射值最多 128，规范结果最大 16 KiB；
- Array 排序、Attribute 按名称排序，Fingerprint 绑定 Mapping Revision、Mapping Digest 和规范 Attribute；
- 未发布/未映射 Claim 从未进入 Application。API Adapter 用闭包封装 Raw JWT、Issuer、Subject 与 Claims，只向 Application 暴露“按已解析 Mapping 返回精简 Attribute”和“通过 Repository 解析事实”的受信操作；这些原始值不出现在 Application DTO/Context。

Mapping Head 真正变化时，`0025` 保留既有 Epoch/CAS 语义并追加 `audit.claim_mapping_activation_events`。事件只含 Project、Identity Type、旧/新 Revision、Digest、Sequence 与结果 Epoch，不保存 Issuer、Mapping JSON、Subject 或 Claim。

## 4. Delegation 与 DPoP

Delegation 使用受信 Issuer 签发的 OAuth 2.0 Token Exchange `act` 语义：顶层 `sub` 是终端 Human，嵌套 `act.sub` 是有序 Service Chain。当前支持最多 15 个 Service Actor，总 Principal 数最多 16，禁止重复 Subject/Principal 和环。

每个 Delegation 必须同时满足：

- 精确 Runtime Audience/Scope/Signer，TTL 不超过 120 秒，并有 `jti`；
- Immediate Actor 的 Kernel Service Client 与 `azp|client_id` 一致；链中所有 Actor 都是 Active Service、有 Project Binding，且都允许 Token 请求的每项 Capability；
- `cnf.jkt` 绑定真实 ES256 DPoP Public JWK；Proof 校验 `typ/alg/jwk/iat/jti/htm/htu/ath`，私钥不进入服务端；
- Token JTI、DPoP JTI、Issuer 与 Key Thumbprint 形成不可逆 Replay Fingerprint，由 PostgreSQL 全局唯一键原子消费；不同 API 进程不能各自重放成功；
- Replay 表只保存 Fingerprint、Project 和有界过期时间；请求时机会清理过期行，Worker 另有最大 10,000 行的有界 prune 函数。

当前接受受信 IdP 已签发的 Token Exchange Credential，不在本项建设 Token Exchange 签发 Endpoint、密钥托管产品或浏览器 Service Credential。

## 5. Permission Intersection 与输出

直接 Human/Service 的授权 Principal 集只有自身。Delegation 的有序集合是：

```text
immediate service actor → nested service actors → terminal human
```

Identity 层提供唯一交集原语，要求每个预期 Principal 都恰好有一份可信 Permission Grant：

```text
effective permissions = P(actor) ∩ P(chain...) ∩ P(terminal user)
```

缺任一 Principal、输入重复、Capability 不允许或任一集合不含目标 Permission，结果都只有 `{decision:"DENY"}`，不返回拒绝发生在哪一环。G2-03-06 的 Policy Gateway 必须消费这组 Principal 和同一交集语义，不能另写“Service 代表用户”的并集或覆盖逻辑。

Application 输出只包含 Foundation `IdentityDelegationSummary`、映射后的 Attribute、请求 Capability 和 Principal UUID 集合。Bearer、Raw JWT、Raw Claims、Issuer、完整 Subject、DPoP/Delegation Credential、JTI 与内部拒绝原因均不在 Context、Error 或 Evidence Artifact 中。

## 6. Migration `0025`

`0025_runtime_identity_boundary.sql` 只增加无法用已有事实正确表达的三类持久数据：

- `authz.service_identity_profiles`：Project 内不可变 Service Client/Capability allowlist；只允许 Active→Revoked，不原地换 Client/Capability；有效变化同事务推进 Authorization Epoch；
- `authz.delegation_replay_records`：跨进程原子 Replay Fingerprint 与短期保留；Runtime 无裸表权限；
- `audit.claim_mapping_activation_events`：脱敏、Append-only Mapping 激活事件。

同时增加受控注册/撤销/解析/消费/清理函数。三张表都强制 RLS；`api_runtime` 只执行 Identity 函数，`worker_runtime` 只执行有界 Replay prune，`read_only_ops` 只读脱敏 Mapping Audit。`0001`～`0024` 不修改字节。

## 7. 被否决的方案

- **复用 Admin 自动建 Principal**：未知 Runtime Subject 会变成有效身份，否决；
- **把 Raw Claims Map 传给 Application/Policy**：未映射 Claim 可影响授权或泄露，否决；
- **客户端 Header 表达 Delegation**：来源、Signer、PoP 和重放均不可证明，否决；
- **进程内 Replay Set**：多进程/重启可重复使用，否决；
- **Service 权限覆盖用户权限**：形成权限提升，否决；
- **把 Service Capability 写进 Role Binding 或 Token 当真相**：管理角色不是业务数据权限，Token 也不是 Kernel allowlist，否决；
- **在本项提前建 Query Endpoint/Policy Compiler**：越过 G2-03-05～12 顺序 Gate，否决。

## 8. 后果与后续 Gate

G2-03-04 关闭了 Runtime 身份建立和 Delegation 信任链，但不代表数据读取已经上线：

- G2-03-05 激活 Policy Resource Parser/Compiler/Test；
- G2-03-06 把 Identity Principal 集、Epoch 与 Policy Artifact 合并为唯一 Gateway，并验证最迟 5 秒撤权；
- G2-03-07～12 才实现 Query SQL、Lease、HTTP 和 Generated Client；
- G2-03-13 才创建只读 Web 消费者；
- 完整 HTTP Log/Trace 泄露突变与统计时序侧信道在 G2-03-11/12/14 继续验证。

后续不得绕开本 Application Port 直接从 Header/Claim 构造 Policy Actor，也不得把 Replay Store 换回单进程内存状态。
