# Red-Team：G2-01-06 Definition Validation 与 Dependency Graph

- 日期：2026-08-14
- 审查对象：Definition Validator、Dependency Extractor、Graph Algorithm、Application Use Case、PostgreSQL Repository 与 `0004` 向前加固
- 方法：Intended → Enforcement Point → Negative Test → Residual Risk
- 结论：**Go for G2-01-07**；G2-01-06 范围内的重试身份、边伪造、跨 Project 泄漏、确定性和原子状态偏差已关闭。

## 1. 审查中发现并修正的偏差

### 1.1 第一次依赖校验失败后，同一内容永远无法重试

原表只以 `(subject, content digest, validator version)` 唯一标识不可变报告。Link Draft 引用的 Object Draft 后续变为 Validated 时，Link 内容 Hash 不变，但第二次结果应从失败变为成功；旧唯一键会阻止写入新事实。受害者是正常的分步建模流程，实际表现为必须无意义修改 Description 才能继续。`0004` 新增内部 `validation_context_digest`，把依赖 Revision 状态、Digest、闭包、边和拓扑结果纳入不可变验证输入；内容摘要仍保持公共合同语义。真实 PostgreSQL 测试证明同一 Subject/Content 先失败、目标验证后成功，两份报告和 Context Digest 均不可变且不同。**CLOSED**。

### 1.2 内部调用者可以绕过 Extractor 直接把 Draft 标成 Validated

原 `transitionRevisionState` Port 能直接执行 `draft → validated`，数据库也不要求报告或完整边。即使 HTTP 尚未暴露该方法，后续组合代码仍可能误用，造成 Content、Dependency 和状态分裂。现在 Application 只暴露服务器 `validateRevision`；PostgreSQL Adapter 拒绝通用状态方法进入 Validated；数据库 Trigger 进一步要求当前 Digest 的成功报告，并精确核对 Object 零边或 Link 两条内容边。直接 SQL 绕过测试稳定返回 `55000`。**CLOSED**。

### 1.3 Cross-Project 引用的错误形状和锁行为泄漏目标是否存在

若先读取并锁定外部 Project 的目标，再返回专用 Cross-Project Code，调用者可以用错误数量、延迟和锁竞争区分“缺失”和“存在但不可见”。Validation Closure 现在只读取并锁定 Source Project 内的 Revision；外部 ID 与 Missing ID 进入同一 `DEPENDENCY_UNAVAILABLE` Issue，Code、Path、Message、Remediation 和 Issue 数量相同，报告不包含外部 Resource ID。**CLOSED**。

### 1.4 持久边可与内容引用漂移

只在 Application 中重新提取仍不足以防止 Adapter 误传类型、Path 或 Target。Repository 只接受服务器产生的边；`0004` Insert Trigger 同时按 Source Link 内容核对 `link_source`/`link_target`、固定 JSON Pointer、同 Project、Object Type Family 和可复用目标状态；Draft→Validated Trigger 再检查两条边完整集合。故意交换 Path 的直接 INSERT 返回 `23514`，失败事务不留下部分边或状态。**CLOSED**。

### 1.5 图排序依赖数据库返回顺序

数据库自然顺序或普通字符串排序漂移会让同一 Pin 集合产生不同验证顺序和后续 Manifest。Domain Graph 使用稳定字符串 ID 作为唯一 Tie-break，输出 dependency-first 拓扑；循环 DFS 的起点、邻接和旋转起点全部确定。100 轮随机边顺序产生相同拓扑和图摘要，固定环产生同一闭合 Cycle Path。**CLOSED**。

## 2. Intended-vs-Implemented 矩阵

| Intended Claim                                      | 精确执行点                                                                              | 反例测试                                                                    | 结果 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---- |
| Object/Property/Link 使用严格激活合同               | Contracts Parser + Domain semantic Validator；Deferred Family 无法进入 typed definition | Primary Key overlay、嵌套 JSON Filter Path、Base-only Link Action mutation  | PASS |
| Dependency 只能由内容服务器提取                     | `extractResourceDependencies` 固定两端类型/Path；Application 命令没有 Dependency 字段   | 客户端 Validator Version/图字段被严格命令拒绝；错 Path SQL INSERT 被拒绝    | PASS |
| Missing/Cross-Project/Archived/未验证依赖阻止 READY | `validateDependencyTargets` + 同 Project Closure + DB Target Guard                      | Missing、Cross-Project、Draft Target、Archived 状态负例                     | PASS |
| 不可见 Resource 不通过错误泄漏                      | Cross-Project 不进入 Closure 查询或锁；与 Missing 同形 Issue，只返回 Source Resource ID | 两份报告的可见错误字段和数量完全一致，正文无外部 Resource ID                | PASS |
| 所有循环默认拒绝且路径稳定                          | `analyzeDependencyGraph` 确定性 DFS + canonical cycle rotation                          | 同一三节点环不同输入顺序均输出 `a→b→c→a`                                    | PASS |
| 依赖优先拓扑与报告排序确定                          | UUID/string C-order Tie-break；Issues 按 Resource/Path/Code/内容排序                    | 100 轮 shuffled edges 的 order/report preimage/digest 相同                  | PASS |
| 校验、报告、边、Validated 状态全有或全无            | 单 PostgreSQL 事务；报告 Context UQ；边 Insert Guard；状态 Trigger                      | 首次失败零边；32 路重试只产生一个成功报告；伪造边整笔回滚                   | PASS |
| 相同内容可随依赖上下文变化重新校验                  | `validation_context_digest` 进入报告唯一键，`subject_digest` 仍是内容 Digest            | Target Draft→Validated 后 Link Content Digest 不变，报告从 invalid 变 valid | PASS |

## 3. What I Couldn't Assess

- G2-01-07 尚未实现结构兼容性和下游影响判定；本任务只保证图事实可信、闭合和确定。
- G2-01-08 尚未在 Release Stage 重新检查 Pin、报告 Context 与当前依赖状态；Revision Validated 不等于 Release READY。
- G2-01-10 尚未实现 HTTP/OIDC、Body Limit 和 Error Envelope；当前“不泄漏”证明覆盖 Application/Report 数据形状和 Repository 查询边界。
- G2-01 活跃 Family 的依赖深度最多为 Link→Object；循环和深闭包使用通用算法向量验证，未来 Family 启用前仍须用其真实 Extractor 重新验收。
- 本机 PostgreSQL 16 的 32 路并发证明事务正确性，不是生产吞吐、多 AZ 或连接代理容量证明。
