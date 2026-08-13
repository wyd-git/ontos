# Red-Team：ADR-011 Trusted Handler Host 进程边界

- 日期：2026-08-13
- 审查对象：[ADR-011](../architecture/adr/011-trusted-handler-host-boundary.md)
- 方法：`strategy-red-team` 后接 `intended-vs-implemented`
- 结论：**G2-00-07 的独立进程 seam 可接受；真实 Artifact Promotion、容器 Egress / Resource Limit、Policy-aware Query Port 与 Action Transaction 仍由后续 Function / Action / Deployment Gate 阻断**

## Top Kill-Assumptions（排序）

### 1. Production 部署会同时落实独立 Secret Identity、Egress Deny 和资源限额（100）

- **Claim：** 独立 Host 不会读取平台凭据、绕过 Context 访问网络，或用 CPU / Memory 耗尽 API。
- **Steelman：** 原型没有继承父进程环境，只允许读取 Host 目录，默认禁止文件写入、子进程与 Worker；网络常用入口在 Artifact 加载前被替换；无限循环只杀 Host，不杀 Coordinator。
- **Fails if：** Production Pod 仍挂载 API Secret / Service Account，NetworkPolicy 或主机防火墙允许任意出站，Host 与 API 共用无上限 cgroup，或把应用级 API 替换宣传成恶意代码沙箱。
- **Evidence to get this week：** 在 Linux 验收环境运行独立 Service Account / Secret Mount 清单、`curl`/TCP/DNS 出站反例、只读 RootFS、非 root、PID/CPU/Memory 限制和 OOM 故障注入；同时证明 API 仍可服务。
- **Kill criterion：** Host 能读取任一 API / DB / S3 / OIDC / Registry Credential，能在默认配置访问外网，或一次 Artifact OOM 能杀死 API Pod / Node；P0 Handler 不得放行。
- **Cheapest test：** 当前 `pool.test.ts:64-155` 先证明进程级白名单及常用网络/文件/进程入口；部署 Gate 把同一 Capability Probe 放进实际 Linux 镜像和 NetworkPolicy。
- **处理：** macOS / Node seam CLOSED；Production Container / Egress / cgroup OPEN。

### 2. 真实 Runtime 生成的 Read Set 已经过同一 Policy，并在 Apply 时已锁定（100）

- **Claim：** Handler 只能看到调用者被授权、且本次计划允许读取的 Object / Property。
- **Steelman：** Context 同时检查 Manifest Query、Invocation Declaration、Object RID、Property 子集和较小 Read Budget，只返回 Runtime 预先给出的投影副本；Host 自身没有 DB 身份。
- **Fails if：** HTTP 客户端能直接填写 `queryResults` / `readSet`，Runtime 在 Policy 前取数，Function / Action 使用不同 Policy 向量，或 Apply 遇到新对象时临时补锁而不是返回 stale。
- **Evidence to get this week：** Function / Action Integration 从真实 Policy Gateway 生成 Context；对同一 Actor/Release 跑 HTTP Query、Function、Preflight 和 Apply 一致向量，并在 Apply 扩大 Read Set 时返回 `PREFLIGHT_STALE`。
- **Kill criterion：** 任一调用路径让外部请求直接决定授权 Query Result，或 Handler 读到 HTTP Query 不可见的 Property / Object；对应 Function / Action Gate 失败。
- **Cheapest test：** `context.ts:26-98` 与 `pool.test.ts:46-126` 已固定 Host 侧拒绝；下一步用一个真实 Query Application Port 替换 Fixture 数据，不改变 Context 合同。
- **处理：** Host Context CLOSED；Policy / Query / Lock Translation OPEN（G2-03 / G2-04）。

### 3. Artifact Promotion 会让“登记 Digest”成为不可变部署事实（96）

