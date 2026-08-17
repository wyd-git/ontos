# G2-03 Query + Policy 任务包可行性复审

- 日期：2026-08-17
- 审查对象：[G2-03 Query + Policy 可执行任务包](../delivery/g2-03-query-policy-task-pack.md)
- 配套边界：[G2-03 UI/API 早期消费者合同](../architecture/g2-03-ui-api-consumer-contract.md)
- 审查基线：G2-02-14 PASS commit `2e9d9d89e27a517f36b446805604ee2bdd2121ac`
- 结论：**Conditional Go for G2-03-01 only**；方向可落地，但必须先用 ADR/Spike 关闭 Identity、Policy IR、Query Plan、GC Lease 和 Web 栈五个接缝，不允许直接建 Query Endpoint

## 1. 一句话结论

这份任务包不再是“先写一个查询 API，以后再看页面怎么接”。它有一条可执行的生产路径，也把最容易造成大规模返工的 UI/API 消费者接缝前移了。

但它不能按旧 3–4 周计划执行。当前代码库没有生产 Query/Policy 包、没有 `apps/web`、没有 Runtime OpenAPI 生成链，Principal 也没有 Service Type/Claim Mapping/Delegation 生产事实。按 15 个顺序项目的理想工程日对账后，更诚实的单通道容量是 **11–18 工程周**，并在两个薄切片后重估。

## 2. 已有代码基线核验

| 承重能力                     | 当前真实状态                                                                                 | 对 G2-03 的意义                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Metadata/Release/Package     | G2-01 已有不可变 Revision、Release Pin/Activation、Package 和真 Admin HTTP/OIDC              | Policy 可作为 Resource Family 激活，无需另造可编辑定义库          |
| Object/Link Current          | G2-02 已有正式 Shared `object_current` / `link_current`、类型索引、Activation 和原子 Cutover | Query 有正式服务数据源，不需要为 UI 建领域表                      |
| Runtime Plan/Serving Head    | G2-02 已绑定 Release、Revision、Generation 与显式 Serving Head                               | Activation-aware Get/Search 可只向前扩展，不需要重做 Release      |
| Index/Capacity               | Published Property 已导出有限 Index Plan，100k/1m 已完成 Materialization 实测                | 查询有性能起点，但必须用正式 Policy SQL 重跑 Explain/SLO          |
| GC                           | G2-02 已有 Root Provider Registry/Inventory/fail-closed                                      | 可扩展 Query Lease Provider，但当前尚未实现 Query Root            |
| Management AuthZ             | `authz.principals`、`role_bindings`、`authorization_epochs` 已存在                           | 可复用事务/Epoch，但当前仅是管理授权，不等于业务 Object Policy    |
| Foundation Identity Contract | 已有 `human                                                                                  | service`、Delegation Chain、`intersection` 契约                   | 不需要重新发明身份摘要，但数据库/OIDC 生产适配仍缺失 |
| Policy Epoch                 | ADR-012 与双进程 Harness 已证明 Epoch/5s TTL/Notify/fail-closed 语义                         | 风险是生产 Adapter 落地，不是从零设计缓存语义                     |
| Query/Policy 算法            | G1 固定 Corpus 已证明有限 AST、Policy Predicate、Link 与 100k/1m 指标方向                    | 可复用向量/指标/算法结论，不能导入 Spike 生产代码                 |
| Runtime HTTP                 | `apps/api` 已有 OIDC、Body/Error/Router 和真 PostgreSQL Admin 路径                           | 可扩展而不需要另起服务，但 Runtime Scope/取消/限额仍需实现        |
| Web                          | 不存在 `apps/web`；根 `package.json` 没有前端框架/浏览器测试依赖                             | 不能声称“后面直接接 UI”；必须在 03-01 先选型/锁版/验证生成 Client |

## 3. 端到端可落地走查

### 3.1 定义与发布

`policy` 已在 Metadata Resource Family Enum 中，但 Registry 明确标记 Deferred。G2-03-02/05 可以以新 Schema/Parser/Dependency/Compatibility 只向前激活，并复用现有 Draft→Validated→Published、Package Expander 和 Release Closure。

