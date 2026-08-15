# G2-02-02 Snapshot、Mapping、Generation 与 Job 合同 Evidence

- 日期：2026-08-15
- 结论：**PASS**（只代表 G2-02-02 合同 Gate；不代表 DB-02、上传/物化/激活闭环或完整 G2-02 已完成）
- 任务合同：[G2-02 Materialization 任务包 § G2-02-02](../delivery/g2-02-materialization-task-pack.md#g2-02-02冻结-snapshotmappinggeneration-与-job-模块合同)
- 治理：[Materialization v1 合同与兼容性治理](../architecture/materialization-contract-governance.md)

## 1. 实际交付

本工作项在 `@ontos/contracts` 冻结 12 类 Materialization v1 顶层合同，激活 `snapshot_schema` 与 `mapping` Resource Family，并让直接 Resource 与 Package 展开器共享同一个 Registry/Parser。

交付物包括严格 Runtime Parser、JSON Schema、Catalog、Golden Fixture、首次冻结 Baseline、Schema/Runtime Agreement、Breaking-change Gate、状态机、规范 Digest/幂等前像、服务器 Compatibility Certificate 和稳定错误族。没有新增数据库表、Migration、Endpoint、Worker 或对象存储实现。

## 2. Acceptance 对照

| 要求                                      | 实现与证据                                                                                                         | 结论 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---- |
| `snapshot_schema`、`mapping` G2-02 Active | `resource-family-registry.ts` 注册两个 Parser；直接/Package 同值测试                                               | PASS |
| 未知字段、宽松日期/数字和危险能力拒绝     | 严格 Object Shape、Foundation Scalar；SQL/Code/Path/Endpoint/Credential 与 Join/Window/Aggregate/Function 负测     | PASS |
| Mapping 仅逐行确定性 AST，复用 Codec      | 只开放 Column/Constant/Cast/Concat、Object/Link Key；版本固定 `@ontos/value-codec:pk1`                             | PASS |
| 状态、终态、Digest、版本                  | 六类状态机合法/非法边；Snapshot/Group/Job/Generation/Activation/GC Digest mutation；Schema Baseline mutation       | PASS |
| 幂等身份字段精确                          | 只接受 Content Hash、Mapping Revision、Target Member、Runtime Plan 和版本；显示名/上传时间/DB 顺序被拒绝           | PASS |
| 服务器兼容证书                            | 固定 Issuer，绑定 Schema/Mapping/Target/Plans/Generation/Validator/Evidence；`compatible` 字段负测                 | PASS |
| Golden Fixture                            | 20 例覆盖 Object、Link、组合 Group、Optional Rejection、Required Failure、Row Confirmation、安全拒绝和稳定错误清单 | PASS |
| Manifest 与 Breaking Gate                 | Catalog 冻结 12 Definitions、11 操作错误、7 Report 原因；v1 Baseline 与 Runtime Agreement 接入 `check:contracts`   | PASS |
| 不提前冻结 HTTP/SDK                       | Catalog 标为 internal/server-issued；治理文档明确 Endpoint/DTO 属于后续 G2-02-13                                   | PASS |

## 3. 可落地性复审修订

实现完成后又按“意图与实现差距”复审了跨字段语义，额外补上：

- Snapshot 文件字节/行数安全整数求和，防止溢出或汇总不一致；
- Job `updatedAt >= createdAt`、Queued 无假进度、Attempt/Checkpoint/Stage 一致；
- Report 不允许“Passed 但包含 Required/PK 致命原因”，Awaiting Confirmation 不能掩盖致命失败，Error Sample 必须对应聚合 Row Reason；
- Projected Peak 不能小于实测或预留，且硬上限不能审批绕过；
- Digest 测试证明只排除声明的生命周期/自引用字段，业务绑定字段变化必改前像。

这些修订避免了合同虽然能解析、但 DB-02/Worker 无法可靠执行的假完成。

## 4. 验证结果

```text
npm run check:contracts
PASS — 11 Foundation + 12 Metadata + 12 Materialization contracts
       16 API errors + 11 Materialization operation errors + 7 report reasons
       86 Golden cases

npm run test:contracts
PASS — 40 tests

npm run test:unit
PASS — 313 tests

npm run typecheck
PASS

npm run verify
PASS — 22/22 Gates, 326 tests
```

完整 Gate 还覆盖真实 PostgreSQL 16、OIDC、Admin HTTP、S3、OpenTelemetry、Metadata clean-room 和 production-boundary smoke/teardown。第一次受限沙箱运行因禁止监听 `127.0.0.1` 得到 `EPERM`；按仓库既定规则在沙箱外原命令重跑后 22/22 通过，这不是代码或凭据故障。远端 CI 仍须在最终 PR Head 上再次通过。

## 5. 下一工作项的真实入口

允许进入 G2-02-03：从现有连续 Migration 账本新增 `0007+`，将本合同映射为 DB-02 表、约束、Trigger、最小权限和两个真实 Worker 登录的 Lease/Fencing/Checkpoint 薄切片。G2-02-03 未完成前，不开始 CSV Ingress，也不能声称生产闭环已形成。