- **Claim：** RPC 的 Digest 只能选择经过评审、签名并随 Host Release 部署的确切 Artifact 字节。
- **Steelman：** RPC 严格拒绝 Path / Module / Code / URL；静态 Registry 运行时冻结；加载前重新计算源文件 SHA-256；请求 Timeout、Read Budget、Query 能力和输入输出 Schema 都不能扩大登记值。
- **Fails if：** Production Catalog 可被 Runtime 请求写入，Digest 没有绑定完整构建产物 / 依赖 / Node Runtime，校验后到加载前文件可被替换，或 Rolling Deploy 把同一 Digest 指向不同字节。
- **Evidence to get this week：** 构建一个签名 Artifact Bundle：Digest 覆盖编译输出、Manifest 和依赖锁；镜像内只读；Admin Promotion 留审计；两个 Host 版本对同一 Digest 返回一致 Metadata。
- **Kill criterion：** 未经 Admin Promotion 的 Artifact 能被执行，同一 Digest 在两个实例解析为不同字节，或运行目录在启动后可写；Production Catalog 不得接入。
- **Cheapest test：** 当前 `catalog.ts:13-116`、`registry.ts` 和 `protocol.test.ts:23-112` 证明静态 Fixture；下一步先做一个离线签名 Bundle，不需要先做完整 Catalog UI。
- **处理：** 静态 Fixture Registry CLOSED；签名 Promotion / 只读镜像 OPEN。

### 4. Pool 的进程隔离在真实容量与故障风暴下仍保持可用（84）

- **Claim：** 一个无限循环或 Host Crash 不会拖死 Coordinator，固定 Pool 可以继续处理后续调用。
- **Steelman：** Timeout 在父进程计时，先 `SIGTERM`、最多 250ms 后 `SIGKILL`；代际不复用；活动 Host kill 和显式 Pool restart 都有自动测试；替代进程启动失败时 Pool fail closed，不让未来请求无限排队。
- **Fails if：** 大结果在 IPC Decode 前耗尽内存，Queue 无界导致请求堆积，Host 重启风暴打满 CPU，或 API 总 Deadline 小于 Queue + Handler Deadline 却没有取消传播。
- **Evidence to get this week：** 在 Linux 以目标并发测试 Queue Depth、IPC Payload、Timeout Storm、OOM、连续启动失败和 Rolling Restart；记录 API P95、替代速率与最大内存。
- **Kill criterion：** 单个 Artifact 能越过 10 秒硬上限占用 Host，连续 Host 故障导致 API 不可响应，或无界 Queue 在目标流量下超过内存 / API Deadline。
- **Cheapest test：** 当前无限循环为 100ms，要求 1.1 秒内返回且新 PID 成功；下一步先加总请求 Deadline、Queue 上限与并发 2×Pool Size 的小负载测试。
- **处理：** 单进程生命周期 CLOSED；Queue Backpressure / Memory / Linux 容量 OPEN。

### 5. v1 私有 RPC 可以安全滚动升级而不发生静默降级（72）

- **Claim：** Coordinator 与 Host 协议不一致时明确失败，而不是忽略字段或猜测旧语义。
- **Steelman：** Envelope 每层使用精确字段集合，协议和版本固定，未知消息 / Error Code / 额外执行选择器被拒绝；READY 握手验证 Child PID。
- **Fails if：** 部署先后顺序让不同版本长期混跑，Breaking Change 未提升版本，或 IPC 入口在 JSON Size 校验前接受不受控大消息并被当作外部边界暴露。
- **Evidence to get this week：** 用旧 Coordinator / 新 Host 和新 Coordinator / 旧 Host 各跑一次 Rolling Matrix；不兼容组合必须在 READY / 首次调用前失败并触发可观测部署回滚。
- **Kill criterion：** 不兼容版本仍执行 Artifact，新增字段被静默忽略，或私有 IPC 被暴露为跨网络公共 API。
- **Cheapest test：** 当前 `protocol.ts:123-241` 与 `protocol.test.ts:23-57` 验证版本 / 精确字段；Production 发布前增加两版二进制兼容矩阵。
- **处理：** 单版本 Protocol CLOSED；Rolling Upgrade Matrix OPEN。

