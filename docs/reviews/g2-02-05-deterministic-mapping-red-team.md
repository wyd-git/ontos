# G2-02-05 Deterministic Mapping Red Team

- 日期：2026-08-15
- 方法：先把本项钢人化为“Snapshot 字节进入 Object Identity 前的唯一、版本化、可重放解释层”，再攻击 AST 绕过、隐式类型转换、绑定漂移、Identity 混淆、错误泄密、假流式与证据夸大
- 结论：**G2-02-05 可 PASS；只放行 G2-02-06。RID/Object Identity Repository、Base 持久化、Dangling Link、Current、Worker 恢复、Cutover 与最终 30 分钟 SLO 仍为 OPEN**

## 1. 用户 SQL 或未登记 AST 节点绕过编译器

**攻击**：若 Mapping 能携带 SQL、函数名、时间或随机节点，重放会受数据库、Locale 和执行时环境影响。

**证据**：冻结合同 Parser 严格拒绝未知字段，Compiler 只产出 `column | constant | cast | concat`；未登记 `join` 与 `rawSql` 都稳定失败。Plan 不含函数对象、SQL、当前时间或随机数。

**结论**：CLOSED。

## 2. Mapping/Schema/Target 内容与 Revision 绑定漂移

**攻击**：只传 ID 或只信任调用者的 Digest，可以让同一 Revision 在不同 Worker 上解释为不同内容。

**证据**：Compiler 对 Mapping、Snapshot Schema、Target Definition 重算规范 Digest 并核对 ID；Link 额外核对两端 Object Resource/Revision/Definition Digest。Plan 固定 Compiler/Mapping/Codec Version、所有输入 Digest、Target Revision、Quality Rules 和 Plan Digest。

**结论**：CLOSED。Source Content Digest 与精确 Object Version 的读取绑定由 G2-02-04 事实与后续 Worker 编排共同负责，本纯执行器不接受任意 URL/Path。

## 3. 隐式 Cast、JavaScript Number 或时区破坏值语义

**攻击**：int64 进入 Number、decimal 丢 scale、Timestamp 用本地时区、JSON 二次序列化，都会让同一行变值。

**证据**：非空单元格先按 Schema Descriptor 调用 `@ontos/value-codec`，不同类型必须显式 `cast`；int64/decimal 始终为规范文本，Timestamp 转 UTC 微秒，JSON 产出限制规范 JSON。固定 Seed Property Tests 覆盖 int64、scale、时区、Unicode、null、concat 和 PK 边界。

**结论**：CLOSED。

## 4. 缺失必填 Base Property 直到写库才失败

**攻击**：Mapping 可以省略非空 `source_only/overlay_override` Property，小样本编译通过后才在 Base 表失败。

**证据**：最终审查补上 Compiler Gate：Primary Key 由专用表达式独占，每个非空 Base Property 必须有且只有一个 Mapping；`overlay_only/system_managed` 反向禁止被来源 Mapping 写入。

**结论**：CLOSED，是本次 Intended-vs-Implemented 发现的实际缺口。

## 5. Object/Link 把展示名或行号当作身份

**攻击**：Display/API Name、行号、Worker 或当前 Release 进入身份，同一业务对象会跨代变 RID。

**证据**：Object 只输出 `pk1` Canonical PK Candidate；Link 只输出两端 Object Resource/Revision/Canonical PK Lookup。大小写与 NFC 等价输入产生同一规范候选，1,024-byte 上限经固定 Seed 边界测试。

**结论**：CLOSED for candidate generation。批内 Collision 判定和永久 RID 由 G2-02-06 负责。

## 6. 错误反射原值、完整 PK 或敏感列

**攻击**：Codec/JSON/数据库原始异常往往携带输入片段；聚合高基数字段也会形成侧信道。

**证据**：Rejected Row 只保留行号、稳定 Reason/Mapping/Codec Code 和可选的单个安全列名；PK/Endpoint 和映射到 confidential/restricted Property 的列名被压制。聚合 Key 只由三个有界 Code 组成。Sink 底层异常被稳定错误包装。

**结论**：CLOSED for ordinary Mapping output。

## 7. 同一输入的顺序、Locale 或进程不同导致 Digest 漂移

**攻击**：对象键、错误聚合、Property 顺序或 `localeCompare` 可在不同环境中变化。

**证据**：所有输出顺序用 Code Point 比较，事件按源行顺序进入 `mapping-stream-chain-v1`。独立 Node 进程在 `UTC/C` 与 `Asia/Shanghai/zh_CN` 下的 Plan、事件、计数和 Digest JSON 逐字节相等。

**结论**：CLOSED。

## 8. “流式”仍缓存所有行、错误或下游失败后继续前进

**攻击**：Parser 逐行回调不等于端到端有界；Executor 可能保存事件数组，或 Sink 拒绝后仍计算后续行。

**证据**：Reader 只保存当前有上限记录并等待 Consumer；Executor 只保存当前事件、链式 Digest、计数和固定 Code 聚合。Sink 失败立即转为不可继续终态。在 128 MiB V8 Heap 下完整执行 100k Object + 1m Link；专用 x86_64 机器峰值 93.78 MiB，GC 后仅比基线多保留约 0.77 MiB。

**结论**：CLOSED for Mapping memory shape。这不是数据库、S3、WAL、Index 或 30 分钟总 SLO 的证明。

## 9. 排序后的失败模式

| 排名 | 失败模式                              | 影响 | 可能性 | 当前处理                                         |
| ---: | ------------------------------------- | ---: | -----: | ------------------------------------------------ |
|    1 | Revision/Digest 绑定漂移              |    5 |      3 | 重算 Digest + 精确 ID/Endpoint 绑定，CLOSED      |
|    2 | 隐式 Cast 破坏 int64/decimal/timezone |    5 |      4 | 显式 Cast + 公共 Codec + Property Tests，CLOSED  |
|    3 | Display/API Name 混入身份             |    5 |      3 | 只输出 Revision + Canonical PK Candidate，CLOSED |
|    4 | 错误泄露值/PK/敏感列                  |    5 |      3 | 有界 Code 和列名压制，CLOSED                     |
|    5 | 假流式在 1m 行线性增长                |    5 |      4 | 128 MiB 子进程完整执行，CLOSED                   |
|    6 | 非空 Base Property 未映射             |    4 |      3 | 最终 Compiler 完整性 Gate，CLOSED                |
|    7 | 同进程通过、跨进程漂移                |    4 |      3 | 双 Locale/Timezone 子进程逐字节比较，CLOSED      |
|    8 | 候选 PK 已生成被夸大为永久 RID        |    5 |      4 | 明确 OPEN to G2-02-06，不阻塞本 Gate             |

## 10. 放行结论

未发现 SQL/未登记 AST 旁路、隐式数据库 Cast、非确定输出、敏感普通错误或线性 Heap 增长。G2-02-05 可证明“受管 CSV 行可确定性编译和执行为 Object/Link 候选”，不能证明候选已获得 RID、写入 Base、形成 Current 或可被查询。下一项只能是 G2-02-06 永久 Object Identity 与不可变 Base。
