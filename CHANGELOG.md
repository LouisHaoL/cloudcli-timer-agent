# Changelog

## 0.1.1 — 2026-09-01

- 修复:server 进程加单实例守卫(`server.lock` + pid 探活,残锁自动回收)——多个实例(宿主 + standalone)共写同一份台账会互相覆盖,导致调度字段丢失、执行历史被清
- 运维:agent 任务的 CLI 在 Windows 上必须配绝对路径 exe(npm 的 `claude` 是 `.cmd` 垫片,`spawn` 无法直接执行);在 `~/.cloudcli-timer-agent/profile.json` 配 `command` 指向 `claude.exe`

## 0.1.0 — 2026-09-01

首个发布版。

- 两类任务:AI Agent 任务(prompt 注入 `claude --print`,支持会话续聊、按任务指定 `--model`/`--effort`)/ 普通任务(直接执行命令)
- 调度模式:5 段 cron(带预设)+ 固定间隔(锚定上次触发时刻,空窗按整间隔叠加,手动执行也算上次触发)
- 任务面板:列表/状态筛选/搜索、新建/编辑、详情+执行历史、跳过一次、立即执行、暂停/恢复、归档
- 工作空间/会话选择器,at-most-once 触达,台账原子写与自动修复
