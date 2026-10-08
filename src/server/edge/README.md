# 边缘转发实例（Edge Relay）

本地只做两件事的轻量实例：**模型转发（/v1）** 和 **使用日志**。
配置一律在服务器上改，本地只从服务器拉取，**不向服务器写任何数据**。

## 它和主服务的区别

- 不启动任何调度器：没有签到、重登、余额刷新、模型采集、公告轮询、WebDAV 备份。
  这条约束由 `edgeBoundary.architecture.test.ts` 静态锁死。
- 自带数据目录与端口，绝不共用主服务的数据目录（闸门会拒绝 `DATA_DIR=./data`）。
- 只监听 `127.0.0.1`，不对外暴露。
- 日志只写本地库，不上报服务器。

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
| `METAPI_EDGE_CONFIG_SOURCE_URL` | 否 | 服务器地址，例如 `https://你的域名` |
| `METAPI_EDGE_CONFIG_SOURCE_TOKEN` | 否 | 服务器的 `AUTH_TOKEN`，用于拉取配置 |
| `METAPI_EDGE_CONFIG_SYNC_INTERVAL_MS` | 否 | 自动同步间隔，默认 5 分钟，最小 30 秒 |
| `ACCOUNT_CREDENTIAL_SECRET` | 否 | 与服务器保持一致最省事（本地不做重登，不一致也能跑） |

启动（用 `DOTENV_CONFIG_PATH` 指向配置文件）：

```powershell
$env:DOTENV_CONFIG_PATH=".env.edge"; npm run edge
```

也可以用编译产物启动：`npm run build:server` 后执行 `npm run edge:start`。

## 客户端怎么接

下游密钥会随配置一起拉下来，所以本地实例接受和服务器同一把 `sk-` 密钥，
只需要改客户端的 `base_url`：

```
http://127.0.0.1:30086/v1
```

建议只把「大上下文」的客户端指到本地，其余继续用服务器地址；
这样本地实例出问题时只影响一个客户端。

## 排错先看三处

1. `GET /api/edge/status`（带本地 `AUTH_TOKEN`）：看 `lastSyncAt` / `lastSyncError` / `sections`。
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
