# Changelog

## 0.2.0 — 2026-09-05

同步 dsh-timer-agent v0.5.0:一次性任务 + nextRunAt 驱动调度模型。

- **一次性任务**:仅设执行时间(新建页执行模式下拉选"一次性",默认当前 +1h),触发一次即归档;成功/失败/手动执行均消耗;创建走 `runAt`(ms epoch 或 ISO)、编辑/详情页 `PATCH nextRunAt` 手改(固定间隔同理;cron 拒绝手改,时刻归表达式管)
- **执行完全由持久化的 `nextRunAt` 驱动**,cron/固定间隔只负责计算它;tick 对一次性任务在触发当拍消耗 `nextRunAt`(at-most-once),运行中到点不消耗、下一拍重试
- **暂停保留 `nextRunAt`**(不再清空);恢复/重启归档改为按真实上次执行时间(最后一条 execution.startedAt,回退 lastTriggeredAt)重算,错过不补跑;新增 `resumeNextMs` 统一该语义
- 台账修复(`repairJob`)识别一次性规则(有 nextRunAt/lastTriggeredAt 证据才保留,空白脏行仍丢弃),旧台账零迁移直接兼容
- 执行结算一次性任务归档(`settleExecution`);跳过一次对一次性任务拒绝(API 400,UI 隐藏入口)
- UI:新建/编辑页执行模式下拉(Cron/固定间隔/一次性,未勾选启用调度时禁用);详情页一次性标签 + 修改下次执行时间控件;模式切换保留已填内容

## 0.1.1 — 2026-09-01

- 修复:server 进程加单实例守卫(`server.lock` + pid 探活,残锁自动回收)——多个实例(宿主 + standalone)共写同一份台账会互相覆盖,导致调度字段丢失、执行历史被清
- 运维:agent 任务的 CLI 在 Windows 上必须配绝对路径 exe(npm 的 `claude` 是 `.cmd` 垫片,`spawn` 无法直接执行);在 `~/.cloudcli-timer-agent/profile.json` 配 `command` 指向 `claude.exe`

## 0.1.0 — 2026-09-01

首个发布版。

- 两类任务:AI Agent 任务(prompt 注入 `claude --print`,支持会话续聊、按任务指定 `--model`/`--effort`)/ 普通任务(直接执行命令)
- 调度模式:5 段 cron(带预设)+ 固定间隔(锚定上次触发时刻,空窗按整间隔叠加,手动执行也算上次触发)
- 任务面板:列表/状态筛选/搜索、新建/编辑、详情+执行历史、跳过一次、立即执行、暂停/恢复、归档
- 工作空间/会话选择器,at-most-once 触达,台账原子写与自动修复
