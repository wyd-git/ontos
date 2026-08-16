# G2-02-10 Runtime Member Plan 与兼容证书 Evidence

- 日期：2026-08-16
- 结论：**PASS**（只代表 G2-02-10；不代表 Snapshot Group Cutover、Serving Head Refresh、GC、Admin HTTP 或整个 G2-02 已完成）
- 任务合同：[G2-02 Materialization 任务包 § G2-02-10](../delivery/g2-02-materialization-task-pack.md#g2-02-10实现-runtime-member-plan-与受信兼容证书)
- 架构依据：[ADR-007 Runtime Activation](../architecture/adr/007-runtime-activation-serving-head.md)、[ADR-008 Shared Projection](../architecture/adr/008-shared-projection-index-capacity.md)
- 专项红队：[G2-02-10 Red Team](../reviews/g2-02-10-runtime-plan-compatibility-red-team.md)

## 1. 实际交付

| 组件                      | 责任                                                                                                                    | 明确不做                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Runtime Plan Domain       | 从服务器读取的 Release Pins、Snapshot Group Definition 与已准入 Index Plan 编译确定性 Member 集合和 Digest              | 不接受请求提交 Member 列表或 Plan Digest                                 |
| Metadata Stage            | 在 Stage 事务内派生并持久化不可变 Runtime Plan；重复 Stage 必须得到完全相同结果                                         | 不修改历史 R1/A0，不在 Stage 中创建 Activation                           |
| Compatibility Coordinator | 枚举仍受支持的 Release，确保 Refresh Job，逐 Member 查找候选 Generation，报告 `pending/ready/reused/failed/stale`       | 不移动 Channel/Serving Head；一个 Release 的失败不写其他 Release Pointer |
| PostgreSQL Adapter        | 使用受信 Refresh Job 函数和四参数证书函数；把数据库拒绝稳定映射为 stale/incompatible                                    | 不允许调用方提交 decision、validator 或 evidence digest                  |
| Migration `0015`          | 完整 Group Definition、Stage-only Plan、证书事实绑定、当前证书 View、Release READY 完整性 Guard、审批有效期和最小权限   | 不改写 0001～0014，不实现 G2-02-11 Cutover                               |
| PostgreSQL Harness        | metadata-only、单 Member、多 Object + Base Link、两个 Release 复用、失败 Job、库存漂移、审批过期、Digest 变化和伪造攻击 | 测试 Activation 只验证完整成员集合；不冒充正式 Cutover Handler           |

## 2. 生产流程与信任边界

```text
Owner/Editor Stage Release
  → Metadata Store 读取 Published Pins
  → 读取服务器持有的 Snapshot Group Definition
  → 读取当前 Inventory 上已准入 Index Plan
  → 编译并持久化不可变 Runtime Member Plan
  → Materialization 完成 Generation、Quality、Capacity
  → API 只提交 projectId + generationId + targetReleaseId
  → SECURITY DEFINER 函数重读全部权威事实并签发证书
  → current_compatibility_certificates 动态重验当前库存/审批/质量
  → 所有 Group 的全部 Member 证书齐全后，Release 才可进入 READY
```

客户端、API 调用参数与 Worker 状态都不是兼容事实来源。证书函数只接受四个身份参数；decision、Validator Version、Evidence Digest 与 Certificate Digest 均由数据库计算。`api_runtime` 只能执行受控函数并读取当前证书；为 Stage 判断审批有效性，只新增 `capacity_approvals(project_id, approval_id, state, expires_at)` 四列读取权限，没有 UPDATE、DELETE、DDL 或 Owner 权限。没有新增客户端变量、Secret、定时任务或外部 Provider。

## 3. Acceptance 对照

| 要求                         | 实现与可执行证据                                                                                                                                                                                                | 结论 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Runtime Plan 只能服务器派生  | Domain 编译器严格解析 Pin/Mapping/Group/Index，按 Member Key 排序；Migration 重验 Published Pin、精确 Revision、Group Membership 与 Index Admission；请求合同没有 Member/Digest 字段                            | PASS |
| R1/A0 不变，首成员只能进 R2  | 真实 DB-01 Release 测试先保留 metadata-only R1/A0，再 Stage 含两个 Object 与一个 Base Link 的 R2；Migration 不更新历史行                                                                                        | PASS |
| Staging 可启动首轮物化       | 已密封且持有 Runtime Plan 的 Staging Release 可创建受管上传会话；Draft/无 Plan 仍不可访问，因此 R2 不需要先伪装 READY 才能获得首个 Snapshot                                                                     | PASS |
| Plan 不可变且 Group 必须完整 | 同 Release 重复 Stage 得到相同 Digest；持久 Plan 与重新派生结果不一致即拒绝；Deferred Trigger 拒绝部分 Group 和 late Member                                                                                     | PASS |
| 证书绑定全部权威事实         | 证书绑定 Project、Generation Digest、目标 Release/Member/Revision、Group Version、Snapshot/Schema/Mapping Digest、Index Plan、Quality/Report/Job、当前 Inventory、Capacity/Index Admission 与 Validator Version | PASS |
| 旧事实变化使证书失效         | Security-barrier Current View 每次重验 exact Admission ID、当前 Inventory、Approval State/Expiry、Quality/Report/Job 与 Digest；库存 Revision 变化后旧证书不会自动复活                                          | PASS |
| 全部 Member 后才能 READY     | Release READY Trigger 按 Snapshot Group 比较计划 Member 数和当前证书 Member 数；单个证书不能放行多 Member Release                                                                                               | PASS |
| 跨 Release 复用              | 两个并存 Release 对同一 READY Generation 分别签发证书，协调器报告 `ready/reused`；两个 Release、一个 Generation 的当前证书集合真实落库                                                                          | PASS |
| 失败隔离                     | 协调器逐 Release 返回结果且不创建 Activation/Pointer；失败 Job 的 Generation 即使伪造 READY、Quality 与 Report 也不能取得证书                                                                                   | PASS |
| 负向攻击稳定拒绝             | 覆盖伪造七参数证书、跨 Project、late Member、陈旧 Inventory、过期 Approval、失败 Job 与 Snapshot Digest 变化                                                                                                    | PASS |
| 多成员真实容量闭环           | 100k Object + 1m Link 的同一 Group 同时包含 Object 与 Base Link，两个 Generation、两个证书和两成员 Activation Harness 完整通过                                                                                  | PASS |

## 4. Intended-vs-Implemented 复审与实际返工

1. **原证书 FK 阻断合法跨 Release 复用。** 原复合 FK 强制 Generation 的源 Runtime Plan 等于目标 Release Plan；`0015` 保留真实 Generation Identity FK，并由受信函数分别重验源事实与目标 Plan，允许内容等价时签发 `projection_equivalent`。
2. **只保存证书 Digest 不足以防“旧证书复活”。** 首版 Current View 会在 Inventory 漂移后失效，但若未来出现同 Revision Admission，旧证书可能再次匹配。证书现在保存 exact `capacity_admission_id` 与 `index_admission_id`，新 Admission 只能签发新证书，旧证书永不自动复活。
3. **质量通过不能只看一个布尔状态。** 当前证书同时关联 Snapshot Digest、Mapping Digest、Report/Job Group Version、Report 总行数、成功 Job 和零 Overlay；复制 Quality 行但绑定失败 Job 的负测被拒绝。
4. **审批有效期必须成为持久证据。** G2-02-09 Admission 只保存 Approval ID；`0015` 增加 Admission 上的 Expiry、副本一致性约束和动态 Active/Expiry 重验。Legacy 有审批但无 Expiry 的行 fail closed。
5. **Base Link 不能伪造 Object 索引准入。** Link 使用服务器专用、零 Entry 的 `g2-02-10-link-index-v1` Plan；Object 仍必须绑定当前 Inventory 的真实 Index Admission。两者都进入同一个不可分割 Group Plan。
6. **Metadata Stage 的最小权限曾缺一条接缝。** 全量 PostgreSQL 回归发现 `api_runtime` 无法读取 Approval 有效状态；最终只开放四个判断字段，真实 Package/Release 老回归与新 Runtime Plan 向量全部通过。
7. **首成员流程曾形成 Ready/Materialize 循环依赖。** 旧 Ingress 只接受 Ready/Published Release，但新规则要求 Generation/Certificate 齐全才能 Ready；Commit-bound Gate 暴露了这条死锁。生产 Ingress 现在允许已有不可变 Runtime Plan 的 Staging Release 创建受管上传会话，同时仍拒绝 Draft/无 Plan，首轮 Snapshot → Generation → Certificate → Ready 路径可真实启动。

这些返工没有增加 Cutover、Serving Head、GC、Query、Action、UI 或调度器范围。

## 5. 正式容量复跑

最终多成员闭环在独立 Ubuntu 24 / x86_64 / 8 vCPU / 16 GiB / PostgreSQL 16.14 上，从空数据层执行 100,000 Object 与 1,000,000 Link：

| 指标                     |                                结果 |
| ------------------------ | ----------------------------------: |
| Object / Link 行数       |                 100,000 / 1,000,000 |
| Object / Link 批次       |                            20 / 200 |
| Object / Link 主阶段     |                646,547 / 633,764 ms |
| 完整构建                 |           1,284,840 ms（约 21m25s） |
| Quality Current          |                          166,145 ms |
| 总逻辑吞吐               |                          859 rows/s |
| Project 实际物理字节     |                 2,827,124,736 bytes |
| Capacity Reserved / Peak | 4,240,687,104 / 4,240,687,104 bytes |
| Node Peak RSS            |                   332,627,968 bytes |
| WAL                      |                         约 5.10 GiB |

构建低于 30 分钟停止线，Peak 低于 12 GiB 硬上限。Worker/API 连接池重启前后 Object/Link Digest 稳定；最终 Release 在两个当前证书齐全前保持 Staging，随后两 Member Closure 通过。该容量复跑不等于 G2-02-11 的真实原子 Cutover。

## 6. 可复现验证

```text
Node 24.18.0 / npm 11.16.0

npm test
PASS — 395 tests，0 failures；其中 Runtime Plan/Coordinator 8 个专项单元测试

npm run lint
npm run format:check
npm run typecheck
PASS

npm run test:materialization-ingress:integration
PASS — Staging Runtime Plan 可通过真实 OIDC/HTTP/PostgreSQL/versioned S3 启动首轮 Snapshot

npm run test:database
PASS — 6/6 PostgreSQL suites；Migration 0001～0015、DB-01 老回归、Runtime Plan、证书和权限向量

ONTOS_G2_02_09_CAPACITY=1 \
  node --test --test-concurrency=1 tools/database/materialization-postgres.integration.test.ts
PASS — 100k Object / 1m Link，多成员 Runtime Plan + 两证书 Closure，1,301,150 ms
```

## 7. 交付与运行说明

- Migration 继续使用单一 `ontos_migration.schema_migrations` 账本，当前连续到 `0015`；失败只 Roll Forward，不修改已发布历史。
- API/Worker 不拥有 Certificate、Admission、Quality、Report 或 Runtime Plan 任意直写权限；签发和 Refresh Job 只能调用登记函数。
- `worker:start` 仍保持 fail closed，直到 G2-02-11 把证书结果接入正式 Cutover Handler。
- 本 Gate 没有新环境变量、凭据、外部服务或客户端 Secret；重启和轮换规则沿用现有 PostgreSQL Runtime Roles。
- CI/PR Required Check 仍必须绑定最终 Commit；本地与专用机证据不替代远端分支保护。

## 8. 非结论与下一项

- 现在已有“这个 Generation 是否能服务这个 Release”的可信证明，但还没有正式创建新 Runtime Activation 或移动 Serving Head；
- `RuntimeCompatibilityCoordinator` 故意只准备 Job、候选与证书，不写任何 Pointer；
- Snapshot Group 原子 Cutover、并发 Publish/Refresh CAS、旧代继续服务和支持窗数据刷新属于 G2-02-11；
- GC/Drop 属于 G2-02-12，Admin HTTP/Testkit 与 clean-room 属于 G2-02-13/14；
- Query、Action 和 UI 仍不在 G2-02 范围内。

因此下一唯一允许的工作项是 **G2-02-11：Snapshot Group 原子 Cutover 与数据 Refresh**。
