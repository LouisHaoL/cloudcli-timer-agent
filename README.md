# cloudcli-timer-agent — CloudCLI 定时任务插件

[dsh-timer-agent](../dsh-timer-agent) 的 CloudCLI 插件移植版:把「Scheduled Prompt」(cloudcli-cron)换成一个**支持真正 5 段 cron** 的定时任务板。架构与 cloudcli-cron 同构(manifest.json + tab 客户端 + 常驻 server 进程),域模型与调度语义直接移植自 dsh-timer-agent 的零依赖 core。

## 它解决什么

Scheduled Prompt 只支持 daily/weekly/monthly 等预设枚举,**不支持 cron 表达式**;本插件恢复 dsh-timer-agent 的完整能力:

- **5 段 cron**(分 时 日 月 周,`*` / `*/n` / `a-b` / 逗号列表,day+weekday OR 语义)+ 新建/编辑页的预设下拉(每天 09:00 / 每小时 / 每 10 分钟 / 每周一 09:00 / 工作日 09:00 / 月初 10:00)
- **两种任务类型**:
  - **AI Agent 任务**(默认):到点把 prompt 喂给配置的 CLI(`{{prompt}}` 占位或 stdin 注入),支持每任务覆盖 CLI 命令/参数/超时
  - **普通任务(命令)**:到点直接 spawn `命令 + 参数`(不经过 AI、不消耗额度),stdout/stderr 尾部(≤16k 字符)与退出码入账
- **跳过一次**:详情页一键跳过下一个触发点,之后照常
- **执行历史**:每次触发的结果/耗时/输出尾部/错误原因(上限 200 条)
- **立即执行 / 暂停 / 恢复 / 归档 / 搜索**

> [!WARNING]
> **普通任务会在本机以当前用户权限执行任意命令,没有沙箱或白名单。** 台账 `~/.cloudcli-timer-agent/jobs.json` 可被篡改即等价于本机任意代码执行;HTTP API 仅监听 127.0.0.1 且无鉴权。只填你审查过的、无人值守安全的命令。

## 安装

```sh
# 方式一:作为插件市场添加(推荐)
claude plugin marketplace add LouisHaoL/cloudcli-timer-agent
claude plugin install cloudcli-timer-agent

# 方式二:clone 到 CloudCLI 插件目录后构建
git clone https://github.com/LouisHaoL/cloudcli-timer-agent ~/.claude-code-ui/plugins/cloudcli-plugin-timer-agent
npm install && npm run build

# 方式三:本目录已构建好,直接拷贝/链接到 ~/.claude-code-ui/plugins/ 即可
```

重启 CloudCLI,插件页出现「Timer Agent」标签即生效。

## 调度语义(继承 dsh-timer-agent)

- server 每 30s 一拍;**at-most-once**:先顺延 `nextRunAt` 再触发,崩溃不会重复触发
- **错过即跳过**:server 停机期间到点的任务不补跑(重启后仅执行已顺延到期的那一次)
- **固定间隔锚定上次触发**:`下次 = 上次触发 + N`;停机/暂停/长任务跨过的空窗按整间隔叠加到未来,网格永不漂移到"当前时间";**手动执行也算上次触发**(下次 = 手动时刻 + N)
- 任务运行中到点 → 跳过本次,等下一个 cron 匹配点
- cron 按本机本地时间解析

## Agent 任务的执行模型

- 执行档 = 任务级 `cli` 覆盖 → server 默认 profile(`~/.cloudcli-timer-agent/profile.json`,可用 `PUT /v1/profile` 写)→ 内置默认(`claude --print`)
- `args` 是模板:`{{prompt}}` / `{{workdir}}` / `{{title}}` / `{{taskId}}` / `{{session}}` / `{{scheduledFor}}`;**没有 `{{prompt}}` 占位时 prompt 走 stdin**
- 续聊(continuity):把 `args` 模板写成例如 `--print --resume {{session}}`,任务上填 `session` 字段
- 执行档与 prompt 里的 CLI 一律**用绝对路径**(插件 server 的 PATH 往往不全,如 `D:\env\nodejs\node.exe`)
- 默认超时 10 分钟,到点 SIGTERM 记为 cancelled;可按任务/按 profile 覆盖

## HTTP API(回环,server 随机端口,宿主经 rpc 代理访问)

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/v1/jobs` | 刷新并返回全部任务 |
| POST | `/v1/jobs` | 创建任务 |
| PATCH | `/v1/jobs/:id` | 更新(`{"skipNext":true}` = 跳过一次) |
| DELETE | `/v1/jobs/:id` | 删除 |
| POST | `/v1/jobs/:id/actions/{pause,resume,run-now,archive,restart}` | 操作 |
| GET/PUT | `/v1/profile` | server 默认 CLI 执行档 |

独立调试:`node dist/server.js`,stdout 首行 `{"ready":true,"port":N}`(cloudcli-cron 同款握手)。注意 host 实例与独立实例共用一份台账,**别同时跑两个**,避免重复触发。

## 结构

```
manifest.json          # CloudCLI 插件清单(slot: tab / entry / server)
src/
├── index.ts           # 客户端入口:mount/unmount(宿主契约)
├── types.ts           # PluginAPI / PluginModule(照 cloudcli-cron 契约)
├── shared/
│   ├── schedule.ts    # 5 段 cron 解析 + nextRunAt(移植自 dsh-timer-agent)
│   ├── jobs.ts        # 任务域模型 + 状态机(移植 + 跳过一次/触发来源)
│   └── command.ts     # 引号感知参数切分 + 输出截尾(移植)
├── server.ts          # server 入口:握手 + 30s ticker
├── server/
│   ├── store.ts       # ~/.cloudcli-timer-agent/jobs.json 原子写 + 损坏降级
│   ├── scheduler.ts   # at-most-once 调度 / runRequestedAt 手动通道 / skip-once
│   ├── runner.ts      # spawn 执行(agent 模板/stdin + command),超时/结算
│   └── http.ts        # 回环 HTTP API
└── client/
    ├── api.ts         # api.rpc 封装
    ├── app.ts         # 任务板 UI(列表/新建(cron 预设)/详情(历史/跳过一次))
    └── styles.ts      # 内联样式(随主题 dark/light)
```

## 与参照实现的关系

| | scheduled-prompt (cloudcli-cron) | 本插件 |
|---|---|---|
| 调度 | 枚举预设(无 cron) | **5 段 cron** + 预设下拉生成表达式 |
| 台账 | 每 workspace 一个 JSON | 单一 `jobs.json`(任务自带 workdir) |
| 执行 | executionProfile spawn CLI | 同款 spawn 模型 + 任务级 CLI 覆盖 / `{{session}}` 续聊 |
| 防重 | occurrenceKey + 内存去重 | 先顺延 nextRunAt 的 at-most-once(dsh 语义) |
| 跳过 | — | **跳过一次** |
| UI 插件契约 | mount/unmount + rpc 代理 | 相同 |

## 已知限制

- 任务只在 server 进程存活时触发(宿主开着才拉起 server;错过不补跑)
- 「续聊」依赖目标 CLI 自己的会话管理(`--resume` 等),插件只透传 `{{session}}`
