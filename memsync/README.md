# MemorySync

让 Claude Code 与 Codex 共享同一份团队记忆：约束、进度、决策、版本与工作日志通过 Git 同步，启动时自动注入有预算上限的上下文，结束时自动提交并推送**已经写入的**会话笔记。笔记内容由 AI 或人通过 `memsync note` 写回。无需数据库、常驻服务、MCP 或任何模型 API。

## 它解决什么问题

- **新机器零上下文**：`init → link → 启动工具` 后，AI 立刻知道团队规范、项目约束、当前版本和正在进行的工作。
- **写回有固定落点**：`memsync note` 把笔记写入会话日志，SessionEnd/wrapper 自动提交并推送；笔记内容仍需 AI 或人主动写，提交统计由 Git 自动补齐，按唯一文件名落盘，避免手工合并冲突。
- **约束可治理**：权威约束只能经 `propose → approve` 修改；直接编辑会被 `verify` 指认。
- **离线可用**：网络不可用时使用上一次的缓存包继续工作，恢复后自动补推。
- **双工具一致**：Claude Code 走原生 hooks；Codex 按版本探测 hooks 能力（路径 A/A2），不可用时降级为 `AGENTS.md` + `memsync run codex`（路径 B）。

## 架构

```
 Claude Code hooks                     ┌────────────────────────────────────────┐
 SessionStart / SessionEnd /           │ 团队记忆 Git 仓库 (memory repo)         │
 PreCompact                            │  org/conventions.md                    │
        │                              │  org/governance.yaml                   │
        ▼                              │  projects/<slug>/                      │
 memsync hook ──┐                      │    constraints.md  (权威，需批准)       │
                ├──▶ memsync sync ───▶ │    state.md        (派生快照)           │
 Codex hooks    │     │                │    journal/YYYY-MM/... (会话日志)       │
 SessionStart / │     │                │    decisions/ proposals/ versions/      │
 UserPrompt /   │     │                │    archive/                            │
 Stop           │     ▼                └────────────────────────────────────────┘
        │       │  有界上下文包 (≤ budget)                 ▲
        │       │  ├─ 团队规范 / 项目约束                  │ pull / push
        │       │  ├─ 当前进度 / 自上次以来               │
        │       │  └─ 写回方式 + recall 索引指针           │
        │       │                                          │
        │       └──▶ cache/packs/<slug>.md  ──────────────┘
        │            (离线启动降级使用)
        ▼
 memsync note / session / propose / recall / report / maintain
        │
        └──▶ $MEMSYNC_HOME/repo  (default ~/.memsync/repo)
```

- 一个团队一个记忆仓库；本地只有 `$MEMSYNC_HOME`（默认 `~/.memsync`）。
- 会话日志按 `时间_用户_主机_工具_会话短id.md` 命名；冲突宁可中止也不自动合并。
- 配置文件 `$MEMSYNC_HOME/config.json` 保存仓库路径、远端、身份和默认预算。

## 要求

- Node.js **>= 22**（推荐 24，CI 覆盖 22 与 24）。
- Git 2.31+（Windows 建议 Git for Windows）。
- 对团队记忆仓库的读写权限（SSH 或 HTTPS）。

## 安装

### 方式 A：安装包（推荐给使用者）

从团队记忆仓库获取 `memsync/downloads/memsync-0.1.0.tgz`，然后：

```bash
npm install -g path/to/memsync-0.1.0.tgz
memsync --version
```

安装包已经包含打包好的 `dist/memsync.mjs`，不需要 clone 源码，也不需要 `npm run build`。

> `npm install -g memsync` 不适用：当前没有发布到 npm registry。请使用上面的 tgz 路径。

### 方式 B：从源码（开发或修改 CLI）

```bash
git clone <this repo>
cd Agent-memorySync          # 如果从 AgentMemories 克隆，则 cd AgentMemories/memsync
npm ci
npm run build                # 生成 dist/memsync.mjs
npm install -g .             # 或 npm link
memsync --version
```

