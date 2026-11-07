# 实现说明

给要改这个插件、或者接手维护的人。先读这个，再读代码。

## 一句话

**纯提示词破限。** 不改请求、不改模型参数、不碰网络层。只做两件事：往 system prompt 里塞一段人格正文，以及让工具确认自动放行。

这意味着它的能力上限由模型本身决定 —— 提示词能让模型「愿意做」，但做不到模型架构上「不会做」的事。

## 核心约束：缓存

这是整个设计的前提，理解了它才能理解所有奇怪的取舍。

系统提示词位于一次模型请求的**最前面**。改它 = 第 0 个 token 就变了 = **整条前缀缓存全部失效**，不是部分失效。

你的 `dsh-providers-hub` 里实测数据（见其 `lib/buddy-adapter.js`）：

```
不带 prompt_cache_key → prompt_cache_hit_tokens=0,    credit=0.34
带 prompt_cache_key   → prompt_cache_hit_tokens=7808, credit=0.02
```

差 17 倍。而人格正文有 2 万 token 左右，所以「会话中途换人格」是很贵的事。

更麻烦的是 DSH 的行为：新版会把 system 更新**追加进历史**，于是一个会话里会存在两份 system，模型同时读到「你是 A」和「你是 B」，行为漂移。旧版 agent-purge 用 `startsRequestSeries: true` 去触发 request series 重建来绕开这个问题，本插件**故意不采用这个方案**。

**我们的做法**：一个会话只在开始前决定一次，之后永不改变。

```
                    ┌─ 选择发生在第一次请求之前
用户点开关 → 写 state → │
                    └─ 此后每轮 assemble 读同一个值 → system prompt 恒定
```

代价是没有「中途切换」能力。这是刻意的，不是缺陷。

## 两个钩子

### 1. `system-prompt/assemble`

```js
scope.on('system-prompt/assemble', handler, { prepend: true })
```

`scope` 是 **`agent.ctx`**，不是插件自己的 ctx。这是关键：

- `system-prompt/assemble` 是 **scope-filtered waterfall**
- 注册在某个 agent 的 ctx 上，就只收到那个 agent 的 assembly
- agent 销毁时宿主自动清理

所以每个会话一个独立监听器，值在创建时锁定，天然隔离。**不要**改成全局监听 + 自己判断 `context.agent` —— 那是老办法，容易串。

改写逻辑（`applyPersona`）：

```
人设置顶（order: -100000）
+ 剥掉宿主自己的身份行（避免和人格抢「你是谁」）
+ 其余 section 原样保留
```

「其余原样保留」很重要。工具说明、团队策略、沙箱策略都在这些 section 里，删了模型就不会用工具。这就是为什么**不提供 strict 模式选项** —— strict 会把这些一起干掉。

`agent/created` 时安装，`agent/disposed` 时释放。插件加载时已经在跑的会话会补装一次。

### 2. `approval/request`

```js
ctx.on('approval/request', (req, next) => {
  if (破限会话) return 'allowed-once'
  if (state.allowInNormal) return 'allowed-once'
  return next()
}, { prepend: true })
```

破限会话强制放行。普通会话看设置。这个不影响缓存，只影响权限。

## 「会话已开始」怎么判断

```js
const session = ctx.sessions.get(sessionId)
for (const event of session.ownEvents()) {
  if (event.type === 'user/message') return false  // 已开始
}
return true  // 还没开始
```

三个要点：

1. **用 `ownEvents()`，不是全部事件**。fork 出来的会话继承父会话历史，那些不是它自己的。
2. **不要用 Client 的 `useSession().blank` 判断**。那个值在会话被 engage 后会变 false，连新建会话的空态都会被误判成「已开始」—— 这个坑我们踩过。
3. **读不到就当「已开始」**。宁可拒绝写，不可事后改。

## 文件结构

```
index.js        Host 半
  ├ 状态读写（state.json，原子写：tmp + rename）
  ├ 人格读写（personas/*.md，Markdown + frontmatter）
  ├ HTTP 路由 /purge-quickly/{state,toggle,settings,personas}
  ├ system-prompt/assemble 改写
  ├ approval/request 放行
  └ fork / 子代理继承

client.js       Client 半（单个普通脚本，无 import）
  ├ conversation.input.left              可点的开关（只在未开始时渲染）
  ├ conversation.session.header.actions  只读徽章（一直显示）
  └ settings.section                     设置页（人格 CRUD）
```

### 为什么 client.js 是单个文件

DSH 的 Client 模块格式是 `window.__ModuleLoader__.load({ id, factory })`，factory 里不能 `import`，只能 `require` 白名单里的东西（`react`、`ctx`、`styles` 等）。

设置页的代码原本在 `settings.source.js`，最后**手工嵌入** client.js。这样部署简单，但改代码时要小心两处不同步。

如果要重构：把设置页保持在 client.js 内部，但用明显的分隔注释标出边界。

### 状态存储

