# MemorySync：跨主机、跨工具的团队项目记忆库设计

- 日期：2026-11-13
- 更新：2026-11-14（v1.1，吸收 MemoraX Code 的实现经验，见附录 A）
- 状态：待评审（Draft）
- 决策已定：方案 C（Git 事实来源 + 薄 CLI + 工具适配器，MCP 后置）；首版只支持 Claude Code 与 Codex；全团队共用一个记忆仓库

---

## 1. 背景与问题

团队多名开发者各自使用不同的 AI 编程工具（Claude Code、Codex），每个人、每台主机上的 AI 只看得到：

- 自己这次的对话上下文；
- 当前工作区的代码。

由此产生四类损耗：

1. **规范漂移**：同一个项目，A 的 AI 按 `constraints.md` 的旧理解写，B 的 AI 根本不知道有这条约束，C 的 AI 甚至把约束改掉了。
2. **进度不透明**：谁在做什么、做到了哪个版本、哪些已经完成、哪些被阻塞，只有本人知道；AI 无法基于真实进度做建议。
3. **重复踩坑**：某人已经确认过的技术选型、踩过的坑、放弃的方案，换一个人、换一个工具又要重来一遍。
4. **交接成本**：上下文只存在于个人会话里，会话结束即蒸发；人休假、换任务、换工具后无法接续。

目标不是让 AI「更聪明」，而是让**同一个项目的所有 AI 实例看到同一个项目世界**，并且这个世界是可控、可审计、可回滚的。

## 2. 意图、成功的定义

### 2.1 意图

为团队建立一个独立于个人工作区的**项目记忆库**：

- 每个开发者启动 Claude Code / Codex 时自动取得最新记忆；
- 开发过程中，AI 把进度、决策、阻塞、约束变更写回；
- 核心约束是权威版本，只能通过「提案 → 批准」修改；
- 记忆以纯文本存放在公司私有 Git 仓库中，可审计、可评审、可离线。

### 2.2 成功的样子（验收视角）

- 新同事装好工具后，**15 分钟内**接入：启动 AI 即看到项目约束、当前版本、他人进度。
- 两个开发者同一分钟各自写回一条记录，**不需要人工解决 Git 冲突**。
- 某人的 AI 想改核心约束时，只能产生一条**待批准的提案**，不能静默生效。
- 一次会话结束后，记忆库里自动留下：谁、在哪台机器、用什么工具、在哪个分支、改了哪些文件、产生了哪些提交、完成了什么、遗留了什么（Claude Code、启用 hooks 的 Codex、或使用包装器的 Codex 为完整记录；降级模式的 Codex 尽力而为并明确标记）。
- 断网时启动 AI 仍能拿到**缓存的上一次记忆**，并明确标注「已过期 X 小时」。
- 启动注入的上下文默认 **≤ 3000 tokens**，不拖慢会话、不淹没任务。

### 2.3 反目标（实现了也算失败）

- 需要人手动记得执行同步命令才生效；
- 任意 AI 都能直接编辑权威约束；
- 会话结束需要人手动 commit / push；
- 每次启动注入大量流水账，AI 反而忽略真正重要的约束；
- 每周都需要人对 Git 冲突做手术；
- 为同步引入一个必须 7×24 运维的中心服务。

## 3. 范围

### 3.1 目标（v1）

| 编号 | 功能需求 | 说明 |
|---|---|---|
| FR-1 | 记忆库初始化与项目注册 | 一个团队记忆仓库，管理多个项目；新项目注册 slug、代码仓地址、owner |
| FR-2 | 工作区绑定与身份识别 | 从工作区自动识别项目；记录 git 身份、主机名、工具、会话 ID |
| FR-3 | 启动自动同步与上下文注入 | Claude Code 通过 hook；Codex 按版本探测 hooks，不可用时用受管 AGENTS.md + 启动包装器；带缓存与超时 |
| FR-4 | 会话自动记录 | 自动记录起止时间、分支、提交、变更统计，失败也不阻塞开发 |
| FR-5 | AI 结构化写回 | progress / decision / blocker / todo / constraint-proposal 五类，按会话追加 |
| FR-6 | 权威约束治理 | 提案、批准、修订记录；直接修改可被校验发现 |
| FR-7 | 版本与进度 | 版本快照、当前状态派生、按人/按版本的工作报告 |
| FR-8 | 检索 | 对约束、决策、日志、版本做确定性全文检索，按需展开 |
| FR-9 | 双工具适配 | Claude Code 全自动；Codex 支持 hooks 时全自动，否则降级为受管指令 + 包装器 |
| FR-10 | 冲突与离线 | 追加式文件布局避免冲突；离线缓存与延迟推送 |
| FR-11 | 安全 | 默认不存会话原文；密钥模式拦截；仓库权限即团队权限 |
| FR-12 | 运维自检 | doctor / verify / maintain / compact / status，用于诊断与长期维护 |

### 3.2 非目标（v1 明确不做）

- 不做代码语义索引、向量检索、RAG；
- 不做中心服务器、Web 面板、实时协同；
- 不替代 Git 历史、Issue 跟踪器或代码评审；
- 不保存完整对话 transcript（默认只存结构化摘要与统计）；
- 不做 per-project 权限隔离（单仓 = 全团队可见，见 §17）；
- 不支持 Cursor / Gemini / Copilot（适配器接口预留，后置）；
- 不做自动 LLM 摘要（不依赖任何模型 API，避免额外密钥与成本）；
- 不做 MCP 前端（作为 C 方案的后续演进，接口预留）。

### 3.3 反目标

见 §2.3。

## 4. 已确认的决策与约束

| 决策 | 取值 | 来源 |
|---|---|---|
| 架构路线 | C：Git 作唯一事实来源 + 薄 CLI + 工具适配器，MCP 后置 | 你的选择 |
| 首版工具 | Claude Code、Codex | 你确认 |
| 仓库拓扑 | 全团队一个记忆仓库，多项目按目录隔离 | 你确认 |
| 中心服务 | v1 不引入 | 由 C 推出 |
| 运行环境 | Windows 优先（Windows 11），兼容 macOS/Linux | 现状 |
| 本机工具链 | Node 24.14、Git 2.56、Python 3.12 | 已检测 |
| 记忆存储 | 纯文本 Markdown + YAML front matter，Git 仓库 | 设计决定 |
| 鉴权 | 复用公司 Git 托管凭据（SSH 或 HTTPS credential helper） | 设计决定 |
| 推送策略 | 记忆仓库默认分支允许团队成员直接 push，不强制 MR | 你确认 |
| Codex 集成 | 按安装版本探测 hook 能力；支持则走 hooks，不支持才降级为 `AGENTS.md` + wrapper | 设计决定，见 §10.3 |

**跨工具现实约束**：各工具的 hook 能力与注入格式不同。Claude Code 有 SessionStart / SessionEnd；Codex 的插件/hook 能力随版本变化（参考项目的 Codex adapter 已声明并使用 SessionStart / UserPromptSubmit / Stop），必须在安装时探测。无论是否支持 hooks，`CLAUDE.md` / `AGENTS.md` 受管指令块都是最后的兜底入口。该差异必须被适配器隔离，不能泄漏进记忆模型。

## 5. 方案对比与选择

### 5.1 三条路线

**A. 纯 Git 记忆仓**：启动 `git pull` + CLI 渲染工具文件；会话结束追加日志并 push。

- 成本：约 2–3 周/单人；覆盖核心需求约 75%。
- 优点：零服务器、离线可用、审计天然、PR 评审天然。
- 缺点：没有 MCP / 检索接口，后续演进要重写客户端层。

