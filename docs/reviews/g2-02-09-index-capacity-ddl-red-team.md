# G2-02-09 Index、Capacity 与 DDL Red Team

- 日期：2026-08-16
- 方法：钢人化 5 个承重主张，再逐一写出失败条件、现有证据、Kill Criterion 与最低成本复测
- 结论：**G2-02-09 可 PASS；只放行 G2-02-10。Certificate、Cutover、GC、HTTP 与总验收仍为 OPEN**

## 1. 主张：Index Plan 真正来自不可变 Release，而不是测试 JSON

**钢人**：计划同时绑定真实 Project/Release/Pin、Published Object Type Revision、Property 能力、Evidence、Plan Digest 和 Inventory Revision；同一 Release 不能换计划。

**失败条件**：Repository 只相信调用参数；伪 Release ID、未发布 Revision、错误 Property 类型、未注册 JSON Path 或漏掉能力仍能持久化。

**证据**：生产 Adapter 读取 Release/Pin/Revision Content 与 Digest 后重验；两个真实 Release 复用同一 Plan，随后修改 Release 1 的方向得到稳定拒绝。该攻击在 Intended-vs-Implemented 复审中曾发现真实缺口并触发返工。

**Kill Criterion**：任一计划能绕过真实 Pin/Published Content，或同一 Release 能持久化第二个不同 Plan，09 立即 FAIL。

**最低成本复测**：真库中分别改变 Release ID、Revision State、Pin Digest、Property Type、JSON Path、能力覆盖和方向，每项都必须在 Admission 前拒绝。

**状态**：CLOSED。

## 2. 主张：共享表索引既复用，又不会跨 Project/Generation 错误唯一

**钢人**：物理签名包含 Revision/Predicate/Recipe/Key/方向及 Unique Scope；相同签名跨 Release 只创建一次，不同定义绝不覆盖。

**失败条件**：Unique 只作用于 JSON 表达式，会把两个代的同业务键误判冲突；或同名异定义被当成已存在。

**证据**：正式 100k/1m 同时保留多个 Generation 且 Unique Build 成功；Catalog 定义明确以 `project_id,generation_id` 为前缀。11 Recipe、签名 Comment、同名异定义与 Persisted Definition 篡改均有真库负测。

**Kill Criterion**：去掉 Scope 后仍通过测试，或同名异定义返回 REUSED，立即 FAIL。

**最低成本复测**：两个 Generation 写同值并创建 Unique；再预建同名错误索引，Executor 必须分别成功和拒绝。

**状态**：CLOSED。

## 3. 主张：容量准入不会因漏库存而系统性低估

**钢人**：Build 前后都读取全 Project Generation、Forecast、Index Units、Serving Roots 和 Catalog 实测；任何缺失使 `measurementComplete=false` 或协议冲突；实际 Project 字节成为保守下界。

**失败条件**：只计算目标 Generation、只计算当前 Channel、漏 Staging/固定 Index/ops 表，或测试 Loader 才能提供快照。

**证据**：默认生产 Loader 使用 Repeatable Read；Scanner 覆盖 Runtime 与 ops Object/Link Staging；Pending/Failed Index 阻断。正式实测 2.827 GB（2.632 GiB）高于 497 MiB G1 外推，系统选择实测并预留 4.240 GB（3.949 GiB），没有选择较小估算。

**Kill Criterion**：Catalog 实际总字节大于 Capacity measured lower bound，或缺 Forecast/Measurement 后仍可通过，立即 FAIL。

**最低成本复测**：插入缺 Forecast Generation、Pending Index、未跟踪动态 Index 和额外物理表，逐项验证拒绝或下界增长。

**状态**：CLOSED for one data-bearing Project。多 Project 部署级总磁盘仍不在当前包络。

## 4. 主张：动态 DDL 不会把 Owner 能力扩散到 API/Worker

