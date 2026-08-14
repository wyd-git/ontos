# Foundation Contract 与兼容性治理

状态：Frozen for G2-00

Owner：Contracts / Tech Lead

适用 Gate：G2-00-09 及后续所有模块 Gate

## 1. 目的与范围

本合同层只冻结所有模块必须共享、且已经有实现依据的语义。它不提前猜测 Query、Snapshot、Action、Event 或 OpenAPI 的完整字段。

机器权威资产为：

- `packages/contracts/schemas/foundation.schema.json`：Foundation JSON Schema v1；
- `packages/contracts/catalog.json`：合同 Owner、方向和后续模块最晚冻结 Gate；
- `packages/contracts/error-codes.json`：16 个 PRD 核心 API 错误码及稳定分类；
- `packages/contracts/fixtures/foundation-golden.json`：合法、边界和拒绝向量；
- `packages/contracts/src/`：运行时边界 Parser；
- `tools/contracts/baseline/`：兼容性比较基线；
- `tools/contracts/`：Schema、错误码、Golden Fixture 和架构门禁。

Foundation v1 共登记 11 类合同：Schema Version、Ontos ID、Correlation ID、Artifact Digest、Idempotency Key、Canonical Instant、Correlation Context、Identity/Delegation Summary、Release Binding、Error Envelope，以及由 ADR-009 单独冻结的 Property Value Codec。

## 2. 已冻结语义

### 2.1 ID

- 持久业务实体 ID 是应用生成、规范小写文本表示的 UUID，分配后永不复用。
- UUID 是不透明标识。调用方不得从 ID 推断类型、创建时间、租户或排序，也不得依赖具体 UUID version/variant。
- Resource、Revision、Release、Snapshot、ActionExecution、ChangeSet、Event、Principal 和 Object RID 等具体字段在其所属模块冻结；Foundation 只冻结共同 Wire 编码。
- Correlation ID 与业务实体 ID 分离，格式为 `corr_` 加 16～123 个安全 ASCII 字符，总长 21～128。它用于用户可见的故障关联，不等同于内部 Trace ID。
- 外部提供的 Correlation 值只能在校验后作为关联输入；受信边界必须生成或映射服务端关联值，不能把客户端任意字符串直接作为安全日志标签。

### 2.2 版本、时间、摘要和幂等

- Foundation `schemaVersion` 当前只接受整数 `1`。不兼容演进必须新增版本并并行读取，不能原地改写 v1。
- Artifact Digest 固定为 `sha256:` 加 64 位小写十六进制，指向精确 Artifact bytes；Digest 一经登记不得重新绑定到其他内容。
- Canonical Instant 固定为 UTC、六位小数秒、27 字符 RFC 3339 文本，例如 `2026-08-13T10:05:00.123456Z`，并验证真实 Gregorian 日期。
- Idempotency Key 是 16～128 字符的不透明值。持久化语义必须以 Actor/Service Identity、操作和 Key 共同定域；同 Key 同请求返回原结果，同 Key 不同请求返回 `IDEMPOTENCY_KEY_REUSED`。Apply 重试必须沿用原 Key。
- Property Value Codec 继续由 ADR-009、`@ontos/value-codec` 和其 Golden Vector 负责；Foundation Catalog 只绑定其版本，避免复制两套编码实现。

### 2.3 Identity、Release 与 Error

- Identity 摘要只携带 Actor、最多 16 个不重复 Delegation Principal、Claims Fingerprint、认证时间与固定的 `intersection` 授权模式；Raw Token、Raw Claim 和 Group 明文不能进入合同。
- Release Binding 同时绑定 Project、Release、Release Revision、Runtime Activation 和 Manifest Digest。下游执行不能只携带一个 Release ID 后再隐式读取“最新”版本。
- Error Envelope 的程序判断依据是 `code`、`category` 和 `retryable`；`message` 可以本地化，不能作为程序分支条件。
- `details` 最大 16 KiB、深度 8、节点 1,000，并按无原型、不可变 JSON 克隆。这个边界只防止结构滥用；Producer 仍必须执行 Policy 与脱敏，禁止返回 Stack、SQL、文件路径、Secret、Token 或原始依赖错误。
- 核心错误码的 HTTP Status、Category、Retryable、Meaning 和 Client Action 都属于稳定语义。增加新错误码兼容；删除、改名或改变既有语义是破坏性变更。

## 3. 写入与读取兼容规则

