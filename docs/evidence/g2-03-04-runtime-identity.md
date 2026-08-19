# G2-03-04 Runtime Identity / Claim Mapping / Delegation Evidence

- 日期：2026-08-19
- 结论：**PASS**
- 资格限定：只有同一 Commit 的 `g2-03-04-evidence-manifest.json` 为 `CLEAN_ROOM_PASS` 时成立
- 任务合同：[G2-03-04](../delivery/g2-03-query-policy-task-pack.md#g2-03-04实现-runtime-identityclaim-mapping-与-delegation-交集)
- 架构决策：[ADR-022](../architecture/adr/022-runtime-identity-claim-mapping-delegation.md)
- 复审：[Intended-vs-Implemented](../reviews/g2-03-04-intended-vs-implemented.md)

## 1. 本 Gate 证明了什么

G2-03-04 已把 G2-03-01 的内存 Trust Boundary 与 G2-03-03 的持久接缝替换为正式生产分层：

1. Runtime Bearer 通过真实 OIDC Discovery/JWKS/签名、Issuer、Audience、Algorithm、Scope 和时间验证；
2. Human/Service Principal、类型、状态、Project Binding、Service Client/Capability 只从 Kernel/PostgreSQL 解析，未知身份不自动创建；
3. Published Claim Mapping v1 以白名单和固定上限生成精简 Attribute 与确定性 Fingerprint，未映射 Claim 不进入 Application；
4. Token Exchange `act` Delegation 强制短 TTL、真实 ES256 DPoP、Capability 子集、链上所有 Principal 和 PostgreSQL Replay；
5. Service、链中 Service 与终端 Human 的 Permission 只取交集，Deny 不暴露拒绝环节；
6. 两个独立 Node API 进程和独立连接池使用同一 PostgreSQL Replay Store，第一进程成功后第二进程稳定拒绝；
7. Mapping 切换和 Service Profile 新增/撤销同事务推进 Authorization Epoch；Mapping Audit 脱敏且历史不可改；
8. Application Context、Error、Replay 表和 Audit Event 均不保存 Bearer、Raw Claims、Issuer/Subject、DPoP 或 Delegation Credential。

该结论不声称 Policy/Query/HTTP/UI 已可使用。

## 2. 正式产物

| 产物                                 | 责任                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `@ontos/identity-domain`             | Claim Mapping v1、类型/数量/字节约束、映射规范化、Permission Intersection         |
| `@ontos/identity-application`        | 唯一 Runtime Identity Use Case、Repository/Crypto Port、同形失败、Compact Context |
| `@ontos/identity-postgres`           | 单 Snapshot Principal/Mapping Resolver、持久 Replay Adapter、SHA-256 Adapter      |
| `apps/api/src/runtime-oidc.ts`       | OIDC/JWKS/Bearer/Token Exchange Actor/DPoP/Identity Header Boundary               |
| `0025_runtime_identity_boundary.sql` | Service Profile、Replay Record、Mapping Activation Audit 与受控函数/RLS           |
| `tools/runtime-identity/`            | Domain/Application/OIDC 破坏测试与真实 PG/OIDC/双进程 Integration                 |

## 3. 机器证据

| 命令 / Artifact                                  | 证明                                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `npm run test:runtime-identity`                  | Claim Mapping 边界、权限交集、同形错误、OIDC 负向量、链长、TTL、Capability、真实 DPoP                            |
| `npm run test:runtime-identity:postgres`         | PostgreSQL 16、Human/Service/Delegation、Mapping 切换、Epoch/Audit、Unknown/Disabled/Revoked、双 API 进程 Replay |
| `npm run test:query-policy-persistence:postgres` | G2-03-03 仍可独立按 0024 历史边界复现，不被 0025 偷改                                                            |
| `npm run check:g2-03-04-evidence`                | Required Record、Source Marker、Scope 前向接纳与 Runtime Identity Artifact                                       |
| `npm run verify`                                 | 40 道统一 Gate、Clean Checkout、同 Commit Artifact 与最终 Manifest                                               |
| `g2-03-04-runtime-identity.json`                 | `REAL_OIDC_POSTGRES_DPOP_TWO_API_PROCESSES`                                                                      |
| `g2-03-04-evidence-manifest.json`                | 本 Gate 唯一最终 `CLEAN_ROOM_PASS` 资格                                                                          |

Artifact 只记录 Gate、Commit、PostgreSQL 版本、Migration 版本和布尔断言，不写 Token、Issuer、Subject、JTI、DPoP Key、Claim 值或连接凭据。

## 4. 关键故障矩阵

| 场景                                                                       | 结果                                                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Wrong Issuer/Audience/HS256/Scope/typ、Expired/Future/Not-before、Oversize | 同形 `AUTHENTICATION_FAILED`                                                     |
| `X-Ontos-*` 自报 Principal/Type/Delegation                                 | 在 Identity Resolver 前拒绝                                                      |
| Unknown Subject                                                            | 不创建 Principal，计数不变并失败                                                 |
| Disabled Human / Revoked Service Profile                                   | 下一次 Identity 建立失败                                                         |
| Human 携带 Service Capability / 错 Service Client                          | 类型或 Client 约束失败                                                           |
| 未映射 admin Claim                                                         | 不读取、不进入 Context/Fingerprint/Evidence                                      |
| Mapping 值类型错误、过长、重复或协议 Claim                                 | Mapping/Identity fail closed                                                     |
| Mapping Head 切换                                                          | 新 Revision 生效、Fingerprint 改变、Epoch +1、旧 Revision 不变、Audit 无敏感内容 |
| Delegation 缺 DPoP、URL/Token/Key 不匹配、链过长、TTL 过长                 | 不产生 Identity Context                                                          |
| Service 请求未授权 Capability                                              | 全链失败，不指出拒绝 Service                                                     |
| 两 API 进程使用同一 Delegation                                             | 第一成功；第二由 PG 唯一 Replay Fingerprint 拒绝                                 |
| 缺任一 Principal Permission Grant                                          | `{decision:"DENY"}`，无拒绝环节                                                  |

## 5. 范围与剩余风险

本项没有新增 Runtime HTTP Endpoint、Public OpenAPI、Policy Resource Parser/Compiler、Query SQL、Web、Action/Overlay 或 SDK。`apps/api` 只增加后续 Route 必须复用的网络身份 Adapter。

| 剩余风险                                                     | Owner                 | 关闭 Gate         |
| ------------------------------------------------------------ | --------------------- | ----------------- |
| Policy Resource/Compiler/Test 尚未提供真实 Permission Facts  | Policy / Metadata     | G2-03-05          |
| Policy Gateway、Epoch Cache 与最迟 5 秒撤权尚未组合 Identity | Policy / Runtime      | G2-03-06          |
| Runtime HTTP Route 的 Log/Trace/Error 泄露与限额尚未复跑     | API / Security        | G2-03-11/12       |
| Query SQL、Lease 与 Object/Link 数据权限尚未执行             | Query / PostgreSQL    | G2-03-07～12      |
| 生产 IdP/HSM/Key Rotation 与 Replay prune 运维调度尚未部署   | Security / Operations | 部署 Gate / G2-07 |

本 Gate 关闭后只放行 **G2-03-05：Policy Resource、Compiler 与 Release Gate**。