**B. 中心服务 + MCP**：内网服务（DB + API + MCP），所有工具连接。

- 成本：约 8–12 周/小组；首版功能 90%+。
- 优点：统一、实时、细粒度权限、可做面板。
- 缺点：服务器、认证、备份、迁移、运维全部自建；且**并不能单独解决启动注入**——Codex 的 hook 能力按版本而异，最终仍要文件兜底，客户端复杂度并没有降低。

**C. 混合**：Git 作唯一事实来源 + 一个薄 CLI 承载全部记忆逻辑 + 工具适配器；MCP 作为后续薄前端复用同一套核心。

- 成本：约 3–4 周；首版覆盖核心需求约 85%；长期上限与 B 相同。
- 优点：A 的运维成本，B 的演进空间；核心逻辑只写一遍。
- 关键理由：A、B、C 中真正难的 70% 是同一份——记忆 schema、写入与合并协议、上下文预算、工具适配；差异只在存储与运维。

### 5.2 选择

**采用 C。** 理由：

1. 首版功能完整度已覆盖全部核心需求，成本约为 B 的 1/3；
2. 「启动自动拉取」本质是客户端 hook 问题，Git 方案不比服务端方案多写多少客户端代码；
3. 团队规模（若干人）与仓库体量（纯文本）远未到 Git 的瓶颈；
4. 未来若需中心服务，只替换存储后端或加 MCP 前端，**客户端协议不变**。

### 5.3 已知取舍

- 单仓 = 所有团队成员可读所有项目记忆；不满足项目级保密。若未来出现需要隔离的项目，再拆仓或采用子模块。
- 并发写入依赖「按写入者分文件 + 派生内容重生成」，不引入数据库事务。
- Codex 在 hooks 不可用时的启动注入不是 100% 确定（见 §10.3），Claude Code 与启用 hooks 的 Codex 是确定的。

## 6. 总体架构

```
┌───────────────────── 开发者主机 A ─────────────────────┐
│  Claude Code ──SessionStart/SessionEnd hooks──┐        │
│                                               ▼        │
│                                          memsync CLI   │
│  Codex ──hooks 或 AGENTS.md + wrapper───►    │        │
│                                               │        │
│                               ~/.memsync/repo ◄────────┼──┐
└───────────────────────────────────────────────┘        │  │
                                                         │  │ git pull / push
┌───────────────────── 开发者主机 B ─────────────────────┐  │
│  Codex / Claude Code ─────────────────────► memsync CLI │  │
│                               ~/.memsync/repo ◄────────┼──┘
└───────────────────────────────────────────────────────┘  │
                                                           ▼
                                            公司私有 Git 托管（如 GitLab/GitHub）
                                            team-memory 仓库 = 唯一事实来源
```

组件职责：

| 组件 | 职责 |
|---|---|
| `memsync` CLI | 唯一的记忆读写实现：同步、渲染、记录、提案、发布、检索、自检 |
| 记忆仓库 | 事实来源；纯文本；Git 历史即审计日志 |
| 适配器 | 把各工具的启动/结束事件翻译成 CLI 调用；隔离工具差异 |
| 本地缓存 | `~/.memsync/cache/` 与工作区 `.memsync/`，用于离线与快速启动 |
| 受管 Markdown 块 | 写入 `CLAUDE.md` / `AGENTS.md` 的固定说明块，随 CLI 升级更新 |

**分层原则**：记忆模型（§7）、渲染（§9）、写回协议（§8）与具体工具无关；适配器只做格式转换与事件触发。

## 7. 记忆模型

### 7.1 仓库布局

```
team-memory/
├── README.md
├── .gitattributes                 # 全部文本 eol=lf，避免 Windows 噪声
├── org/
│   ├── conventions.md             # 全团队通用规范（跨项目继承）
│   └── people.yaml                # 姓名、角色、常用工具、项目 owner（可选）
├── projects/
│   └── <project-slug>/
│       ├── meta.yaml              # 项目元信息与代码仓映射
│       ├── constraints.md         # 权威约束（只能经 approve 修改）
│       ├── state.md               # 当前状态（派生区 + 人工备注）
│       ├── decisions/
│       │   └── ADR-0001-<title>.md
│       ├── proposals/
│       │   └── 2026-11-13-<id>.md
│       ├── versions/
│       │   └── 0.4.0.md
│       ├── journal/
│       │   └── 2026-11/
│       │       └── 2026-11-13/
│       │           └── 143205_alice_win-claude_ab12cd.md
│       └── archive/               # 压缩后的旧日志（内容不删除）
└── .memsync/                      # 可选：校验脚本、CI 配置
```

设计要点：

- **写入者分文件**：每个会话一个日志文件，文件名包含时间、用户、主机、工具、会话短 ID，天然避免并发写同一文件。
- **追加优先**：日志与提案只追加，不重写历史内容。
- **派生可重建**：`state.md` 的派生区、版本报告都可以从日志与 Git 重新生成，丢失可恢复。
- **权威文件受控**：`constraints.md`、`org/conventions.md` 只允许 CLI 在批准流程中修改。

### 7.2 会话日志格式

```markdown
---
id: ab12cd
project: checkout-service
user: alice
email: alice@corp.com
host: alice-laptop
tool: claude-code
session: 7f3c9a1e-...
started: 2026-11-13T14:32:05+08:00
ended: 2026-11-13T16:10:44+08:00
branch: feature/cart
workspace: E:\work\checkout-service   # 用于崩溃补全与 diff 统计
base_commit: 9f2c1ab                  # 会话开始时的 HEAD
version_hint: 0.4.0
commits: [3a1f2c9, 88de001]
files_changed: 14
insertions: 320
deletions: 41
outcome: completed        # completed | partial | blocked | abandoned | unknown
summary_source: ai        # ai | derived（AI 未写摘要时由笔记推导）
---

## 工作摘要

一句话说明本次会话推进了什么。

## AI 记录

- 15:02 [progress] 完成购物车合并逻辑，补充 6 个单测
- 15:40 [decision] 优惠券计算下沉到 domain 层，理由是避免接口层重复
- 15:58 [blocker] 支付重试依赖库存服务新接口，等待 bob 确认

## 未完成 / 交接

- [ ] 合并逻辑的并发场景需要压测
- [ ] 与 bob 对齐库存接口契约
```

- 会话开始时由适配器创建（front matter + 空章节），结束时补齐统计字段。
- `AI 记录` 由 AI 通过 `memsync note` 追加；每条带时间与类别。
- 不在日志中保存对话原文；摘要由 AI 自己写（它就在对话里，不需要额外模型）。

### 7.3 项目元信息

```yaml
slug: checkout-service
name: 结算服务
repos:
  - git@git.corp.com:shop/checkout-service.git
  - https://git.corp.com/shop/checkout-service.git
owners: [alice@corp.com]      # 以邮箱为准，approve 时据此校验
default_branch: main
current_version: 0.4.0        # 「当前版本」的唯一真相
version_status: active        # planning | active | frozen
context_budget_chars: 12000   # 约 3000 tokens
maintenance:                  # 后台维护策略，见 §8.5
  interval_hours: 72
  cooldown_hours: 6
  mainline_only: true
created: 2026-11-13
```

`repos` 用于工作区自动识别：SSH 与 HTTPS 地址视为同一仓库，匹配工作区任一 remote（不仅 `origin`）。

### 7.4 权威约束