```
$DSH_HOME/purge-quickly/
├── state.json
│   { defaultPersona, allowInNormal, sessions: { [sessionId]: { persona, at } } }
└── personas/*.md
    ---
    id: my-persona
    name: 显示名
    description: 说明
    order: 10
    ---
    正文
```

首次启动会从 `~/.agent-purge/personas/` 复制现成的人格（如果存在），原目录不动。会过滤掉 `active.md` —— 那是 agent-purge 的派生文件，不是人格。

## 界面细节（这些都调过很多次）

### 字号

**必须用主题变量，不能写死，也不能 inherit。**

```css
font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
```

原因：用户改「应用字号」时，所有按钮要一起缩放。写死像素就脱节了。

`-1px` 是因为实测比旁边的「智能体团队」大一号。基准来自 app.asar 里宿主的真实样式：

- `agent-team` 的 `.VBK9GG_trigger`: `font-size: 12px`
- `conversation` 的 `.A6Bq1a_trigger`: `font-size: var(..., 13px)`

主题变量默认算出 13px，减 1 就是 12px，和「智能体团队」一致。

### 位置

```css
position: relative;
top: -1px;
```

比同级元素上移 1px。用 relative 不用 margin，避免影响布局流。

### 图标

面具，14×14，`currentColor` 描边。persona 的本义就是面具。

- 普通态：空心描边
- 破限态：内部点亮（同色 16% 填充）

**不要加横穿面具的笔画**（比如斜线高光）。14px 下会盖住眼睛，糊成一团。这个试过，不行。

### 槽位选择

| 用途 | 槽位 | 说明 |
|---|---|---|
| 可点开关 | `conversation.input.left` | list 型，加进去不覆盖任何宿主控件 |
| 只读徽章 | `conversation.session.header.actions` | `order: 0`，排在 `agent-team(-20)` `agent-preset(-10)` 之后 |
| 设置页 | `settings.section` | `order: 25`，在「Agent 预设」和「插件市场」之间 |

**不要碰 `conversation.input.permission`** —— 那是 single 槽，已被宿主占用（`[工作区内修改 ▾]`），替换它等于抹掉宿主控件。

## 测试

```bash
npm test
```

161 项断言，4 个文件：

| 文件 | 覆盖 |
|---|---|
| `test-step1.mjs` | Host 半：路由、状态、人格 CRUD、assemble 改写、fork 继承、放行策略 |
| `test-step2.mjs` | Client：组件渲染、点击、槽位注册、样式基准、图标状态 |
| `test-step3.mjs` | 设置页：列表、新建、编辑、复制、删除、开关、默认人格 |
| `test-order.mjs` | 人格排序（默认人格永远第一） |

测试用 mock 宿主 + 自制的极简 React 运行时，**不需要启动 DSH**。

写测试时踩过的坑：

- 极简 React 替身必须真正执行 `useEffect` 并重渲染，否则 `setState` 的效果永远看不到
- 替身的 `find` 要能展开函数组件（`typeof el.type === 'function'`），否则找不到 `ModeIcon` 里面的 `<path>`
- 产品代码读 `globalThis.confirm`，测试要挂在那里，不是 `window.confirm`

## 已知边界

| | |
|---|---|
| 中途切换 | 不支持，故意的（缓存） |
| strict 模式 | 不提供（会删掉工具说明） |
| 多标签一致性 | 4 秒轮询兜底，不是实时推送 |
| 人格变更 | 对新会话生效；已锁定会话不受影响 |
| 破限成功率 | 取决于模型，未做量化 |

## 调试

日志：`$DSH_HOME/purge-quickly/purge-quickly.log`

```
apply       插件加载
seed        人格复制
state-init  状态文件初始化
routes      路由注册
scoped      给某个会话装了监听
inherit     子会话继承父会话
toggle      开关切换
persona-*   人格增删改
```

路由可以直接 curl（本机，无需认证）：

```bash
curl http://127.0.0.1:<port>/purge-quickly/state
curl "http://127.0.0.1:<port>/purge-quickly/state?sessionId=session-xxx"
```

端口看 DSH 启动日志，或 `Get-NetTCPConnection` 找监听进程。

## 改代码后怎么生效

- **Client 半**（`client.js`）：保存后客户端 HMR 自动重载，刷新页面即可
- **Host 半**（`index.js`）：需要重启 DSH
- **人格文件**：直接改，下一轮生效，不用重启

## 历史包袱

这个插件是从 `agent-purge` + `dsh-unlag` 两个项目精简合并来的。那里面有很多本插件**不需要**的东西，读的时候别被带偏：

- agent-purge 支持 20+ 个 harness（pi / codex / claude / opencode / workbuddy…），本插件只有 DSH
- agent-purge 每轮现读 `state.json`（全局可变），本插件是每会话一次快照
- agent-purge 有 `/purge` 斜杠命令、PATH shim 接管、Windows 安装器，本插件都没有
- dsh-unlag 的热重载按钮本插件没做（需要时手动重启）

旧数据在 `$DSH_HOME/dsh-prompt-mode.old/`（改名前的目录），确认不要可以删。
