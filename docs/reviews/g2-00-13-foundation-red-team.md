# Red-Team：G2-00-13 Foundation 总 Gate

结论：**Go（G2-00 Foundation）**。独立 clean checkout 在空项目卷上完成 bootstrap、16/16 Gate 和 teardown；Manifest 绑定 Commit、Dirty、环境、输入、Artifact、Owner 与风险。该结论只允许建立 G2-01 任务包，不把 Foundation 包装成可用产品。

## Top Kill-Assumptions（按优先级）

### 1. “Clean room”没有偷偷复用当前工作树或持久卷（已关闭，99）

- **Claim：** G2-00 可以从远端源码和固定公开配置重建。
- **Fails if：** Clone 含未提交文件、依赖由当前 `node_modules` 提供、Docker 复用旧卷，或 Manifest 没有绑定 Head/Dirty。
- **Evidence to get this week：** 新 HTTPS Clone 的空状态、前后项目卷清单、Manifest Commit/Dirty。
- **Kill criterion：** `git status` 非空、前置 Reset 未执行、`cleanCheckout!=true`，或 Manifest Commit 不等于 Clone Head。
- **Cheapest test：** 在新临时目录执行 `npm ci → env:reset → verify → env:reset`。
- **结果：** Head `7c4aa88...`、`dirty=false`、`CLEAN_ROOM_PASS`；前后只删除 `ontos-g2-local` 三个测试卷。**CLOSED**。

### 2. 十二个局部 PASS 真能在一个进程路径共同成立（已关闭，97）

- **Claim：** 合同、权限、环境、testkit、供应链和架构边界不是互相冲突的孤立样例。
- **Fails if：** 最终验证手工挑选命令、跳过真实 PostgreSQL/Smoke，或一个失败后仍输出总 PASS。
- **Evidence to get this week：** `tools/ci/run.ts:33-64` 的唯一顺序与 clean-room `report.json`。
- **Kill criterion：** 任一必跑项缺失/Skipped/Fail，或 CI 不再只调用 `npm run verify`。
- **Cheapest test：** 一次完整 clean-room Gate 并检查 16 个 Step。
- **结果：** 16/16 PASS，203/203 Unit，PostgreSQL/OIDC/S3/OTEL 均真实执行；失败仍 fail-fast 并 teardown。**CLOSED**。

### 3. Foundation 没有提前混入业务实现（已关闭，96）

- **Claim：** G2-00 只有底座、合同与 seam proof，不含 DB-01、业务 Endpoint 或页面。
- **Fails if：** 新 App/Workspace、非 DB-00 Migration、业务表或 UI 文件被纳入总 PASS。
- **Evidence to get this week：** `security/g2-00-evidence-policy.json:4-10` 与 `tools/ci/foundation-evidence.ts:44-77,206-250` 的 Git 跟踪清单检查。
- **Kill criterion：** Workspace/Migration/Table 集合漂移，出现 `apps/` 或非 Spike UI 文件。
- **Cheapest test：** 分别注入 App、DB-01 Table 和 `.tsx` 的负面单测。
- **结果：** 负面测试稳定产生 8 个 Violation；真实清单为 3 个 Package、1 个 DB-00 Migration、唯一迁移账本表、0 App、0 UI。对伪装在现有 `tools/` 下的语义仍依赖代码审查；本 Commit 已额外搜索 Server Listener，只有 Handler Host 的网络拒绝探针。**CLOSED for current Commit**。

### 4. Evidence Manifest 不是把文档里的 PASS 再抄一遍（已关闭，94）

- **Claim：** Manifest 来自实际执行，而不是人工编辑结论。
- **Fails if：** Manifest 不记录 Commit/Dirty、丢失 Artifact Hash、把脏工作树称为 clean，或复制完整输出造成 Secret 二次暴露。
- **Evidence to get this week：** `tools/ci/foundation-evidence.ts:105-153` 与生成 Artifact。
- **Kill criterion：** Dirty 工作树得到 `CLEAN_ROOM_PASS`、Step 与报告不一致，或 Manifest 包含 `outputTail`。
- **Cheapest test：** 用 Dirty/Clean 假报告构造 Manifest，并检查输出不复制日志。
- **结果：** Unit 覆盖 Commit-bound clean qualification；实际 Manifest Hash 为 `2b7541...b160`，只保留紧凑结果和摘要。**CLOSED**。

