# Metadata v1 合同与兼容性治理

状态：Frozen for G2-01-02

Owner：Contracts / Metadata

适用范围：G2-01 Metadata 控制面及后续所有读取 Release/Package/Revision 的模块

## 1. 权威资产

Metadata v1 不以数据库 `jsonb`、HTTP DTO 或页面表单为公共合同。机器权威资产为：

- `packages/contracts/schemas/metadata.schema.json`：可移植的结构 Schema；
- `packages/contracts/src/metadata.ts`：严格 Runtime Parser 与跨字段语义；
- `packages/contracts/src/resource-family-registry.ts`：可发布 Resource Family 的唯一服务器 Registry；
- `packages/contracts/src/canonical-json.ts`：Digest 前像规范；
- `packages/contracts/catalog.json`：Owner、冻结状态和兼容策略；
- `packages/contracts/fixtures/metadata-golden.json`：每个顶层合同的合法、边界、拒绝向量；
- `tools/contracts/baseline/metadata.v1.schema.json`：v1 兼容基线；
- `tools/contracts/check-metadata.ts`：Schema、Parser、Fixture、Catalog、Registry 与 Baseline 的统一 Gate。

`@ontos/contracts` 保持纯合同层，不依赖 Node 内建模块、数据库、HTTP/OIDC Framework、云 SDK 或其他 Workspace Package。SHA-256 由基础设施 Adapter 对规范 UTF-8 前像执行，不进入合同包。

## 2. G2-01 已冻结合同

顶层合同共 12 个：Project、Resource Envelope、Property Definition、Object Type Definition、Link Type Definition、Resource Revision、Resource Dependency、Validation Report、Compatibility Report、Release Manifest、Package Manifest 与 Management Role Binding。所有合同都带 `schemaVersion=1`，写入时拒绝未知字段。

Object/Property/Link 冻结以下最小可落地语义：

- API Name、Display Name、Description；
- Property 类型、Nullable、Write Mode、Unique/Filterable/Sortable/Searchable 查询声明；String Property 必须显式声明 `caseSensitive`；
- Property Classification 可显式声明；省略时由 Object Type 的 Default Classification 继承；
- Object Type 的 Primary Key、Title、默认搜索、默认排序与 Property 集合；Primary Key 必须引用唯一、非空且可由 Foundation `pk1` Codec 稳定编码的 Scalar Property（String、Boolean、Integer、Decimal、Date、Timestamp、Enum）；
- Link 两端精确绑定 Object Type Revision ID，并冻结两侧 API Name、Cardinality、来源、删除行为与 Action 创建/删除声明。

Release Manifest 至少包含一个 Metadata Pin；“G2-01 零成员 Activation”只表示没有 DB-02 Runtime Generation Member，不表示 Release 可以没有 Metadata Resource。

PRD 中的 Base Mapping、Object Policy、Link Policy、Object View/Application Config 字段没有在 G2-01 猜测或假冻结。它们分别由 G2-02、G2-03、G2-05 拥有；届时通过新 Object/Link Revision 与新 Release 增量加入，不能回写现有 Published Revision。

## 3. 结构校验与语义校验

校验分成两层，二者都必须通过才能进入 VALIDATED/READY：

1. JSON Schema 负责字段、Required、类型、Reference、Pattern、Enum、长度、数量、整数范围与未知字段；
2. Runtime Parser 负责跨字段/跨元素语义，例如 Enum Property 必须携带 Enum Values、Decimal Scale 不得超过 Precision、Primary Key/搜索/排序必须引用合法 Property、Validation/Compatibility 汇总结论必须与 Findings 一致、Release Pin 顺序连续、Package Entry 确定性排序和 Role Scope/Resource ID 一致。

JSON Schema 可能接受一个结构合法但语义矛盾的对象，这不是 Parser 漂移。Golden Fixture 用 `schemaDisposition` 明确区分结构拒绝与语义拒绝。`metadata-runtime-schema-agreement.ts` 则逐项核对 Schema 能表达的字段、Required、Reference、Enum、Pattern 和限制，防止其中任一侧静默改变。

自定义 Schema Gate 遇到未实现的关键字直接失败，不能忽略后假装通过。目前已执行 `minimum`/`maximum`，因此 Etag、Release Number、Pin Order 和 Decimal 范围在 Schema 与 Runtime 两侧一致。

## 4. Resource Family 激活边界

`RESOURCE_FAMILY_REGISTRY` 是直接 Resource API 与 Package Expander 的共同事实来源；两个入口只做 Adapter 映射，最终都调用 `parsePublishableResourceContent`。

