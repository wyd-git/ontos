# ADR-009：公共值编码、Primary Key 与 Golden Vector

- 状态：Accepted for G2-00-05
- 日期：2026-08-13
- Owner：Contracts / Runtime
- 决策范围：Snapshot、Action、Query、SDK 共用的 Property Value、Primary Key、排序与错误合同
- 可执行合同：`packages/value-codec/`
- 共享向量：`tools/value-codec/golden-vectors.json`

## 1. 决策结论

P0 只允许一份公共值语义：无外部 Runtime 依赖的 `@ontos/value-codec`。Snapshot Mapping、Action 参数与写入、Query 参数和 SDK 都必须调用这个包的公开入口；SDK 的提前校验不能替代 Server 再校验。业务模块、数据库 Adapter 和 Query Compiler 不得自行解析 integer、decimal、date、timestamp 或 Primary Key。

Codec 接收已经被 Transport 解码的 `unknown` 值和受信 Published Revision 的 Property 描述，返回可直接进入 API/存储边界的规范值，或抛出稳定 `ValueCodecError`。输入无效时不能猜测、舍入、截断、采用本机时区或依赖数据库隐式 Cast。

数据库只接收 Codec 输出。PostgreSQL 不重新计算 Unicode Primary Key；它使用 `text COLLATE "C"` 保存规范值并用显式 Unique Constraint 解决并发竞争。Integer、Decimal、Date、Timestamp 的查询/索引表达式使用受控类型 Cast，不按 JSON/text 默认顺序比较。

## 2. 公共值矩阵

| Property / Value | 边界输入                                  | 规范输出                                      | P0 拒绝条件                                                                            |
| ---------------- | ----------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| UUID             | 8-4-4-4-12 十六进制字符串，字母可大小写   | 36 字符小写 UUID                              | 花括号、无连字符、非十六进制；不额外限制 version/variant                               |
| boolean          | JSON boolean                              | JSON boolean                                  | 字符串 `"true"`、数字等隐式转换                                                        |
| integer          | 十进制字符串                              | 有符号 64-bit 最短十进制字符串                | JavaScript `number`、`+`、前导零、指数、越界；`-0` 规范为 `0`                          |
| decimal          | 十进制字符串 + Published precision/scale  | 固定 scale 的十进制字符串                     | JavaScript `number`、指数、超过 precision/scale、任何舍入                              |
| date             | 固定宽度 `YYYY-MM-DD`                     | 原固定宽度文本                                | 非真实 Gregorian 日期、年份 0000、宽度变化                                             |
| timestamp        | 有秒和明确时区的 RFC3339，0–6 位小数秒    | UTC、六位小数秒、27 字符 RFC3339              | 无时区、空格分隔、闰秒、超过微秒、`-00:00`、超过 ±14:00、UTC 后越出 0001–9999          |
| enum             | Published Revision 中存在的稳定 Code      | 原 Code                                       | Display Name、未知 Code、重复 Code Schema                                              |
| string           | well-formed Unicode 字符串                | 原字符串，不 Trim、不改大小写、不做 NFC       | U+0000、lone surrogate、超过默认 64 KiB UTF-8                                          |
| string[]         | JSON string array                         | 保留顺序和重复项的 string array               | 非数组、非 string 项、超过默认 1,000 项或单项限制                                      |
| json             | JSON-compatible plain object/array/scalar | UTF-8 Key 排序后的确定性 JSON；API 返回整体值 | 非 plain object、循环、非有限数、unsafe integer、指数输出、超过 1 MiB/64 层/100k nodes |

所有长度按 UTF-8 byte 计，不按 JavaScript code unit、Unicode code point 或 PostgreSQL character 计。部署可以在 Revision 中收紧 string、array、json 限制，但同一 Published Revision 内不得改变。

### 2.1 Integer 与 Decimal 不经过 JavaScript number

Integer 和 Decimal 的 Wire JSON 均为字符串。Integer 使用 `BigInt` 做有符号 64-bit 边界检查；Decimal 把符号、整数位和小数位作为文本处理，再把规范值解释为 unscaled `bigint` 比较。P0 不允许科学计数法，也不把多余小数位四舍五入。

例如 precision 5、scale 2：

```text
"1.2"    -> "1.20"
"-0"     -> "0.00"
"999.99" -> "999.99"
"1000"   -> DECIMAL_VALUE_OUT_OF_RANGE
"1.234"  -> DECIMAL_VALUE_OUT_OF_RANGE
```

这使 Snapshot CSV 文本、Action/Query JSON 字符串和 SDK 返回值保持同一语义。调用方若先执行 `Number(value)`，已经破坏合同，Codec 会拒绝 number 而不是尝试恢复丢失的数字。

### 2.2 Timestamp

Timestamp 解析不调用 JavaScript `Date`，避免毫秒截断、Host 时区和宽松字符串解析。实现使用 Gregorian civil-date 与 epoch microseconds 的纯整数换算；六位微秒全程保留。

