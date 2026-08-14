# G2-00-09 Foundation Contract 与兼容性 Gate 验收记录

- 结论：**PASS（仅限 G2-00-09 Foundation Contract 与本地兼容门禁）**
- 执行日期：2026-08-13
- 分支：`agent/g2-00-09-foundation-contracts`
- 起始 Commit：`091adcfaf8b2660ea62bd8b929f5d809a7b9e5f2`
- 工具：Node.js 24.18.0 / npm 11.16.0 / TypeScript 6.0.3
- 环境：macOS 26.5.2（Build 25F84）arm64

本记录对应 [G2-00-09 WWA](../delivery/g2-00-foundation-task-pack.md#g2-00-09建立-foundation-contract-与兼容性-gate)。最终实现 Commit 由 PR Head 记录，避免在被提交文件中写入自身 Commit Hash。

## 1. 验收映射

| WWA 声明                                                                                                  | 实现证据                                                                                                                              | 执行证据                                                                                | 结果              |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------- |
| 冻结 ID、Value Codec、Schema Version、Error、Correlation、Identity/Delegation、Release Binding 与兼容规则 | `packages/contracts/` 的 Runtime Parser、Schema、Catalog、错误码；ADR-009 Value Codec 版本绑定；治理文档 §2～3                        | 11 类 Foundation、16 个 PRD 核心错误、Runtime/JSON 一致性 Gate                          | PASS              |
| 写入默认拒绝未知字段，读取兼容策略明确                                                                    | Object Schema 全部 `additionalProperties=false`；Runtime 精确字段；Error Producer 严格、Consumer 忽略新增响应字段                     | 未知写入字段拒绝与未来响应字段读取测试                                                  | PASS              |
| 每类合同有合法、边界、拒绝 Golden Fixture                                                                 | `foundation-golden.json` 的 30 个用例；Value Codec 原有 positive/invalid/PK/order/collision 向量                                      | JSON Schema 与 Runtime Parser 双执行；稳定拒绝 Code 核对                                | PASS              |
| 自动 Diff 阻止删除/改名/收紧，允许定义内兼容增加                                                          | Schema Diff、Error Catalog Diff、Supported Keyword 检查、Runtime/Schema Agreement                                                     | 删除、改名、必填增加、类型/Enum/限制/未知字段策略变化均失败；可选字段与新 Code 增加兼容 | PASS（本地 Gate） |
| Query、Snapshot、Action、Event 有 Owner、不变量和最晚冻结 Gate，不假冻结字段                              | Catalog 的 5 个 Deferred Family；治理文档 §4                                                                                          | Gate 检查 Owner、至少两个不变量、G2-01～04 与 `fieldsFrozen=false`                      | PASS              |
| 合同包不依赖 HTTP/DB/React/云 SDK，也不暴露数据库列                                                       | `@ontos/contracts` 无 Runtime Dependency；Contracts 层 Workspace/External Dependency 与 Import allowlist 为空；公共 Schema 无数据库列 | `check:architecture` PASS — 2 Packages / 16 Source Files                                | PASS              |

## 2. 冻结资产

### 2.1 Foundation v1

- 业务实体 ID：规范小写 UUID 文本，不透明、不复用、不承诺特定 Version/Variant；
- Correlation ID：`corr_` 加安全 ASCII，不等同 Trace ID；
- Schema Version：整数 `1`；
- Artifact Digest：`sha256:` 加 64 位小写十六进制；
- Idempotency Key：16～128 字符不透明值，持久语义在业务 Store 中按身份与操作定域；
- Canonical Instant：UTC、六位小数秒、27 字符并验证真实 Gregorian 日期；
- Identity：Actor、最多 16 个不重复 Delegation Principal、Claims Fingerprint、认证时间和固定交集授权；
- Release Binding：Project、Release、Release Revision、Runtime Activation 与 Manifest Digest 同时绑定；
- Error Envelope：稳定 Code/Category/Retryable、可本地化 Message、受限 JSON Details 与 Correlation ID；
- Property Value Codec：继续以 ADR-009 和 `@ontos/value-codec` 的 `pk1` 合同为权威。

### 2.2 兼容策略

- 删除、改名、新必填、可选改必填、类型/Reference/Const/Pattern/Format 变化、Closed Enum 变化、限制收紧和未知字段策略变化都阻断；
- 新独立 Definition、可选字段增加和必填改可选属于 Gate 定义的兼容变化；
- 写入可选字段增加必须 Server Reader 先行；响应/Event 增加必须 Consumer Reader 先行；
- 所有新 Schema Keyword 必须先实现 Gate 支持，否则直接失败，不能被静默忽略；
- Runtime Parser 元数据必须与 JSON Schema 同步，防止“Schema 兼容但生产入口仍拒绝”；
- 16 个核心错误的 HTTP Status、Category 与 Retryable 在 JSON 和 Runtime 同时冻结；未知模块错误码可在后续 Owner Gate 中增加。

## 3. Red-Team 与 Intended-vs-Implemented

[专项审查](../reviews/g2-00-09-foundation-contract-red-team.md)在 PASS 前实际发现并修正：

1. 初版前缀 ULID 与蓝图“应用生成 UUID”冲突，现改为规范 UUID，并把 Correlation ID 独立建模；
2. 初版 Schema Diff 不能发现 Runtime Parser 忘记接收新增字段，现增加 Runtime/Schema agreement Gate 与故意失败变异测试；
3. 初版错误码只有 JSON 分类目录，Runtime 可产生矛盾 Category/Retryable，现对 PRD 核心 Code 强制分类并校验 JSON/Runtime 一致；
4. Runtime 字符长度最初使用 UTF-16 Code Unit，而 JSON Schema 使用 Unicode Code Point，现两侧统一按 Code Point；
5. Error Details 增加 Byte/Depth/Node 上界、无原型不可变克隆与 Prototype Pollution 回归测试。

审查后没有仍未关闭、且属于 G2-00-09 本地合同范围的 Intended-vs-Implemented 偏差。

仍开放但不阻断本任务：

- 基线文件的 Contracts Owner 审批、受保护 CI 与不可绕过的远端必跑项：Owner 为 Platform / Quality + Contracts，Gate 为 G2-00-12；
- 真实 API Error Details 的 Policy/Secret 脱敏与 HTTP Adapter 全入口接入：Owner 为 API / Security，Gate 为 G2-05。

## 4. 可复现执行

### 4.1 全仓 Gate

```text
PATH=/Users/wangyudong/.nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin:/bin npm run verify

check:toolchain     PASS — node 24.18.0 / npm 11.16.0
format:check        PASS
lint                PASS
typecheck           PASS
test:unit           PASS — 169/169
check:architecture  PASS — 2 packages / 16 source files
check:contracts     PASS — 11 Foundation / 16 stable error codes / 5 deferred families / 30 Golden cases
```

G2-00-09 专项为 16/16 Top-level Tests；兼容性测试包含允许与阻断两侧，不能只证明当前 Schema 与 Baseline 相等。

`package-lock.json` 未变化，SHA-256：

```text
596243cf1053ee28b22ba1f66307403d0627338bd56582dcfa1f4b88197bb45b
```

### 4.2 冻结资产摘要

```text
cf511ab00e1c9be993053a6eeddead620e36a49c9e0a104a8a38051575f87c30  foundation.schema.json
c9b2acef6e480181bcbbdbc6b42c6b9f4fb13decdad5eb34032ca74485397579  catalog.json
f5120e9afe970462303d3c21b0f8eb381e4da605895aa493f419c85c7b2647db  error-codes.json
1f2dfcd8cf109435ad1903214265e591387fec06291bbf65ad35ffdf5a612a7b  foundation-golden.json
cf511ab00e1c9be993053a6eeddead620e36a49c9e0a104a8a38051575f87c30  baseline/foundation.v1.schema.json
f5120e9afe970462303d3c21b0f8eb381e4da605895aa493f419c85c7b2647db  baseline/error-codes.v1.json
127bbc17afdb9b01c684299e6a6997d489cd7e8d7252ccbfe31e3aac608431f6  value-codec/golden-vectors.json
```

`packages/contracts/` 与 `tools/contracts/` 全文件按路径排序、逐文件 SHA-256 后的清单摘要：

```text
26d364284ef3d9a48c213fcab813235a22165e75604a5cc00c871d524522f512
```

任何 Foundation Schema、Parser、Catalog、错误分类、Fixture、Baseline 或 Gate 行为变更都必须重新生成 Evidence。

## 5. 明确不宣称

- 本记录不是 G2-00 Foundation 总 Gate PASS；G2-00-10～13 仍未完成。
- 当前 JSON Schema 只覆盖 Foundation，不是完整 OpenAPI；业务 Endpoint 与 SDK/Web 发布合同按 G2-01～05 渐进冻结。
- Deferred Query/Snapshot/Action/Event 只登记 Owner、语义不变量和最晚 Gate，字段明确未冻结。
- 当前没有 HTTP Server、数据库表/列、Migration、业务 Adapter 或页面，也没有验证 Framework 是否在所有入口调用 Parser。
- Error Details Parser 只执行结构与资源限制，不能代替真实 API Producer 的 Policy、Secret 和错误脱敏。
- Idempotency Key 只冻结 Wire 与跨模块语义；原结果持久化、请求 Digest 和并发行为在 Action Store Gate 验证。
- Application-generated UUID 只冻结 Wire 编码；生成位置、不复用和数据库 Unique/FK 在所属 Store 与 DB Gate 验证。
- 当前 Diff 是本地可执行 Gate；G2-00-12 完成前不宣称远端分支保护已经阻止基线被同时改写。
