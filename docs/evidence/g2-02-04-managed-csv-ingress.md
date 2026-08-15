# G2-02-04 受管 UTF-8 CSV Snapshot Ingress Evidence

- 日期：2026-08-15
- 结论：**PASS**（只代表 G2-02-04 受管 Ingress Gate；不代表 Mapping、Object Identity、Shared Projection、Worker、Cutover/GC、100k Object/1m Link 或整个 G2-02 已完成）
- 任务合同：[G2-02 Materialization 任务包 § G2-02-04](../delivery/g2-02-materialization-task-pack.md#g2-02-04实现受管-utf-8-csv-snapshot-ingress)
- 边界合同：[Managed UTF-8 CSV Ingress](../architecture/managed-csv-ingress.md)
- 专项红队：[G2-02-04 Red Team](../reviews/g2-02-04-managed-csv-ingress-red-team.md)
- 运维入口：[Admin API Operations](../operations/admin-api.md)

## 1. 实际交付

本项增加四个分层包和一个前向 Migration，不建立第二套数据库或对象存储入口：

| 组件                                 | 责任                                                                                | 明确不做                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| `@ontos/materialization-domain`      | 增量 UTF-8/CSV 物理扫描、Header/行列与多维硬上限                                    | Schema 推断、Mapping、业务值转换             |
| `@ontos/materialization-application` | Session/Token、受管上传、精确版本 Finalize、Group 原子注册、重试/清理               | 任意 URL/路径/Bucket、客户端权威 Hash        |
| `@ontos/object-store-s3`             | S3 Versioning 启动检查、精确 Version PUT/HEAD/GET/LIST/DELETE、精确长度流           | Presigned URL、用户 Credential、非版本化降级 |
| `@ontos/materialization-postgres`    | Session 状态机、Claim/续租/回收、Group/Snapshot/File 单事务提交                     | DDL、历史 Migration 改写、物化 Worker        |
| `0010_managed_csv_ingress.sql`       | `snapshot_upload_sessions`、File 扫描事实、不可变/转换 Trigger、最小 Grant/Ops View | 修改 0001～0009 或创建新 Migration 账本      |

Admin API 新增三个受 OIDC 与 Project RBAC 保护的入口：创建上传 Session、流式上传内容、Finalize Snapshot Group。运行时在监听前检查 Bucket Versioning，后台有界清理孤儿版本，关闭时等待清理任务退出。

## 2. Acceptance 对照

| 要求                                             | 实现与可执行证据                                                                                                                                                 | 结论                                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Actor/Project/媒体/大小/过期/随机 Key/Token 绑定 | Session 从 `ready                                                                                                                                                | published` Release Runtime Plan 派生不可变事实；服务端 UUID Key；Token 只存 SHA-256；严格 JSON 拒绝 Bucket/Host/Path/Credential | PASS |
| 服务端重新读取并计算事实                         | 记录 S3 Version ID；Finalize 前后核对 latest，精确 GET 记录版本；流式重算 SHA-256、bytes、rows；客户端 Digest 只比较                                             | PASS                                                                                                                            |
| CSV 固定语义与资源上界                           | 14 个 Domain/Application tests 覆盖 BOM、UTF-8、CRLF/LF、引号、转义、NUL、Header、列数、截断、伪装格式和文件/行/列/字段/记录上限                                 | PASS                                                                                                                            |
| 不存在/版本变化/过期/重复/响应丢失/重启          | 稳定错误映射；数据库 Claim + 5 分钟续租/回收；已完成请求从数据库重建同一结果；真实 API 重启前后 JSON 相同                                                        | PASS                                                                                                                            |
| Snapshot/File 不可变事实                         | 一个 PostgreSQL 事务写 Group Version、Snapshot、File、Member 与 Session Pointer；File 只保存受管 Artifact/Version、Digest、Size、Rows、scan status、Source Label | PASS                                                                                                                            |
| 有界清理且保护注册版本                           | `<=24h` 未完成保留；分页删除未注册 Versions/Delete Markers；注册版本加入保护集合；真实重启清理只留下被 File 引用的 Version                                       | PASS                                                                                                                            |
| 真实 S3/PG/HTTP 故障闭环                         | 真实 OIDC、PostgreSQL 16、SeaweedFS Versioning 覆盖半程断线、S3 停止/恢复、版本篡改、并发 Finalize、Lease 过期、API 重启、响应重放                               | PASS                                                                                                                            |
| 内容与秘密不出 Error/Log                         | S3 SDK Logger 静默；六个固定公开错误；Handler Boundary 与真实响应负测不含内容、Key、Version、Token、Secret、Endpoint、SQL/连接错误                               | PASS                                                                                                                            |

## 3. 状态、并发与恢复边界

- `created → uploaded → finalizing → finalized` 是成功路径；失败/过期进入有界清理，Runtime 身份不能删除历史 Session。
- Finalize Claim 由 PostgreSQL 锁定完整 Group；进程单调时钟每 60 秒调度、PostgreSQL 时间决定租约有效性，每个成员前后再次续租。API Kill 停止续租，过期后新请求回收；旧 Claim 无法提交。
- 并发请求只有一个事务赢家。赢家提交但响应丢失时，同 Actor、同 Session、同 Token 重试返回数据库中同一 Snapshot ID、Digest、成员顺序和 JSON。
- S3 暂停或流中断只释放 Claim/保留 `created|uploaded` 可重试状态；CSV/内容不合法只终止对应 Session，其他成员不产生部分 Group。

## 4. Intended-vs-Implemented 复审与实际返工

对照任务合同、ADR-014、合同 Schema、Migration 和真实 Adapter 后，本项在 Gate 内关闭了这些实现差距：

1. Release Ingress 最初沿用了错误生命周期假设，改为只接受已有状态机中的 `ready|published`；
2. 多成员输入顺序会影响返回 Snapshot 顺序与重放，改为按 Code Point 确定性排序后注册；
3. 客户端坏 Token 与服务端随机数异常不能共用 400，拆成 Admin Invalid 与 Dependency Unavailable；
4. PostgreSQL query cancellation `57014` 不能伪装成参数冲突，改为 Dependency Unavailable；
5. S3 输入流异常不能被误报为长度不符，改为可重试 Dependency Unavailable；
6. Docker S3 重启后随机 Host Port 会变化，真实重启测试改为预留固定回环端口；
7. API 关闭与后台清理可能竞态，关闭流程改为等待在途清理；
8. 最终红队发现固定 5 分钟 Lease 不足以覆盖大文件/多成员扫描，补上数据库同 Claim 续租、Trigger 限制、流中 60 秒心跳和推进时钟测试；
9. 任务包要求的“上传中断”不能用“Storage 停机”代替，增加真实 HTTP 半程断线并验证同 Session 无污染重试。
10. 首次 GitHub CI 暴露独立 S3 Adapter 测试错误依赖已经运行的本地 Compose 端口；改为测试自行启动、等待并清理版本化 S3 容器，干净 Runner 不再依赖外部状态。

这些返工没有扩大产品范围，反而收紧了“外部字节只能经受管、可恢复、可审计入口成为 Snapshot”这一边界。

## 5. 验证结果

```text
npm run test:materialization-ingress
PASS — 14 tests

npm run test:materialization-ingress:integration
PASS — 2 real integration suites
       PostgreSQL 16 + versioned S3 + OIDC + streaming HTTP + fault/restart

npm run test:database
PASS — 6 PostgreSQL 16 integration suites，包含 0010 权限/状态/回滚

专用 x86_64 Ubuntu 24 / 8C16G 机器
PASS — typecheck / lint / architecture / 14 ingress tests / 7 admin tests
       / real PostgreSQL DB-02 integration

npm run verify
PASS — clean commit / 23 of 23 gates / 344 tests
       包含锁文件重装、格式、Lint、TypeScript、合同、架构、Supply Chain、
       PostgreSQL、OIDC、Metadata clean-room、真实 Versioned S3/Ingress 和 Production Boundary
```

整仓 Gate 必须在本 Evidence 对应的干净提交上通过，GitHub 必需检查也必须在 PR 最终 Head 上通过后才能合并。专项测试的两行 Fixture 用来证明协议、权限、并发与恢复语义，不是容量成绩。

## 6. 非结论与下一工作项

本项尚未解释 CSV 业务值、生成 Object RID、写 Object/Link Base/Current、运行 Worker、建索引、切换 Serving Head 或完成跨代 GC。因此：

- `512 MiB / 10m rows` 是输入拒绝上界，不是已证明的 SLO；
- `100k Object / 1m Link / 30 分钟` 仍只由 G2-02-14 最终验收；
- S3-compatible Provider 差异仍需最终 Provider Matrix；
- 已注册 Snapshot 在 S3 故障时数据库事实不变，但真正可查询的物化数据尚未实现。

G2-02-04 PASS 后只允许进入 G2-02-05：确定性 Mapping AST 校验/编译、公共 Value Codec、流式行执行与跨重启逐字节一致性。不得提前宣称完整生产闭环。
