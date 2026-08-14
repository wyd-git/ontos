# Red-Team：G2-01-07 Compatibility Engine

- 日期：2026-08-15
- 审查对象：Object/Property/Link Comparator、Pin-set Impact、Application Diff、PostgreSQL Adapter 与 G1 Compatibility Vectors
- 方法：Intended → Enforcement Point → Negative Test → Residual Risk
- 结论：**Go for G2-01-08**；G2-01-07 范围内的 JSON Diff 误判、Endpoint 重新 Pin 死锁、条件项伪 READY、行序漂移和客户端覆盖已关闭。

## 1. 审查中发现并修正的偏差

### 1.1 把 Link Endpoint Revision ID 变化一律当成换 Endpoint，会让产品无法升级

Link 合同 Pin 精确 Object Revision。若比较器只比较 UUID，则任何 Object 的 Display 文案或 nullable Property 更新都会要求 Link 新 Revision；而 Link 新 Revision又会因 Endpoint UUID 变化被判 Breaking，最终所有被 Link 引用的 Object 都无法正常升级。现在 Pin-set Comparator 用服务器 Revision→Resource 身份区分“同一 Object Resource 的 Revision 前移”和“真正换成另一个 Object Resource”。旧 Link 未重新 Pin 时仍由 `DOWNSTREAM_PIN_REQUIRES_REPIN` 阻断；正确重新 Pin 后不伪报 Endpoint 变化；真实 Resource 身份变化仍 Breaking。**CLOSED**。

### 1.2 普通 JSON Diff 无法表达 Enum、Primary Key 和 Query Readiness

Key 新增/删除本身不能判断 nullable、Enum 放宽/收紧、Primary Key 禁止或 Index 条件。Comparator 先通过严格合同 Parser 得到 typed definition，再逐语义字段判定，并输出稳定 JSON Pointer、Code、Severity 和 Required Next Step。Property 改名不会凭相似内容猜测 Alias，而是保守地表现为旧 Property 删除加新 Property，保证 Gate 不被启发式绕过。**CLOSED**。

### 1.3 `conditional` 被当成带警告的 Compatible

Query/Unique/JSON Filter 能力需要 G2-02 的 Index/Materialization 证据；G2-01 没有这些能力。Severity 汇总固定 `compatible < conditional < breaking < forbidden`，任何 Conditional 都使 Outcome 为 `conditional`；所需下一步明确指向拥有 Gate，Release 08 只能把纯 Compatible 集合推进 READY。**CLOSED**。

### 1.4 只比较同 Resource 会漏掉不可闭合的下游 Link

一个 Object 自身可能兼容，但 Candidate Release 若保留 Pin 到旧 Object Revision 的 Link，运行时世界仍不闭合。`comparePinnedCompatibility` 接受实际 Baseline/Candidate Pins 和 Candidate Dependency Edges；Source 已 Pin 而 Target 未 Pin 时输出 `DOWNSTREAM_PIN_REQUIRES_REPIN`。随机排列 Pins/Edges 100 轮产生相同 Findings 和 Report Preimage。**CLOSED**。

### 1.5 客户端能用 Semantic Version 或伪造 Baseline 内容改变结论

Domain Comparator 没有版本号参数；Application Strict Command 只接受两个 Revision ID，显式拒绝 `semanticVersion`、`baselineContent`、客户端 Finding 等字段；Repository 从存储读取并复核 Content Digest。同一比较的 Report ID 绑定 Comparator Version、两个 Revision ID/Digest 与稳定 Findings。直接 Diff 可选择 `against` 做信息比较，但它不是 Publish 证书；G2-01-08 必须从服务器 Channel Pointer 读取 Published Baseline。**CLOSED for G2-01-07，Publish enforcement 由 08 验收**。

### 1.6 延后 Family 被“无变化”或“新增资源”路径误判 Compatible

若只在 Revision 内容变化时调用 Family Comparator，未激活的 Policy/Action/View Pin 可以因 Revision 未变或首次加入而跳过。Pin-set Comparator 现在独立扫描所有 Candidate Pins，对每个未激活 Family 输出 `RESOURCE_FAMILY_COMPATIBILITY_DEFERRED`；G1 Action/Policy/Handler/Runtime Bridge Case 只记录拥有 Gate，不推断当前 Compatibility。**CLOSED**。

### 1.7 Endpoint 身份解析可能成为 Cross-Project 关系探针

