# Antigravity Token Monitor

极简实时的 Antigravity 侧边栏 Token 监控插件。

## 功能特性

- **当前对话实时监控**：自动跟随当前激活的对话，展示上下文窗口占用进度条、累计 Token、缓存命中率、估算费用与缓存节省金额、新输入/输出比例及关联子助手统计。
- **全局总览**：支持按今日 / 7 天 / 30 天 / 全部切换，查看跨会话总消耗 Token、对话数、总估算费用、平均缓存命中率以及分模型占比。
- **自定义单价与币种**：点击右上角 `⚙` 可自定义各模型的输入/缓存/输出单价、上下文窗口上限，以及在美元 (`$`) 与人民币 (`¥`) 之间一键切换。
- **主题自适应**：通过 Antigravity `/preload.js` 自动同步宿主浅色/深色主题。

## 数据来源

只读扫描本地 `<appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`，结合文件 `mtime + size` 内存缓存，不修改任何对话数据。
