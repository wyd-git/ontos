# G2-01-01 Metadata 控制面事务设计验收记录

- 结论：**PASS（仅限 ADR 与可执行状态合同）**
- 执行日期：2026-08-14
- 分支：`agent/g2-01-01-metadata-control-plane`
- 工具：Node.js 24.18.0 / npm 11.16.0
- 数据库状态：**未创建 DB-01；真实 PostgreSQL 证明仍 OPEN**

本记录对应 [G2-01-01 WWA](../delivery/g2-01-metadata-task-pack.md#g2-01-01冻结-metadataauthz-与零成员-activation-事务设计)。实现 Commit 由 PR Head 记录，避免已提交文件引用自身尚不存在的 Hash。

## 1. Intended-vs-Implemented 映射

| 意图                                       | 实现                                                                                           | 自动反例                                                                                     | 结果                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------- |
| DB-01 表、键、不可变性与 Runtime 权限冻结  | ADR-013 §3 列出 18 张候选表的 PK/FK/UQ、可变列和 API/Worker/Ops Grant                          | 文档审查确认未创建 DB-01 Migration/业务表                                                    | PASS（设计）/ OPEN（DB）      |
| Revision/Release/Package/Role 状态只向前   | `tools/metadata-control-plane/model.ts` 的四组状态函数与 Binding 替换事务                      | Etag 陈旧、回退、FAILED 复活、Pending 跳 Superseded、旧 Binding ID 复活均拒绝                | PASS（状态合同）              |
| Publish 与 Snapshot Cutover 无锁序冲突     | 同一 `LOCK_ORDER`；两个操作各取单调子集                                                        | 显式逆序计划拒绝                                                                             | PASS（合同）/ OPEN（SQL）     |
| G2-01 零成员 Activation 可增量进入 DB-02   | ADR-007 区分 Metadata Pin/Runtime Plan Pin；允许空 Plan；DB-01 模型显式拒绝非空 Activation     | R1/A0 → R2/A1 → R2/A2 并发 R3；历史 R1/A0、R2 Plan/Manifest 不变；DB-01 非空 Member 反例拒绝 | PASS（Harness）               |
| Package Active 与 Release/Channel 原子一致 | `publishReleaseTransaction` 同时切 Release、Serving Head、Channel、Change、Installation、Epoch | 五个事务边界逐一故障注入；全部保留旧状态；重复请求 No-op                                     | PASS（状态合同）              |
| 管理 RBAC 不成为 JWT/G2-03 旁路            | 严格 Foundation Identity、集中角色矩阵、Resource 权限交集                                      | 原 Token/额外字段拒绝，Principal 不匹配拒绝，Executor/Auditor 不扩权                         | PASS（Harness）/ OPEN（HTTP） |
| Publish 不把外部依赖带入事务               | Publish 是纯函数，输入只有已存在的 State/ID/Digest/CAS，无 Callback/Port                       | 类型和实现审查无 S3/OIDC/HTTP/Worker/Materializer 入口                                       | PASS（设计）                  |
| 失败可以 Roll Forward                      | ADR-013 §7 只新增 Release/Activation/Migration/Binding，历史不改                               | Failed Terminal、旧 Binding 不复活、Rollback 使用新 Release 的既有 Harness                   | PASS（状态合同）              |

## 2. 编码前审计实际修正的错误

任务包最初把 seam 写成 `R1 empty A0 → R1 first-member A1`。这与 ADR-007 的“Activation Members 必须等于 Release Plan”以及 Release Plan 不可变相冲突，照此实现会让 DB-02 必须修改历史 R1 或 A0。

在创建 ADR-013 和 DB-01 表之前，审计将其修正为：

```text
R1 metadata-only / empty runtime plan / A0
  → R2 adds first runtime member plan / A1
  → R2 data refresh / A2
  ↔ concurrent R3 publish
```

相应变更已同步写入 ADR-007、G2-01 任务包、任务包红队和 Runtime Harness。该修正没有扩大产品范围；它关闭了一个会导致未来 Migration 重写的可落地性缺口。

## 3. 可复现专项执行

```text
nvm exec 24.18.0 npm run test:metadata-control-plane
PASS — 10/10

nvm exec 24.18.0 npm run test:activation
PASS — 17/17（14 fixed scenarios + 3 properties）

nvm exec 24.18.0 npm run typecheck
PASS
```

### 3.1 全仓本地 Gate

```text
nvm exec 24.18.0 npm run verify
Foundation Gate: PASS — 16/16

format / lint / typecheck                         PASS
unit                                              PASS — 216/216
contract / architecture / testkit provenance     PASS
secret scan                                      PASS — 265 tracked text files / 0 findings
foundation scope                                 PASS — 3 packages / 1 DB-00 migration / no business app or UI
supply chain                                     PASS — 135 packages / 138 SBOM components / 0 vulnerabilities
PostgreSQL 16 integration                        PASS — non-owner boundary and escalation denial
production-boundary up/smoke/down                PASS — PostgreSQL / OIDC / S3 / OTEL
```

这次 Gate 仍只回归已有 DB-00 和 Foundation 生产边界；它没有创建或验证 DB-01。远端 Foundation Gate 和 clean main 结果由 PR/`main` CI 记录，不能用本地 Worktree PASS 替代。

## 4. Red-Team 结论

[ADR-013 专项红队](../reviews/adr-013-metadata-control-plane-red-team.md)攻击了五个承重假设：

1. 空 Activation 是否真的能进入 DB-02；
2. Package Active Pointer 是否会先于 Release 暴露；
3. Publish/Refresh 是否可能锁反转或倒拨；
4. 最小 RBAC 是否成为 G2-03 授权旁路；
5. 内存 Harness 是否被误称为数据库证明。

第 1 项原假设被证伪后已修订；第 2～4 项在状态/设计层关闭；第 5 项明确保留为 G2-01-03 Kill Criterion。因此只放行 G2-01-02，不宣称 DB-01 或 G2-01 完成。

## 5. 明确不宣称

- 没有创建 DB-01 Migration、表、索引、FK、Trigger、受控写函数或 Repository；
- 没有用真实 PostgreSQL 证明事务回滚、锁等待、Deadlock、权限和 Published 不可变；
- 没有实现 Resource/Package 合同、Validator、Dependency Extractor 或 Compatibility Gate；
- 没有实现真实 OIDC、Principal Repository、HTTP Admin API 或多进程撤权链路；
- 没有创建 Generation、Snapshot、Runtime Activation Member 或 Materializer；
- 没有把 G2-03 Object/Property/Link/Action Policy 提前并入最小管理 RBAC；
- 没有把纯函数故障注入称为 SQL 或生产可用性证明。

以上项目分别属于 G2-01-02～11 或 G2-02/G2-03。它们不阻止 G2-01-01 设计 Gate PASS，但会阻止越级宣称完整产品或生产就绪。
