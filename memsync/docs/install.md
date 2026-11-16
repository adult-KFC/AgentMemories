# 安装与接入

本文覆盖 Windows / macOS / Linux 安装、Claude Code hooks、Codex 路径 A/B 与信任提示，以及升级和卸载。

## 0. 前置条件

- Node.js **>= 22**，推荐 **24**（`node --version`）。
- Git 2.31+（`git --version`）。
- 团队记忆仓库的读写权限；先在终端验证：

  ```bash
  git ls-remote <memory-repo-url>
  ```

- 所有本地状态都在 `$MEMSYNC_HOME`（默认 `~/.memsync`）。只有 `config.json`、记忆仓库克隆、缓存和本地编排状态，不含数据库。

## 1. 安装 CLI

### 安装包（推荐）

从团队记忆仓库获取 `memsync/downloads/memsync-0.1.0.tgz`，然后：

```bash
npm install -g <path-to>/memsync-0.1.0.tgz
memsync --version
```

安装包已经包含打包好的 `dist/memsync.mjs`，不需要 clone 或 build。

> `npm install -g memsync` 不适用：当前没有发布到 npm registry。

### 从源码（开发）

```bash
git clone <repo>
cd Agent-memorySync          # 从 AgentMemories 克隆时为 AgentMemories/memsync
npm ci
npm run build
npm install -g .             # 或 npm link
memsync --version
```

单文件 bundle 会生成到 `dist/memsync.mjs`；hooks 使用 Node 绝对路径 + CLI 绝对路径调用，不依赖 PATH。修改源码后需要重新 `npm run build`。

### Windows

1. 安装 Node.js 24 LTS（`winget install OpenJS.NodeJS.LTS` 或 nodejs.org 安装包）。
2. 安装 Git for Windows；推荐在 Git Bash 或 PowerShell 中操作。
3. `npm install -g <path-to>\memsync-0.1.0.tgz`。全局 npm 目录默认不需要管理员权限；若遇到权限错误，改用 nvm-windows 或修复 npm prefix。
4. `memsync init` 会把记忆仓库的 `core.autocrlf` 固定为 `false`，并在仓库中提交 `.gitattributes`（`* text=auto eol=lf`），避免 CRLF 造成虚假 diff。
5. hooks 中的命令是带引号的绝对路径；路径含空格也能工作。无需手动改 PATH。

### macOS

1. 安装 Node 24：`brew install node@24`，或用 nvm/fnm。
2. `npm install -g <path-to>/memsync-0.1.0.tgz`；使用 nvm 时不要加 `sudo`。
3. Git 由 Xcode Command Line Tools 提供；SSH 使用系统 ssh-agent。

### Linux

1. 通过 nvm、fnm 或发行版仓库安装 Node 22+（推荐 24）。
2. `npm install -g <path-to>/memsync-0.1.0.tgz`；若全局目录需要 root，请配置用户级 npm prefix，不要长期使用 sudo。
3. 记忆仓库使用 SSH key 或 credential helper。

## 2. 初始化、绑定项目

```bash
memsync init --remote git@git.corp.com:team/memory.git \
  --name "你的名字" --email you@corp.com

cd path/to/project
memsync link checkout-service
memsync doctor
```

- `init` 克隆到 `$MEMSYNC_HOME/repo`，并写入 `$MEMSYNC_HOME/config.json`。重复执行是安全的：flag 优先，缺省字段沿用已有配置或本机 Git 身份。
- `link <slug>` 校验项目存在，写入工作区 `.memsync.json` 和本机 repo map。**建议提交 `.memsync.json`**，让队友自动解析项目。
- 如果工作区有多个匹配项目，`link` 会要求显式 slug；未绑定的工作区启动时不会注入任何内容，也不会报错。
- `memsync sync` 可随时手动拉取并打印上下文。

## 3. Claude Code hooks

```bash
memsync install --tool claude-code            # user scope（默认）
memsync install --tool claude-code --scope project
```

安装内容：

- 在 `~/.claude/settings.json`（或项目的 `.claude/settings.json`）中注册：
  - `SessionStart` → `memsync hook session-start --tool claude-code`
  - `SessionEnd` → `memsync hook session-end --tool claude-code`
  - `PreCompact` → `memsync hook pre-compact --tool claude-code`
- 在 `CLAUDE.md` 写入带 `<!-- memsync:begin -->` / `<!-- memsync:end -->` 标记的受管块，说明先读上下文、如何写回、不要直接改权威文件、如何 `recall`。块外内容保持不变，重复安装幂等。
- 若运行环境提供 `CLAUDE_ENV_FILE`，`SessionStart` 会把 `MEMSYS_SESSION` / `MEMSYS_TOOL` / `MEMSYS_HOST` 追加到该文件，后续 Bash 命令可继承会话 id。

安装后重启 Claude Code，或新开一个会话。验证：

```bash
memsync doctor
```

`claude-hooks` 检查会读取 settings.json，确认 hook 命令存在且 CLI 路径仍然有效。

## 4. Codex 集成（路径 A / A2 / B）

> **Windows Codex 0.169 实测 command hooks 不执行**（`SessionStart Failed`，hook 脚本无标记、上下文未注入）。Windows 上请显式使用 `--force-path B`；路径 A/A2 只应在真实 Codex 版本/平台上验证通过后启用。