这条路径可行，但不能只改 Registry 布尔值。现有 `meta.resource_dependencies` 只支持 Property/Link 三种 Dependency Type，Policy Target/Artifact/Test Result 都需要前向 Migration 和 Release Gate。

### 3.2 身份与授权

现有 OIDC Adapter 已安全检查 Issuer/Audience/Algorithm/Scope/Time，且不把 Raw Token 传入 Application。但 `authz.principals` 现有列没有 Identity Type，也没有 Claim Mapping Revision 或 Delegation Credential 验证事实。

因此“复用现有 OIDC”只能解决验签，不能解决 Runtime Identity Context。任务包已将这个差距前移到 03-01/03/04，在 Query Endpoint 前关闭，路径可行。

### 3.3 Policy Compiler/Gateway

ADR-012 已给出精确 Artifact Key、同 Snapshot Epoch/事实读取、最长 5 秒缓存和 fail-closed。G1 已证明 Row Predicate 进 SQL、Property 双重防御和 Link 策略方向。

生产缺口是 Policy AST/IR、Artifact Store、Release Test 和真 PostgreSQL Snapshot Adapter。任务包将“定义/编译”与“决策/缓存”分成 05/06，并要求 Query 依赖唯一 Gateway，避免循环依赖和 Endpoint 手写授权。

### 3.4 Query 与 Current Projection

G2-02 的 Current Row 包含 Project、Generation、Object/Link Revision、RID/Canonical PK 和 JSONB Property，且索引计划已绑定 Published Property。这足以支撑通用 Query，不需要为每个 Object Type 新建表。

不确定性在于正式 G2 Policy Predicate 加入后的执行计划，以及一跳 Link Exists 在 Object Policy 中与二跳 Query 组合的上界。所以 03-01 先用真实表/Explain 验证四个代表查询，03-09 再用 10k/100k 强制重估；不把全量性能风险留到 14。

### 3.5 Activation、Cursor 与 GC

Runtime Serving Head/Activation 已存在，因此“请求开始解析一次”可实现。G2-02 GC 还明确预留了未来 Query Lease Root Provider；当前没有对应表/实现，不能靠“查询很快”假设规避。

在 03-03 加入有界 Query Lease/孤儿回收和 Provider 可保持 G2-02 mark-plan-commit 语义，不需要重写 GC。Cursor 不用作长期 GC Root，只绑定下一页上下文，避免无界保留 Generation。

### 3.6 HTTP/OpenAPI/Web

Object Type 当前已有 Display Name、Title Property、Default Search、Default Sort 和 Property `filterable/sortable/searchable`；Link Type 已有两端 Display/API Name 和 Cardinality。这些 Metadata 足以生成 G2-03 的基础 List/Detail/Link，无需提前激活 Object View。

但现在没有 OpenAPI 字段源、生成 Client、Web 框架或浏览器 Gate。所以可行路径不是“保证以后直接套 UI”，而是 03-01 先选型，02 冻结 Candidate，12 接真 HTTP/Client，13 用真实页面反向验证。这个顺序能在 G2-03 内发现接口问题，而不会等到 G2-05。

## 4. 任务量与容量对账

| 规模     | 任务                                   | 数量 | 理想日/项 |                 小计 |
| -------- | -------------------------------------- | ---: | --------: | -------------------: |
| M        | 01、02、04、06、08、09、10、11、12、15 |   10 |       3–5 |                30–50 |
| L        | 03、05、07、13、14                     |    5 |       5–8 |                25–40 |
| **合计** | 15 个顺序工作项                        |   15 |         — | **55–90 理想工程日** |

对当前一条有效通道，55–90 理想日对应 **11–18 工程周**。该范围包含任务内单测/真库/浏览器/红队/Evidence，不包拉取镜像、外部审查或基础设施不可用的等待时间。

这个计划保守于自动化执行的历史墙钟时间，因为工程容量不应把“工具某次跑得快”当成身份安全、SQL 计划和 UI 选型已经没有风险。只有在 03-03 和 03-09 用真实返工/吞吐证据才能缩短剩余区间。