```markdown
# 核心约束（权威）

<!-- 本文件只能通过 `memsync approve` 修改；直接编辑会被 `memsync verify` 报告。 -->

## 必须

- MUST 所有对外接口使用 `internal/contract` 中的 IDL 定义
- MUST 数据库迁移向前兼容至少一个版本

## 禁止

- MUST NOT 在 domain 层直接调用第三方 HTTP 客户端
- MUST NOT 提交任何真实用户数据到测试夹具

## 架构

- 服务分层：api → application → domain → infra
- 跨服务通信只允许同步 HTTP 与异步事件两种形式

## 常用命令

- 构建：`pnpm build`
- 测试：`pnpm test -- --runInBand`
```

每条约束可带可选子项，用于适用范围、例外与生命周期；渲染与 `verify` 都读取这些字段：

```markdown
- MUST 所有对外接口使用 internal/contract 中的 IDL
  - 适用：所有对外 HTTP/RPC 接口
  - 例外：legacy-report 模块（迁移截止 2026-12-31）
  - 状态：active
```

- `状态` 允许 `active` / `superseded`；被取代的条目**保留原文并标记**，不删除，保证审计可追溯。
- 没有子项时视为「全局、无例外、active」，绝大多数约束应保持这种简单形态。
- 注入时按「适用/例外」判断是否展示；AI 仍以 live code 与当前任务为准。

`org/conventions.md` 结构相同，作为所有项目的公共前缀注入（团队级 MUST / MUST NOT）。

### 7.5 提案

````markdown
---
id: 2026-11-13-a1b2
kind: constraint
project: checkout-service
author: alice
tool: claude-code
host: alice-laptop
status: proposed          # proposed | approved | rejected | superseded
created: 2026-11-13T15:40:00+08:00
---

## 提案内容

用一句话说明要改什么、为什么。正文供人阅读，**批准时只应用下面的结构化变更块**。

## 变更（approve 时确定性应用）

```yaml
change:
  file: constraints.md
  section: 禁止
  op: add                 # add | remove | replace | supersede
  section_hash: 4d1e9c    # 创建提案时目标小节的内容哈希
  match: ""               # replace/remove/supersede 必填：现有条目的精确文本
  items:
    - MUST NOT 在 domain 层直接调用第三方 HTTP 客户端
```

## 理由

当前两层各有一份重试逻辑，已经出现行为不一致……

## 影响面

infra/payment、api/order 两个模块需要重构，预计 1 天。

## 批准记录

（由 `memsync approve` 填写：批准人、时间、提交号）
````

- `approve` 先校验 `section_hash`：目标小节在此之后被人改过则拒绝，要求提案人重新基于最新内容生成提案，绝不「按散文猜意图」。
- `replace/remove/supersede` 还必须校验 `match` 精确命中唯一一条现有约束；`supersede` 会新增条目并把旧条目标记为 `状态：superseded`，旧条目保留。
- `kind: decision` 的提案没有 `change` 块，批准后由 CLI 按模板生成 `decisions/ADR-<NNNN>-<title>.md`（编号取现有最大号 +1）。
- 提案文件按 `id` 唯一，不同人不会写同一个文件。

### 7.6 版本与状态

- `versions/<version>.md`：版本目标、已交付项、按人聚合的贡献、遗留问题。
- `state.md` 的派生区由 `memsync state refresh` 从日志与版本文件重建：

```markdown
# 当前状态

<!-- memsync:derived:begin -->
- 当前版本：0.4.0（开发中）
- 进行中：alice — 购物车合并逻辑（11-13）；bob — 支付重试（11-12 起）
- 最近完成：11-12 bob — 库存接口联调
- 已知阻塞：支付重试等待库存服务接口
- 最近同步：2026-11-13T16:10
<!-- memsync:derived:end -->

## 人工备注

- 0.4.0 的发布窗口暂定 11-20
```

标记块之外的内容由人维护，CLI 不触碰。

## 8. 关键流程

### 8.1 启动同步（读路径）

```
工具启动
  → 适配器调用 `memsync hook session-start`（Claude Code；Codex hooks 可用时同理）
    或 `memsync sync`（Codex 无 hooks 时由 AGENTS.md 指令触发）
  → 获取本地锁（最多等 3s，超时则走缓存）
  → 若距上次同步 > 60s：git pull --rebase --autostash（5s 超时，失败则缓存）
  → 解析项目（§8.2）
  → 创建/复用会话记录，写入工作区会话指针（§8.3）
  → 渲染上下文包（§9）；当前状态由日志实时计算（§8.5），不依赖已提交的 state.md
  → Claude Code：以 JSON additionalContext 注入；Codex：打印到 stdout 进入对话
  → 更新 last_seen 游标
```

- 未绑定项目时：安静退出（exit 0），不注入任何内容，不打扰开发。
- 任一步失败：**绝不阻塞工具启动**；注入缓存包并附一行告警（如 `[memsync] 离线，使用 6 小时前的记忆`）。
- Claude Code hook 超时上限 30s，正常路径目标 ≤ 2s（缓存）/ ≤ 10s（需拉取）。

### 8.2 项目解析顺序

1. 从当前目录向上查找 `.memsync.json`（`{"project": "checkout-service"}`）；
2. 计算工作区的 **git common dir**（`git rev-parse --git-common-dir`），查本机缓存 `~/.memsync/state/repo-map.json`（`link` 时写入；linked worktree 与主工作区共享同一键）；
3. 读取工作区**任一** remote（优先 `origin`，其次 `upstream`），与 `projects/*/meta.yaml` 的 `repos` 做规范化匹配（SSH/HTTPS 视为同一仓库）；
4. 都失败 → 视为未绑定，输出提示 `memsync link <slug>`，不注入。

- 用 common dir 而非工作区路径，保证 linked worktree、detached HEAD、克隆到不同目录都识别为同一项目。
- Git 元数据损坏时**不按目录名猜项目**（团队记忆里同名目录很常见），直接视为未绑定并提示。
- `.memsync.json` 可提交进代码仓库，让全组自动映射；`memsync link` 生成它并提示提交。

### 8.3 写路径：会话与笔记

**当前会话的判定**（`note` 不带 `--session` 时），按优先级：

1. 显式 `--session <id>`；
2. 环境变量 `MEMSYS_SESSION`：
   - Codex 包装器设置，子进程与 AI 执行的命令都会继承；
   - Claude Code 的 SessionStart hook 在 `$CLAUDE_ENV_FILE` 可用时写入 `export MEMSYS_SESSION='<session_id>'`，后续 Bash 工具调用因此继承会话 ID（MemoraX 的 `memory-cli-session.mjs` 验证了该机制）；
3. 工作区会话指针 `.memsync/sessions/current-<tool>.json`：由 SessionStart hook / `session begin` 写入，含会话 ID、host、tool、cwd 哈希、开始时间、`base_commit`；作为没有 env file 时的兜底；
4. 以上都没有 → 隐式新建会话，标记 `implicit: true`。

有 `CLAUDE_ENV_FILE` 时，Claude Code 的会话归属是确定的；没有时退化为指针，同一工作区并发多个会话取最后开始者，CLI 检测到多活跃会话时提示并要求 `--session` 指定（限制见 §17）。Codex 有 hooks 时同理；无 hooks 时由 wrapper 的环境变量兜底。

**note**：

- `memsync note <kind> --text "..."` 追加到会话日志；`--text` 支持从 stdin 读入。
- 去重：以 `sha256(kind + text)` 为键，同一会话内重复内容直接忽略并提示，防止 AI 反复写同一条。
- 单条 note 上限 8KB；超出拒绝并要求拆成多条，避免把整段日志塞进记忆库。
- checkpoint：每 5 条 note（可配置）+ 会话结束 + Claude Code `PreCompact` hook 时做一次本地提交；同一会话连续 note 在 checkpoint 时合并为一次提交。CLI 是短命进程，不做时间触发；最坏丢失窗口 = 最近 4 条笔记。