```bash
memsync install --tool codex               # 自动探测
memsync install --tool codex --force-path B  # Windows / 已确认 hooks 不可用
```

安装器会用真实的 `codex` 可执行文件做能力探测（隔离的 `CODEX_HOME`，不触碰你的配置）：

| 结果 | 含义 | 安装方式 |
|---|---|---|
| **路径 A** | `SessionStart` 能注入上下文，hooks 可用 | 注册插件 hooks（SessionStart / UserPromptSubmit / Stop） |
| **路径 A2** | hooks 可用，但只能注入 UserPromptSubmit | 插件 hooks + 在提示词阶段注入 |
| **路径 B** | hooks 不可用或探测不确定 | 写 `AGENTS.md` 受管块，配合 `memsync run codex` 包装器 |

探测结果缓存在 `$MEMSYNC_HOME/state/capabilities.json`，key 为 `<codex 版本>|<命令>`。升级 Codex 或切换可执行文件后，重新运行 `memsync install --tool codex` 会强制重新探测。

### 信任提示

路径 A/A2 安装会执行 `hooks/list` 并列出即将信任的 hook：

```
hook: memsync-codex-adapter@SessionStart SessionStart "node" ".../memsync.mjs" hook session-start --tool codex
? trust these Codex hooks? [y/N]
```

- 只有回答 `y` / `yes`（或传入 `--yes`）才会写入 `hooks.state.<key>.trusted_hash`，并在写入后通过一次新的 `hooks/list` 验证 `trusted`。
- 拒绝或非交互（非 TTY）输入会降级到路径 B，并给出 warning；不会静默写入信任。
- Codex 升级导致 hook 内容/hash 变化时，旧信任不再生效；必须重新运行安装并确认。`memsync doctor` 的 `codex-capabilities` 会显示缓存的路径与版本。
- 非交互环境（CI、脚本）：

  ```bash
  memsync install --tool codex --yes
  memsync install --tool codex --force-path B   # 明确强制降级
  ```

### Codex `Stop` 语义（需用真实构建验证）

当前实现把 `Stop` hook 视为**会话结束**（`memsync session end`）。真实 Codex 版本可能按轮次触发 `Stop`，而不是在会话真正结束时触发一次；这种差异还没有在真实构建上验证过（fixtures 只覆盖协议形状）。为降低影响，已结束的会话指针会被视为不存在：`Stop` 之后的下一次 `memsync note` 会开一个新的隐式会话（`implicit: true`），不会污染已结束的日志。上线前请用目标 Codex 版本人工验证 `Stop` 的触发频率，并据此决定是否改为按轮次 checkpoint。

### 路径 B：包装器

```bash
memsync run codex -- <codex 参数>
```

包装器每次顶层启动都会开始一个全新会话，把 `MEMSYS_SESSION` / `MEMSYS_TOOL` / `MEMSYS_HOST` / `MEMSYS_WRAPPER` 导出给子进程，并在工作区写入 `.memsync/wrapper-active` 标记（Codex 的 shell 环境策略可能过滤 `MEMSYS_*`，标记供 AI 判断无需重复 sync），退出时结束会话并在沙箱外提交、推送日志。子进程退出码优先；收尾失败只打印一行诊断。

如果直接运行 `codex`（路径 B 的非包装器模式），先执行 `memsync sync --tool codex` 开始会话；之后的 `memsync note` 无需 `--session`，会通过工作区指针归属到该会话。

> Codex 默认 `workspace-write` 沙箱禁止外网，窗口内 `memsync sync`/`git push` 可能超时。推荐用 `memsync run codex`（沙箱外同步/推送）；确需窗口内联网时使用 `codex -s danger-full-access` / `memsync run codex -- -s danger-full-access`。

## 5. 升级

```bash
npm install -g <path-to>/memsync-0.1.0.tgz
memsync install --tool claude-code
memsync install --tool codex --force-path B   # Windows
memsync doctor
```

升级后必须重新执行 `install`：hooks 记录的是 CLI 的绝对路径，新版本路径可能变化；Codex hook 的 hash 也可能变化，需要重新确认信任。

## 6. 卸载

```bash
npm uninstall -g memsync
```

然后按需清理：

1. **Claude Code**：从 `~/.claude/settings.json`（或项目 `.claude/settings.json`）删除包含 `memsync ... hook` 的 hook 条目；从 `CLAUDE.md` 删除 `<!-- memsync:begin -->` 到 `<!-- memsync:end -->` 之间的块。
2. **Codex**：通过 Codex 的插件命令移除 `memsync-codex-adapter` 插件；从 `$CODEX_HOME/AGENTS.md` 删除受管块；删除 `$MEMSYNC_HOME/codex/` 下的插件/市场文件。
3. **本地状态**：删除 `~/.memsync` 会移除配置、记忆仓库克隆、缓存和本地日志。**注意**：如果本地还有未推送的日志，请先 `memsync sync` 或 `git -C ~/.memsync/repo push`。
4. **工作区**：`.memsync.json` 是项目绑定文件，可保留或随工作区一起删除。

团队记忆仓库本身不受卸载影响。
