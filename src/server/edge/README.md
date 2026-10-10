# 边缘转发实例（Edge Relay）

本地只做两件事的轻量实例：**模型转发（/v1）** 和 **使用日志**。
配置一律在服务器上改，本地只从服务器拉取，**不向服务器写任何数据**；
唯一的例外是本机的「先用哪个源」——转发顺序与启停可以只在本机调（见下节）。

## 它和主服务的区别

- 不启动任何调度器：没有签到、重登、余额刷新、模型采集、公告轮询、WebDAV 备份。
  这条约束由 `edgeBoundary.architecture.test.ts` 静态锁死。
- 自带数据目录与端口，绝不共用主服务的数据目录（闸门会拒绝 `DATA_DIR=./data`）。
- 只监听 `127.0.0.1`，不对外暴露。
- 从服务器同步下来的配置只放在内存库（`DB_URL=:memory:`）里，不落本地磁盘；
  本机产生的使用日志归档到数据目录下的 `edge-logs.db`，不上报服务器。
- 自带打包好的前端，但只显示两个页面：**模型转发**与**使用日志**；
  登录页下方可以直接填服务器地址与端口（见下一节）。
- 模型转发在本地是**服务器的镜像**：规则的增 / 删 / 改仍然只能在服务器上做，
  但**顺序（置顶 / 上移 / 下移）与启用 / 停用**可以只在本机调，改完立刻对本机转发生效。
  这不是回写服务器：本地改动存在 `edge-logs.db` 里，服务器上的规则一变就以服务器为准（见下节）。

## 为什么要这么做

服务器上行带宽有限，大上下文请求的首字节时间被「上传请求体」拖掉好几秒；
把请求体改从本机出口上传，这几秒就消失了。转发之外的活必须留在服务器，
所以这里只做转发。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `METAPI_EDGE_MODE` | 是 | 必须为 `1` / `true` / `yes` / `on`，否则拒绝启动 |
| `DATA_DIR` | 是 | 独立数据目录，例如 `./data-edge`，不能是 `./data` |
| `HOST` | 是 | 必须是 `127.0.0.1` |
| `PORT` | 是 | 建议 `30086`，不要占用主服务默认的 4000 |
| `AUTH_TOKEN` | 否 | 登录前本地 `/api/*` 的默认令牌；exe 走登录页，不用配 |
| `METAPI_EDGE_CONFIG_SYNC_INTERVAL_MS` | 否 | 自动同步间隔，默认 5 分钟，最小 30 秒 |
| `ACCOUNT_CREDENTIAL_SECRET` | 否 | 与服务器保持一致最省事（本地不做重登，不一致也能跑） |

启动（用 `DOTENV_CONFIG_PATH` 指向配置文件）：

```powershell
$env:DOTENV_CONFIG_PATH=".env.edge"; npm run edge
```

也可以用编译产物启动：`npm run build:server` 后执行 `npm run edge:start`。

## 登录与同步设置

同步源只有两处，**exe 不需要环境变量也能跑**：

- 服务器地址：数据目录下的 `edge-connection.json`（本机连接参数，登录页要回填）。
- 管理员令牌：内存库里的设置键 `auth_token` —— 它同时就是本地 `/api/*` 的登录令牌，
  所以「登录 exe 的密码」和「服务器上的管理员令牌」是同一个值。令牌不落盘，
  进程重启后要重新登录。

登录页（以及登录后的「同步设置」弹窗）拿到地址和令牌后，会先用一个 GET
探针 `/api/settings/auth/info` 到服务器验一次；验过了才写入设置表并热加载，
失败则原样把原因显示在页面上。登录成功后会自动同步一次，之后每 5 分钟拉一次。
启动时不拉配置：内存库是空的，登录前也没有服务器令牌。

## 配置只驻内存，日志留在本地 SQLite

工作库是内存库，`db/index.ts` 打开库和 `runSqliteMigrationsOn()` 建表都发生在同一条连接上：
内存库只存在于创建它的那条连接里，换一条连接建表等于建到别的临时库里。
同步只拉三段（账号与站点、设置、模型转发规则），导入即整段替换，进程退出全部消失。

使用日志不能跟着丢，所以 `logArchive.ts` 把 `proxy_logs` 的行镜像到
`DATA_DIR/edge-logs.db`：每秒把内存里新增的日志搬进归档库，启动时和每次导入配置之后
再把归档读回内存（导入账号会重建站点/账号并级联删除日志）。归档表由主库那张表 CTAS 生成，
列清单按主库 schema 生成、缺列自动补，读回来时临时关外键——历史日志引用的账号可能早就删了。
日志列表仍然查内存库那张真实的 `proxy_logs`，跟账号、站点做 join 的查询一行都不用改。

exe 的登录页会回填默认服务器 `43.142.48.105:81`（服务器 nginx 对外暴露的端口，
4000 从公网连不上），换服务器直接在界面里改，或者改 `src/web/edgeMode.ts` 里的
EDGE_DEFAULT_SERVER_HOST / EDGE_DEFAULT_SERVER_PORT。

管理接口一共四个：