**session end**（Claude Code SessionEnd / Codex Stop hook / Codex wrapper 退出时）：

1. 补齐 front matter：`ended`、分支、`commits`（`base_commit..HEAD` 中本会话新增的提交）、`files_changed/insertions/deletions`（`git diff --stat base_commit` + 工作区）；
2. `outcome` 与「工作摘要」：优先采用 AI 结束前通过 `memsync session summary --outcome ... --summary "..."` 写入的值；缺失时由 CLI 从笔记确定性推导（有 blocker → blocked；有未完成 todo → partial；否则 completed），标记 `summary_source: derived`；
3. 提交、`git pull --rebase`、push；
4. push 失败标记 `pending_push`，下次同步或 `status` 时重试。

会话开始时必须记录 `workspace` 与 `base_commit`，否则崩溃后无法确定对哪个 clone、从哪个点统计。

**崩溃补全**：超过 12 小时未结束的会话，下次同步时用 `base_commit`、文件 mtime 与 git 统计尽力补全，`outcome: unknown`、`summary_source: derived`。

**写入健壮性**（借鉴 MemoraX 的写回管线）：

- push 失败只对 timeout / 429 / 5xx 重试（最多 3 次，指数退避）；4xx 直接保留并提示，不盲目重试。
- 所有诊断与 trace 只记录会话哈希、内容哈希、长度与计数，不记录正文。
- 会话内的 note 在推送前按时间排序，保证日志可读；重复或乱序不会污染历史。

### 8.4 权威约束变更

```
AI 判断需要改约束
  → memsync propose constraint --title "..." --section "禁止" --op add --item "..."
  → 生成 proposals/<id>.md（含结构化 change 块与 section_hash），提交并推送
  → owner 审阅：memsync approve <id>
  → 校验 section_hash → 确定性应用变更 →（kind=decision 时生成 ADR）
  → 提交信息带 `Memsync-Approved-By: <email>` trailer，推送
```

- 批准采用**结构化变更块**（§7.5），不做自然语言解析；目标小节已被他人改动则拒绝，要求基于最新内容重新提案。
- **owner 校验**：调用者身份（§8.8）的邮箱必须在 `meta.yaml` 的 `owners` 中，否则**硬失败**；`--force` 可越过，但会写入提交信息与输出。该检查是本地约定，不是安全边界；真正的边界是 Git 仓库/分支权限与审计。
- **org 级约束**：`org/conventions.md` 由 `org/governance.yaml` 中的 `owners` 批准，流程相同。
- AI 被明确告知**不得直接编辑** `constraints.md`；受管块和上下文包里都写明。
- `memsync verify` 检查 Git 历史：若 `constraints.md` / `org/conventions.md` 的变更缺少批准 trailer，或出现绕过批准的直接修改，则报错；可挂到 pre-push 或 CI。
- 这不是密码学级强制，而是「默认阻止 + 可检测」；若托管方开启分支保护，见 §8.7。

### 8.5 版本、状态与报告

**当前版本的唯一真相是 `meta.yaml` 的 `current_version`。** 会话开始时 `version_hint` 自动取该值；单条笔记可用 `note --version <x>` 覆盖。`memsync version set <x> --status active|frozen` 负责开启或冻结版本；`release` 结束后把版本写入 `versions/<version>.md` 并将 `version_status` 置为 `frozen`，下一个版本由人显式开启，不自动递增。

- `memsync release <version>`：
  - 参数可选 `--code-repo <path> --since-tag v0.3.0 --to-tag v0.4.0`；
  - 从代码仓 Git 历史按作者聚合提交，与日志中带相同 `version_hint` 的条目合并；
  - 生成 `versions/<version>.md`（按人分组的交付项、提交数、主要文件），刷新 `state.md` 快照，提交推送；
  - 不自动打代码 tag，版本号由人指定，避免误操作。
- `memsync report --since 7d [--by person|version]`：输出站会用的文本报告，完全由日志与 Git 数据生成，不调用模型。

**state.md 的新鲜度与冲突**：

- 启动注入的「当前进度」**每次从近期日志与 `versions/` 实时计算**，不读已提交的 `state.md`，避免「快照过期导致 AI 看到旧进度」。
- 已提交的 `state.md` 只是供人浏览、评审与索引的快照，由 `release`、`state refresh` 或人手动刷新，**不在每次 session end 时写入**，避免所有主机争抢同一文件。
- 若拉取时 `state.md` 仍冲突：派生区可重建，CLI 自动取任一版本并立即按日志重新生成后继续 rebase；只有「人工备注」区冲突才中止并交给人。

**维护节奏（避免多主机争抢）**：`state.md` 快照、版本聚合与日志归档统一由 `memsync maintain` 执行，默认策略（可在 `meta.yaml` 的 `maintenance` 覆盖）：

- 仅当项目默认分支出现新提交（`mainline_only: true`）才触发；
- 距上次成功维护 ≥ 72 小时；
- 同一基线上失败后进入 6 小时冷却；
- `sync` 检测到到期时启动**分离的短任务**（detached，不阻塞启动）；失败只记录，不影响工具使用；下次同步再评估。
- 维护任务与写回使用不同锁，避免阻塞会话结束的 push。

### 8.6 冲突与离线

**冲突规避**（主要手段）：

- 日志文件按「用户 + 主机 + 工具 + 会话」唯一命名，同一文件只有一个写入者；
- `state.md` 派生区由 CLI 重新生成，不做手工合并；
- 权威文件单写者（批准流程），CLI 内加锁并自动 rebase 重试。

**冲突兜底**：若 `git pull --rebase` 仍冲突：

1. `git rebase --abort`，保留本地；
2. 输出明确指引：冲突文件、双方提交、可执行的 `memsync resolve` 建议；
3. 绝不自动丢弃任何一侧内容。

**离线**：

- 启动使用 `~/.memsync/cache/packs/<project>.md`，附过期时间告警；
- 写入照常本地提交，push 进入待发送队列；
- 网络恢复后的下一次同步先 push 再 pull，失败保留队列；
- `memsync status` 显示：上次同步时间、待推送提交、锁状态、仓库大小。

**并发**：

- 本机使用 `~/.memsync/lock` 文件锁串行化所有写操作与拉取；
- 跨主机靠 Git 推送的并发检查；push 被拒则 pull --rebase 后重试（最多 3 次，指数退避）。

### 8.7 推送策略

**已确认：记忆仓库默认分支允许团队成员直接 push，不强制 MR。** 这是「会话结束自动、即时可见」成立的前提，也是 v1 的实现口径。记忆仓库本质是追加式数据仓库，写入者分文件，权威文件另有批准流程，因此直推风险可控；`verify` 作为 pre-push / CI 兜底。

若未来托管策略改为强制 MR（v1 不支持，仅记录演进方向）：

- 配置 `push_mode: mr`：每个会话推到 `memsync/<user>/<session>` 分支并输出 MR 链接，由 owner/合并队列合并；
- 代价：他人看不到未合并的记录；`Memsync-Approved-By` trailer 在 squash merge 后可能丢失，`verify` 需改为检查 MR 元数据；
- 自动冲突重试、离线队列的语义都要相应调整。

### 8.8 身份来源

