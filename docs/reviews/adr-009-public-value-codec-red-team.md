# Red-Team：ADR-009 公共值编码、Primary Key 与 Golden Vector

- 日期：2026-08-13
- 审查对象：[ADR-009](../architecture/adr/009-public-value-codec.md)
- 方法：`strategy-red-team` 后接 `intended-vs-implemented`
- 结论：**G2-00-05 的公共值合同可接受；真实 Snapshot/Action/Query/SDK 接线与 DB-02 Production Constraint 仍是下游 Gate**

## Top Kill-Assumptions（排序）

### 1. Unicode Runtime 升级不会静默改变已有 Object Identity（100）

- **Claim：** NFC + locale-independent uppercase 可以稳定实现 case-insensitive Primary Key。
- **Steelman：** 算法不读取请求 Locale 或 PostgreSQL Collation，`pk1` framing 也显式带版本。
- **Fails if：** Node/ICU/Unicode 升级改变 normalization 或 case mapping，但仍以 `pk1` 写入；同一个 Source Key 会得到另一个 `canonicalPrimaryKey`，或两个历史对象发生新碰撞。
- **Evidence to get this week：** 固定 Node、ICU、Unicode 版本；遍历全部 Unicode Scalar，Hash `NFC -> uppercase -> NFC`；保留 decomposed/composed、多字符展开和大小写碰撞向量。
- **Kill criterion：** 任一工具链升级造成版本或 Mapping Digest 改变，却没有新 ADR、身份影响扫描和明确迁移/保持方案。
- **Cheapest test：** 单元测试现场计算 1,112,064 个非 surrogate Scalar 的 Digest。
- **处理：** 已加入 Node 24.18.0 / ICU 78.3 / Unicode 17.0 与 SHA-256 `04eac79f...614b855` Gate；`straße -> STRASSE` 和 composed/decomposed `Café` 向量同时保留。

### 2. “受限 JSON”不会被误当成精确数字或任意查询容器（90）

- **Claim：** P0 可以保留 JSON 整体读写，同时不破坏 integer/decimal 的精确语义。
- **Steelman：** exact integer/decimal Property 强制字符串；JSON 不参与 Primary Key，PRD 也不保证任意内部查询。
- **Fails if：** 财务金额、64-bit ID 或 Decimal 被塞入 JSON number 后参与身份、约束或计算；Transport 解析前的十进制文本已经被 binary64 舍入，Codec 无法恢复。
- **Evidence to get this week：** Golden Vector 证明 unsafe integer、非有限数和指数输出被拒绝；ADR 明确 JSON number 是已解码 binary64，不承诺任意精度。
- **Kill criterion：** 任一 P0 Mapping、Action 或 Query 把 JSON 内数字用于 PK、Unique、金额计算或任意 JSON Path Filter，却没有升级为类型化 Property。
- **Cheapest test：** 对 `9007199254740992` 和 `1e-7` 做边界负例，并在首个 Snapshot Mapping Integration 中加入同样的失败 Fixture。
- **处理：** 当前合同已明确限制和替代建模。首个业务集成仍必须证明没有把 JSON 当 exact-number 后门。

### 3. 下游不会绕过公共 Codec，直接依赖数据库宽松 Cast（90）

- **Claim：** 一份 `@ontos/value-codec` 足以让 Snapshot、Action、Query 和 SDK 语义一致。
- **Steelman：** 包位于 contracts layer、无 Runtime 依赖，适合 Server 与 SDK 共用；同一 Golden Vector 已对四种消费者名称执行。
- **Fails if：** 未来任一 Adapter 自写 `Number`/`Date`/`parseFloat`，或让 PostgreSQL `numeric(p,s)` 舍入、宽松解析 timestamp；当前公共包正确也无法保护旁路。
- **Evidence to get this week：** G2-00-09 把 Codec 加入 Foundation Contract；Snapshot/Action/Query/SDK 各自在其 Gate 加真实入口 Integration，审查生产代码不存在第二 parser。
- **Kill criterion：** 任一业务入口在写入或编译 Query 前没有可引用的 `@ontos/value-codec` 调用与共享向量测试。
- **Cheapest test：** 每实现一个入口，先把同一个 `golden-vectors.json` 原样喂给真实 Adapter；出现不同结果即阻止合并。
- **处理：** G2-00-05 只证明公共实现可复用，不冒充尚不存在的四个业务模块已经接线。

### 4. JSON/Primary Key Size Gate 本身不会成为内存放大入口（80）

- **Claim：** 1 MiB JSON 与 1,024-byte Primary Key 上限可以在边界保护服务。
- **Steelman：** 还有限制 JSON depth 64 和 nodes 100k，字符串都要求 well-formed Unicode。
- **Fails if：** 实现先构造/规范化极大值、最后才检查长度；攻击者可以在收到稳定错误前制造远超上限的临时分配。
- **Evidence to get this week：** 检查遍历路径是否逐 Token 计 UTF-8 bytes；Primary Key 是否在 case expansion/framing 前先拒绝明显超长 raw component。
- **Kill criterion：** 一个远超限制的单字符串或多节点 JSON 必须完成全量 canonical string 后才失败，或错误不是稳定 Codec Error。
- **Cheapest test：** 使用 8-byte JSON limit 和 10-byte PK limit，在内层值处触发错误。
- **处理：** 审查中已把 JSON 改为 traversal-time byte budget，并给 PK 增加 raw component early reject；保留 depth/node 双上限。

