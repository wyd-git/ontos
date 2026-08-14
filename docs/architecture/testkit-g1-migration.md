# G1 资产迁移与正式 Testkit 边界

- 状态：Frozen for G2-00-11
- G1 冻结输入：`spikes/g1`
- 正式承载：`packages/testkit`
- 检查入口：`npm run test:testkit`、`npm run check:architecture`

## 1. 结论

G2 复用 G1 已验证过的领域包、数据形状、确定性生成规则和语义测试向量，但不复用 G1 的运行时代码、数据库凭据、固定端口、个人路径、性能脚本或 Evidence 输出。迁移后的 Testkit 是独立、可版本化的正式 workspace；它运行时不得读取或导入 `spikes/g1`。

这不是把 Spike 改名为生产模块。边界如下：

| 资产                                               | 正式实现                              | G1 依赖方式                                   |
| -------------------------------------------------- | ------------------------------------- | --------------------------------------------- |
| 两个 Package Manifest                              | Testkit 内语义等价复制的 JSON Fixture | 只记录来源和冻结 Hash；仅规范化 JSON 排版空白 |
| 固定种子数据                                       | Testkit 流式生成器                    | 重写为无数据库、无端口的纯确定性规则          |
| Query Corpus                                       | 数据化 JSON Vector                    | 移除 G1 编译器函数，只保留查询语义和参考阈值  |
| Overlay / Conflict                                 | 输入与期望结果 JSON Vector            | 从 G1 测试断言提取，不导入 Reference Model    |
| Policy                                             | 策略交集、入口一致性和拒绝路径 Vector | 从断言提取，不导入 Gateway                    |
| Package 兼容性                                     | 变更操作与期望兼容码 Vector           | 从断言提取，不导入 G1 Release Store           |
| Spike SQL、Compose、数据库密码、固定端口、性能报告 | 不迁移                                | 禁止成为正式测试前置条件                      |

## 2. 冻结指纹

G1 的 47 个可执行输入使用 `spikes/g1/scripts/content-fingerprint.js` 定义的算法：按相对路径排序后，对每个文件依次 Hash `path + NUL + bytes + NUL`。

- 算法：SHA-256
- 文件数：47
- 冻结指纹：`sha256:dff360ddb4c6683ab0481eb6d3d5f122aea6ad4e8039c51e57634ba894bd4aa1`

正式 Testkit 的 Provenance Catalog 还记录每个迁移组的来源文件、单文件 SHA-256、组指纹和有意转换。组指纹使用同一个有序路径算法，但路径相对于 `spikes/g1`。

| 组              | 冻结组指纹                                                                |
| --------------- | ------------------------------------------------------------------------- |
| `generator`     | `sha256:e5a38585a2dfaa919a57cd67be1f81dcceaa666312bfa3ac7b4daae354a0a17d` |
| `packages`      | `sha256:cc90f7297c1e411017c307f1eae290fd3e2e89ae2031377ffa2a1e9774ed05ca` |
| `query`         | `sha256:62c0be70852444df816604026eec2d4ae8a5fc9cb5e9c21bc9cf874f9b45c131` |
| `overlay`       | `sha256:2d089d120e605d73a5b526396756f50dc01314ec88908bb798a26aa7cdda815e` |
| `policy`        | `sha256:451a48fca5ff9341dd953cbef2f552800d77d9f00d858f2308f29d36bda34ea8` |
| `compatibility` | `sha256:8a49a1c60f27912c7f2fb2ed1aeedd0384f86543d2f9a866e47d45e0d1546802` |

Testkit 的行为测试只依赖正式副本。单独的 Provenance Audit 从 G1 可执行源重算上述指纹，用来证明“从哪里迁来”；它不读取 G1 Evidence、数据库、端口或凭据。

## 3. 确定性生成协议

默认种子 `seed-20260813` 继承 G1 冻结 Release 的语义。生成器提供两个正式 Preset：

- `small`：50 Objects、100 Links，用于快速行为测试；
- `benchmark`：100,000 Objects、1,000,000 Links，用于容量和集成验证。

生成器返回可重复迭代的 Iterable，不把百万级数据一次性保存在内存，也不把生成结果提交到 Git。Object 和 Link 的标识、类型轮转、状态、时间、金额、区域、Tag 及端点公式均固定；相同种子和配置必须产生相同摘要。当前 G1 数据本身没有可变随机输入，因此非默认种子通过稳定的 SHA-256 偏移改变序列，默认种子保持 G1 参考序列。

## 4. 依赖禁线

机器策略将 `spikes/g1` 定义为禁止的 Repository Import Root：

- `apps/*` 和 `packages/*` 中任何静态、动态、`require` 或 Import Type 的相对导入只要解析到该目录就失败；
- Testkit 也受同一规则约束；
- Production Layer 继续不能依赖 `@ontos/testkit`；
- Provenance Audit 位于 `tools/`，只能读取源文件并核验 Hash，不能被生产包依赖。

## 5. 非目标

G2-00-11 不实现 G1 查询编译器、Overlay 引擎、Policy Gateway、Package Release Store 或业务数据库 Schema。它只提供将来实现这些能力时可重复使用的正式输入和期望结果。运行语义由后续生产模块实现，并用这些 Vector 做回归验证。