## 5. 主要风险与最低成本验证

| 排名 | 风险                                               | 已有证据                                   | 最低成本验证                         | 阻断点                    |
| ---: | -------------------------------------------------- | ------------------------------------------ | ------------------------------------ | ------------------------- |
|    1 | 真实 Policy Predicate 破坏 G2 Current/Index 计划   | G1 方向 + G2 Index                         | 03-01 四个真 PG Explain              | 阻断 02/03                |
|    2 | Service/Delegation 只能信任客户端自报              | Foundation Contract，无 Production Adapter | 03-01 Threat Model + 03-03/04 薄切片 | 阻断一切 Runtime Endpoint |
|    3 | Policy Resource/Artifact 无法与 Release 不可变绑定 | Metadata 生命周期已有                      | 03-05 单 Policy Publish/Failure      | 阻断 Query 发布           |
|    4 | Query 中途 Cutover/GC 读交叉代或被回收             | Activation + GC Provider Registry          | 03-03/08 Query Lease + Kill/GC       | 阻断 Search/Load          |
|    5 | OpenAPI/Runtime/Web 需要平行 DTO                   | 现无生成链                                 | 03-01 最小生成 Client Compile        | 阻断 Contracts            |
|    6 | 通用 UI 需要 Object View/BFF/领域分支才能用        | Object/Link Metadata 已有                  | 03-13 双 Fixture + 请求预算          | 阻断 G2-03 总 Gate        |

## 6. 已写回的可行性修订

1. **UI 消费者前移，但严格只读**：G2-03 加入真实 List/Detail/Link 消费者；Action 仍归 G2-04，完整 UI/SDK 仍归 G2-05。
2. **不提前激活 Object View**：只读壳用已有 Object/Link Metadata，避免为了页面偷渡 Builder/View Schema。
3. **Generated Client 在 G2-03 做消费 Gate**：允许 OpenAPI Candidate，但不宣称可发布 SDK 或 90 天客户端支持。
4. **Identity/Delegation 放到 Query 前**：不用 Admin OIDC 摘要伪装完整 Runtime Identity。
5. **Query Lease 与 GC Root 前移**：不用短查询假设取代可执行并发/恢复证据。
6. **缩小 Aggregate**：G2-03 只交付 `count`，不为了合同完整性将全 P0-A 读能力塞入首个 Runtime Gate。
7. **工期与工作分解对账**：3–4 周改为 11–18 工程周，并在 03-03/09 强制重估。

## 7. 现在还不能确定的事

- Policy IR 最终列形状、Artifact 表和 Dependency Type 命名，必须由 03-01/02/03 的真实 ADR/Schema 决定；
- Delegation 最终运输是受信网关签名摘要还是 Kernel 自验证 Token Exchange，必须在 03-01 Threat Model 选择一个真实可部署方案；
- 前端框架和 OpenAPI 生成器的具体版本，目前仓库没有基线，必须在 03-01 用依赖/构建/浏览器证据锁定；
- 正式 G2 Policy Predicate 下的最终 P95 与 Index Write/Read 成本，必须在 03-01/09/14 实测；
- 前端产品视觉、完整双语、Object View 和真实用户可用性，属于 G2-05/P0-B，不能由只读壳提前推断。

这些未知项不阻止 G2-03-01，因为 01 的目的正是以最低成本证伪它们。它们阻止跳过 01 直接建正式 Endpoint、数据表或页面。

## 8. 放行结论

任务包在以下限制下可实施：

- 仅放行 G2-03-01；
- 01 必须交付 ADR-020、真 PostgreSQL Explain、Identity/Delegation Threat Model、生成 Client Compile 和 Web 栈决策；
- 任一 Kill Criterion 触发时停止 02/03，不用应用后过滤、领域 Endpoint、BFF 或客户端权限绕过；
- 只有 03-15 总 Gate 通过后才能宣称 G2-03 PASS，页面出现不构成提前完成。

在这些条件下，该计划可以从当前 G2-02 代码库只向前落地，不需要重写 Metadata、Materialization、Activation、Current 或 GC 核心。
