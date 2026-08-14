# G2-01-02 Metadata 合同与兼容 Gate 验收记录

- 结论：**PASS（仅限 G2-01-02 Metadata 合同层与兼容 Gate）**
- 执行日期：2026-08-14
- 分支：`agent/g2-01-02-metadata-contracts`
- 起始 Commit：`b3e617853724724960adaabc69df6555eeb2332c`
- 工具：Node.js 24.18.0 / npm 11.16.0 / TypeScript 6.0.3
- 数据库状态：**未创建 DB-01；G2-01-03 仍 OPEN**

本记录对应 [G2-01-02 WWA](../delivery/g2-01-metadata-task-pack.md#g2-01-02冻结-metadata-模块合同与兼容-gate)。最终实现 Commit 与远端 Gate 由 PR Head/Check 记录，避免已提交 Evidence 引用自身尚不存在的 Hash。

## 1. Intended-vs-Implemented 验收映射

| WWA 意图                                                                                    | 实现                                                                                                                                        | 自动反例/执行证据                                                                                                            | 结果 |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---- |
| Project、Resource、Revision、Dependency、Reports、Release、Package、Role Binding 全部版本化 | 12 个 Metadata JSON Schema Definition、Runtime Parser 与 Catalog Entry                                                                      | 36 个合法/边界/拒绝 Golden Fixture；`schemaVersion=1`                                                                        | PASS |
| Object/Property/Link 冻结 API Name、类型、PK、Cardinality、查询与引用                       | 严格 Definition Parser；Property 类型/Case Rule/Nullable/WriteMode/Query Flags；Object PK/Title/Search/Sort；Link 两端 Revision/Cardinality | 错误 API Name/Enum/Cardinality/Pointer、缺失 PK 引用、非 Unique PK、String 缺 Case Rule、错误 Search/Sort、Decimal/JSON 反例 | PASS |
| 写入拒绝未知字段，Reader/Writer 发布顺序明确                                                | 所有 Object Schema `additionalProperties=false`；Runtime 精确字段；治理文档 §6                                                              | 嵌套未知字段拒绝；Optional Addition Diff Compatible 但 Parser Agreement 在 Reader 未更新时失败                               | PASS |
| 直接 Resource 与 Package 共同使用一个 Family Registry                                       | Direct/Package 两入口共同委托 `parsePublishableResourceContent`                                                                             | 2 Active、8 Deferred；8 × 2 入口同一 `CAPABILITY_NOT_ACTIVE`/Gate；Unknown 稳定拒绝                                          | PASS |
| Schema 与 Runtime Parser 不静默漂移                                                         | `metadata-runtime-schema-agreement.ts` 核对字段、Required、Ref、Enum、Pattern、长度、数组和整数范围                                         | Schema 新可选字段但 Parser 未更新时失败；当前 Agreement PASS                                                                 | PASS |
| 兼容 Gate 允许可选增加并阻断破坏变异                                                        | v1 Baseline + 通用 Schema Diff 扩展 `minimum/maximum`                                                                                       | 删除、Required Addition、Type、Enum、Bounds、Unknown Policy 变化均 Breaking                                                  | PASS |
| Key 顺序/空白不影响 Digest                                                                  | 合同层 Canonical JSON；Manifest 专用前像排除自引用 Digest                                                                                   | Key 重排/空白 Hash 相同；业务值变化 Hash 不同；负零、Unsafe Integer、Undefined 拒绝                                          | PASS |
| 只冻结 Metadata Family                                                                      | Catalog 的 `ResourceRevisionReleasePackage.fieldsFrozen=true` 与三个已激活 Definition                                                       | 其他 4 Deferred Contract Family 保持 `false`；Policy/Action/View 等 Registry Deferred                                        | PASS |
| Contracts 无 DB/HTTP/OIDC/Node/Workspace 依赖                                               | Pure TypeScript Parser/Canonicalizer/Registry；SHA-256 留给 Adapter                                                                         | Architecture Gate PASS：3 Packages / 23 Source Files                                                                         | PASS |

## 2. 红队实际修正

[专项红队](../reviews/g2-01-02-metadata-contract-red-team.md)在冻结前发现并修正三个会导致后续返工的真实偏差：

1. Property Classification 初版误做必填，与 PRD“缺失时继承 Object Default”冲突；现改为可选并由后续 Runtime 解析有效 Classification；
2. Primary Key 初版只检查 Non-null 与类型，没有强制对应 Property `unique=true`；现加入语义拒绝与回归测试；
3. Primary Key 初版只允许 String/Integer，且 String Property 未冻结 `caseSensitive`，与 ADR-009 `pk1` Codec 和 PRD Query 大小写规则冲突；现允许 Codec 已支持的 Stable Scalar，并要求 String 显式 Case Rule；
4. Release Manifest 初版允许空 Pins，容易把“零 Runtime Member Activation”误解为“空 Metadata Release”；现 Schema/Parser 同时要求至少一个 Metadata Pin。

另外固定两条边界：结构 Schema 与跨字段 Runtime 语义是两层必跑校验，不把 Schema 接受语义矛盾对象误认为漂移；Manifest Digest 前像统一排除且只排除 `manifestDigest` 自身，调用方不能自行定义投影。

## 3. 冻结资产

### 3.1 合同与 Fixture

- 12 个顶层 Metadata 合同；19 个含嵌套结构的 Object Definition；
- 36 个 Metadata Golden Fixture，其中 7 个结构拒绝、5 个跨字段语义拒绝；
- 10 个 Metadata 专项测试；
- Catalog 总计 11 Foundation + 12 Metadata Contract；
- 合同 Gate 总计 66 个 Foundation/Metadata Golden Fixture；
- Registry 总计 10 个 Resource Family：2 Active、8 Deferred。

### 3.2 资产 SHA-256

```text
0b1f3ee776014d59a2657bef15d4cf6b6eb897f5648521bd9a8c050cf4a9f7b9  metadata.schema.json
0b1f3ee776014d59a2657bef15d4cf6b6eb897f5648521bd9a8c050cf4a9f7b9  baseline/metadata.v1.schema.json
9f9273c89de0ad83365aaeaab0227c2f4719d8b76805ab5d487113fad55a7157  metadata-golden.json
ed5236e6869c504c1a750527d74867627205c251deb41b0fdba1c94195ea76f4  catalog.json
8605ed99c6005bc8f80b5f9702e250ca6776fdf3f862921d4f0ee9b442221150  metadata.ts
a8a18fc9d667a58bb216b4cfb4d4f4eaf3a255af3ff5b4d995556228f1ee532d  resource-family-registry.ts
e1a8e6aacaf3b1624f5dd4ef8f255cc006972d87d31f893fea8d09f81c6a9855  canonical-json.ts
```

Baseline 与当前 Schema 在首次冻结时字节相同。后续兼容增加不得为了消除 Finding 同时移动 Baseline；破坏变化必须建立新版本与迁移计划。

## 4. 可复现执行

### 4.1 Metadata 专项

```text
nvm exec 24.18.0 npm run test:metadata-contracts

10 tests / 10 pass / 0 fail
```

### 4.2 合同与全仓 Gate

```text
nvm exec 24.18.0 npm run check:contracts

contracts: PASS (11 foundation, 12 metadata, 16 stable error codes, 66 golden cases)

nvm exec 24.18.0 npm run verify

Foundation Gate: PASS
unit:                  226/226
contract-golden-diff: PASS
architecture:          PASS — 3 packages / 23 source files
supply chain:          PASS — 135 packages / 138 SBOM components / 0 vulnerabilities
postgres integration: PASS — PostgreSQL 16 / role escalation blocked
production boundary:  PASS — OIDC / S3 / PostgreSQL / OpenTelemetry
teardown:              PASS — containers and network removed
```

沙箱内第一次执行在 `npm audit` 返回缺少漏洞元数据时 Fail Closed；该结果属于受限网络环境，不被当作通过。随后在沙箱外使用仓库固定 Node/npm 完整重跑，Supply Chain 与全部后续 Gate 均 PASS。

## 5. 明确不宣称

- 本任务没有创建 DB-01 表、Migration、Repository、事务或最小数据库权限；G2-01-03 负责真实 PostgreSQL 落地。
- 本任务没有实现 Project/RBAC、Resource Draft、Dependency Extractor、业务 Compatibility、Release Publish、Package Lifecycle 或 Admin HTTP API。
- `ValidationReport`/`CompatibilityReport` 只是稳定 Envelope；具体算法分别由 G2-01-06/07 实现。
- Family Registry 已冻结唯一判断来源，但真实 Release Validator 与 Package Expander 接入仍须在 G2-01-08/09 证明。
- Canonicalizer 已冻结 Digest 前像；Store 中重算、持久化和比对 SHA-256 仍须在 G2-01-05/08/09 证明。
- Object Mapping、Policy、View/Application Config 引用尚未冻结；它们由 G2-02/03/05 通过新 Revision/Release 增量加入。
- 当前 Gate PASS 不代表 G2-01 完成；G2-01-03～12 仍 OPEN。
