# MemorySync 团队使用说明

面向：使用 Claude Code 或 Codex 参与 `pilot-app` 试点的同事。

## 1. 它是什么

MemorySync 是一套团队共享的项目记忆工具：

- 记忆数据存放在本仓库 `AgentMemories` 的 `projects/`、`org/`；
- 工具源码、安装包和使用文档在 `memsync/`；
- 每个开发者的电脑上运行 `memsync` CLI，启动 AI 工具时自动拉取团队记忆；
- 开发中的进度、决策、阻塞、待办通过 `memsync note` 写回，会话结束时提交并推送。

它不会保存完整对话原文，只保存 AI 写入的结构化摘要和 Git 统计。

## 2. 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10/11（macOS/Linux 基本可用，但试点以 Windows 为主） |
| Node.js | ≥ 22，推荐 Node 24 LTS |
| Git | 已安装，可访问 GitHub |
| GitHub | 已被邀请到私有仓库 `adult-KFC/AgentMemories` |
| AI 工具 | Claude Code 或 Codex CLI（ChatGPT 桌面版不支持） |
| 网络 | 能访问 GitHub；公司代理需给 Git 配置代理 |

## 3. 安装 CLI

安装包在本仓库：

```text
memsync/downloads/memsync-0.1.0.tgz
```

先 clone 仓库（私有仓库需要 GitHub 登录）：

```bash
git clone https://github.com/adult-KFC/AgentMemories.git
cd AgentMemories
```

然后安装：

```bat
npm install -g memsync\downloads\memsync-0.1.0.tgz
memsync --version
```

Windows 全局安装若报 `EPERM`，把 npm 全局目录改到用户目录：

```bat
npm config set prefix "%APPDATA%\npm"
setx PATH "%APPDATA%\npm;%PATH%"
```

重新打开终端后重试。

## 4. 初始化记忆库

每个开发者使用**自己的姓名和邮箱**；owner 本人使用 `zhooy123@foxmail.com`。

```bat
memsync init ^
  --remote https://github.com/adult-KFC/AgentMemories.git ^
  --name "你的姓名" ^
  --email "你的邮箱"
```

成功后输出：

```text
Memory repo: C:\Users\<你>\.memsync\repo
Identity: 你的姓名 <你的邮箱>
Remote: https://github.com/adult-KFC/AgentMemories.git
```

## 5. 绑定需要共享记忆的项目（以 pilot-app 图书管理系统为例）

以下以试点项目 `pilot-app`（图书管理系统）为例。实际接入时，把代码仓地址和 `pilot-app` 替换成你们自己的项目；`pilot-app` 是创建项目时指定的 slug，可在 `projects/<slug>/meta.yaml` 中看到。

```bat
git clone https://github.com/adult-KFC/pilot-app.git
cd pilot-app
memsync link pilot-app
memsync install --tool claude-code
```

重启 Claude Code。之后在该目录启动 Claude Code，它会自动拉取记忆并注入约束/进度。

### Codex CLI

Codex 在 Windows 上的 command hooks 目前不可用，使用**路径 B**：

```bat
memsync install --tool codex --force-path B
```

启动 Codex 时不要直接运行 `codex`，用 wrapper：

```bat
memsync run codex
```

wrapper 会在启动前同步、退出后提交并推送。Codex 窗口内部仍受 sandbox 网络限制，AI 不应在窗口内反复执行 `memsync sync`。

如果确实需要 Codex 窗口内联网：

```bat
memsync run codex -- -s danger-full-access
```

这会关闭 Codex sandbox，只建议在信任的试点仓使用。

ChatGPT 桌面版不是 CLI，不能接入；需要安装 Codex CLI。

## 6. 日常命令

```bat
memsync sync              :: 手动拉取并渲染记忆
memsync sync --strict     :: 拉取失败即报错，不回退缓存
memsync status            :: 上次同步、pending push、仓库体积
memsync doctor            :: 诊断配置、凭据、hooks、Codex 能力
memsync recall "关键词"   :: 检索约束、决策、日志、版本
memsync report --since 7d :: 按人统计进度
memsync maintain --check  :: 检查维护是否到期
memsync state refresh     :: 刷新人读的 state.md 快照
```

写回：

```bat
memsync note progress "完成了 X"
memsync note decision "选择方案 C，原因是..."
memsync note blocker "等待库存服务确认"
memsync note todo "下一步压测"
memsync note handoff "交接说明"
memsync session end
```

至少 5 条 note 才自动 checkpoint；不足 5 条时，结束会话前执行 `memsync session end`。`note` 本身只写本地，`session end` 才提交并推送。