```text
2026-08-13T16:01:02.123456+08:00
  -> 2026-08-13T08:01:02.123456Z

2026-08-13T08:01:02Z
  -> 2026-08-13T08:01:02.000000Z
```

`Z` 和 `+00:00` 表示已知 UTC；RFC3339 的 `-00:00` 表示未知本地偏移，因此 P0 作为歧义输入拒绝。闰秒不在 P0 时间模型中，秒必须是 00–59。

### 2.3 Restricted JSON

JSON Property 是展示和整体读写能力，不是任意精度数字容器或任意路径 Query。其数值语义是 Transport 已解码的有限 ECMAScript binary64；unsafe integer 和会规范成指数形式的 number 被拒绝。需要精确业务数字时必须使用 integer/decimal Property 或明确的 string 字段。

Canonical JSON 按 UTF-8 byte 的 `C` 顺序递归排列 Object Key，保留 Array 顺序，并把 `-0` 规范为 `0`。大小、深度、节点数在遍历时逐步计费并提前失败，不能先构造无界字符串后再检查 1 MiB。

## 3. Canonical Primary Key

### 3.1 Component 规则

Primary Key 至少有一个非 null Component。允许 UUID、boolean、integer、decimal、date、timestamp、enum 和 string；不允许 json 或 string[]。每个 Component 先按其 Property Codec 规范化，再进入 Primary Key framing。

String Component：

1. 拒绝空字符串、U+0000 和 ill-formed Unicode；不 Trim；
2. 总是执行 Unicode NFC；
3. `caseSensitive=true` 保留大小写；
4. `caseSensitive=false` 使用 ECMAScript locale-independent default uppercase，再做一次 NFC；
5. 不依赖请求 Locale、操作系统 Locale 或 PostgreSQL Collation。

大小写/Normalization 表属于身份算法。G2 工具链固定 Node 24.18.0、ICU 78.3、Unicode 17.0，并对全部 Unicode Scalar 的 `NFC -> uppercase -> NFC` 结果保存 SHA-256 基线。Runtime/Unicode 升级若改变该摘要，必须阻止合并，评估现有身份，再选择保持算法或发布新版本与迁移；不得在 `pk1` 下静默改变。

### 3.2 无歧义复合编码

Canonical Primary Key 是内部稳定、外部可传输但应视为 opaque 的字符串：

```text
pk1|<component-count>|<type-tag><utf8-byte-length>#<canonical-value>...
```

示例：

```text
[string "tenant|north", integer "-0"]
  -> pk1|2|s12#tenant|northi1#0
```

Type Tag 防止 string `"1"` 与 integer `"1"` 成为同一身份；UTF-8 byte length 防止 delimiter 和相邻 Component 边界冲突。编码后的完整值最多 1,024 UTF-8 bytes；更长业务标识必须在 Mapping 中生成稳定紧凑键，原值可保留为普通 Property。

`pk1` 是身份协议版本，不是显示前缀。已发布 Object Type 不能原地改变 Component 顺序、类型、precision/scale、大小写规则或 Codec 版本。

### 3.3 Collision 与并发

Snapshot/批量写入在持久化前对 Canonical Primary Key 建 Map；不同 Source Candidate 规范到相同值时返回 `PRIMARY_KEY_COLLISION`，错误只包含 Candidate ID，不回显 Primary Key 值。

该预检不能解决并发。DB-02 必须实现 ADR-008 的：

```text
UNIQUE (project_id, generation_id, object_type_resource_id, canonical_primary_key)
```

并把 `23505` 映射为可解释的冲突，不向调用方返回原数据库错误。

## 4. 排序合同

Canonical text 与业务排序不是同一概念。所有排序均由类型描述决定：

| 类型      | TypeScript Comparator               | PostgreSQL 受控表达式 |
| --------- | ----------------------------------- | --------------------- |
| UUID      | 16 bytes / 规范 hex 顺序            | `::uuid`              |
| boolean   | `false < true`                      | `::boolean`           |
| integer   | `BigInt`                            | `::bigint`            |
| decimal   | 对齐 scale 后比较 unscaled `BigInt` | `::numeric`           |
| date      | 固定宽度规范文本                    | `::date`              |
| timestamp | 固定宽度 UTC 规范文本               | `::timestamptz`       |
| enum      | Published Code List 的声明顺序      | 编译后的 ordinal      |
| string    | UTF-8 byte / `C` 顺序               | `COLLATE "C"`         |

Query Compiler 后续只能从 Published Property Descriptor 选择以上白名单表达式；不能接受客户端 SQL、Cast、Collation 或 Enum ordinal。P0 的业务 Locale Collation 若要不同于 `C`，必须固定到 Release 并新增兼容/索引证据，不能修改本 ADR 的身份和 Golden Vector。

## 5. PostgreSQL Fixture 的职责

`tools/value-codec/postgres-fixture.sql` 是可执行的交叉实现，不是 Production Migration：