| 变化                                   | 写入合同                                   | 响应/Event 读取合同                             | 自动 Gate          |
| -------------------------------------- | ------------------------------------------ | ----------------------------------------------- | ------------------ |
| 增加可选字段                           | 先部署能接收该字段的 Server，再部署 Writer | 先部署忽略未知字段的 Reader，再由 Producer 发出 | 允许并给出兼容提示 |
| 增加必填字段                           | 破坏旧 Writer                              | 破坏旧 Producer/Reader                          | 阻止               |
| 删除或改名字段                         | 破坏                                       | 破坏                                            | 阻止               |
| 改类型、`$ref`、Pattern、Format、Const | 破坏                                       | 破坏                                            | 阻止               |
| 收紧长度、数量、唯一性                 | 破坏                                       | 破坏                                            | 阻止               |
| Closed Enum 任意变化                   | 破坏；需新版本或显式 Open Enum 设计        | 破坏旧 Reader                                   | 阻止               |
| 必填改可选                             | 接收范围放宽                               | Reader 仍能读旧 Producer                        | 允许               |
| 新增独立 Definition                    | 不影响旧合同                               | 不影响旧合同                                    | 允许               |

所有写入 Parser 使用精确字段集合并拒绝未知字段。Error Envelope 的 Producer Parser 同样严格；Consumer Reader 允许忽略新增响应字段，但仍严格验证所有已知字段。兼容增加不是“随便加字段”，必须遵循 Reader/Server 先行的发布顺序。

`npm run check:contracts` 同时执行以下检查：

1. 当前 JSON Schema 只使用 Gate 已实现的关键字，避免校验器静默忽略新语义；
2. v1 Schema 与冻结基线执行结构 Diff；
3. 核心错误码与分类执行语义 Diff；
4. Catalog 的 Owner、方向、未知字段策略和最晚冻结 Gate 完整；
5. JSON Schema 与 Runtime Parser 的字段、Required、Reference、Pattern、Length、Enum 和关键限制一致；
6. 每个 Foundation Schema 都有合法、边界、拒绝 Fixture；
7. 每个 Fixture 同时通过 JSON Schema 和运行时 Parser，拒绝结果还必须匹配稳定校验错误码；
8. Property Value Codec 的 Catalog 版本与 ADR-009 实现及 Golden Vector 一致。

基线文件不是日常“修测试”的目标。G2-00-12 必须把 Contracts Owner Review、CI 必跑项和分支保护绑定到基线与 Gate 代码；新主版本只能在 ADR、迁移/双读计划和对应 Golden Fixture 同时完成后建立新基线。

## 4. 渐进冻结登记

| 模块合同族                                | Owner                     | 最晚冻结 Gate | G2-00 只冻结的语义不变量                                                                   |
| ----------------------------------------- | ------------------------- | ------------: | ------------------------------------------------------------------------------------------ |
| Resource / Revision / Release / Package   | Metadata                  |         G2-01 | Published Revision 不可变；Publish 原子；Rollback 产生新 Release                           |
| Snapshot / Mapping / Validation / Job     | Materialization           |         G2-02 | 失败不切 Active Generation；Base/Overlay 分离；Checkpoint 与 Fencing 持久化                |
| Query / Policy / Cursor                   | Query / Identity Policy   |         G2-03 | Query 绑定一个 Release/Activation；Policy 进入计划和投影；Cursor 绑定 Query/Policy Context |
| Function / Action / Preflight / ChangeSet | Action / Function Runtime |         G2-04 | Preflight 只读且 Apply 重验；事实与 Outbox 原子；Handler 只产出 Plan                       |
| Event / Outbox / Audit                    | Action / Platform         |         G2-04 | 至少一次投递；可观察去重；Audit 只追加且脱敏                                               |

这些合同族在 G2-00 的字段 `fieldsFrozen=false`。OpenAPI 与 SDK/Web 发布合同按蓝图在 G2-05 冻结；当前 JSON Schema Foundation 不是对完整 API 字段的提前承诺。

## 5. 依赖边界

`@ontos/contracts` 位于 `contracts` 层，不依赖 HTTP Framework、数据库 Driver/ORM、React、云 SDK 或其他 Workspace Package，也不出现数据库列名。运行时模块只能依赖这些公共类型、Parser 和 Schema 资产，不能把数据库 JSONB 当作公共合同。

## 6. 变更流程

1. 先判断是 Foundation 兼容增加、模块首次冻结，还是破坏性变更。
2. 兼容增加必须先补 Schema、Runtime Parser、三类 Golden Fixture 和发布顺序说明。
3. 模块首次冻结由登记 Owner 在所属 Gate 完成，不修改 `fieldsFrozen` 之前不得声称字段稳定。
4. 破坏性变化必须新增 Schema Version 与 ADR，说明旧版本支持窗、双读/双写或迁移、回退和删除条件。
5. 本地执行 `npm run check:contracts`；G2-00-12 后由相同命令在受保护 CI 中强制执行。