`npm link` 会把全局 `memsync` 链接到当前源码目录，适合开发；修改源码后需要重新 `npm run build`。给同事使用请优先方式 A。

## 快速开始（每位开发者）

```bash
# 1. 克隆团队记忆仓库并写入身份
#    把 <memory-repo-url> 替换为团队记忆仓地址
memsync init --remote <memory-repo-url> \
  --name "你的名字" --email you@corp.com

# 2. 在代码仓库中绑定项目（写 .memsync.json，建议提交）
#    把路径替换为试点代码仓，checkout-service 替换为项目 slug
cd path/to/checkout-service
memsync link checkout-service

# 3. 安装工具集成
memsync install --tool claude-code
memsync install --tool codex --force-path B   # Windows/0.169：hooks 不可用，走 AGENTS.md + wrapper

# 4. 自检与手动同步
memsync doctor
memsync sync
```

Codex 的 `install --tool codex` 默认会探测并自动选择 A/A2/B。Windows Codex 0.169 的 command hooks 不可用，因此建议显式使用 `--force-path B`；路径 A/A2 只在经过真实 Codex 验证、command hooks 可用的环境启用。路径 B 下用 `memsync run codex` 启动，wrapper 负责沙箱外的同步与推送。

当前试点配置：记忆仓 `https://github.com/adult-KFC/AgentMemories.git`，代码仓 `https://github.com/adult-KFC/pilot-app.git`，项目 slug `pilot-app`。

`init` 只需要执行一次（换机器时再执行）。`link` 会在工作区写入 `.memsync.json`；把它提交到代码仓库后，队友无需重复指定 slug。

## 团队首次配置

1. **创建记忆仓库**：新建一个私有 Git 仓库（GitHub / GitLab / 自建均可），建议带一个初始提交（例如 README，避免空仓的 unborn branch），给团队授予写权限。仓库内容全部是 Markdown/YAML，不需要任何服务端组件。
2. **确定 owner**：至少一位项目 owner 的邮箱；owner 才能 `approve` 项目约束。组织级规范（`org/conventions.md`）的 owner 写在 `org/governance.yaml` 的 `owners` 列表。
3. **创建项目骨架**（由 owner 执行一次）：

   ```bash
   memsync init --remote <memory-repo-url> --name "Owner" --email owner@corp.com
   memsync project add checkout-service \
     --repo git@git.corp.com:shop/checkout-service.git \
     --owner owner@corp.com \
     --version 0.1.0
   ```

   该命令会创建并推送：
   - `projects/checkout-service/meta.yaml`（仓库、owner、当前版本、预算与维护策略）
   - `projects/checkout-service/constraints.md`、`state.md`
   - `projects/checkout-service/{journal,decisions,proposals,versions,archive}/`
   - `org/conventions.md`、`org/governance.yaml`

4. **团队成员接入**：按上面的「快速开始」执行 `init → link → install`，然后用 `memsync sync` 确认能看到团队规范与项目约束。

> 记忆仓库默认全员可见（一个团队一个仓库）；如果需要按项目隔离，后续可拆分为多个记忆仓库。

## 日常使用

| 场景 | 命令 |
|---|---|
| 启动时自动注入上下文 | Claude hooks 自动调用；Codex 路径 B 由 `memsync run codex` / `AGENTS.md` 触发；也可手动执行 `memsync sync` |
| 写回进度/决策/阻塞/待办 | `memsync note progress "..."`（自动解析会话；歧义时加 `--session`） |
| 开始/结束会话 | Claude hooks 自动处理；手动用 `memsync session begin --tool claude-code`（Codex 用 `--tool codex`）/ `memsync session end` |
| 查历史细节 | `memsync recall "关键词"`（默认 5 条、每条 ≤800 字符、总量 ≤4000 字符；`--all` 返回全文） |
| 团队日报 | `memsync report --since 1d`（也支持 `7d` / ISO 日期） |
| 改约束 | `memsync propose constraint --title ... --section 禁止 --op add --item "..."`，owner 执行 `memsync approve <id>` |
| 校验约束历史 | `memsync verify` |
| 版本与发布 | `memsync version set 0.5.0 --status active`，`memsync release 0.5.0` |
| 健康检查 | `memsync doctor`、`memsync status` |
| 维护 | `memsync maintain --check`、`memsync maintain`、`memsync state refresh` |