### 5. TypeScript 与 PostgreSQL “排序一致”不是同名测试、实际不同语义（72）

- **Claim：** 同一向量在内存比较、Cursor/SDK 和数据库 Index 中顺序一致。
- **Steelman：** Integer/Decimal 用整数语义，Timestamp 已固定 UTC 宽度，String 固定 `C` byte order。
- **Fails if：** Decimal comparator 假定 scale 相同、Enum 用字母序、String 落回默认 Locale，或 PostgreSQL Fixture 只比较预写的期望而没有真实 typed `ORDER BY`。
- **Evidence to get this week：** 对 8 个可排序类型执行 PostgreSQL `uuid/boolean/bigint/numeric/date/timestamptz/ordinal/C` ORDER BY；TypeScript 使用独立 comparator 产生同一列表。
- **Kill criterion：** 任一 Order Group 的完整序列不同；或 PostgreSQL 测试没有连接真实 16.x Server。
- **Cheapest test：** 8 个小型乱序数组，不需要先建 Production 表。
- **处理：** 已在真实 PostgreSQL 16.14 通过 8 组排序。审查还发现直接 Decimal comparator 原先隐含相同 scale，现已对齐到共同 scale 后比较。

## Intended vs. Implemented 审查

| 已记录意图                      | 审查前实际                                                          | 身份/精度/资源边界                              | 修正与证据                                                   | 状态               |
| ------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ | ------------------ |
| JSON 最大 1 MiB                 | 最初完成整个 Canonical JSON 后才检查 bytes                          | 超限输入可能先制造大临时字符串                  | traversal-time UTF-8 budget；8-byte 负例                     | CLOSED             |
| Unicode PK 算法不得静默漂移     | 最初只有少量 NFC/大小写例子                                         | Runtime 升级可重写 Object Identity              | 固定 Node/ICU/Unicode + 全 Unicode Scalar Digest             | CLOSED             |
| Decimal 排序按数值而非文本      | 公共 comparator 最初把两边 unscaled bigint 直接比较，隐含相同 scale | 跨 Descriptor/工具调用可把 `1.2` 与 `1.20` 排错 | 对齐 common scale；新增相等反例                              | CLOSED             |
| Timestamp 覆盖完整冻结年份      | 属性测试最初只随机 2000–2099                                        | civil-date 算法在远端年份缺少证据               | 随机范围扩到 0002–9998；固定 0001/9999 边界                  | CLOSED             |
| PostgreSQL 证据必须报告真实版本 | 首次 PASS 行的版本字段取错，显示 `undefined`                        | 不能确认交叉验证落在哪个 Server                 | 改用 `current_setting('server_version')`，现场报告 16.14     | CLOSED             |
| 四个入口使用同一合同            | 当前没有业务 Snapshot/Action/Query/SDK 模块                         | 不能把公共包测试误报为真实入口集成              | 测试证明同一向量可复用；ADR 明确各模块仍需 Integration Gate  | OPEN（下游所有者） |
| PostgreSQL 唯一键解决并发碰撞   | 当前只有 `pg_temp` 唯一 Fixture，没有业务 Migration                 | 并发写仍未被 Production Constraint 保护         | 4 个碰撞向量命中 `23505`；DB-02 必须实现 ADR-008 复合 Unique | OPEN（DB-02）      |

没有发现仍未修正、且属于 G2-00-05 纯 Codec/Fixture 范围的 Intended-vs-Implemented 漂移。Published Property Descriptor 的真实性由后续 Foundation Schema/Release Validation 提供；本包负责值而不把未验证 Draft Schema变成受信合同。

## What's Well-Reasoned

- Exact integer/decimal Wire 类型、范围和 scale 从入口就拒绝 JavaScript number，没有事后“尽量恢复”。
- Timestamp 不经过 JavaScript Date，时区、微秒、Gregorian 日期和歧义输入都由同一纯函数处理。
- Primary Key 同时带版本、Component Count、Type Tag 和 UTF-8 Length，delimiter 与类型边界不能碰撞。
- Batch Collision 提前给出可解释错误，PostgreSQL Unique Fixture 再证明并发冲突的最终防线。
- 数据库不重做 Unicode identity，避免 Node 与 PostgreSQL 各拥有一套随升级漂移的 Case/Collation 算法。
- Golden Vector 是数据文件，不把期望散落在四套入口测试中；PostgreSQL Fixture 使用真实 typed ordering，而非只比较字符串快照。

## What I Couldn't Assess

- 真实 Snapshot CSV/Parquet Reader 是否在解析前保留 integer/decimal 文本；
- HTTP JSON Parser 是否会在 Restricted JSON 到达 Codec 前接受重复 Key 或损失原 numeric lexeme；
- DB-02 最终 Migration、`COLLATE "C"`、表达式索引与复合 Unique 的实际 DDL；
- Query Compiler 的 Cursor Encoding 是否复用相同 comparator/tie-breaker；
- 生成式 SDK 在 Browser、Node 和其他语言中的 Golden Vector 兼容性；
- 历史 `pk1` 数据面对未来 Unicode/Codec 升级的迁移成本。

这些未知项不阻止 G2-00-05 的公共合同 Accepted，但分别阻断对应业务入口、DB-02、Query/SDK 和首次 Codec 升级。下一步先完成本项 clean-room Evidence，再进入 G2-00-06；不能用 test-only PostgreSQL 函数替代 Production Migration。