- **唯一来源**：`init` 时确定并写入 `~/.memsync/config.json` 的 `identity {name, email}`（默认从 Git 全局配置推导，必须有人确认）；同时写入记忆仓库的本地 `git config user.name/user.email`，使所有提交与身份一致。
- 缺失邮箱时 `init` 直接失败，不允许匿名写入。
- `host` 取 `os.hostname()` 的短名；日志文件名的用户段取邮箱 `@` 前部分，小写并只保留 `[a-z0-9-]`。
- `report --by person`、owner 校验、`seen` 游标都以**邮箱**为键（邮箱不区分大小写）。
- 本地身份可以被人为改写，这与 Git 提交身份的性质相同；团队边界由仓库权限与审计承担，CLI 只保证一致性。

## 9. 上下文渲染（token 预算）

**默认预算：12,000 字符（约 3,000 tokens），硬上限 24,000 字符。** 按字符而非 token 计算，避免依赖各模型的 tokenizer；中英文混排按较保守估计。

优先级与降级顺序（高 → 低）：

1. 身份与项目（1 行）
2. 团队通用规范摘要（`org/conventions.md` 的 MUST/MUST NOT 条目）
3. 项目核心约束（全部 MUST / MUST NOT；架构段按预算截断）
4. 当前状态（从近期日志与 `versions/` 实时计算，不读 `state.md` 快照）
5. 自你上次会话以来的变化（只放标题级摘要，每条 ≤300 字符，最多 8 条；完整内容用 `recall`）
6. 你的未完成事项（本人最近会话的 todo / handoff）
7. 最近的决策（最近 3 条 ADR 标题 + 一句话结论）
8. 写回说明（固定短块：note / propose / recall 的用法）
9. 参考索引（关键文件路径，供按需 `recall`）

**启动包是落地页，不是日志导出**：只放「现在必须知道的」——约束、当前进度、新变化摘要、未完成项、写回方式。历史细节、旧会话原文、PR/issue 证据都不进启动包，通过 `memsync recall` 按需取。

**`recall` 的读取预算**：默认最多 5 条命中，每条 ≤800 字符，总量 ≤4000 字符；按「相关度 + 时间」排序并标注来源文件与日期。`--all` / `--json` 才返回完整内容，且必须由人显式请求，避免一次检索重新灌满上下文。

预算不足时从第 9 项向上裁剪，裁剪处保留一行指针，例如：

```
… 已省略 4 条较早记录，需要时执行 `memsync recall "支付"`.
```

渲染结果示例（节选）：

```
[MemorySync] project=checkout-service version=0.4.0 synced=2026-11-13T16:10+08:00

## 团队规范（摘要）
- MUST 所有代码变更走 MR，不直接推 main
- MUST NOT 在日志中输出用户手机号

## 项目核心约束（必须遵守）
- MUST 所有对外接口使用 internal/contract 中的 IDL
- MUST NOT 在 domain 层直接调用第三方 HTTP 客户端
...

## 当前进度
- 版本 0.4.0 开发中；alice 在做购物车合并，bob 在做支付重试
- 阻塞：支付重试等待库存服务接口确认

## 自你上次会话以来
- 11-13 15:40 bob 完成库存接口联调；决策：重试上限 3 次

## 你的未完成事项
- [ ] 合并逻辑并发压测

## 写回方式
- 完成一项：`memsync note progress "..."`
- 关键决策：`memsync note decision "..."`
- 改约束：`memsync propose constraint --title "..." --section "..." --op add --item "..."`
- 查细节：`memsync recall "关键词"`
```

**自上次会话以来**的游标按「用户邮箱 + 主机 + 工具 + 项目」存于 `~/.memsync/state/seen.json`，成功注入后更新。加上主机与工具，是为了让同一个人在两台机器、两个工具上各自看到「本机上次以来」的变化，而不是互相吞掉更新。

## 10. 工具适配

### 10.1 适配器契约

每个适配器只需提供三件事：

1. 会话开始：调用 `memsync session begin --tool <name>`（或 `sync`），拿到渲染结果并注入；
2. 会话中：让 AI 能执行 `memsync note`；
3. 会话结束：调用 `memsync session end`。

工具差异（hook 机制、注入格式、指令文件位置）全部封装在适配器内。

### 10.2 Claude Code（确定性）

由 `memsync install --tool claude-code` 写入用户级 `~/.claude/settings.json`（建议用户级，使所有代码仓生效；也支持项目级）：

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "<abs-path>/memsync hook session-start", "timeout": 30 } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "<abs-path>/memsync hook session-end", "timeout": 30 } ] }
    ]
  }
}
```

- 写入时使用 CLI 的**绝对路径**（Windows 上尤其重要），避免依赖 PATH。
- `SessionStart` 输出 `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<上下文包>"}}`；无项目时输出空并 exit 0。
- `SessionStart` 在 `$CLAUDE_ENV_FILE` 可用时写入 `export MEMSYS_SESSION='<session_id>'`（同时带 tool/host），使后续 Bash 工具调用继承会话 ID；同时写工作区会话指针（§8.3）作为无 env file 时的兜底。
- `compact` / `resume` 触发时同样注入（resume 时额外带「你的上次会话」）。
- 可选注册 `PreCompact` hook：在上下文被压缩前做一次 checkpoint，降低笔记丢失风险。
- 在项目工作区 `CLAUDE.md` 写入受管块（固定说明：先读上下文、用 note 写回、不改 constraints、可 recall），升级时整体替换块内内容。

### 10.3 Codex（按版本探测，双路径）

Codex 的插件/hook 能力随版本变化。MemoraX Code 的 Codex adapter 已声明并使用 `SessionStart` / `UserPromptSubmit` / `Stop` hooks（见其 `hooks.json`），说明其目标版本支持；但不同安装方式与版本不能假设一致。因此适配器**先探测，再选路径**，安装命令输出实际选择的路径。

**路径 A：hooks 可用（首选，与 Claude Code 等价）**

- `memsync install --tool codex` 写入 Codex 插件 hooks：
  - `SessionStart` → `memsync hook session-start --tool codex`：同步、注入上下文包、写会话绑定；若探测到该事件不能注入，则只做同步与绑定，由 `UserPromptSubmit` 首轮注入；
  - `Stop` → `memsync session end`（或按轮次 checkpoint）；
  - 可选 `UserPromptSubmit`：用于「自上次以来」提醒或检索提示。
- 会话归属优先用 hook 提供的 session ID（env file 可用时写入 `MEMSYS_SESSION`），无 env file 时用指针。
- 验收标准与 Claude Code 一致。

**路径 B：hooks 不可用（降级）**

1. **受管指令块**：`memsync install --tool codex` 写入用户级 `~/.codex/AGENTS.md`（全局生效）：

```markdown
<!-- memsync:begin -->
## 项目记忆库（必须执行）
1. 会话开始时先运行 `memsync sync`，并遵循其输出中的约束与进度。
2. 完成一项工作、做出关键决策或遇到阻塞时，用 `memsync note <kind> "..."`
   写回（kind = progress | decision | blocker | todo | handoff）。
3. 不要直接编辑 constraints.md；需要改约束时用 `memsync propose`。
4. 需要项目细节时用 `memsync recall "<关键词>"`。
<!-- memsync:end -->
```

2. **启动包装器（推荐）**：`memsync run codex [-- args]`
   - 先同步并生成/刷新本地上下文包；
   - 设置 `MEMSYS_SESSION` 环境变量与会话记录；
   - 启动 codex，退出时自动 `session end`；
   - 它保证会话归属与会话统计，但不能强制把内容注入 Codex 的上下文——注入仍依赖第 1 层的指令。

