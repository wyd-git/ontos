# G2-02-04 Managed CSV Ingress Red Team

- 日期：2026-08-15
- 方法：先把本项钢人化为“外部字节进入不可变 Snapshot 的唯一受管入口”，再攻击存储注入、身份、完整性、流式上界、并发、崩溃恢复、清理和证据夸大
- 结论：**G2-02-04 可 PASS；只放行 G2-02-05。Mapping、Object Identity、真实物化、吞吐基线、Cutover 与 GC 仍保持 OPEN**

## 1. 上传接口变成 SSRF、路径穿越或凭据转发器

**攻击**：客户端若能提交 Endpoint、Bucket、Key、URL、相对/绝对路径或 Credential，就能让 API 读取任意网络与文件资源；即使字段“暂时不用”，宽松 JSON 也会留下未来旁路。

**证据**：创建、上传和 Finalize 命令均拒绝未知字段；对象 Key 只由服务端 UUID 生成且必须匹配固定 `ingress/<shard>/<uuid>.csv`；S3 Endpoint、Bucket 和 Credential 只来自进程配置。真实 HTTP 负测提交 Bucket 后稳定返回 `ADMIN_REQUEST_INVALID`，响应不包含内部 Endpoint、Key 或 Secret。

**结论**：CLOSED。部署仍必须保证该 Bucket Credential 只授予 Ontos 服务，不与用户共享。

## 2. 猜到 Session ID 即可越权上传或完成别人的 Snapshot

**攻击**：UUID 不是授权。若只按 Session ID 查找，另一个已登录用户可覆盖对象或用自己的 Project 权限完成他人的会话。

**证据**：Session 绑定创建 Principal、Project、Release 和 Runtime Member；上传按 `session_id + created_by_principal_id` 读取，再重验 `metadata.edit`；Finalize 同时校验 Actor、完整成员集合与 256-bit Token 的服务器 SHA-256。外部只收到一次 Token，数据库不保存明文；真实 OIDC outsider 返回不可区分的 404。

**结论**：CLOSED。

## 3. 客户端 Hash、最新对象或截断流污染服务器事实

**攻击**：客户端自报 Hash 可能伪造；上传后再写一个同 Key 版本会制造 TOCTOU；声明长度和实际流不一致可能留下半对象或把错误版本注册。

**证据**：上传记录 S3 返回的精确 Version ID；Finalize 在扫描前后都读取 latest metadata，并按记录 Version ID 精确 GET，服务端流式重算 SHA-256、字节数和行数。客户端 Digest 只比较。真实 S3 测试覆盖新版本篡改、错误长度、客户端半程断线、Storage 停止/恢复和同 Session 完整重试；任何失败都不写 uploaded/finalized 事实。

**结论**：CLOSED。

## 4. “流式”实现仍可被一行或一个字段打爆内存

**攻击**：只要 Parser 为引号字段、Header 或错误样本无限累积，512 MiB 文件仍能让 Node Heap 失控；压缩炸弹和伪装格式可绕过字节上限。

**证据**：Scanner 增量解码并只保留当前字段/记录；文件 512 MiB、行数 10m、列 512、字段 1 MiB、记录 8 MiB、Header 128 bytes 均有编译硬上限。BOM、UTF-8、CRLF/LF、引号、转义、NUL、重复/错序 Header、截断、gzip/zip/Parquet 特征和错误列数均有固定负测；响应不反射单元格或 Header 内容。

**结论**：CLOSED for bounded memory。512 MiB/10m 是拒绝上界，不是已证明的吞吐 SLO。

## 5. 多成员 Snapshot Group 只完成一半却对外可见

**攻击**：逐文件注册会让同一 Group Version 出现部分 Snapshot；重试后还可能混入不同 Release、Schema 或 Group Version。

**证据**：创建会话从 `ready|published` Release 的不可变 Runtime Plan 复制 Member、Schema、Mapping 和 Plan Digest；Finalize 在数据库锁内要求提交的 Member Key 精确覆盖该组。Group Version、全部 Dataset Snapshot、File、Group Member 和 Session Pointer 在一个 PostgreSQL 事务提交，任一约束失败整组回滚。

**结论**：CLOSED。

## 6. 长扫描超过 5 分钟，活跃 Finalize 被错误接管

**攻击**：固定 5 分钟 Lease 对 512 MiB 文件或多成员组不足；旧请求和接管请求可能同时计算并争抢提交。

**证据**：最终审查增加数据库 Lease 续期：每个成员开始/扫描完成时续期，流式扫描期间用进程单调时钟每 60 秒调度、以 PostgreSQL 时间作为租约权威并按原子 Claim 续期；Trigger 只允许同 Claim 延长。进程崩溃会停止续期，过期 Claim 可回收；旧 Claim 无法完成事务。单测用推进时钟验证流中续期，真实 PG/S3/HTTP 测试验证过期 Claim 在 API 重启后回收并成功生成下一 Group Version。