## Intended vs. Implemented 审查

| 已记录意图                                           | 审查前实际                                                                                         | 边界影响                                           | 修正与证据                                                                                                            | 状态                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 输入与输出都按登记 Schema 独立校验                   | Query 与 Capability Probe 最初共用一个按字段猜方向的 Schema，输入形状可能作为输出通过              | Handler 可返回不符合公开 Result Contract 的值      | `catalog.ts:21-27, 226-297` 拆分 Input / Output Schema；`protocol.test.ts:84-95` 固定反例                             | CLOSED                                      |
| 只接受 JSON Object 且不能污染 Prototype              | `requireJsonObject` 最初可把 Array 强转为 Object；普通赋值处理 `__proto__` 会改变结果对象原型      | 类型边界不准确，未来宽 Schema 可能继承攻击者对象   | `protocol.ts` 先验证 Plain Object，再用 own data property 构造；`protocol.test.ts:53-56, 98-104`                      | CLOSED                                      |
| Protocol / Version 不匹配使用稳定错误                | 最初全部映射为 `INVALID_INVOCATION`                                                                | Rolling Deploy 无法区分数据错误与版本错误          | 新增 `ProtocolMismatchError`，Host 映射 `PROTOCOL_MISMATCH`；版本负例 `protocol.test.ts:41-44`                        | CLOSED                                      |
| Registry 是只读部署事实                              | TypeScript 只有 `readonly` 类型，运行时 Registration / Query Array 最初仍可修改                    | Host 内误修改可改变后续执行能力                    | `catalog.ts:108-112` 对条目、Query Array 和 Registry 冻结；测试 `protocol.test.ts:63-66`                              | CLOSED（Fixture）                           |
| 默认拒绝网络                                         | 初版覆盖 fetch / HTTP / TCP / TLS / UDP / DNS，但漏掉 HTTP/2，测试也只打到 fetch                   | 受信任 Artifact 仍可能意外从另一常用入口出站       | `network-guard.ts` 加 HTTP/2；Capability Probe 覆盖 fetch、HTTP/1、HTTP/2、TCP、TLS、UDP、DNS；`pool.test.ts:128-149` | CLOSED（应用护栏）/ OPEN（部署 Egress）     |
| Host 只读自身文件，不得创建子执行环境                | 初版只自动验证文件写入与子进程，没有验证目录外读取和 Worker                                        | 错配 Permission 参数可能读取主机文件或绕过进程预算 | Capability Probe 增加 `/etc/hosts` 读取和 Worker，均返回 `SYSTEM_CAPABILITY_DENIED`                                   | CLOSED（Node seam）/ OPEN（容器）           |
| Secret 不进入 Host 环境                              | 启动代码从零构造 4 项白名单；测试在父进程真实注入 DB / S3 / OIDC / Registry / npm Secret           | 继承父环境会跨越平台信任边界                       | `launch.ts` 白名单；`pool.test.ts:11-75` 子进程返回 Secret Presence 为空                                              | CLOSED                                      |
| Context 拒绝未声明 Query 与 Read Set 扩大            | 实现同时核验 Manifest、Invocation、Object、Property、Query Result 和 Read Budget，并只返回冻结投影 | 缺一层会泄露调用者无权数据                         | `context.ts:26-98`；直接与真实 Host 反例 `context.test.ts` / `pool.test.ts:77-126`                                    | CLOSED（Fixture）/ OPEN（真实 Policy Port） |
| 无限循环由父进程硬终止，Host 代际不复用              | `Promise.race` 未使用；父进程 Timer 销毁 Child 并补新 PID                                          | 同进程软超时会继续占用 CPU / 修改全局状态          | `pool.ts:398-435`；100ms 无限循环与新 PID 调用 `pool.test.ts:167-186`                                                 | CLOSED                                      |
| Host kill / replacement 竞态不会误报健康             | 初版 `killOneForTest` 在 exit 事件到达前可能把旧 PID 当作健康，且 Context 部分错误同步抛出         | 故障注入偶发失败，调用合同不稳定                   | 健康条件排除旧 PID；Query 统一返回 Promise rejection；专项测试稳定通过                                                | CLOSED                                      |
| Replacement 启动失败时不无限积压                     | 初版替代启动失败只拒绝当时 Queue，后续调用仍可能进入无 Worker Queue                                | 故障状态可累积请求直至内存耗尽                     | Pool 保存 fatal 状态，未来调用 fail closed，显式 restart 后清除                                                       | CLOSED（失败语义）/ OPEN（重试策略）        |
| 这是 trusted deployment boundary，不是恶意多租户沙箱 | ADR 明确排除恶意 Native / Runtime Escape / 用户上传，并要求需求变化时改用 Container / MicroVM      | 错误产品声明会让应用护栏承担做不到的攻击面         | ADR §2、§5、§9–10；Production Gate 必须验证实际部署文案和策略                                                         | CLOSED（声明）                              |