3. **兜底**：若 AI 没有先执行 sync 而直接 note，CLI 隐式建会话；未结束的会话在下一次同步时尽力补全。

**支持口径**：先按路径 A 安装并做一次启动验证；探测失败才走路径 B。B 路径下记录可能标记 `implicit` / `derived`，安装文档必须写明差异，不能让人误以为与 A 等价。B 路径的启动注入依赖模型遵循 `AGENTS.md`，不是 100% 确定；若未执行 sync 的比例明显偏高，可启用「首次输入提示」开关：把上下文包作为初始用户消息传入（占用一次对话轮次，默认关闭）。

**能力探测（安装时执行一次，结果缓存到 `~/.memsync/state/capabilities.json`，按 Codex 版本与路径失效）**：

| 探测项 | 方法 | 判定 |
|---|---|---|
| Codex 版本 | `codex --version` | 记录，用于缓存与支持矩阵 |
| 插件系统 | `codex plugin --help`，再试 `codex plugin marketplace add <dir> --json` | 子命令存在且返回 JSON 结构合法 |
| hooks 子系统 | `codex app-server --stdio` → `initialize` → `hooks/list {"cwds":[workspace]}` | 返回 `data[].hooks` 即可用；`error.code === -32601` 即不支持 |
| Hook 信任 | `hooks/list` 的 `trustStatus` / `currentHash`；`config/batchWrite` 写入 `hooks.state.<key>.trusted_hash` | 安装时列出 hook key/事件/命令并确认；未信任不执行 |
| SessionStart 注入 | 临时 hook 在 `hookSpecificOutput.additionalContext` 放随机 nonce，`codex exec` 要求复述 | 输出含 nonce 即可注入；hook 执行但无 nonce → 只能执行不能注入 |
| UserPromptSubmit 注入 | 同上，事件换为 `UserPromptSubmit` | 参考实现已用此路径注入提醒，成功率更高 |
| env file | 临时 hook 只导出环境变量名（不导出值），在会话内 shell 检查候选变量 | 找到会话 env file 才使用；找不到就走指针 |

- 探测使用**独立的临时 `CODEX_HOME` 与临时工作区**，10 秒超时，结束后清理；不读取、不打印用户配置内容。
- 任何一项不确定都**按降级处理**（路径 B 或指针），绝不默认假设支持。
- 探测结果写入 `memsync doctor --json`；Codex 升级或启动失败时重新探测。
- 参考实现：MemoraX 的 `plugin-hooks.ts` 用 `app-server` 的 `hooks/list` 与 `config/batchWrite` 完成同样的判断与信任写入，可作为兼容性测试样本。我们**直接沿用这套协议探测与信任流程**，差异是不引入它的常驻 Backend，并额外增加「注入」与「env file」两项行为探测。

### 10.4 兼容性矩阵

| 能力 | Claude Code | Codex（hooks 可用） | Codex（降级） |
|---|---|---|---|
| 启动自动拉取 | 确定（SessionStart） | 确定（SessionStart） | 受管指令 + wrapper（高概率） |
| 会话结束自动记录 | 确定（SessionEnd） | Stop hook | wrapper 退出；否则下次同步补全 |
| 会话归属 | env file + 指针兜底 | hook env / 指针 | wrapper env / 指针 |
| AI 写回 | `memsync note`（上下文中告知） | `memsync note`（上下文中告知） | `memsync note`（AGENTS.md 中告知） |
| 项目指令文件 | `CLAUDE.md` 受管块 | Codex 插件/`AGENTS.md` | `AGENTS.md` 受管块 |
| 安装方式 | 写 `~/.claude/settings.json` | 写 Codex 插件 hooks | 写 `~/.codex/AGENTS.md` + 建议别名 |

## 11. CLI 命令面

| 命令 | 作用 |
|---|---|
| `memsync init` | 首次配置：克隆/定位记忆仓库、设置身份、生成全局配置 |
| `memsync project add <slug> --repo <url> --owner <email>` | 注册项目（owner 用邮箱） |
| `memsync link [slug]` | 把当前工作区绑定到项目，生成 `.memsync.json`，安装适配 |
| `memsync install --tool <claude-code\|codex> [--scope user\|project]` | 安装 hook / 受管块 / 包装器；Codex 先探测 hook 能力，输出实际路径 |
| `memsync sync` | 拉取并输出上下文包；检测到维护到期时启动分离的短任务 |
| `memsync hook session-start` / `session-end` | Claude Code / Codex hooks 入口（读 stdin JSON，含 PreCompact checkpoint） |
| `memsync run <tool> [-- args]` | 包装器：同步 → 建会话 → 启动 → 收尾（Codex 降级路径的推荐入口） |
| `memsync session begin\|end\|summary` | 会话生命周期；`summary --outcome ... --summary "..."` 由 AI 在结束前写入 |
| `memsync note <kind> "<text>" [--session <id>]` | 追加结构化笔记（stdin 亦可；并发会话时显式指定） |
| `memsync propose <constraint\|decision> ...` | 提交带结构化变更块的提案 |
| `memsync approve <id> [--note "..."] [--force]` | 校验 owner 与 section_hash，确定性应用；`--force` 记入审计 |
| `memsync version set <x> --status <planning\|active\|frozen>` | 开启/冻结当前版本（`meta.yaml` 为唯一真相） |
| `memsync release <version> [--since-tag ...]` | 生成版本记录与报告 |
| `memsync state refresh` | 重建供人浏览的 `state.md` 快照（注入不依赖它） |
| `memsync maintain [--check]` | 按策略刷新状态快照、版本聚合与日志归档；`--check` 只报告是否到期 |
| `memsync report --since <7d\|date>` | 生成按人/版本的进度报告 |
| `memsync recall <query> [--all]` | 全文检索；默认 5 条 × 800 字符、总量 4000 字符，`--all` 才返回完整内容 |
| `memsync status` | 同步状态、待推送、锁、仓库体积、维护到期情况 |
| `memsync doctor` | 诊断 git 凭据、hook 安装、Codex 能力探测结果、仓库健康、时钟偏移 |
| `memsync verify` | 校验约束变更批准、日志 schema、文件命名 |
| `memsync compact --before <date>` | 归档旧日志（只移动，不删除） |

配置位置：

- 全局：`~/.memsync/config.json`（仓库路径/远程、身份覆盖、默认预算、安装状态）
- 工作区：`.memsync.json`（项目 slug、预算覆盖；可提交）
- 工作区运行时：`.memsync/`（`sessions/` 会话指针、缓存、锁；加入 `.gitignore`）

## 12. 安全与隐私

- **仓库即边界**：记忆仓库放在公司私有 Git 托管，成员权限 = 记忆可见范围；单仓意味着全员可见（本设计接受的取舍，见 §17.1）。
- **默认不存对话**：只存结构化摘要、笔记、统计；不复制 transcript。
- **密钥拦截**：`note` / `propose` 入库前做模式匹配（`sk-`、`ghp_`、`AKIA`、PEM 私钥块、常见 token 形态、超长高熵串），命中则拒绝写入并提示，`--allow-raw` 需显式确认且记入日志。
- **敏感数据规范**：在 `org/conventions.md` 写明「不得把用户数据、生产凭据、客户信息写入记忆库」。
- **不联网**：除 Git 远程外无任何外部请求；无遥测；不依赖任何 LLM API。
- **诚实边界**：密钥拦截是启发式，不是保证；仓库访问控制是最终防线。
- **审计**：每次写回都是 Git 提交，作者为本人，提交信息含项目、会话、工具；`git log --stat` 即可追溯。
- **删除**：`compact` 只移动不删除；如需真删，走 Git 历史重写流程（明确、少见、由管理员执行）。

