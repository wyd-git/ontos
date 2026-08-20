# G2-03-06 Intended vs Implemented 对照审计

- 日期：2026-08-20
- 方法：`intended-vs-implemented`
- 结论：**PASS**

## 1. 可证明的意图来源

本审计只使用已提交的产品/架构意图，不从现有代码反推需求：

1. [G2-03-06 任务合同](../delivery/g2-03-query-policy-task-pack.md#g2-03-06实现生产-policy-gateway-与-5-秒撤权)；
2. [ADR-012](../architecture/adr/012-policy-epoch-cache-fail-closed.md) 的 Epoch/Cache/fail-closed 语义；
3. [ADR-020](../architecture/adr/020-query-policy-identity-consumer-boundary.md) 的唯一 Gateway 与后续 Query 消费边界；
4. [ADR-022](../architecture/adr/022-runtime-identity-claim-mapping-delegation.md) 的 Human/Service/Delegated Principal 交集；
5. [ADR-023](../architecture/adr/023-policy-resource-compiler-release-gate.md) 的精确 Release/Revision/Compiler/Artifact 绑定；
6. [ADR-024](../architecture/adr/024-production-policy-gateway-revocation.md) 的正式生产落点。

## 2. 意图与实现对照

| 承重要求                                                                                                | 实现/证据                                                                                         | 结论 |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---- |
| 同一 MVCC Snapshot 获取 Epoch、Principal/Delegation Role、Service Profile 和精确 Compilation            | `0027` 有界 Resolver + `PostgresPolicyGatewayRepository` 的单个 `REPEATABLE READ READ ONLY` 事务  | 一致 |
| 缓存键覆盖 Project、Identity/Delegation、Resource/Permission、Release、Policy Revision、Compiler、Epoch | `PolicyGatewayCacheKey` 与长度分隔序列化；每个维度有独立变异测试                                  | 一致 |
| TTL 最长 5 秒、不滑动、错误不续期                                                                       | 注入单调时钟，`now >= expiresAt` 失效；`1..5000ms` 性质测试                                       | 一致 |
| NOTIFY 只是提前失效 Hint，丢失/重复/乱序/重连不改变上界                                                 | 专用 PG Listener、真实 Backend 终止/自动重连、单调 Project Floor、双进程撤权与 4,999/5,000ms 验收 | 一致 |
| Human、Service、Delegated 使用同一 Principal Permission 交集                                            | 复用 `identity-domain.decideIntersectedPermission`，Service 额外交集当前 Profile Capability       | 一致 |
| 只读取精确 Artifact，不回退 latest/旧版                                                                 | S3 内容寻址读取 + Application 二次摘要/合同/目标绑定；真实删除后 fail closed                      | 一致 |
| Runtime 只有一个 Gateway Port，不新增裸 Binding/Current Reader 或 `internalAllow`                       | 生产 Package 不导入 `tools/policy-epoch`；新 Resolver 只授权 `api_runtime`，Worker/Ops 负测通过   | 一致 |
| Telemetry 不泄露 Subject/Claim/Token/Predicate/Value/SQL                                                | 固定六字段 Observation + 观察器故障隔离测试                                                       | 一致 |

## 3. 审计中发现并关闭的偏差

1. 初版 Snapshot 绑定了 Release/Policy Revision/Compiler，但没有明确证明 Policy Rule 直接作用于当前 Object。现在 Resolver 要求直接 Rule Target Dependency，Application 还会用 Artifact Rule Target 二次复核；拿 Predicate 中间接引用的 Person Policy 冒充 WorkItem Policy 已被拒绝。
2. 初版在处理其他依赖错误时，如果延迟采样同时发现单调时钟回退，虽然会 Deny，但可能保留原错误码。现在该路径优先回报 `POLICY_MONOTONIC_CLOCK_UNSAFE`，清空缓存并使进程代际永久 fail closed。
3. 重型 G2-03-05 和 G2-03-06 原可能分别启动 PostgreSQL/S3。现在两个 Artifact 复用同一次真实 Release 环境，减少一次重复启动，不删除任何验收断言。

## 4. 仍然存在但不属于本项的缺口

- Policy IR 还没有编译进参数化 Query SQL，因此当前不宣称 Object/Property/Link 已可安全对外读取；
- Runtime HTTP、SDK、Function、Action 和 UI 尚未存在，跨入口旁路由 G2-03-11～13 闭合；
- 长时 wall-clock Soak、Listener 告警和生产凭据托管属于 G2-03-14/部署 Gate。

这些缺口会继续阻止公开 Runtime Read，但不要求重写 G2-03-06 的 Port、数据库 Snapshot、Artifact 绑定或 Cache 模型。

## 5. 结论

没有发现需要暂停 G2-03 或改变产品目标的承重偏差。本结论只在同一 Commit 的 `g2-03-06-evidence-manifest.json=CLEAN_ROOM_PASS` 时成立；随后只放行 G2-03-07。
