# G2-00-05 公共值编码与 Golden Vector 验收记录

- 结论：**PASS（仅限 G2-00-05）**
- 执行日期：2026-08-13
- 分支：`agent/g2-00-05-public-value-codec`
- 起始 Commit：`4fd86e49a7ada561f668665f8a612da4d1d1eb57`
- 工具：Node.js 24.18.0 / npm 11.16.0 / fast-check 4.9.0
- Unicode Runtime：ICU 78.3 / Unicode 17.0
- 环境：macOS 26.5.2（Build 25F84）arm64 / PostgreSQL 16.14

本记录对应 [G2-00-05 WWA](../delivery/g2-00-foundation-task-pack.md#g2-00-05adr-009-公共值编码与-golden-vector)。最终实现 Commit 由 Draft PR head 记录，避免在被提交文件中写入自身 Commit Hash。

## 1. 验收映射

| WWA 声明                                                                      | 实现证据                                          | 执行证据                                                                 | 结果 |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ | ---- |
| 覆盖 UUID、PK、integer、decimal、date、timestamp、enum、string/string[]、json | `packages/value-codec/src/`；ADR-009 §2–3         | 16 个正向 Golden Values、14 个稳定错误、4 个 Primary Keys                | PASS |
| integer/decimal JSON 不经过 JavaScript number                                 | `scalars.ts`；`property.ts`                       | Wire number 负例；signed 64-bit / precision 38 边界；序列化后仍为 string | PASS |
| timestamp 为 UTC 六位微秒固定宽度；拒绝非法/歧义                              | `scalars.ts`；ADR-009 §2.2                        | Offset、跨日、0001/9999、闰年、无时区、闰秒、7 位小数、`-00:00`          | PASS |
| Primary Key 大小写、Unicode、长度和复合键正反例                               | `primary-key.ts`；Unicode Baseline                | NFC、`straße`、Type Tag、UTF-8 Length、delimiter、1,024-byte、4 组碰撞   | PASS |
| TypeScript 与 PostgreSQL 同值同序                                             | `golden-vectors.json`；`postgres-fixture.sql/.ts` | PostgreSQL 16.14：16 Values、4 PK、4 Collision、8 Order Groups           | PASS |
| 属性测试覆盖 round-trip、边界和碰撞                                           | `properties.test.ts`                              | 固定 Seed `20260813`；5 项各 300 次；完整 Unicode Scalar Digest          | PASS |

## 2. 冻结的公共合同

### 2.1 值语义

- integer 是 `[-2^63, 2^63-1]` 的规范十进制 string；
- decimal 是 precision 1–38、scale 0–18 的固定 scale string，不接受指数或舍入；
- date 是真实 Gregorian `YYYY-MM-DD`；
- timestamp 是 `0001..9999`、明确时区、最多六位输入精度，输出固定 `YYYY-MM-DDTHH:mm:ss.ffffffZ`；
- enum 保存 Published Revision 中的稳定 Code；
- string 默认 64 KiB UTF-8，string[] 默认 1,000 项且保留顺序/重复；
- restricted json 默认 1 MiB、64 层、100k nodes，Object Key 使用 UTF-8 `C` 顺序，unsafe integer/指数输出不作为 exact-number 后门；
- boolean 虽未单列在 G2-00-05 WWA 文案中，属于 PRD 已冻结的 P0 Property Type，和其他标量走同一公共包。

### 2.2 Primary Key

```text
pk1|<component-count>|<type-tag><utf8-byte-length>#<canonical-value>...
```

String Primary Key 总是 NFC；按 Property 选择保留大小写或 locale-independent default uppercase。完整规范值最多 1,024 UTF-8 bytes，不 Trim、不依赖 PostgreSQL 默认 Collation。

Unicode identity Gate 固定：

```text
Node.js 24.18.0
ICU 78.3
Unicode 17.0
NFC -> uppercase -> NFC all-scalar SHA-256
04eac79fe1912c1c6257c3c085217a946ee2595d424099fec79ece773614b855
```

工具链升级改变版本或 Mapping Digest 时必须先做身份影响审查，不能沿用 `pk1` 静默写入。

### 2.3 排序

| 类型      | TypeScript                     | PostgreSQL Fixture |
| --------- | ------------------------------ | ------------------ |
| UUID      | 规范 byte/hex                  | `uuid`             |
| boolean   | `false < true`                 | `boolean`          |
| integer   | `BigInt`                       | `bigint`           |
| decimal   | common scale unscaled `BigInt` | `numeric`          |
| date      | 固定宽度文本                   | `date`             |
| timestamp | 固定宽度 UTC 文本              | `timestamptz`      |
| enum      | Published 声明顺序             | ordinal            |
| string    | UTF-8 byte                     | `COLLATE "C"`      |

## 3. Red-Team 与 Intended-vs-Implemented 结果

[专项审查](../reviews/adr-009-public-value-codec-red-team.md)在 Accepted 前关闭了以下偏差：

- JSON 最初在完整构造 Canonical String 后才检查 1 MiB，现改为遍历时逐 Token 计费；
- Unicode Normalization/Case 最初只有少量示例，现固定 Runtime 版本并 Hash 全部 Unicode Scalar；
- 直接 Decimal comparator 最初隐含相同 scale，现先对齐 common scale；
- Timestamp 属性测试最初集中在 2000–2099，现覆盖 0002–9998 并固定 0001/9999 边界；
- PostgreSQL 首次 PASS 的版本字段读取错误，已改用 Server `current_setting` 并现场确认 16.14；
- SQL string[] Fixture 的限制失败从返回空结果改为明确异常。

修正后没有仍未关闭、且属于 G2-00-05 纯 Codec/Fixture 范围的 Intended-vs-Implemented 漂移。真实业务入口接线和 Production Unique/Expression Index 明确保留给各模块 Gate 与 DB-02。

## 4. 可复现执行

### 4.1 Clean install

```text
NODE_VERSION=24.18.0 /Users/wangyudong/.nvm/nvm-exec npm ci
toolchain: PASS (node 24.18.0, npm 11.16.0)
added 136 packages
```

执行前后 `package-lock.json` SHA-256 均为：

```text
596243cf1053ee28b22ba1f66307403d0627338bd56582dcfa1f4b88197bb45b
```

### 4.2 全仓 Gate

```text
NODE_VERSION=24.18.0 /Users/wangyudong/.nvm/nvm-exec npm run verify

check:toolchain     PASS
format:check        PASS
lint                PASS
typecheck           PASS
test:unit           PASS — 95/95
check:architecture  PASS — 1 package / 7 source files
```

G2-00-05 专项为 25/25 top-level tests，其中 5 个 fast-check Property 各执行 300 次。Snapshot、Action、Query、SDK 四个消费者名称对同一 Golden Vector 数据执行，不存在四份复制期望。

### 4.3 真实 PostgreSQL 交叉验证

```text
NODE_VERSION=24.18.0 /Users/wangyudong/.nvm/nvm-exec npm run test:value-codec:postgres

PASS — 16 values
PASS — 4 canonical Primary Keys
PASS — 4 normalization collisions / UNIQUE 23505
PASS — 8 typed order groups
PostgreSQL 16.14 (Debian 16.14-1.pgdg12+1)
```

该命令连接 G2-00-02 的真实本地 PostgreSQL 容器；SQL 使用 `pg_temp` 函数，不污染或冒充 Production Schema。

### 4.4 Artifact Digest

对 `packages/value-codec/` 与 `tools/value-codec/` 全部文件按路径排序后逐文件 SHA-256，再对清单 SHA-256：

```text
49d3973efface0ba6bfd4cf138b2c3bed040b30d1af94d521ee62e66d1af5981
```

后续任何 Codec、Golden Vector、测试或 PostgreSQL Fixture 变更都必须重新生成 Evidence，不得沿用本结论。

## 5. 明确不宣称

- 本记录不是 G2-00 Foundation 总 Gate PASS；G2-00-06～13 仍未完成。
- 当前没有 Object Store、Identity Map、Repository、Migration 或 Query Compiler。
- “Snapshot/Action/Query/SDK 共用”当前证明公共包和向量可共用，不证明尚未创建的真实业务模块已完成 Integration。
- `postgres-fixture.sql` 不是 Production Migration；DB-02 仍须实现复合 Unique、`C` Collation 和受控类型表达式。
- Restricted JSON 不提供 arbitrary-precision number、任意 JSON Path 或 Primary Key 能力。
- 首次改变 `pk1`、Unicode Runtime 或 Canonical JSON 前必须新增兼容/迁移 ADR。