## 13. 失败模式与降级

| 失败场景 | 行为 |
|---|---|
| 未安装 / 未初始化 | hook 静默 exit 0；不打扰开发 |
| 工作区未绑定项目 | 不注入；提示 `memsync link` |
| 无 Git 凭据 / 拉取失败 | 用缓存包 + 过期告警；不影响启动 |
| 离线 | 本地记录与提交；push 排队 |
| push 被拒（他人先推） | pull --rebase 后重试 3 次；仍失败则保留本地并提示 |
| 真正的文本冲突 | 中止 rebase，保留双方，输出可操作指引；不自动丢内容 |
| 仓库损坏 | `doctor` 检测；重新 clone 到新目录（缓存可重建） |
| 同一用户多主机并发 | 文件按主机区分；各自推送 |
| 同一主机、不同工作区并发 | 文件锁 + 会话 ID 区分，互不影响 |
| 会话崩溃未收尾 | 下次同步按 mtime + Git 统计补全，标记 unknown |
| hook 超时 | 30s 上限，内部拉取 5s 超时；超时走缓存 |
| 上下文过大 | 按优先级裁剪，留指针；硬上限 |
| 时钟偏差 | 以 Git 提交时间为准校正；doctor 告警 |
| Windows 换行 / 编码 | 仓库 `.gitattributes` 强制 LF；CLI 统一 UTF-8 |
| 记忆仓库增长 | `compact` 归档；`status` 显示体积与告警阈值（默认 100MB） |
| 同一工作区并发多个会话 | Claude 用 `CLAUDE_ENV_FILE` 隔离；无 env file 时指针取最后开始者，提示并要求 `--session`；Codex hook/wrapper 用环境变量 |
| `CLAUDE_ENV_FILE` 不可用 | 退回会话指针；检测到多活跃会话时提示 `--session` |
| Codex 版本不支持 hooks | 自动降级到 `AGENTS.md` + `memsync run codex`；安装输出明确路径 |
| Hook 未信任 / hash 变化 | `hooks/list` 显示 `untrusted` 或新 hash，要求重新确认；旧信任不生效 |
| 会话结束 AI 未写摘要 / outcome | 由笔记确定性推导，标记 `summary_source: derived` |
| 重复 note | 按 `sha256(kind+text)` 在会话内去重，直接忽略 |
| `state.md` 派生区冲突 | 自动取任一版本并按日志重建后继续 rebase；人工备注区冲突才中止 |
| 维护任务失败 / 超时 | 只记录，不阻塞工具；按冷却策略下次重试，快照可能短暂陈旧 |
| 托管方强制 MR | `push_mode: mr`，记录延迟可见；需 owner/合并队列配合（见 §8.7） |

## 14. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript + Node.js ≥ 22（本机 24） | 已在开发机；跨平台；hook 调用方便 |
| CLI 框架 | 轻量（commander 或手写解析） | 命令面不大，避免重依赖 |
| 数据格式 | Markdown + YAML front matter | 人类可读、可评审、Git diff 友好 |
| Git 操作 | `child_process` 调用系统 git | 复用凭据、行为可预期、无原生依赖 |
| 锁 | 基于 `O_EXCL` 的文件锁 | 零依赖、跨平台 |
| 检索 | 逐文件全文匹配（优先调用 `rg`，无则内置扫描） | 仓库小，无需向量库 |
| 测试 | Vitest + 临时 bare 仓库做集成测试 | 能真实模拟多主机并发 |
| 打包 | esbuild 单文件 bundle + `bin` 入口 | 安装简单；hook 用绝对路径 |
| 分发 | 内部 npm registry 或从 Git 安装；`memsync install` 自检 | 团队规模小，不引入安装器 |
| CI | 可选：`memsync verify` 作为 pre-push 或 CI 检查 | 约束治理的兜底 |
| 后台维护 | 分离的短进程（`spawn` detached），无常驻守护 | 需要延迟/定时任务，但不引入服务 |

不引入：数据库、ORM、HTTP 框架、MCP SDK、向量库、云服务。

## 15. 测试与验收

### 15.1 测试策略

- **单元**：front matter 解析、schema 校验、渲染预算与裁剪顺序、redaction、项目解析、文件名生成、时间处理。
- **集成**：临时 bare 远程 + 两个克隆，模拟两名用户、两台主机、两种工具；覆盖并发写、离线、push 拒绝、冲突中止、会话补全。
- **适配器**：用固定的 Claude Code hook stdin JSON 样本验证输出结构；验证 `CLAUDE_ENV_FILE` 导出与 session 绑定；用假的 `codex` 可执行文件验证 wrapper 的环境变量、会话生命周期与退出码透传；模拟无 hooks 的 Codex 验证降级路径。
- **回归**：Golden file 校验上下文包布局，避免无意膨胀。
- **Windows**：CI 至少一个 Windows runner；路径含空格、中文用户名、CRLF 场景。

### 15.2 验收场景（必须全部通过）

1. 新机器：`init → link → 启动 Claude Code`，注入内容含团队规范、项目约束、当前版本与进度，耗时 ≤ 10s（不含首次 clone）。
2. 两名开发者同一分钟各写 3 条笔记并结束会话（默认直接推送模式）：双方均成功推送；pull 后 6 条记录齐全、作者与主机正确，无人工冲突。
3. AI 直接修改 constraints.md 并提交：`verify` 报错并指出提交；经 `propose → approve` 的修改则通过。
4. 离线启动：注入缓存包且带过期告警；恢复网络后自动补推。
5. 会话结束：日志包含起止时间、分支、提交、diff 统计、笔记；`report --since 1d` 能按人列出。
6. 未绑定工作区启动：无注入、无报错、工具正常工作。
7. 默认上下文 ≤ 12,000 字符；超长时按优先级裁剪且保留索引指针。
8. 含 `sk-...` 的笔记被拒绝写入并给出提示。
9. Codex：hooks 可用时（路径 A）连续 10 次启动，10/10 产生完整会话记录（归属、分支、提交统计、收尾）；hooks 不可用时（路径 B）包装器模式 10/10 完整，非包装器模式至少 8/10 执行了 sync 并留下记录，未完整的记录明确标记为 `implicit` / `derived`。
10. `doctor` 在缺少凭据、hook 路径失效、仓库体积超阈值时给出可执行建议。
11. 会话归属：同一工作区并发两个 Claude 会话，`CLAUDE_ENV_FILE` 可用时各自 `note` 落到正确会话；不可用时给出提示并要求 `--session`。
12. `recall` 默认最多 5 条、每条 ≤800 字符、总量 ≤4000 字符；只有 `--all` / `--json` 才返回完整内容。
13. 约束适用条件：带「适用/例外」的约束按条件注入；`supersede` 后旧条目标记 `superseded`、新条目生效，旧条目仍可检索。
14. 维护策略：非主线提交不触发；72 小时内重复 `sync` 不重复维护；维护失败不阻塞启动，`status` 显示到期与冷却状态。
15. Codex hook 信任：未信任的 hook 不执行；确认后 `hooks/list` 显示 trusted；升级导致 hash 变化时必须重新确认，旧信任不生效。

## 16. 实施里程碑