`note` 默认按 `--session` → `MEMSYS_SESSION`（`CLAUDE_ENV_FILE` 导出，Git Bash: `$MEMSYS_SESSION`，PowerShell: `$env:MEMSYS_SESSION`）→ 工作区指针 → 隐式新建会话的顺序解析；同一工作区有多个并发会话时必须显式传 `--session`。会话日志记录起止时间、分支、提交列表、diff 统计和笔记；`report` 完全由日志推导，按人分组。

## 手动提醒 AI 拉取 / 推送

可以手动执行，也可以用自然语言提醒 AI；后者依赖受管 `CLAUDE.md` / `AGENTS.md` 是否被遵循，**明确写出命令更可靠**。

拉取：

```bash
memsync sync              # 拉取并渲染，失败回退缓存
memsync sync --strict     # 拉取失败直接报错，不回退缓存
```

Claude Code 在 `pilot-app` 中还可以用安装生成的 `/memsync-sync`；它会先检查 `.memsync/wrapper-active`，wrapper 模式下不会重复拉取。

推送：

```bash
memsync note progress "本次完成的内容"
memsync session end       # 提交并推送；note 本身只写本地
```

自然语言示例（让 AI 转成上面的命令）：

```text
先运行 memsync sync --strict，确认记忆是否最新，再回答当前进度。
把本次结论用 memsync note 写回，然后执行 memsync session end 并确认推送成功。
```

注意：

- `memsync note` 不会推送，必须 `memsync session end`（或正常结束 Claude 会话触发 SessionEnd hook）。
- Codex 路径 B 用 `memsync run codex` 启动；默认沙箱窗口内不要反复运行 `memsync sync`，wrapper 会在沙箱外同步/推送。
- 不要用项目目录的 `git pull` 代替记忆同步：那通常只更新代码仓；记忆仓在 `%USERPROFILE%\.memsync\repo`（macOS/Linux 为 `~/.memsync/repo`）。如果确实手动拉了记忆仓，随后执行 `memsync sync --no-pull` 重新渲染并更新缓存。

## 安全与隐私

- 不保存对话原文，也不调用任何 LLM；摘要由正在对话的 AI 主动写入。
- 笔记和提案在落盘前扫描密钥形态（`sk-...`、PEM 私钥、GitHub/AWS token、Bearer token）；笔记命中即拒绝写入，提案中的敏感文本会脱敏为占位符后落盘。
- 权威文件（`constraints.md`、`org/conventions.md`）通过提案审批修改；审批提交带 `Memsync-Approved-By:` trailer，`verify` 可检测绕过。
- 记忆仓库的 Git 写权限才是真正的安全边界；owner 校验只用于防误操作。

## 文档

- [安装与升级（Windows / macOS / Linux、Claude hooks、Codex 路径 A/B、信任提示）](docs/install.md)
- [故障排查（离线、凭据、hook 未信任、冲突、doctor、Codex 重新探测、维护）](docs/troubleshooting.md)
- [设计规范](docs/superpowers/specs/2026-11-13-shared-team-memory-design.md)
- [实施计划](docs/superpowers/plans/2026-11-14-memsync-v1.md)

## 开发

```bash
npm ci
npm run typecheck
npm test              # 单元 + 集成 + e2e
npm run test:e2e      # 仅端到端验收
npm run build         # dist/memsync.mjs
```

Windows 优先；所有测试使用临时 `MEMSYNC_HOME`、临时 HOME 与空的 `GIT_CONFIG_GLOBAL`，不会读写真实的 `~/.memsync`、`~/.claude`、`~/.codex` 或全局 Git 配置。