修正后没有仍未关闭、且属于 G2-00-07 seam proof 范围的 Intended-vs-Implemented 漂移。所有 OPEN 项均需要真实 Policy / Function / Action / Linux Deployment 证据，不能在 G2-00-07 Evidence 中写成已完成。

## What's Well-Reasoned

- 把 Artifact 执行从 API 进程移出，硬超时可以杀代际而不是依赖 cooperative cancellation；
- Host 完全没有 DB 身份，避免“只读账号”成为绕过 Object / Property Policy 的另一条 Query 路径；
- Digest、Revision、Schema、Query 能力、Read Budget 与 Timeout 同时登记，请求只能缩小不能扩大；
- Context 使用 Runtime 已授权的最小 Query Result，逐 Property 再投影，且 Handler 看不到 Repository 或 Action Dispatcher；
- 网络应用护栏与 Production Egress Policy 的责任被明确分开，没有把 Node Permission Model 误称为网络沙箱；
- Timeout / Host Exit 后不复用进程，避免残留异步任务和全局状态污染下一次调用；
- 错误跨 RPC 只返回稳定 Code 和安全消息，原始异常与 Stack 留在 Host 内且当前不输出。

## What I Couldn't Assess

- Production Artifact Bundle 是否覆盖编译输出、依赖锁、Manifest、Node ABI 与签名，以及 Promotion / Rollback 审计；
- Linux 镜像的只读 RootFS、非 root、Service Account、Secret Volume、NetworkPolicy / 防火墙、seccomp / AppArmor 和 CPU / Memory / PID 限制；
- 真实 Query Application Port 是否先执行同一 Policy Gateway，再构造最小 Query Result；
- Action Preflight / Apply 是否固定 Read Set、稳定排序加锁、拒绝扩大 Write Set，并把 Mutation Plan 交回 Runtime 二次验证；
- IPC 大消息在 Node Decode 前的内存成本、Pool Queue 上限、总请求 Deadline、取消传播、重启风暴和目标负载；
- Rolling Deploy 的两版协议矩阵、Telemetry Redaction、Host Health / Replacement 告警与长期运行资源泄漏；
- OOM、Native Addon、Runtime 漏洞或主动修改全局对象的恶意 Artifact；这些明确不属于当前 trusted code seam 的安全声明。

下一步先生成 G2-00-07 clean-room Evidence。进入真实 Function / Action / Deployment Gate 时，优先验证前三项 Kill-Assumption；任一失败都停止 Handler 集成并修改 ADR / 部署边界，不退回 API 同进程加载，也不扩大“沙箱”宣传。
