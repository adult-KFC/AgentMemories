# MemorySync 项目历程（0 → 1）

本文是根据开发过程整理的项目历史，**不是原始对话逐字记录**。原始对话中包含本机路径、凭据形态和运行日志，不适合直接公开；这里只保留架构决策、关键问题和验证结果。

脱敏后的对话记录见 [conversation-redacted.md](conversation-redacted.md)。

## 时间线

### 2026-11-13：问题与方案

- 问题：团队多人使用 Claude Code/Codex，各自上下文不共享，导致规范漂移、进度不透明、重复踩坑、交接困难。
- 比较三条路线：
  - A：纯 Git 记忆仓 + CLI；
  - B：中心服务 + MCP；
  - C：Git 事实来源 + 薄 CLI + 工具适配器，MCP 后置。
- 选择 **C**：首版无服务器、离线可用、Git 审计天然，后续可替换存储或增加 MCP 前端。
- 确定双工具范围：Claude Code + Codex；全团队一个记忆仓。

### 2026-11-14：设计落地与实现

- 产出设计文档与 14 个任务的实现计划（TDD、逐任务评审）。
- 核心模块：配置/身份、Git 管道与锁、项目解析、会话 journal、note 去重/脱敏、上下文渲染、Claude hooks、约束提案/批准/校验、版本报告、recall、维护、Codex 探测/插件/wrapper、端到端验收。
- 关键决策：
  - 会话日志按「人 + 主机 + 工具 + 会话」分文件，append-only；
  - 权威约束只能 `propose → approve`；
  - 注入上下文有字符预算，历史细节走 `recall`；
  - 不保存对话原文，不做 LLM 自动摘要；
  - 默认 `memsync sync` 拉取有超时，失败回退缓存；
  - 维护策略：主线新提交 + 72 小时 + 冷却。
- 最终测试规模：38 个测试文件、451 通过 / 1 跳过。

### 2026-11-15：试点环境

- 建立记忆仓库 `adult-KFC/AgentMemories` 与试点代码仓 `adult-KFC/pilot-app`。
- 试点项目 slug：`pilot-app`，owner：`zhooy123@foxmail.com`。
- 第一条权威约束：`MUST NOT 提交任何真实用户数据到测试夹具`，走提案/批准流程落地。
- 发现并修复：
  - 少于 5 条 note 不会自动提交；必须 `memsync session end`；
  - 笔记本记忆仓 `origin/main` 未解析，导致 pull 失败和 maintenance 跳过；
  - `state.md` 是快照，启动注入实际从 journal 实时计算。

### 2026-11-16：真实 Codex 与同步稳定性

- Codex CLI `0.169.0` 实测：
  - `plugin`、`app-server --stdio`、`hooks/list` 可用；
  - **Windows 上 command hooks 不执行**：`SessionStart Failed`，hook 脚本无标记、secret 未注入；
  - 路径 A/A2 在 Windows 不可用，改用路径 B（`AGENTS.md` + wrapper）。
- 发现 Codex 默认 `workspace-write` 沙箱禁止外网：
  - 沙箱外 `memsync sync --strict` 成功；
  - 沙箱内超时；
  - `-s danger-full-access` 可成功。
- 增加：
  - `memsync sync --strict`：拉取失败 exit 1，不回退缓存；
  - `/memsync-sync` 斜杠命令（Claude）与 Codex wrapper 感知；
  - 默认 pull 超时 15 秒，可用 `MEMSYNC_PULL_TIMEOUT_MS` 调整；
  - wrapper 写 `.memsync/wrapper-active` 标记，避免 Codex 在沙箱内重复 sync；
  - Codex `AGENTS.md` 明确沙箱限制、`--tool codex` 和 `session end`。
- 修复自动导入的 Codex 技能误触发 strict sync 的问题，并关闭 Codex 的自动命令导入同步。

### 2026-11-16：收尾与上传

- 工具源码、安装包、使用说明和本历史文档纳入 `AgentMemories/memsync/`。
- 记忆数据仍保存在 `projects/`、`org/`，与工具源码分目录。
- 构建产物 `memsync/downloads/memsync-0.1.0.tgz` 可直接安装。

## 当前状态

- 分支：`feat/memsync-v1`（本地工具仓），源码快照已进入 `AgentMemories/memsync/`。
- 测试：451 通过 / 1 跳过；typecheck/build 正常。
- 试点代码仓 `pilot-app` 尚无业务代码，处于需求规格评审阶段。
- 已知限制见 [usage-for-team.md](usage-for-team.md) 第 8 节。

## 关键经验

1. **自动拉取与自动写回是两件事**：hook 负责启动/收尾；内容必须由 AI 或人调用 `memsync note`。
2. **note 与约束不是一回事**：`note` 进 journal；`constraints.md` 只走提案/批准。
3. **时间线证据要区分本地提交、外部推送和远端确认**；`pending push` 在 upstream 异常时可能不可信。
4. **Codex 的平台限制必须显式降级**：Windows hooks 不可用时，wrapper + AGENTS.md 是可靠路径。
5. **不要把完整对话当记忆库**：结构化摘要 + Git 统计更可控，也避免密钥和隐私泄漏。
