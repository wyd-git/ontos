# G2-03-08 Intended vs Implemented Review

- Review：G2-03-08 Runtime Metadata 与 Activation-aware Object Get
- 日期：2026-08-21
- 方法：以冻结任务包、Runtime Read Contract、ADR-007/019/020/021/024/025/026 为意图源，逐项对照 Migration、生产包、单元测试和真实 PostgreSQL 16 机器证据
- 结论：**PASS**

## 1. 意图源

本审查不从已有代码反推需求，承重意图按以下优先级读取：

1. `docs/delivery/g2-03-query-policy-task-pack.md` 的 G2-03-08 Why/What/Acceptance；
2. `docs/architecture/g2-03-runtime-read-contract.md` 的 Execution Context、Response、Property 与错误语义；
3. ADR-007/019 的 Release 支持窗口和 GC Root；
4. ADR-020/021/024/025 的 Policy Gateway、Query Lease、Policy-in-SQL 与 Compiler 边界；
5. ADR-026 对本 Gate 的单 Policy P0、门控 View、Object Version 与范围冻结。

## 2. 逐项差距审查

| 冻结意图                                                           | 实际实现                                                                           | 证据                                             | 结论 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------ | ---- |
| 每请求只解析一次 Project/Release/Activation/Plan/Generation/Policy | 同快照 Resolver 返回完整候选，Application 后续不查询“最新”事实                     | 显式 Release/Channel 与精确 ID 断言              | PASS |
| 显式 Release 支持与退役无 fallback                                 | 不可变 `support_until`，显式 CAS Retire，缺 Head 映射 `RELEASE_RETIRED`            | 权限/不可变/Retire PostgreSQL 负测               | PASS |
| 读取前 Lease 保护全部 Generation                                   | Policy 后原子重验并 Commit，Activate 后才可见门控 Current                          | 无 Context 0 行、精确 Context 1 行、漂移无 Lease | PASS |
| Kill 后孤儿 Lease 有界回收                                         | Lease 依赖数据库 TTL；独立 Owner 被 `SIGKILL`，Worker 过期并移除 Root              | 真实子进程/PostgreSQL/GC Provider 测试           | PASS |
| Metadata 只返回 Actor 可发现能力                                   | Object allow 才出现；Property/Link 按 Policy 降级，不输出内部 Policy               | 两 Object 一显一隐、restricted capability 断言   | PASS |
| Get 使用 Canonical PK + 精确 Revision/Generation                   | Compiler 生成 PK；Repository 只读 Lease View 并精确绑定                            | 真 PostgreSQL Object 与 `objectVersion=7`        | PASS |
| 不存在/不可见同形 404                                              | 未知/Denied Object 与 0 行均为 `OBJECT_NOT_ACCESSIBLE`                             | Application 与 PostgreSQL 负向量                 | PASS |
| 五态与 Serializer 二次防御                                         | SQL 不返回 mask/deny 原值；Serializer 核对 Policy、Key Set、Row/Byte               | mask/missing、泄露/多行/非法 Shape 负测          | PASS |
| Cutover/Refresh/Policy/Retire 不混代                               | 候选 Commit 比较 Activation、Generation Digest、Compilation、Epoch；读事务精确门控 | Serving Head/Epoch 漂移与 Retire 断言            | PASS |
| API/Worker/Ops 最小权限                                            | API 仅受控函数和 View；三角色无裸 Current                                          | `has_*_privilege` 与 42501 负测                  | PASS |

## 3. 审查中发现并关闭的偏差

- ADR-007 已要求至少 90 天显式 Release 支持，但 `0001`～`0027` 没有持久支持截止时间，无法安全实现 Retire；`0028` 增加并冻结 `support_until`，没有修改历史 Migration；
- 旧 Query Lease Plan 只返回 Generation ID，不能构建精确 Published Schema Registry；Resolver 现在同快照返回 Activation Member 的 Resource/Revision/Generation/Definition，并在 Commit 时重验 Generation Set Digest；
- 首次真实 PostgreSQL 读取因门控函数只设置 Query 专用 GUC、没有设置现有强制 RLS 使用的共享 `ontos.project_id` 而得到 0 行；现已在验证精确 Lease 后设置事务级 Project Context，并由门控 View 正向量固定；
- PostgreSQL Driver 错误是 `Error` 子类而非 plain object，旧冲突识别会把 `40001/55000` 误报成内部错误；现已按通用对象字段识别并固定 `QUERY_CONTEXT_CHANGED`；
- Get 编译阶段曾把所有错误统一映射为对象 404，会隐藏 Policy IR/合同故障；现只保留未知/Denied/0 行的 404，Policy 编译失败为 `POLICY_EVALUATION_UNAVAILABLE`，其他编译异常 fail closed；
- 最初的孤儿测试只在同进程故意不 Release；现改为独立 Owner Commit 后真实 `SIGKILL`，直接证明进程死亡不丢 GC 保护且到期可回收。
- 合并前复审发现 Metadata Link 只检查 Artifact rule、没有独立确认 Link Resource 的 Gateway 决策；现对两端可见的 Link 单独调用同一生产 Gateway，把 Object 与 Link 的全部决策绑定进 Lease Policy Context Hash，并增加 allow/deny 正反向量；
- 合并前复审还发现“激活 Lease 的 CTE 与读取门控 View”若只是普通 Cross Join，理论上可能被 PostgreSQL 选择不同 Join 顺序；现通过带 `OFFSET 0` 的相关 `LATERAL` 屏障建立执行依赖，并由真实 PostgreSQL 正向量验证。
- 完整非空库升级发现 Release 回填产生的延迟 Trigger 事件会阻止紧随其后的 `ALTER TABLE`；现先以 `NOT VALID` 建立约束，回填后显式清空事件再 Validate，并由 A0 历史 Release、逐 Migration 故障回滚和连续 `0001`～`0028` 复验固定；
- `0028` 撤销 API 的旧两步 Plan/Commit 后，历史 G2-02 集成仍直接调用旧函数；现明确断言 API 得到 `42501`，Runtime 路径改用原子 Context Commit，同时保留 Owner 事务对 Planned Lease 不产生 GC Root 的历史不变量证明。

## 4. 有意的 P0 简化与保留差距

P0 只允许每个 Release 一个 Runtime Read Policy Artifact。多 Artifact 不是被忽略，而是 fail closed；其组合优先级、测试向量和 Context Hash 必须在未来单独冻结。该限制由 ADR-026 明示，不改变 PRD 的单一 Gateway 与默认拒绝语义。

以下仍是计划内后续，不是本 Gate 的隐藏完成项：

- G2-03-09：Search、Count、签名 Cursor、10k/100k 查询资格；
- G2-03-10：一跳/二跳 Link 产品用例；
- G2-03-11：跨入口 Policy/泄露一致性 Harness；
- G2-03-12/13：Runtime HTTP、Generated Client 与真实只读 Web；
- G2-03-14/15：并发 Endurance、完整 clean-room 与最终总验收；
- G2-04：Overlay/Action 写入和 Object Version Recheck。

本项没有 HTTP、UI、Search/Cursor、Action、领域专用 SQL 或裸 Current Grant。Metadata 的 Link 描述只是策略感知发现信息，不等同于 Link Traversal 已实现。

## 5. 放行结论

G2-03-08 的承重需求均有生产实现和可重复证据；没有发现需要修改 `0001`～`0027`、绕过 Policy Gateway、删除 GC 保护或提前建设 UI 的阻断性偏差。停止条件未触发，放行 **G2-03-09 only**。