**钢人**：API/Worker 只能产生固定数据库请求；专用短生命周期进程只接收 UUID，从结构化事实生成白名单 SQL，并以 Catalog 恢复。

**失败条件**：API/Worker 能传 SQL/Identifier、读取 Secret、获得 Owner/CreateDB，或 Executor 被杀后把 `RUNNING` 当成功。

**证据**：真实 Login 负测覆盖 DDL、Request 读取、`SET ROLE`；CLI 拒绝 SQL/URL/额外参数。SIGKILL 后 Request/Inventory 保持未成功，同 ID 重放按 Catalog 收敛，输出不包含密码。

**Kill Criterion**：Runtime 登录可 DDL/提权，或 Kill 后 Invalid Index 标 READY，立即 FAIL。

**最低成本复测**：每次发布执行真实角色矩阵、阻塞 Concurrent DDL 后 SIGKILL、错误 Catalog 和日志 Secret 扫描。

**状态**：CLOSED for CREATE。DROP 必须等 G2-02-12 的完整 Root 证明，当前显式拒绝。

## 5. 主张：100k/1m 首轮数字足以证明 09 可落地

**钢人**：测试从空 PostgreSQL 数据层执行真实 Base/Current/Quality/Index/Measurement，记录版本、配置、WAL、字节、内存与冷/热状态，并在 30 分钟/12 GiB Kill Criterion 内。

**失败条件**：只生成内存对象、复用暖数据库、不运行 Link/Quality/DDL、隐藏机器配置，或把一次 DB 基准外推成完整产品 SLO。

**证据**：100k/1m 核心构建 21m06s，Peak 4.240 GiB；Object/Link Digest 跨 Worker/API 重启稳定；最终绑定加固后又从空库缩量完整回归。

**Kill Criterion**：相同受控环境核心构建超过 30 分钟、Peak 超 12 GiB、Digest 重启漂移或实测下界倒挂，09 FAIL 并先优化/收紧 Plan。

**最低成本复测**：代码触及 Mapping/Base/Current/DDL/Scanner/Capacity 热路径时重跑正式 100k/1m；仅控制面绑定变化先跑全链路缩量，再由 14 在最终 Head 重跑 clean-room。

**状态**：CLOSED for G2-02-09 first-round DB capacity。真实 HTTP/S3/OIDC/Worker/Cutover 的最终 SLO 仍 OPEN to G2-02-14。

## 6. 排序后的失败模式

| 排名 | 失败模式                      | 影响 | 可能性 | 当前状态                                               |
| ---: | ----------------------------- | ---: | -----: | ------------------------------------------------------ |
|    1 | 伪 Release/Property Plan 获准 |    5 |      3 | CLOSED after production content binding                |
|    2 | 容量库存漏项导致硬上限失效    |    5 |      3 | CLOSED for one Project by default loader + scanner     |
|    3 | API/Worker 获得 DDL/Owner     |    5 |      2 | CLOSED by real login/CLI boundary                      |
|    4 | Unique 跨 Generation 冲突     |    5 |      3 | CLOSED after scoped physical definition                |
|    5 | DDL 中断后假 READY            |    5 |      3 | CLOSED by SIGKILL/Catalog replay                       |
|    6 | 一次基准被夸大为完整产品 SLO  |    4 |      4 | Claim bounded；14 remains OPEN                         |
|    7 | 未证明引用就提前 Drop         |    5 |      3 | BLOCKED by explicit authorization guard；12 owns proof |

## 7. 放行结论

没有触发修改 PRD、改变共享投影架构或把 Owner 权限交给 Runtime 的停止条件。09 的产物可以被 10 的 Runtime Plan/Certificate 直接消费，不需要手工补表或改写历史 Release。

只放行 **G2-02-10 Runtime Member Plan 与受信兼容证书**。不得跳过 Certificate/Cutover/GC，也不得把本轮数据库基准描述成用户已经可以登录使用的完整产品。
