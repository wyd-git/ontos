# G2-02-05 确定性 Mapping 编译与流式执行 Evidence

- 日期：2026-08-15
- 结论：**PASS**（只代表 G2-02-05 Mapping Gate；不代表 RID/Object Identity Repository、Object/Link Base、Current、Worker、Cutover/GC 或整个 G2-02 已完成）
- 任务合同：[G2-02 Materialization 任务包 § G2-02-05](../delivery/g2-02-materialization-task-pack.md#g2-02-05实现确定性-mapping-编译与流式执行)
- 边界合同：[确定性 Mapping 编译与流式执行](../architecture/deterministic-mapping-runtime.md)
- 专项红队：[G2-02-05 Red Team](../reviews/g2-02-05-deterministic-mapping-red-team.md)

## 1. 实际交付

| 组件                   | 责任                                                                                                               | 明确不做                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Managed CSV Row Reader | 复用 G2-02-04 同一 UTF-8/CSV 状态机逐行解码，保留行号并对 Consumer 施加背压                                        | 整文件缓存、Schema 推断、第二套 CSV 语义         |
| Mapping Compiler       | 重跑冻结合同 Parser，核对 Revision/Digest，解析列、Property、PK 和 Link Endpoint，产出规范 Plan/Digest             | SQL、未登记函数、隐式 Cast、运行时 Metadata 查找 |
| Row Evaluator          | 执行 `column/constant/cast/concat/null`，所有值与 PK 调用公共 Codec，输出 Object Candidate 或 Link Identity Lookup | RID 创建、Dangling Link 判定、Base/Current 写入  |
| Stream Summary         | 按源顺序链式计算 Digest，记录接受/拒绝计数和有界错误聚合                                                           | 保存全部行、PK、原值或高基数错误                 |

## 2. Acceptance 对照

| 要求                                     | 实现与可执行证据                                                                                                                                   | 结论 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 允许列/常量/Cast/Concat/null/PK/Link Key | 合同与 Compiler 只接受四类 AST；未登记节点、SQL、未知列、隐式 Cast、缺少必填 Base Property 稳定失败                                                | PASS |
| 全值类型与 PK 经公共 Codec               | boolean/integer/decimal/date/timestamp/enum/string/string[]/json 和 `pk1` 的真实行通过；整仓同时运行 Value Codec Golden/Property Suite             | PASS |
| 版本/输入/目标/Plan Digest 冻结          | Plan 包含 Compiler/Mapping/Codec Version、Mapping/Schema/Target ID+Digest、Quality Rules、Endpoint Digest 和规范 Plan Digest；内容漂移 fail closed | PASS |
| 跨进程确定性                             | `UTC/C` 与 `Asia/Shanghai/zh_CN` 两个独立 Node 进程的 Plan/事件/摘要 JSON 逐字节一致                                                               | PASS |
| 结构化、有界、脱敏错误                   | 负测验证原值、完整 PK、PK 列名、restricted 列名和 Sink Cause 不进入普通错误；聚合只使用稳定 Code                                                   | PASS |
| Object/Link 身份候选                     | Object 输出 Canonical PK；Link 只输出两端 Resource/Revision/Canonical PK，Display/API Name 不参与身份                                              | PASS |
| 固定 Seed Property Tests                 | Seed `20260815`，覆盖 null、Unicode/NFC/case collision、int64、decimal scale、timezone、concat 边界和 1,024-byte PK                                | PASS |
| 同一 Source/Mapping 重放完全一致         | 每行结果、错误顺序、计数、聚合和 Mapped Stream Digest 完全一致                                                                                     | PASS |
| 100k/1m 有界流式                         | 128 MiB V8 Heap 子进程完整执行 100,000 Object + 1,000,000 Link；专用 x86_64 机器峰值 93.78 MiB，结束 GC 后仅增约 0.77 MiB                          | PASS |

## 3. 确定语义

- CSV 空字段是 `null`；常量 `""` 是显式空字符串。
- Snapshot 值先按输入 Descriptor 规范化，再执行显式 Cast，最后按目标 Descriptor 规范化。
- Property 按 Code Point 顺序输出；错误聚合按稳定 Code 顺序输出，不使用 Locale 比较。
- Stream Digest 以 Source Content Digest + Plan Digest 为初始前像，然后按行链入 accepted/rejected 事件。
- Sink 有背压；一旦拒绝当前事件，Execution 立即终止，不允许继续行。

## 4. Intended-vs-Implemented 复审与实际返工

逐条对照任务包、合同、Value Codec、Ingress Reader 和后续 G2-02-06 输入后，本项在 Gate 内关闭了以下差距：

1. 初始执行器只能校验已列出的 Property，无法发现被整个遗漏的非空 Base Property；增加 Compiler 完整性 Gate。
2. 初始 Plan 用 Mapping Digest 间接绑定 Quality Rules，但下游无法不重新解释 Mapping 就使用；改为把冻结 Quality Rules 纳入 Plan 和 Plan Digest。
3. 初始 Sink 失败会抛错，但理论上调用者仍可继续使用已前进摘要的 Session；改为稳定包装并转入不可继续终态。
4. 初始 CSV Scanner 只报物理事实，无法把真实解码行交给 Mapping；在同一状态机增加不可变行回调与背压，不分叉 CSV 语义。
5. 错误聚合和 Property 排序初审查显式排除 Locale 比较，使用稳定 Code Point 顺序。

这些修正没有引入 RID、数据库或 Worker，不改变 G2-02-05 的产品边界。

## 5. 验证结果

```text
npm run test:materialization-mapping
PASS — 22 deterministic/compiler/execution/cross-process/property tests

npm run test:materialization-mapping:capacity
PASS — 100,000 Object + 1,000,000 Link under --max-old-space-size=128
       local: peak <= 97.23 MiB; total 9.66–9.69 s
       x86_64 Ubuntu 24 / 8C16G: peak 93.78 MiB; retained growth 801,944 bytes;
       total 55.19 s; Object/Link Plan + Stream Digests equal the local run

npm run verify
PASS — 24 of 24 gates / 369 tests / 195.53 s on x86_64 Ubuntu 24 / 8C16G
       包含锁文件重装、格式、Lint、TypeScript、合同、架构、Supply Chain、
       128 MiB Mapping Capacity、PostgreSQL 16、真实 S3/OIDC/HTTP、
       Metadata clean-room 和 Production Boundary 启停
```

上述专用机验证已使用与待提交工作树相同的源码完成。合并前仍必须在干净提交与 PR 最终 Head 上各自再通过必需检查，防止证据与实际合并内容脱节。

## 6. 非结论与下一工作项

本项产生的是确定候选，不是已持久的业务对象：

- 大小写/NFC 等价值会生成同一 Canonical PK，但批内重复判定、并发 Resolve/Create 和稳定 RID 属于 G2-02-06；
- Link 只产生 Identity Lookup，尚未判定 required/optional Dangling；
- 100k/1m 只证明 Mapping 内存形状，不包含 S3 读取、PostgreSQL COPY/WAL/Index、Worker Kill/Resume 或 30 分钟总基线；
- 没有 Base、Current、Serving Head、Cutover 或 GC 结论。

G2-02-05 PASS 后只允许进入 G2-02-06：永久 Object Identity、批量 Resolve/Create、不可变 Object/Link Base 与 10k/100k 真实 PostgreSQL 薄切片。
