# 故障排查

> 下文命令以 bash 书写；PowerShell 中把 `$MEMSYNC_HOME` 写成 `$env:MEMSYNC_HOME`。默认值为 `~/.memsync`（Windows: `%USERPROFILE%\.memsync`）。

先运行两个命令，它们能覆盖大多数问题：

```bash
memsync doctor        # 逐项健康检查（失败时退出码 1）
memsync status        # 配置、仓库、上次同步、待推送、锁、体积、维护到期
```

`doctor` 检查项：

| 检查 | 含义 | 失败时怎么做 |
|---|---|---|
| `config` | `$MEMSYNC_HOME/config.json` 是否存在且可解析 | 重新执行 `memsync init`；坏 JSON 直接删除后重建 |
| `repo` | 配置的记忆仓库路径是否为 Git 仓库 | 检查 `repoPath`；不要手改到非仓库目录 |
| `git-remote` | `git ls-remote origin` 是否可达 | 检查网络、远端 URL、SSH key / HTTPS 凭据 |
| `identity` | `config.identity` 的 name/email 是否有效 | `memsync init --name ... --email ...` 重写身份 |
| `claude-hooks` | settings.json 中的 memsync hook 及其 CLI 路径 | 重新 `memsync install --tool claude-code` |
| `codex-capabilities` | 是否有 Codex 能力探测缓存 | `memsync install --tool codex` 重新探测 |
| `repo-size` | 记忆仓库是否超过 100 MB | `memsync compact --before <date>`；检查大文件 |
| `clock` | 最新日志时间与当前时间的偏差 | 校正系统时间；跨时区/休眠机器可能出现提示 |

## 离线启动

现象：启动上下文以 `[memsync] 离线，使用 <时间> 的缓存` 开头。

- 这是预期降级：使用 `$MEMSYNC_HOME/cache/packs/<slug>.md` 的上一次缓存，不阻塞工具启动。
- 工作照常进行；会话结束仍会本地提交，push 失败时写入 `$MEMSYNC_HOME/state/pending-push.json`。`memsync status` 会显示该标记对应的会话与时间。
- 恢复网络后，任意一次 `memsync sync`（或下一次 hook 启动）会先补推，再拉取，并在成功后删除该标记。`memsync status` 的 `pending push` 应变为 `no`。
- 如果离线提示长期不消失：`git -C "$MEMSYNC_HOME/repo" remote -v` 确认 URL；`git -C "$MEMSYNC_HOME/repo" pull --rebase` 查看具体错误；`memsync doctor` 的 `git-remote` 会直接显示失败原因。

## 凭据问题

- SSH：`ssh -T git@git.corp.com`；确认 ssh-agent 已加载正确 key（Windows 可用 `ssh-add -l`）。
- HTTPS：`git ls-remote <url>` 检查 credential helper；Windows 使用 Git Credential Manager，macOS 使用 osxkeychain。
- hooks 在非交互环境运行，Git 不应等待输入。可以在终端先完成一次手动 `git pull`，让凭据被缓存。
- `doctor` 的 `git-remote` 失败信息通常已包含 `Permission denied`、`could not read Username`、`repository not found` 等关键词。

## Hook 未安装或未信任

### Claude Code

现象：启动没有注入上下文；`doctor` 的 `claude-hooks` 显示 `settings not found` 或 `hook command path missing`。

1. 重新执行 `memsync install --tool claude-code`（必要时加 `--scope project`）。
2. 检查 `~/.claude/settings.json` 中是否存在 `memsync ... hook session-start`。
3. `doctor` 会校验 hook 命令里的 CLI 脚本路径是否仍然存在：升级或移动安装目录后必须重装。
4. 重启 Claude Code 或新开会话。

### Codex hook 信任

现象：`memsync install --tool codex` 显示 `fallback (AGENTS.md + wrapper)`，或升级后 hooks 不再执行。

- 安装时会出现信任提示；只有回答 `y`/`yes` 或使用 `--yes` 才写入信任。
- Codex 升级导致 hook hash 变化时，旧 `trusted_hash` 不再匹配；重新运行安装并确认即可。
- 如果确认后仍降级：
  - 查看安装输出的 warning（注册失败、`hooks/list` 失败、trust 写入失败各有不同提示）。
  - 删除 `$MEMSYNC_HOME/state/capabilities.json` 后重新探测。
  - 明确强制路径 B：`memsync install --tool codex --force-path B`，然后用 `memsync run codex -- ...`。
- 路径 B 下 hooks 不执行是预期行为；AGENTS.md 会要求 AI 先 `memsync sync`。

## 冲突

设计上用唯一文件名（时间 + 用户 + 主机 + 工具 + 会话短 id）和派生重建来避免冲突；`sync` 使用 `git pull --rebase`。