| 阶段 | 内容 | 退出标准 | 估时 |
|---|---|---|---|
| M1 基础 | 仓库脚手架、配置、身份、项目解析、`init/link/status`、schema | 能在临时仓库完成初始化和绑定 | 3–4 天 |
| M2 读路径 | `sync`、渲染器、预算裁剪、缓存、Claude Code SessionStart hook、`CLAUDE_ENV_FILE` 绑定 | 验收场景 1、6、7、11 通过 | 3–4 天 |
| M3 写路径 | 会话记录、`note` 去重、checkpoint、`session end`、push/重试、离线队列 | 验收场景 2、4、5 通过 | 4–5 天 |
| M4 Codex | hook 能力探测与信任、路径 A hooks、路径 B 受管 AGENTS.md + `run` 包装器、隐式会话 | 验收场景 9、15 通过 | 3–4 天 |
| M5 治理与报告 | `propose/approve/verify`、`supersede`、`release`、`state refresh`、`report`、`recall` 预算 | 验收场景 3、8、12、13 通过 | 3–4 天 |
| M6 加固 | `maintain`、`doctor`、`compact`、Windows CI、文档与上手指南 | 验收场景 14 + 全部场景 + 新机器 15 分钟接入 | 3–4 天 |

总计约 4 周（单人）。M1–M3 完成即可内部试用（Claude Code 全流程可用），M4 后双工具可用。

## 17. 已知取舍与设计决定（供评审）

1. **一个团队一个记忆仓库**：运维最简单、跨项目可检索；代价是所有成员可见所有项目记忆。若需隔离，后续按项目拆仓（CLI 已按项目 slug 组织，迁移成本低）。
2. **不存对话原文**：保护隐私、控制体积；代价是丢失一些上下文细节，由 AI 自写摘要补偿。
3. **不自动生成摘要**：不引入模型 API，摘要由正在对话的 AI 自己写，统计由 Git 提供；代价是日志质量依赖 AI 的自觉与指令质量。
4. **不做合并驱动**：用唯一文件名 + 派生重建消除绝大多数冲突；少数冲突宁可中止也不自动合并。
5. **默认预算 3000 tokens**：可按项目调整；宁可少而准，不让 AI 忽略约束。
6. **Codex 按版本探测**：不是固定「半自动」；hooks 可用时与 Claude Code 等价，不可用时才降级为 AGENTS.md + wrapper。差异由适配器吸收。
7. **版本号人工指定**：不自动打 tag，避免把版本语义交给工具猜测。
8. **Node/TypeScript**：依据现有环境选择，便于 hook 与跨平台分发；若团队更偏 Python 可替换，核心协议不变。
9. **验证而非强制**：约束治理是「默认阻止 + 可检测」，不做密码学签名；真正的边界是仓库写权限与审计。
10. **单文件 bundle 分发**：`memsync install` 写入绝对路径，规避 Windows PATH 问题。
11. **同一工作区并发 Claude Code 会话**：有 `CLAUDE_ENV_FILE` 时确定性隔离；没有时指针只能指向最后开始者，可能造成归属歧义，需 `--session`。
12. **owner 校验是本地约定**：可被本机使用者绕过；只用于防误操作，不承担安全职责。
13. **直接推默认分支**：已确认记忆仓库不强制 MR；若未来托管策略变化，需改 `push_mode` 并接受可见性下降（§8.7）。
14. **摘要质量依赖指令与 AI 自觉**：缺失时只能确定性推导（blocked/partial/completed），不会编造细节。
15. **同一人跨主机的「自上次以来」各自独立**：两台机器可能各看一遍相同更新；这是为避免漏看而接受的重复。
16. **启动包不是全量记忆**：历史细节依赖 AI 主动 `recall`；用「自上次以来」和索引指针提高触发率，但不保证 AI 一定查。
17. **约束适用条件增加写作成本**：默认保持「全局、无例外」；只有确实有范围/例外的约束才写子项。
18. **维护是分离短任务**：失败不影响主流程，但快照可能短暂陈旧；需要即时准确时手动 `state refresh`。
19. **`CLAUDE_ENV_FILE` 并非所有环境都提供**（远程/容器/旧版本）；会话指针兜底仍保留。
20. **不引入常驻 Backend**：相比 MemoraX 少一个进程，但也就没有定时 flush、轮次内存状态与异步队列；用 checkpoint + 分离短任务折中。

## 18. 留给实现者的自由度

- CLI 参数解析、日志文案、渲染器的内部结构、缓存文件格式；
- 测试夹具的具体构造、CI 配置；
- `recall` 的排序细节（默认按相关度 + 时间，具体权重由实现者定）；
- 受管 Markdown 块的具体措辞（但必须包含：先读上下文、写回方式、不改权威文件、recall 入口）；
- Windows 下的安装细节（绝对路径、shell 选择、编码）；
- 是否提供 shell 别名 `claude` / `codex` 的包装（默认只提供 `memsync run`，别名由用户自选）。

## 19. 落地前需要补齐的运营信息（不阻塞设计批准）

1. **托管地址与访问方式**（GitLab / GitHub / 自建，SSH / HTTPS）——影响 `init` 的默认配置与文档。
2. **各项目 owner 的邮箱**——写入 `meta.yaml`，用于批准校验。
3. **首个试点项目**——用于 M1–M3 验证与验收场景取材。
4. **确认团队接受「单仓全员可见」**——你已选择全团队一个仓，这里只确认可见性范围；若不接受需按项目拆仓。
5. **各开发机的 Codex 版本与插件/hook 支持情况**——用于验证 §10.3 路径 A，并决定是否保留 wrapper 作为默认。

## 附录 A：对 MemoraX Code 的借鉴与取舍

参考项目：`E:\memorax-code-main`。它的定位是「个人/仓库作用域的跨工具记忆」，不是团队共享库；以下只记录机制层面的借鉴。

### A.1 已吸收

| 机制 | MemoraX 的实现 | 在 MemorySync 中的落点 |
|---|---|---|
| Hook 会话绑定 | Claude `memory-cli-session.mjs` 通过 `CLAUDE_ENV_FILE` 导出会话 ID | §8.3、§10.2 |
| Codex hook 能力 | Codex adapter 使用 SessionStart / UserPromptSubmit / Stop | §10.3 路径 A |
| 渐进披露 | `PROFILE.md` 落地页 + 3–7 概念页 + 资源路由卡 + raw 证据，读取有预算 | §9 启动包与 recall 预算 |
| 机械证据 + AI 叙事 | 脚本采集 commit/PR/issue，agent 写 wiki，脚本校验 | §7 统计 + AI note + §11 `verify` |
| 写回健壮性 | 去重、缓冲、分块、有限重试、脱敏 | §8.3、§8.6 |
| 约束适用条件 | personal memory 的 `applies_when` / `do_not_apply_when` / status | §7.4、§7.5 |
| 维护策略 | 主线提交、72 小时、冷却、后台子任务 | §8.5、§11 `maintain` |
| 作用域身份 | git common dir + remote + worktree | §8.2 |
| 无内容诊断 | 哈希会话/内容、只记计数 | §8.3、§8.6 |
| 信任等级 | live code/tests > memory > commit/PR > issue | 注入说明与 `org/conventions.md` |

### A.2 未采用

| 机制 | 不采用的原因 |
|---|---|
| 远端 SaaS 记忆 API | 我们要求内网、Git、无中心服务 |
| 自动保存 user/assistant 原文 | 隐私与体积；只存结构化笔记与统计 |
| 9 客户端 + 常驻 Backend | 范围只有 Claude/Codex；不引入守护进程 |
| LLM 语义路由 / rerank | 不引入模型 API 与额外密钥 |
| Repo Memory 全量 wiki 生成 | 以日志/状态为主；完整仓库 wiki 可作为后续模块 |
| Work Memory 文档索引 | 超出项目记忆范围 |