| Family                                           | G2-01 状态 | 最早拥有 Gate | VALIDATED/READY 行为      |
| ------------------------------------------------ | ---------- | ------------- | ------------------------- |
| `object_type`、`link_type`                       | Active     | G2-01         | 使用已登记严格 Parser     |
| `mapping`、`snapshot_schema`                     | Deferred   | G2-02         | `CAPABILITY_NOT_ACTIVE`   |
| `policy`                                         | Deferred   | G2-03         | `CAPABILITY_NOT_ACTIVE`   |
| `function_type`、`action_type`                   | Deferred   | G2-04         | `CAPABILITY_NOT_ACTIVE`   |
| `interface`、`object_view`、`application_config` | Deferred   | G2-05         | `CAPABILITY_NOT_ACTIVE`   |
| 未登记字符串                                     | Unknown    | 未定义        | `RESOURCE_FAMILY_UNKNOWN` |

Package Manifest 可以登记 Deferred Entry 以产生预检报告，但 Package 内容不能绕过 Registry 进入 VALIDATED/READY。Property 是 Object Type 内嵌定义，不作为独立可发布 Family。

## 5. Canonical JSON 与 Digest

Digest 前像规则固定如下：

1. 输入必须是纯 JSON：Null、Boolean、String、安全整数、Array、Plain Object；禁止浮点、负零、Unsafe Integer、`undefined`、Class Instance 与其他非 JSON 值；
2. Object Key 按 JavaScript/Unicode Code Unit 升序排列；对象原始 Key 顺序和 JSON 空白不参与前像；
3. Array 顺序有业务意义，保持不变；Package Entry、Artifact Digest、Install Input 和 Release Pin 在 Parser 层另有确定性顺序约束；
4. String、Boolean、Null 和整数使用无额外空白的 JSON 表示；
5. `contentDigest` 对规范化 Resource Content 计算；Release/Package `manifestDigest` 对 Manifest 除 `manifestDigest` 自身之外的全部字段计算；
6. 基础设施 Adapter 对前像 UTF-8 Bytes 执行 SHA-256，并编码为 `sha256:` 加 64 位小写十六进制。

修改任何有意义的字段都改变前像；只改变 Key 顺序、缩进或空白不改变前像。Resource Parser 与实际 Digest 比对已在 G2-01-05/06 的 Store/Use Case 边界落地；Release Manifest Digest 已由 G2-01-08 在真实 Store/Stage/Publish 路径落地，Package Manifest Digest 仍由 G2-01-09 完成。

## 6. 兼容规则与滚动发布顺序

Metadata Artifact 是版本化、严格读取的持久事实。Reader 必须先按 `schemaVersion` 选择明确 Parser；未知版本 Fail Closed。Reader 不得用“忽略所有未知字段”掩盖字段漂移。

| 变化                                         | Gate 结果          | 发布顺序/动作                                                                   |
| -------------------------------------------- | ------------------ | ------------------------------------------------------------------------------- |
| 新增独立 Definition                          | Compatible         | 先部署使用者，再开始产生该 Definition                                           |
| 给现有 v1 增加可选字段                       | Compatible finding | 先部署接受该字段的所有 Server/Reader，再部署 Writer；旧 Reader 清零后才允许发出 |
| 必填改可选                                   | Compatible finding | Reader 先行；确认旧 Producer 仍受支持                                           |
| 删除/改名字段、增加必填、可选改必填          | Breaking           | 新建 Schema Version；并行 Reader、迁移/双读、支持窗与退出条件                   |
| 类型、Ref、Const、Pattern、Format、Enum 变化 | Breaking           | 新建 Schema Version；Closed Enum 即使“放宽”也会破坏旧严格 Reader                |
| 收紧长度、数量、整数范围或未知字段策略变化   | Breaking           | 新建 Schema Version                                                             |

兼容 Schema 变化仍必须同步 Runtime Parser、Fixture、Catalog 和发布说明。Baseline 是冻结审查资产，不得为了让测试变绿而与 Candidate 同时改写；只有首次冻结或带 ADR/迁移计划的新主版本可以建立新 Baseline。

## 7. 后续实现接缝

- G2-01-03 将这些合同映射到 DB-01，但数据库 Row 不得成为公共类型；
- G2-01-05 在 Draft 写入/校验时重算 Content Digest，并用 `etag` 防止丢失更新；
- G2-01-06 已实现 Dependency Extractor、Validation Report 与确定性图；G2-01-07 实现业务兼容分类；
- G2-01-08 已在 Stage/Publish 事务中验证 Pin、Report、Published Baseline、Project/Channel Context 与 Digest 一致；
- G2-01-09 的 Package Expander 必须调用当前 Registry，不能维护第二份 Family Switch；
- G2-01-10 的 HTTP Adapter 必须先执行这些 Parser，再映射到 Application Use Case。

本任务没有创建数据库表、HTTP Endpoint、OIDC、Repository、Release Publish 或 Package Installation；这些能力不能因合同 Gate PASS 被宣称完成。