Claude Code 中可使用 `/memsync-sync` 强制检查最新记忆；它会在 wrapper 模式下跳过重复拉取。

### 手动提醒 AI 拉取 / 推送

可以直接执行命令，也可以用自然语言提醒 AI。Claude Code 已实测可用：直接说“先 sync 再回答”“写回后 session end”即可。Codex 路径 B 受沙箱和指令遵循影响，仍建议用 `memsync run codex` 或明确命令。

- 拉取：`memsync sync`（失败回退缓存）或 `memsync sync --strict`（失败直接报错）；Claude Code 可用 `/memsync-sync`。
- 推送：先 `memsync note ...` 写内容，再 `memsync session end` 提交推送；`note` 本身不推送。
- 自然语言示例：
  ```text
  先运行 memsync sync --strict，确认记忆是否最新，再回答当前进度。
  把本次结论用 memsync note 写回，然后执行 memsync session end 并确认推送成功。
  ```
- 不要用项目目录的 `git pull` 代替记忆同步：那通常只更新代码仓；记忆仓在 `%USERPROFILE%\.memsync\repo`。

## 7. 团队约束与决策

核心约束只能通过提案/批准修改：

```bat
memsync propose constraint --title "..." --section "禁止" --op add --item "..."
memsync approve <proposal-id>
memsync verify
```

决策使用：

```bat
memsync propose decision --title "..." --rationale "..."
memsync approve <proposal-id>
```

只有 `projects/pilot-app/meta.yaml` 的 `owners` 邮箱可以批准。

## 8. 当前局限

1. **不保存完整对话**，只保存结构化 note、统计和摘要；需要原文时请自行导出。
2. 单条 note 上限 8KB；上下文注入默认约 12,000 字符；`recall` 默认 5 条 × 800 字符。
3. **Codex Windows command hooks 不可用**（`SessionStart Failed`）；路径 A/A2 在 Windows 上不能启用，只能走 `AGENTS.md` + wrapper。
4. Codex 默认 `workspace-write` 沙箱禁止外网，窗口内 `memsync sync`/`git push` 会超时；用 wrapper 或 `-s danger-full-access`。
5. 记忆仓库与工具源码在同一个 GitHub 仓库的不同目录；仓库是私有的，所有成员可见所有项目记忆。
6. 网络慢时 `memsync sync` 可能超时；可设：
   ```bat
   set MEMSYNC_PULL_TIMEOUT_MS=60000
   ```
7. 不要把 `git pull` 当成记忆同步：项目目录的 `git pull` 只更新代码；记忆仓在 `%USERPROFILE%\.memsync\repo`。
8. 当前安装包版本 `0.1.0`，工具代码在 `memsync/`；更新时重新下载/安装并重跑 `memsync install`。
9. `doctor` 的 `codex-capabilities` 在 `--force-path B` 下可能显示 FAIL，属于已知提示。
10. 不要提交任何密钥、token、真实用户数据到记忆库；`note` 会拦截常见密钥形态，但不是绝对保证。

## 9. 常见问题

| 现象 | 处理 |
|---|---|
| 启动没有注入记忆 | 确认在 pilot-app 目录、`.memsync.json` 存在、`memsync doctor` 的 `claude-hooks` 为 ok，并重启 Claude Code |
| `memsync sync` 超时 | 设 `MEMSYNC_PULL_TIMEOUT_MS=60000`；检查 GitHub/代理；Codex 沙箱内用 wrapper |
| `pending push: yes` | 网络恢复后 `memsync sync` 重试；或 `git -C %USERPROFILE%\.memsync\repo push` |
| PowerShell 禁止 `memsync.ps1` | 用 `memsync.cmd`，或 `cmd /d /s /c "memsync ..."` |
| Codex `SessionStart Failed` | Windows hooks 不可用；使用 `memsync run codex`（路径 B） |
| Codex 窗口内 sync 超时 | 正常，沙箱禁网；用 wrapper 或 `-s danger-full-access` |
| Claude 说记忆未同步 | 检查是否在看代码仓而非记忆仓；运行 `memsync status`/`doctor` |
| `default_branch` 警告 | 检查 `%USERPROFILE%\.memsync\repo` 的 `origin/main`；执行 `git fetch origin main` 和 `git remote set-head origin -a` |

## 10. 更新与卸载

更新：

```bat
npm install -g memsync\downloads\memsync-0.1.0.tgz
cd pilot-app
memsync install --tool claude-code
memsync install --tool codex --force-path B
```

卸载本地配置（不会删除远程记忆）：

```bat
npm uninstall -g memsync
:: 如需清空本机缓存：
:: 删除 %USERPROFILE%\.memsync
```

owner：`zhooy123@foxmail.com`