### 5. 原六周日历没有借 AI 名义继续保留（已关闭，92）

- **Claim：** 实际 Owner、第二视角和并行度会约束计划。
- **Fails if：** 把一个 Accountable Owner + Codex 支持计成 4–6 人并行团队，或为日期删除 Gate。
- **Evidence to get this week：** `security/g2-00-evidence-policy.json:64-110` 与 [Owner/容量矩阵](../delivery/g2-owner-capacity-matrix.md)。
- **Kill criterion：** G2-01～05 同时开发，继续承诺六周，或没有安全/恢复第二审查要求。
- **Cheapest test：** 按实际责任线重排依赖并求和。
- **结果：** 有效并行度固定为 1；六周情景撤销，顺序规划改为 14–22 工程周，每个 Gate 重新估算。**CLOSED**。

## Intended vs. Implemented

| 文档化意图                                                    | 实现现实与引用                                                                                                     | 攻击者/受影响边界                    | 结论  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ----- |
| 新 Checkout 完成 Bootstrap/验证/Teardown（Task Pack 360–368） | `tools/ci/run.ts:76-173` 绑定 Commit/Dirty、统一执行并保证环境清理；实际新 Clone 为 Clean                          | 隐藏本机状态会让下一位开发者无法重建 | MATCH |
| ADR-007～012 Accepted 且有 Evidence（369）                    | Policy 列出 6 对 ADR/Evidence；`foundation-evidence.ts:79-101` 读取真实状态/结论                                   | 过期文档会让下游按未证明模型建表     | MATCH |
| Contract、DB 权限、环境、testkit、架构、Secret 全通过（370）  | `run.ts:33-64` 的 16 项 Gate；真实 PostgreSQL Role Escalation 被阻止                                               | Runtime 越权、策略或 Secret 泄漏     | MATCH |
| 无 DB-01/API/UI（371）                                        | Scope Gate 校验 Workspace/Migration/Table/App/UI；Migration 唯一表见 `migrations/db-00/0001_foundation.sql:95-105` | 下游范围偷跑会污染 Foundation 决策   | MATCH |
| Manifest 含 Commit/Digest/环境/命令/结果/风险（372）          | `foundation-evidence.ts:105-153` 由报告与 Acceptance Artifact 生成                                                 | 人工摘要可选择性遗漏失败             | MATCH |
| Owner/容量/日历真实（373）                                    | Policy 与 Owner/容量文档明确 1 条通道和 14–22 周顺序情景                                                           | 虚假并行导致赶工绕过安全 Gate        | MATCH |
| Required Check 不可绕过                                       | Workflow 只执行 `npm run verify`（`.github/workflows/foundation-ci.yml:16-43`）；Main Protection 已 API 复查       | 管理员或直接 Push 绕开失败 Gate      | MATCH |

没有发现跨信任、数据或成本边界的 Intended-vs-Implemented 未关闭偏差。探索性发现的“`env:reset` 在 bootstrap 前缺依赖”已通过明确执行顺序和运行手册关闭；未降低工具链或测试要求。

## What's Well-Reasoned

- G2-00 把“可复现底座”与“可用产品”严格分开，避免用页面演示掩盖权限和数据一致性缺口。
- 真实服务 Smoke、负向权限测试和强制分支保护共同覆盖了本地正确、集成正确和不可绕过三层。
- Manifest 同时保留稳定源码输入与单次运行 Artifact，避免把随机 SBOM Timestamp 伪装成稳定身份。

## What I Couldn't Assess

- Linux 容器级 Handler 隔离、备份恢复、生产告警和真实 DB-02 容量尚未实现；它们分别属于 G2-05/08、G2-06/07 和 G2-02，不在 Foundation PASS 中偷换完成。
- 当前是单 Accountable Owner 模式；G2-06 Recovery、G2-08 Security 和 Internal Alpha 仍需补充相应领域的第二审查人。

## 独立 Reviewer 结论

本审查使用独立 clean checkout、机器 Manifest、Intent 对照和 Kill-Assumption 测试，不复用实现工作树结论。G2-00-13 为 **PASS**；PR Head 仍必须通过 GitHub 受保护的 `Foundation Gate` 后才能合并。合并后只可创建 G2-01 Metadata 任务包。