| 接口 | 鉴权 | 作用 |
| --- | --- | --- |
| `GET /api/desktop/health` | 免 | 桌面壳探活 |
| `GET /api/edge/status` | 免 | 登录页读当前服务器地址、同步时间与错误 |
| `PUT /api/edge/sync-source` | 免（但要求令牌在服务器上验得过） | 保存服务器地址与令牌 |
| `POST /api/edge/sync` | 本地令牌 | 「同步」按钮，拉一次配置 |
| `POST /api/model-forward-rules/:id/enabled` | 本地令牌 | 本机启用 / 停用整条转发的规则 |
| `POST /api/model-forward-rules/:id/targets/:targetId/move` | 本地令牌 | 本机置顶 / 上移 / 下移（`{action:'top'\|'up'\|'down'}`） |
| `POST /api/model-forward-rules/:id/targets/:targetId/enabled` | 本地令牌 | 本机启用 / 停用某个转发目标 |
| `POST /api/edge/model-forward-local-edits/reset` | 本地令牌 | 「恢复服务器顺序」：丢掉本机改动并重新拉一次服务器快照 |

## 本机的转发顺序 / 启停（只对本机生效）

顺序与启停是「**这台机器先用哪个源**」的开关，所以放在本地调：页面上点置顶 / 上移 / 下移 /
停用，改的是本地内存镜像里的 `model_forward_targets.sort_order / enabled`，随后立刻同步到
`route_channels.priority / enabled` 并失效路由器缓存 —— 下一次请求就按新顺序走，不用重启。

冲突处理只有一个规则：**永远以服务器为准**。

- 本机改动记在 `edge-logs.db` 的 `edge_settings`（键 `edge_forward_local_edit`），
  同时记下它基于的服务器快照指纹（键 `edge_forward_source_hash`，每次成功同步刷新）。
- 下次同步指纹**没变** → 把本机改动盖回镜像并重排通道（快照导入只写 targets，通道优先级要在这里补齐）。
- 下次同步指纹**变了**（服务器改过模型转发规则）→ 本机改动**整份作废**，按服务器那一版重排。
- 「恢复服务器顺序」＝ 清掉本机改动 + 强制重新导入一次服务器快照；服务器不可达时接口会如实报失败，
  不会假装成功（本机改动已经清掉，下一次同步成功就会回到服务器顺序）。

## 客户端怎么接

## 打包 Windows exe

```powershell
npm run dist:desktop:edge
```

产物在 `release/edge/`：`metapi-edge-<版本>-win-x64.exe`（安装包，装完是「Metapi Edge」）
和同名 `.zip`（免安装，解压后跑 `win-unpacked/Metapi Edge.exe`）。

打包前由 `scripts/desktop/packEdgeDesktop.mjs` 换掉原生模块：边缘实例的服务进程跑在
Electron 自带的 Node 上（`ELECTRON_RUN_AS_NODE`），better-sqlite3 必须换成 Electron ABI
的预编译二进制，而 electron-builder 自带的 @electron/rebuild 还不认识 Electron 42 的
ABI（146）、会直接报「无法探测 ABI」。所以这个脚本按 ABI 取官方预编译包、临时替换，
打包结束后还原 node ABI 版本（本地 `npm run dev` / vitest 还要用它）；
`electron-builder.edge.yml` 里对应关掉 `npmRebuild`。

下游密钥会随配置一起拉下来，所以本地实例接受和服务器同一把 `sk-` 密钥，
只需要改客户端的 `base_url`：

```
http://127.0.0.1:30086/v1
```

建议只把「大上下文」的客户端指到本地，其余继续用服务器地址；
这样本地实例出问题时只影响一个客户端。

## 排错先看三处

1. `GET /api/edge/status`：看 `configSource.url` / `lastSyncAt` / `lastSyncError` / `lastSyncSections`。
2. 启动日志里的数据目录绝对路径：确认不是主服务的目录。
3. `data-edge/edge-logs.db` 里 `proxy_logs` 的行数：本地有日志就说明请求确实由本机处理。

## 已知限制

- 有 Cloudflare 盾的站点会在本地 403：`cf_clearance` 绑定服务器出口 IP 与 UA，本地过不了盾。
- `SITES_REQUIRING_SYSTEM_PROXY` 里的域名在服务器上靠本地代理出去（agentrouter.org、anyrouter.top 这类）。
  边缘实例不照抄服务器那份 `system_proxy_url`（它指向服务器本机的代理），而是读本机 Windows
  系统代理的地址；本机没开代理时这些域名会超时或断流。
- 不要在本地放 OAuth（codex / gemini 这类 plan）账号：令牌刷新会写本地库，服务器那边不知道。
- 配置只在内存里：本地新建的站点 / 账号 / 路由会在下次同步时被清掉，配置请一律在服务器上改；
  关掉 exe 就等于清空，重新打开要重新登录。仅有的例外是本机的转发顺序 / 启停（存在 `edge-logs.db`，
  重启还在），但服务器改过模型转发规则后它也会被清掉。
- 归档里的日志不会自动清理（不跑保留策略）；内存里最多读回 10 万条，
  长期使用需要手动清理 `edge-logs.db`。
- 下游密钥的已用额度是两边各自累计的，本地用量不会同步回服务器。