“两个 Revision 是否属于同一 Object Resource”本身也是不可见 Metadata。若 Diff Adapter 不限制 Project，调用者可以在两个 Link Draft 中放入外部 UUID，再通过 Compatible/Breaking 差异判断它们是否同源。PostgreSQL Endpoint 查询现在把目标 Resource 与已授权 Source Resource 的 Project 连接；外部 Revision 不被读取或返回。真实 Integration 用同一外部 Resource 的两个 Revision 构造 Diff，仍得到与 Missing 一样保守的 `LINK_TYPE_ENDPOINT_CHANGED`，报告不暴露外部身份。**CLOSED**。

### 1.8 Package 只比较版本号或 Manifest 引用，无法证明展开事实

Package Version 由发布者声明，不能决定兼容性；Manifest Entry 若与服务器展开的 Revision/Digest 不一致，也不能继续。Package Comparator 忽略版本标签，固定 Package Identity、Namespace 和 Kernel Contract，逐字段比较 Install Input，并要求 Manifest Entries 与服务器 Pins 的 Namespace/API Name/Family/Resource/Revision/Digest 完全相等；随后复用 Release Pin Comparator。伪造 Candidate Digest 输出 `PACKAGE_RESOURCE_EXPANSION_MISMATCH`。**CLOSED**。

## 2. Intended-vs-Implemented 矩阵

| Intended Claim                      | 精确执行点                                                 | 反例测试                                                                              | 结果 |
| ----------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---- |
| PRD 核心矩阵按结构语义判定          | typed Object/Property/Link Comparator                      | Display、nullable、Enum widen；PK、删除、类型、Enum narrow、Link endpoint/cardinality | PASS |
| Conditional 在 G2-01 不进入 READY   | Severity rank + 明确 Required Next Step                    | Query flag、Unique flag、JSON Filter Path 新增                                        | PASS |
| 下游影响来自真实 Pin/Edge           | complete Pin-set Comparator + Candidate closure            | Object 更新配旧 Link Pin 失败；更新 Link Pin 后关闭 Closure Finding                   | PASS |
| 同 Resource Endpoint 前移不误报     | Revision→Resource identity map                             | 相同 Object Resource 新 Revision允许；不同 Resource 仍 `LINK_TYPE_ENDPOINT_CHANGED`   | PASS |
| 结果不依赖 Key/Row/输入顺序         | strict parser + C-order Findings/Pins/Edges                | reversed JSON keys、100 shuffled Pin/Edge runs、重复 PostgreSQL Diff                  | PASS |
| Semantic Version 不改变结论         | Comparator 无 version 输入；Application closed command     | `semanticVersion`/`baselineContent` 注入被拒绝                                        | PASS |
| G1 向量不被选择性迁移               | Testkit 8 Case ID exact coverage + owning-Gate disposition | 删除任一 Case 或无归属使测试失败；当前可判定 Codes 单独断言                           | PASS |
| Deferred Family 不伪装兼容          | Candidate Pin pre-scan                                     | 未激活 Family 不论新增/未变都返回 Deferred Conditional                                | PASS |
| Endpoint 解析不泄漏外部 Project     | Endpoint Revision 查询与 Source Resource Project 等值 Join | 同一外部 Resource 的两个 Revision 仍按不可见/Missing 保守 Breaking                    | PASS |
| Package Version/Manifest 不覆盖语义 | Package identity + exact expansion + Pin comparator        | `1.0.0→99.0.0` 不改结论；Namespace 和伪造 Digest 被阻断                               | PASS |

## 3. What I Couldn't Assess

- G2-01-08 尚未实现服务器从 Channel/Serving Head 选择 Published Baseline、Release Validation Report、Stage/Publish 原子事务；Revision Diff 不能代替发布 Gate。
- G2-01-09 尚未实现 Package Manifest 展开、Raw SQL/Kernel Migration 预检、安装指针和逐 Resource Report 编排；当前只证明 Compatibility Engine 可复用。
- G2-02 尚未提供 Materialization/Index/Migration 证据，因此 Conditional 只能稳定阻断，不能被满足。
- 当前报告为确定性派生响应，不保存独立 Compatibility 表；Release 08 必须把最终 Pin-set 结论绑定进不可变 Validation Report，才能形成发布审计事实。
- PostgreSQL 16 Integration 证明读取、Digest 反校验和重复结果；它不是大 Package（512 Pins）容量基准，容量与 Query Plan 在 Release/Package Gate 继续验证。