- 独立复算 UUID、integer、decimal、date、timestamp、enum、string/string[] 和 restricted json 的规范值；
- 使用 `uuid`、`boolean`、`bigint`、`numeric`、`date`、`timestamptz`、Enum ordinal 和 `COLLATE "C"` 对同一向量排序；
- 保存 TypeScript 产生的 canonical Primary Key 并验证 `C` Collation、1,024-byte Gate 与唯一冲突；
- 不在 PostgreSQL 重做 Unicode Case/Normalization，避免数据库 Locale/Unicode 版本成为第二身份算法。

Fixture 在 G2-00-02 的真实 PostgreSQL 16 容器执行。未来 DB Migration 只能消费相同规范值和类型化排序规则，不能把这些 test-only `pg_temp` 函数复制成第二套生产 Codec。

## 6. Stable Error 边界

公共错误使用 `ValueCodecError { code, path }`。当前稳定 Code：

- `UUID_INVALID`；
- `INTEGER_FORMAT_INVALID` / `INTEGER_VALUE_OUT_OF_RANGE`；
- `DECIMAL_SCHEMA_INVALID` / `DECIMAL_FORMAT_INVALID` / `DECIMAL_VALUE_OUT_OF_RANGE`；
- `DATE_INVALID` / `TIMESTAMP_INVALID`；
- `ENUM_SCHEMA_INVALID` / `ENUM_VALUE_INVALID`；
- `STRING_INVALID` / `STRING_TOO_LARGE` / `STRING_ARRAY_TOO_LARGE`；
- `JSON_VALUE_INVALID`；
- `PRIMARY_KEY_INVALID` / `PRIMARY_KEY_TOO_LARGE` / `PRIMARY_KEY_COLLISION`；
- `VALUE_TYPE_MISMATCH`。

错误不得包含原值、完整 Primary Key、JSON 内容或 Secret。Snapshot 可以在外层增加 row/column，Action/Query 可以增加 parameter/property path，但不能改写底层 Code 的含义。

## 7. Golden Vector 与升级 Gate

`golden-vectors.json` 是 Snapshot、Action、Query、SDK 和 PostgreSQL 共用的版本化数据文件，覆盖：

- 每种公共值的正例与稳定错误；
- 64-bit、precision/scale、Gregorian、时区和微秒边界；
- Unicode NFC、大小写、delimiter、类型 Tag 和复合 Primary Key；
- 不同输入映射为同一身份的碰撞；
- TypeScript 与 PostgreSQL 的规范值和排序。

固定测试之外，fast-check 使用固定 Seed `20260813` 对 signed 64-bit round-trip、decimal unscaled round-trip、timestamp instant/idempotency、复合键边界和大小写碰撞各执行 300 次。

任何修改以下内容都必须更新 ADR、Codec version/兼容策略、Golden Vector 和 PostgreSQL Fixture；只更新期望值让测试变绿不构成兼容证明：

- integer/decimal Wire 类型或范围；
- timestamp 接受格式、精度、时区或输出；
- Unicode Normalization/Case 算法；
- Primary Key Type Tag、Component 顺序、framing 或长度；
- string/json 排序或 Canonical JSON；
- Error Code 含义。

## 8. 被拒绝的方案

### 8.1 各入口自行解析

拒绝。Snapshot CSV、HTTP JSON、SDK 和数据库 Cast 会在精度、宽松格式、时区或错误上漂移，直接破坏 Object Identity 和 Cursor。

### 8.2 依赖 JavaScript Number / Date

拒绝。Number 无法精确覆盖 signed 64-bit 和 precision 38；Date 只保留毫秒且解析接受面不等于本合同。

### 8.3 依赖 PostgreSQL 隐式 Cast 作为校验器

拒绝。PostgreSQL 会接受本合同禁止的某些宽松时间/数字形式，`numeric(p,s)` 还能舍入。数据库保留最终 Constraint 和并发唯一性，但输入语义由公共 Codec 决定。

### 8.4 用 delimiter 直接 join 复合键

拒绝。只要业务值包含 delimiter 或 Component 边界变化就会碰撞。P0 使用版本、类型和 UTF-8 length framing。

### 8.5 让数据库再次执行 Unicode lower/upper

拒绝。结果可能随 Collation Provider、Locale、ICU/libc 和数据库升级改变。PostgreSQL 只比较已规范化的 opaque Primary Key。

## 9. 本任务明确不实现

- 不实现 Object Store、Object Identity Map、Repository、Migration 或 Query Compiler；
- 不实现 Snapshot CSV/Parquet Reader、Action Runtime、HTTP Endpoint 或生成式 SDK；
- 不实现业务 Locale Collation、任意 JSON Path 查询或任意精度 JSON number；
- 不解决历史 `pk1` 数据向未来 Codec Version 的迁移；首次升级前必须新增 ADR；
- 不宣称 test-only PostgreSQL Fixture 是生产数据库校验函数。

G2-00-05 的产物是后续模块必须复用的可执行公共合同。DB-02、Snapshot、Action、Query 和 SDK 仍各自需要 Integration Gate，证明它们没有绕过这个包。
