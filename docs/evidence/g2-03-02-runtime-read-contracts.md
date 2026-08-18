# G2-03-02 Runtime Read 合同 Evidence

- 日期：2026-08-18
- 结论：**PASS**
- 资格限定：只有同一 commit 的 `g2-03-02-evidence-manifest.json` 为 `CLEAN_ROOM_PASS` 时成立
- 任务合同：[G2-03-02](../delivery/g2-03-query-policy-task-pack.md#g2-03-02冻结-querypolicyidentity-与-runtime-read-合同)
- 架构记录：[Runtime Read 合同与生成边界](../architecture/g2-03-runtime-read-contract.md)
- 复审：[Intended-vs-Implemented](../reviews/g2-03-02-intended-vs-implemented.md)

## 1. 本 Gate 证明了什么

G2-03-02 将 G2-03-01 的可行架构变成可执行、可版本化的公共接缝：

1. Query、Identity、Policy、Cursor 和五类 Runtime Read Response 有严格运行时 Parser；
2. 同一字段/枚举/限制源生成 JSON Schema 2020-12 和 OpenAPI 3.1 Candidate；
3. OpenAPI 可重现生成私有 TypeScript Read Client，不允许平行手写 DTO；
4. Golden、Compatibility 和 Mutation 能在正式数据库/API/UI 前发现字段与安全语义漂移；
5. 历史 Scope Gate 只向前接纳合同产物，没有提前创建 Migration、Endpoint、产品页或正式 Query/Policy 包。

该结论不声称 Runtime Query 已可供用户调用。

## 2. 机器证据

| 证据                                    | 期望结果                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `npm run check:contracts`               | 12 个 Runtime Read 合同进入 Catalog；全部 Golden/Parser/Schema/Baseline 一致 |
| `npm run test:runtime-read-contracts`   | Query/Identity/Policy/Cursor/Response/Compatibility 正反测试 PASS            |
| `npm run check:runtime-read-generation` | 5 个 Operation、17 个 Source、34 个 Distribution 文件全部零 Diff             |
| 根 `typecheck`                          | 严格合同、Checker 与测试编译 PASS                                            |
| Generated Transport Compile             | 私有隔离包编译 PASS                                                          |
| Strict Public Types Witness             | `exactOptionalPropertyTypes=true` 编译 PASS                                  |
| Strict Web Package Witness              | 从包根创建 Client、调用 Search、穷举五态并以严格可选属性编译 PASS            |
| Distribution Runtime Import             | JavaScript 包入口与 7 个必需运行时导出动态加载 PASS                          |
| `g2-03-02-contract-evidence`            | Required Record、源码 Marker、Scope、Candidate 和生成 Artifact 一致          |

统一运行产生：

- `generated/ci-report/g2-03-02-runtime-read-generation.json`；
- `generated/ci-report/g2-03-02-acceptance.json`；
- `generated/ci-report/g2-03-02-evidence-manifest.json`。

最终 Manifest 要求 37 个 Required Gate 各且只 PASS 一次、Generation Artifact 完整、CI Report 同 commit 且 `cleanCheckout=true`。本文不手写最终 Hash 或运行时长，避免与 PR Head 漂移。

## 3. 合同与 Golden 覆盖

- 12 个冻结顶层合同：3 Request、Identity、Policy Artifact/Decision、Cursor、5 Response；
- 核心错误 Catalog 从 16 个增至 22 个，新增项为兼容扩展，旧错误语义零改动；
- Runtime Golden 共 15 个合同 Case，其中 3 个明确拒绝；
- 两个领域：WorkItem、Order；
- 五个不同 Actor，覆盖 Human、Service、allow、deny、Property mask/deny；
- Empty、Null、Missing、Masked、Restricted 明确分离；
- Cursor Context Change、Tamper、Expiry 有 AEAD 行为证据；
- Unknown Field、Page 501、逻辑深度 6、集合 501 和 Injection Payload 有负向/边界证据。

合同总检查还继续运行 Foundation、Metadata、Materialization 的历史 Golden，不以新 Gate 替换旧证据。

## 4. 漂移与攻击 Mutation

| Mutation                                | 阻断层                                  |
| --------------------------------------- | --------------------------------------- |
| 删除/改名 Definition 或 Property        | Schema Compatibility                    |
| 改类型或 Nullability                    | Schema Compatibility + Source Agreement |
| 新增 Required / Optional 变 Required    | Schema Compatibility                    |
| 改 Closed Enum                          | Schema Compatibility + Source Agreement |
| 收紧 Page/List/Length                   | Schema Compatibility + Source Agreement |
| 删除/改名 HTTP Path/Method 或改接 DTO   | OpenAPI Compatibility                   |
| 修改已提交 Schema/OpenAPI/Client        | Deterministic Regeneration              |
| Raw SQL、Raw Claims、Rule Trace         | Strict Parser Unknown-field Gate        |
| Masked/Restricted 携带真实值            | Response Semantic Parser                |
| Masked/Restricted 可 Filter/Sort/Search | Metadata Semantic Parser                |
| Cursor 篡改/过期/跨上下文               | AES-GCM + Context Verifier              |
| 将 Candidate Client 公开发布            | Evidence Package Boundary               |

## 5. 范围证据

G2-03-02 策略绑定 baseline `c898c34c6598406e7b7eb9c3e260ac4b5660342d`。允许范围仅包括合同、Schema/OpenAPI/Golden/Baseline、私有 Generated Client、相关 Checker/CI/记录与根配置。

仍显式禁止：

- `migrations/`；
- `apps/web/`；
- 正式 `packages/query|policy|identity|sdk|action`；
- 对应执行工具目录。

Foundation 仅新增 `packages/runtime-read-client` Workspace；G2-02 与 G2-03-01 仅新增 `packages/contracts/`、`packages/runtime-read-client/`、`tools/contracts/` 前向 Prefix。原 21 个 Migration、G2-02 clean-room 与 G2-03-01 真 PG/Web Spike 仍在同一 full profile 执行。

## 6. 实际发现的问题

1. Schema Validator 原本不识别 `oneOf`、联合 `type` 与 Default；补齐后，Nullability 和互斥 Property State 才能机器验证。
2. 原 Compatibility Diff 不比较 `oneOf/default`；补齐后它们的变化被视为 Breaking。
3. 直接全量导出 Runtime Schema 会把 Identity/Policy/Cursor 内部定义暴露到 OpenAPI；改为从公共 Root 收集引用闭包。
4. HeyAPI 0.99 生成 Transport 源码在 TS6 exact optional 下存在内部赋值错误；采用“隔离编译源码 → 确定性 JS/声明 Distribution → 包根消费”的边界，并增加严格 Web 消费者与动态导入证明，没有放宽根配置。
5. 单纯签名 JSON 不能证明 Cursor 不透明；增加 AES-256-GCM Reference 与密文不包含业务值断言。
6. 旧 Scope Gate 默认拒绝新 Workspace/合同文件；以最小 Prefix 前向接纳，没有移除 Migration/Web/正式实现黑名单。
7. Cursor 原先不能表达 nullable Sort Value，且 8 KiB 上限容纳不了最大合法 Envelope；增加显式 null 并用最大输入实测固定 64 KiB 防御上限。
8. Policy 时间操作数原先没有测试时间输入，并列一跳 Link 也被误判为嵌套；每个向量现必须固定 `requestTime`，并且只禁止真正的二跳嵌套。
9. OpenAPI 原检查可阻止 Path 删除，但无法阻止 Search Path 误接 Count DTO；增加了 Operation 级请求/响应/Parameter/Security 绑定及 Mutation。

## 7. 剩余风险

| 风险                                                                   | Owner                         | 关闭 Gate   |
| ---------------------------------------------------------------------- | ----------------------------- | ----------- |
| 合同已冻结但没有生产 Migration、DB 权限或 Query Lease                  | Database / Runtime / Security | G2-03-03    |
| Identity 仍无生产 OIDC、Claim Mapping、Delegation Replay 防护          | Identity / Security           | G2-03-04    |
| Policy Artifact/IR 尚无正式 Resource Compiler/Gateway                  | Policy / Metadata / Runtime   | G2-03-05/06 |
| Query AST 尚未编译为参数 SQL                                           | Query / PostgreSQL            | G2-03-07    |
| Cursor AEAD 只是 Reference，Key Store/Rotation/Telemetry 未建          | Query / Security              | G2-03-03/09 |
| 升级 Generated Transport 时必须保持 Distribution 与严格 Web 包入口证明 | Contracts / Web               | G2-03-12/13 |
| 尚无 Runtime HTTP、真实 Client Request 或产品 UI                       | Backend / Web                 | G2-03-12/13 |

## 8. 下一步

本 Gate 关闭后只放行 **G2-03-03：Query/Policy 前向 Migration 与最小权限**。下一项必须从 0022 开始并保持 0001～0021 不变；未通过前不开始生产 Identity、Query Endpoint 或 UI。
