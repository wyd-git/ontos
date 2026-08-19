# G2-03-05 Policy Resource / Compiler / Release Gate Evidence

- 日期：2026-08-19
- 结论：**PASS**
- 资格限定：只有同一 Commit 的 `g2-03-05-evidence-manifest.json` 为 `CLEAN_ROOM_PASS` 时成立
- 任务合同：[G2-03-05](../delivery/g2-03-query-policy-task-pack.md#g2-03-05激活-policy-resourcecompiler-与-release-gate)
- 架构决策：[ADR-023](../architecture/adr/023-policy-resource-compiler-release-gate.md)
- 复审：[Intended-vs-Implemented](../reviews/g2-03-05-intended-vs-implemented.md)

## 1. 本 Gate 证明了什么

G2-03-05 已把 `policy` 从 Deferred Family 变成可发布的正式 Resource，并闭合了以下链路：

```text
Direct Resource / Package
→ 同一严格 Parser 与 Dependency Extractor
→ 精确 Object / Property / Link / Action Revision 依赖
→ Policy Validation
→ 有界确定性 Compiler + 正式 Evaluator
→ 版本化 S3 内容寻址 IR / Test Report
→ 不可变 PostgreSQL Compilation 事实
→ Release Stage / Publish 双重校验
```

具体已证明：

1. Direct 与 Package 路径共用同一 Registry，不存在宽松的第二 Parser；
2. Rule、Test Vector 和一跳 `link_exists` 的每个引用都生成带 JSON Pointer 的精确 Revision 依赖；
3. Compiler 只读已固定 Release Closure、可索引 Property 和受信 Actor Attribute Schema，不读网络、SQL、环境时间或运行时“最新版本”；
4. Deny 优先于 Mask/Allow，无匹配默认 Deny；Missing/Null 使用三值逻辑，`not(missing)` 不会变成 Allow；
5. 每个 Policy 必须包含 Allow、Deny、Missing、Null，以及适用时的 Link Invisible 和 Property Mask/Deny 向量；
6. IR 与 Test Report 先按 SHA-256 验证后写入版本化 S3，再由受信 Worker/Compiler 记录 PostgreSQL 事实；
7. `api_runtime` 已无权记录“编译通过”，即使伪造普通 Release Validation Report，也不能越过数据库 Policy Gate；
8. 缺编译、错 Content Digest、错向量数、失败向量、错 Artifact 绑定或不完整依赖都阻止 Release READY/PUBLISHED。

该结论不声称 Policy Gateway、Query SQL、Runtime HTTP 或 UI 已完成。

## 2. 正式产物

| 产物                                             | 责任                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `packages/contracts/src/policy.ts`               | Policy Resource/Artifact/Decision 严格合同、上限与精确依赖提取                |
| `@ontos/policy-domain`                           | 纯函数 Compiler、确定性 IR/Test Report、三值逻辑 Evaluator、兼容分类          |
| `@ontos/policy-application`                      | 加载快照、编译、先存 Artifact、后记录 Compilation 的唯一 Use Case             |
| `@ontos/policy-postgres`                         | Repeatable-read 编译输入、受信 Actor Schema、Worker-only Compilation Recorder |
| `S3PolicyArtifactStore`                          | `policy/ir/` 与 `policy/test/` 内容寻址存取与读写 Digest 验证                 |
| `0026_policy_resource_compiler_release_gate.sql` | 依赖精确性、Compilation 绑定、API/Worker 权限、Stage/Publish 数据库防线       |
| `tools/policy-compiler/`                         | Domain/Application/Process/S3/PostgreSQL/迁移回滚/越权破坏测试                |

## 3. 机器证据

| 命令 / Artifact                            | 证明                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `npm run test:policy-compiler`             | Parser/Extractor、AST 上限、语义、兼容、Artifact 顺序、存储失败和跨进程确定性      |
| `npm run test:policy-compiler:integration` | 真 PostgreSQL 16 + 版本化 SeaweedFS S3 + 非 Owner API/Compiler 权限 + Release 发布 |
| `npm run test:database`                    | 0026 与既有 Metadata/Materialization/Query Lease 回归兼容                          |
| `npm run check:g2-03-05-evidence`          | Required Record、Source Marker、范围、历史 Gate 前向接纳与 Artifact 完整性         |
| `npm run verify`                           | 42 道统一 Gate、Clean Checkout、同 Commit Artifact 与最终 Manifest                 |
| `g2-03-05-policy-compiler.json`            | `REAL_POSTGRES_16_VERSIONED_S3_RELEASE_GATE`                                       |
| `g2-03-05-evidence-manifest.json`          | 本 Gate 唯一最终 `CLEAN_ROOM_PASS` 资格                                            |

## 4. 关键故障矩阵

| 场景                                                        | 结果                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| Direct/Package 提交 Raw SQL、多余字段、递归 Link 或过大 AST | 合同或 Compiler 在产生 Artifact 前拒绝                   |
| 跨 Project、错 Family、错 Resource ID、不在 Release Closure | 统一 `TARGET_UNAVAILABLE`/验证失败，不泄露目标是否存在   |
| 非索引 Property、未知 Actor Attribute、不匹配 Test Vector   | 无 Passed Compilation，Release 无法 READY                |
| S3 写入或 Digest 验证失败                                   | 不记录 Compilation，错误统一为 Storage Failure           |
| API 直接调用 `record_policy_compilation`                    | PostgreSQL `42501`；API 不能提交“passed”布尔值           |
| 管理员伪造普通 Release Validation Report                    | 0026 Trigger 仍返回 `G20305_POLICY_COMPILATION_REQUIRED` |
| 向量数 999 或内容摘要错误但向量数正确                       | Compilation 事务回滚，Artifact Reference 零残留          |
| 0026 末尾注入故障                                           | 整个 Migration 回滚，Ledger 仍为 25，新 Resolver 不存在  |
| Published Compilation 尝试修改                              | PostgreSQL `55000`，历史不可原地替换                     |

## 5. 范围与剩余风险

本项没有新增 Runtime HTTP Endpoint、Query SQL、Policy Gateway Cache、Web、Action/Overlay 或 SDK。Action Target 保留精确合同，但 Action Type 未激活时只会 fail closed。

| 剩余风险                                                                                     | Owner               | 关闭 Gate                  |
| -------------------------------------------------------------------------------------------- | ------------------- | -------------------------- |
| 生产 Gateway 尚未按精确 Digest 加载 Artifact、组合 Identity/Epoch 并实现最迟 5 秒撤权        | Policy / Runtime    | G2-03-06                   |
| Artifact 在记录后被运维删除时，当前 Release 事实不变；后续 Gateway 必须因精确对象缺失而 Deny | Policy / Operations | G2-03-06 / Deployment Gate |
| Policy IR 尚未生成参数化 Query SQL，也未完成 10k/100k 查询薄切片                             | Query / PostgreSQL  | G2-03-07～09               |
| 无公开 Runtime Route 或 Web 消费者                                                           | API / Web           | G2-03-12～13               |
| Compiler 生产调度、重试指标和 S3 Credential 托管尚未部署                                     | Policy / Operations | G2-03-06 / Deployment Gate |

本 Gate 关闭后只放行 **G2-03-06：生产 Policy Gateway 与 5 秒撤权**。