如果仍遇到冲突：

1. 如果冲突只涉及 `state.md`（派生文件），`memsync sync` 会自动取任一版本、按日志重建派生区并继续 rebase；其他文件冲突才会中止并保留本地提交。不要手工 `git push --force`。
2. 查看状态：

   ```bash
   git -C "$MEMSYNC_HOME/repo" status
   git -C "$MEMSYNC_HOME/repo" log --oneline -5
   ```

3. 若仓库停留在 rebase 中：`git -C "$MEMSYNC_HOME/repo" rebase --abort`。
4. 重新 `memsync sync`。记忆文件按目录组织，冲突通常只涉及 `state.md`（派生文件）；以当前日志重新生成即可：`memsync state refresh`。
5. 极少数情况：同一台机器、同一用户/工具，且两个会话短 id 的前 6 位相同并在同一秒开始，日志文件名会重合。使用正常的随机 UUID 时会话 id 几乎不会触发；如手工指定了相似 id，请让前 6 位不同。

## 会话归属歧义

现象：`memsync session end` 或 `memsync note` 报 `multiple active sessions in this workspace; pass --session <id>`。

- 同一工作区有两个并发 Claude/Codex 会话时，指针只能指向最后开始者。
- 有 `CLAUDE_ENV_FILE` 时，每个 shell 会导出自己的 `MEMSYS_SESSION`；`note` 和收尾命令会优先使用该值。
- 没有环境文件时，`note` 会按 `MEMSYS_TOOL`（若设置）或工作区指针归属；指针不存在时会自动创建隐式会话并写回。
- 无法唯一确定时，显式传 `--session <id>`。会话 id 可在 `.memsync/sessions/current-<tool>.json` 或日志 front matter 中找到。
- 非包装器 Codex（直接运行 `codex`，未走 `memsync run`）先用 `memsync sync --tool codex` 开始会话，之后的 `memsync note` 会通过工作区指针找到它。

## Codex 重新探测

```bash
memsync install --tool codex                 # 强制重新探测并写入缓存
rm "$MEMSYNC_HOME/state/capabilities.json"   # 彻底清除缓存（Windows: del）
memsync install --tool codex --force-path A  # 已知可用时强制路径
memsync doctor
```

探测使用隔离的临时 `CODEX_HOME`，不会执行真实会话，也不会修改你的 Codex 配置；它只依据 `codex --version`、`plugin --help`、app-server 的 `hooks/list`/`config/read` 与行为注入结果判断路径。任何不确定都会降级到 B，而不是误报 A。

## 维护：state refresh / maintain / compact

- `memsync state refresh`：立即重建 `state.md` 中 `<!-- memsync:derived:begin -->` 到 `end` 的派生块，保留人工备注。需要即时准确状态时使用。
- `memsync maintain --check`：只报告是否到期；输出 `due: <原因>` 或 `not due: <原因>`。
- `memsync maintain`：真正执行维护（刷新快照、归档 90 天前日志、提交并尽力推送）。
- 维护策略来自 `meta.yaml`：
  - `interval_hours: 72`：成功后 72 小时内不重复；
  - `cooldown_hours: 6`：失败尝试后进入冷却；
  - `mainline_only: true`：只跟随 `origin/<default_branch>`，非主线提交不触发。
- 维护失败不会阻塞启动：尝试时间先落盘，后续 `status`/`maintain --check` 会显示到期或冷却状态。
- `memsync compact --before 2026-09-01`：把更早的日志移动到 `archive/`（只移动，不删除）。

## 笔记被拒绝

- **密钥**：`note appears to contain a secret`。`sk-...`、PEM 私钥、GitHub/AWS token、Bearer token 会在落盘前被拒绝；删除凭据后重试。
- **过大**：单条笔记上限 8192 字节；拆分为多条。
- **重复**：相同 kind + 文本会被忽略并提示 duplicate，不是错误。

## 未绑定工作区

现象：启动没有任何注入，也没有报错。

- 这是预期行为。进入代码仓库后执行 `memsync link <slug>`，或提交队友的 `.memsync.json`。
- 若提示 `project <slug> not found`：先在记忆仓库中 `memsync project add`，或 `memsync sync` 拉取最新项目。
- 若提示 `multiple projects match`：`memsync link <slug>` 显式选择。

## 其他

- **版本/权限**：Node < 22 不受支持；`npm install -g` 权限问题优先使用 nvm/fnm 或用户级 prefix。
- **Windows 行尾**：不要手动把记忆仓库改成 CRLF；`init` 已固定 `.gitattributes` 与 `core.autocrlf=false`。
- **诊断文件**：`$MEMSYNC_HOME/state/diagnostics.jsonl` 只记录事件名与哈希后的字段，不包含原文；排查时可保留但通常无需人工读取。
