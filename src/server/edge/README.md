# 边缘转发实例（Edge Relay）

本地只做两件事的轻量实例：**模型转发（/v1）** 和 **使用日志**。
配置一律在服务器上改，本地只从服务器拉取，**不向服务器写任何数据**。

## 它和主服务的区别

- 不启动任何调度器：没有签到、重登、余额刷新、模型采集、公告轮询、WebDAV 备份。
  这条约束由 `edgeBoundary.architecture.test.ts` 静态锁死。
- 自带数据目录与端口，绝不共用主服务的数据目录（闸门会拒绝 `DATA_DIR=./data`）。
- 只监听 `127.0.0.1`，不对外暴露。
- 日志只写本地库，不上报服务器。
- 自带打包好的前端，但只显示两个页面：**模型转发**与**使用日志**；
  登录页下方可以直接填服务器地址与端口（见下一节）。

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
| `AUTH_TOKEN` | 是 | 本地管理令牌。想和服务器用同一个登录密码，就填服务器的那个值 |
| `METAPI_EDGE_CONFIG_SOURCE_URL` | 否 | 服务器地址兜底值（设置表里没配时才用；exe 在登录页填） |
| `METAPI_EDGE_CONFIG_SOURCE_TOKEN` | 否 | 服务器 `AUTH_TOKEN` 的兜底值（同上；正常走登录写入的设置） |
| `METAPI_EDGE_CONFIG_SYNC_INTERVAL_MS` | 否 | 自动同步间隔，默认 5 分钟，最小 30 秒 |
| `ACCOUNT_CREDENTIAL_SECRET` | 否 | 与服务器保持一致最省事（本地不做重登，不一致也能跑） |

启动（用 `DOTENV_CONFIG_PATH` 指向配置文件）：

```powershell
$env:DOTENV_CONFIG_PATH=".env.edge"; npm run edge
```

也可以用编译产物启动：`npm run build:server` 后执行 `npm run edge:start`。

## 登录与同步设置

同步源只有两处，都存在本地设置表里，**exe 不需要环境变量也能跑**：

- 服务器地址：设置键 `edge_sync_source_url`。
- 管理员令牌：设置键 `auth_token` —— 它同时就是本地 `/api/*` 的登录令牌，
  所以「登录 exe 的密码」和「服务器上的管理员令牌」是同一个值。

登录页（以及登录后的「同步设置」弹窗）拿到地址和令牌后，会先用一个 GET
探针 `/api/settings/auth/info` 到服务器验一次；验过了才写入设置表并热加载，
失败则原样把原因显示在页面上。登录成功后会自动同步一次，之后每 5 分钟拉一次。

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
3. `data-edge/hub.db` 里 `proxy_logs` 的行数：本地有日志就说明请求确实由本机处理。

## 已知限制

- 有 Cloudflare 盾的站点会在本地 403：`cf_clearance` 绑定服务器出口 IP 与 UA，本地过不了盾。
- `SITES_REQUIRING_SYSTEM_PROXY` 里的域名在服务器上靠本地代理出去，本地需要能直连或自行配代理，
  否则表现为超时或断流。
- 不要在本地放 OAuth（codex / gemini 这类 plan）账号：令牌刷新会写本地库，服务器那边不知道。
- 本地库只是镜像：本地新建的站点 / 账号 / 路由会在下次同步时被清掉，配置请一律在服务器上改。
- 本地日志不会自动清理（不跑保留策略），长期使用需要手动清理或删库重建。
- 下游密钥的已用额度是两边各自累计的，本地用量不会同步回服务器。