**结论**：CLOSED。

## 7. 并发 Finalize、响应丢失和 API 重启产生两个 Snapshot

**攻击**：两个请求都通过扫描后可能各自写一个 Snapshot；提交成功但响应丢失时重试又生成新 ID。

**证据**：数据库 Claim 是唯一赢家；活跃 Claim 返回稳定冲突。已 Finalized 的同 Actor/Token 请求从注册事实重建并返回同一 Group/Snapshot，不重新生成 ID。真实并发请求只产生一组数据库事实；API 关闭重启后的重放与赢家 JSON 完全一致。

**结论**：CLOSED。

## 8. 清理任务误删已注册版本或永远留下垃圾

**攻击**：只按 Key 删除会删掉 Snapshot 正在引用的历史版本；只清理“当前版本”又会留下断线上传、覆盖版本和 Delete Marker。

**证据**：清理分页列出该随机 Key 的全部 Versions/Delete Markers；Finalized Session 保护唯一注册 Version，只删除其余版本，未完成/失败/过期 Session 在有界保留后删除全部版本。清理完成状态由数据库受控转换记录。真实重启测试先注入孤儿新版本，再确认后台清理只保留已注册版本。

**结论**：CLOSED for G2-02-04。跨代数据 GC 仍由 G2-02-12 持有。

## 9. 错误与日志把内容、Token、Key 或依赖细节带出边界

**攻击**：AWS SDK、CSV Parser、PostgreSQL 或 Node Socket 的原始异常通常包含 Endpoint、Key、Header、SQL 或输入片段。

**证据**：Object Store 使用静默 Logger；应用只映射六个固定公开错误码与固定消息；HTTP Envelope 不包含底层 Cause。Handler Boundary 与真实故障响应扫描 Object Key、Version、Token、Secret、Endpoint 和连接错误；CSV 错误不保存/反射单元格、PK 或自由文本样本。

**结论**：CLOSED for emitted API/log data。统一业务 Metric/Trace 仍在后续可观测性工作中，不得加入高基数字段。

## 10. 小 Fixture 通过被误写成完整生产物化通过

**攻击**：两行 CSV 的真实 S3/PG 测试可以证明协议与故障语义，却不能证明 100k Object/1m Link、Mapping、Identity、WAL、Heap、索引、30 分钟目标或查询可服务。

**证据**：本项只注册受管 Snapshot/File，不执行 Mapping 或写 Shared Projection；Evidence 明确限制结论。G2-02-05 必须证明确定性流式 Mapping，G2-02-06 首次跑 10k/100k 数据薄切片，G2-02-14 才跑 100k/1m 最终验收与恢复矩阵。

**结论**：OPEN，Owner 为 G2-02-05/06/14；不阻塞当前受管 Ingress Gate。

## 11. 排序后的失败模式

| 排名 | 失败模式                               | 影响 | 可能性 | 当前处理                                                |
| ---: | -------------------------------------- | ---: | -----: | ------------------------------------------------------- |
|    1 | 客户端控制存储位置/凭据形成 SSRF       |    5 |      2 | 严格命令 + 服务端 Key/配置，CLOSED                      |
|    2 | 非精确版本或客户端 Hash 成为服务器事实 |    5 |      3 | Version ID + 前后 Head + 服务端流式摘要，CLOSED         |
|    3 | 部分 Group 被注册并对后续运行可见      |    5 |      2 | 完整成员锁定 + 单 PG 事务，CLOSED                       |
|    4 | 长扫描 Lease 过期造成双 Finalize       |    5 |      3 | 60 秒续期 + 过期回收 + 旧 Claim 拒绝，CLOSED            |
|    5 | CSV 内存/压缩炸弹拖垮 API              |    5 |      3 | 流式 Parser + 多维硬上限 + 格式特征拒绝，CLOSED         |
|    6 | 清理删除已注册对象版本                 |    5 |      2 | 精确 Version 保护 + 真实重启清理，CLOSED                |
|    7 | 最终 100k/1m 不能在目标机器运营        |    5 |      4 | 无吞吐宣称；OPEN to G2-02-05/06/14                      |
|    8 | 不同 S3-compatible Provider 语义差异   |    4 |      3 | SeaweedFS + 精确合同已测；Provider Matrix OPEN to 02-14 |

## 12. 放行结论

没有触发任意路径/URL/Bucket、客户端权威 Hash、非版本化对象、整文件缓冲、部分组注册、明文 Token 或秘密泄漏的停止条件。G2-02-04 可以 PASS，下一项只能是 G2-02-05 确定性 Mapping 编译与流式执行；不得从本结论跳到“完整产品”或“完整生产物化闭环”。
