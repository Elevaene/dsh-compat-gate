# dsh-compat-gate

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

在更新 dsh 之前，先说清楚哪些插件会坏；在装插件之前，先说清楚现在装不装得进去。

dsh 生态里，宿主和插件各自跑各自的版本线。每次 dsh 提示"有新版本"，你都要在"想更新"和"怕插件集体报废"之间赌一把——赌输了就是一堆插件静默失效，而且往往在你要用它们的那一刻才发现。

这个插件把那两把赌注换成确定答案，全部离线静态判定，不加载、不试跑任何别人的插件。

## 它解决什么问题

| 你在什么时候犯难 | 它给什么 |
|---|---|
| dsh 弹窗说 0.2.2 可以更新，我该点吗？ | 逐插件列出「相容 / 会失效 / 无法判断」，给出「可以更新 / 建议暂缓」的结论 |
| 已经更新了，到底哪个插件坏了？ | 用真实运行的宿主复核，与上次记录对比，输出「确认失效 N 个」的实证清单 |
| 市场里这个插件刚发布，为什么装不上？ | 查 pnpm 的发布等待期，告诉你还差几小时、或者已被豁免、或者查询不到 |
| 这些判断凭什么信？ | 每条结论都标出它依据的声明原文和范围，没有任何一条是猜的 |

## 功能

- **更新前判定** `check` —— 读 `app-update.yml` 找到更新源，拉取目标版本，逐个插件比对兼容声明，写入账本。
- **更新后复核** `audit` —— 用当前真实宿主版本重算全部插件，与账本上一次的结论对比，`上次相容 → 现在会失效` 的就是实证失效清单。
  dsh 更新完第一次启动时会自动跑一次（比对账本里记录的宿主版本），面板直接显示"确认失效"清单，不用记得敲命令。
  没触发复核时（宿主版本没变），那一栏照样显示账本里记着的上次宿主，不会退化成两个短横让人以为没记住。
- **会失效就给命令** —— 市场最新版声明覆盖目标版本时，直接给出可复制的一行 `dsh plugin --profile <name> add <包>@<版本>`；覆盖不了就不给，免得乱指挥。
- **历史账本** `ledger` —— 每次检查的宿主版本、目标版本、逐插件结论都留档，可回看。
- **发布时效预警** `freshness` —— 判定某个版本是否还在 pnpm 的 `minimumReleaseAge` 等待期内，顺便告诉你豁免清单和 registry 是从哪读的。
  `check` 已经顺手查了这条信息，面板和徽章会直接标出"新版还在等待期，现在装会被拒"。
- **零依赖** —— 只 import `node:*` 内置模块。插件经由 symlink 装进 profile 时，从真实路径出发找不到宿主 node_modules，所以不 import 任何 `@deepseek-ai/*`。
- **自带 semver 子集** —— 以 node-semver 为基准做完差分测试（1184 组，0 处不一致），而不是抄一个近似实现。

- **Web 面板**：会话视图里多一个「兼容闸门」标签页；有插件需要留意时，输入框上方还会冒出一枚小徽章，不用敲命令，也不消耗额度。
  看过了可以点「我已知晓」，徽章就不再出现，直到 dsh 或插件有变化。

## 快速开始

需要 Node.js `>= 20.3.0`，dsh `>= 0.2.1-rc.1`。

```bash
dsh plugin --profile web add github:Elevaene/dsh-compat-gate
```

装完重启 dsh。宿主的插件管理器会自动把 `dsh-compat-gate` 追加到 profile 的 `dsh.profile.bundles`；如果没加，手动在 `$DSH_HOME/profiles/<name>/package.json` 的 `dsh.profile.bundles` 末尾补一行 `"dsh-compat-gate"`。

重启后输入：

```
/compat check
```

### 手动接入（离线 / 本地开发）

不经过 pnpm，用一个目录联接把源码挂进 profile：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-compat-gate" -Target "$env:USERPROFILE\.dsh\plugins\dsh-compat-gate"
```

再把 `"dsh-compat-gate"` 加进 `dsh.profile.bundles`，重启。注意：之后跑 `pnpm install` 会把这个联接当成多余包清掉。

## 使用

两种入口，能力完全一样。

### 斜杠命令

```
/compat                 同 /compat check，读更新源判定
/compat check
/compat 0.3.0           只判定指定版本，不碰网络
/compat audit           用真实宿主复核，并与上次对比
/compat ledger          看账本
/compat freshness       发布时效总览
/compat freshness 包名  只查一个包
```

### 工具 `compat_gate`

| action | 作用 |
|---|---|
| `check`（默认） | 读更新源 → 判定全部已装插件 → 写入账本 |
| `audit` | 按当前真实宿主复核，与账本对比 |
| `ledger` | 查看账本历史 |
| `freshness` | 发布时效判定，可带 `name` 只查一个包 |

`target` 参数可指定版本（如 `0.3.0`），`persist` 控制是否写账本（默认 `true`）。

直接问也行，不必记命令：「dsh 要更新了，我的插件会坏吗」。

### 输出长什么样

```
=========== target=(取自更新源) ===========
宿主 dsh：0.2.1-rc.2（cordis 4.0.5 / schemastery 3.18.5）  探测方式 execPath
profile：web  C:\Users\dk\.dsh\profiles\web
目标版本：0.2.1-rc.3（来源 feed:.../win-x64/nightly.yml，发布 2026-10-23T08:02:12.038Z）

插件                      版本        结论      说明
────────────────────────────────────────────────────────────────────────────
billion-context         0.1.208    无法判断    没有任何 dsh 兼容声明
dsh-cline-pass          0.2.12     相容      声明：>=0.1.2-alpha.3 <0.3.0（8 处声明同范围）
dsh-infinite-gen-5      1.1.0      相容      声明：>=0.2.0-rc.1 <0.3.0-0
dshmarket               1.70.2     相容      声明：^0.1.0-rc.7 || ^0.1.1-rc.2 || ...

判定：caution
说明：可以更新：已声明的插件全部相容，但有 1 个插件没有兼容声明，无法静态判断（方案 A：不实测加载）。
```

## 面板（Web UI）

除了敲命令，最近一次判定还会直接显示在界面里，两处：

- **输入框上方的小徽章**：只在**真的有插件会失效**时才出现，一行字，例如「兼容闸门 · 1 个会失效」
  有版本还在安装等待期时再加一段「· 等待期 1」；全部相容、或者只是"无法判断"时它不出现
  ——7 个插件里常有 1 个没写兼容声明，光凭这个天天弹徽章就是噪音，那种情况请进标签页看。
- **会话视图里的「兼容闸门」标签页**：完整面板，逐插件列出版本、判定与理由，结论行下面一行「更新 dsh 到 x.y.z」按钮（没有新版本时退化成「检查 dsh 更新」）。
  点下去先问一句，确认后就地显示进度：正在检查更新 → 正在下载 42% → 已下载完成，dsh 即将重启安装。

为什么是这两个位置：宿主给槽位分了作用域，`main`（整页）和 `sidebar.panellist`（侧栏图标）
都是 root 作用域，它们的标准属性里**没有** `useProjection`，挂上去永远拿不到数据；
`conversation.view` 与 `conversation.input.dock` 是 session 作用域，才拿得到投影。
同理，dock 槽位没有 `openView`，所以徽章只在宿主提供 `openView` 时才渲染成按钮，
否则就是一段纯展示文字——不做点了没反应的假交互。

面板里那枚「更新 dsh 到 x.y.z」按钮不自己下载任何东西：它调桌面应用自己暴露的更新器
（`window.dshDesktop.updates.open()`，主进程里就是「检查更新」那条既有流程），检查、下载、
关闭重启全交给宿主完成，插件只负责按下这一下（只调一次 `updates.open()`，不重复触发）。
桥会在三个地方找：本窗口、`window.top`、`window.parent`（外壳套一层 iframe 时后两者能命中）。
三处都没有时，那一行不只是说"没法直接更新"，还会多印一行**现场**——页面协议与主机、是否在 iframe 里、
`dshDesktop` 是不是可见——拿这行就能分清"用浏览器打开的"和"桌面外壳没暴露接口"，不用猜。

看过了不想再被打扰，就点面板里的「我已知晓」：之后徽章不再出现，直到出现新的情况——
dsh 版本变了、目标版本变了、或者任何插件的版本或结论变了。判断依据是一枚指纹
（宿主版本 + 目标版本 + 各插件的 `名字@版本:结论`），存在页面里，既不改宿主文件，也不花额度；
同一指纹下想恢复提醒，点「取消标记」即可。存储有三层退路：优先 `localStorage`，写不进去就退到 cookie，
再不行只存在本次运行的内存里；退到内存时面板会明说"标记只在本次运行有效"，不假装记住了。
数据通路是**会话投影**：宿主把结论写进快照，随会话视图下发给浏览器，全程不经过模型，
所以看面板不消耗额度。快照在两种情况下更新——启动后 3 秒在后台算一次；每次跑完
`/compat` 或 `compat_gate` 之后。

为什么不用普通的后端接口：插件装进 profile 之后**不能 import 宿主包**
（`profiles\web\node_modules\@deepseek-ai` 根本不存在，`autoInstallPeers: false`），
标准的 remote 通道因此用不了；会话投影是唯一零额度、零依赖的通道。
代价是 `wire.view` 必须是同步纯函数——所以结论先落盘到 `data/status.json`，
`view` 只做一次带 mtime 缓存的读取，并且永不抛异常（抛了会毁掉整份会话视图）。

## 判定规则
### 每个插件三态

- **相容** —— 所有声明范围都包含目标版本。
- **会失效** —— 至少一条声明范围不包含目标版本，报告会列出每条不满足的声明原文。
- **无法判断** —— 一条 dsh 兼容声明都没有。**这是刻意的**：这类插件与内核耦合浅，静态判定做不了，实测加载又会误报。误报比漏报更伤信任，所以一律报"无法判断"，不去试跑。

### 整体四档

`update` 可以放心更新 / `caution` 只有无法判断的 / `update-plugins-first` 有插件会失效但市场已有新版可覆盖 / `defer` 建议暂缓更新。

### 兼容声明有三种写法，本插件三种都读

| 写法 | 出现在 | 谁在用 |
|---|---|---|
| `dsh.compatibility.dsh` | `dsh` 字段 | dsh-cline-pass |
| `engines.dsh` | `engines` 字段 | dsh-token-metrics |
| `peerDependencies["@deepseek-ai/dsh*"]` | peer 依赖 | dsh-infinite-gen-5、dshmarket |

此外校验宿主自带的 `cordis` / `schemastery` 版本是否满足插件的对应 peer 声明（按声明来源配对比较，不会拿 cordis 的版本去比 schemastery 的范围）。

### 为什么必须 `includePrerelease: true`

dsh 走 `0.2.1-rc.N` 这种预发布线。按标准 `includePrerelease: false` 判定时，`>=0.1.2-alpha.3 <0.3.0`、`>=0.2.0-rc.1 <0.3.0-0` 这类范围**在当前版本上就会被判为不满足**，等于 100% 误报。因此固定开启。

内置 semver 子集复刻了两个最容易写错的细节：

- 上界一律补 `-0`：`^0.2.1` 展开成 `>=0.2.1 <0.3.0-0`，所以 `0.3.0-0` 不算满足。
- `includePrerelease` 下 x-range 的**下界**也补 `-0`：`^0.2` 展开成 `>=0.2.0-0 <0.3.0-0`，`0.2.0-rc.1` 才算满足。

### 目标版本从哪来

读宿主目录的 `resources/app-update.yml`（用 `process.execPath` 逐级向上找，或用 `DSH_APP_DIR` 显式指定），取 `url` + `channel`，再拉 `<url><channel>.yml` 解析 `version`。

## 发布时效预警

pnpm 的 `minimumReleaseAge` 机制：某个版本发布不足这个时长就**拒绝安装**，报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` / `ERR_PNPM_NO_MATURE_MATCHING_VERSION`。默认 **1440 分钟（24 小时）**。

还有更难处理的第二面：一旦这种版本进了 lockfile，pnpm 在**任何**改动前都会校验整个 lockfile，此后连**别的**插件的增删都会被拒。

| 结论 | 含义 |
|---|---|
| `可装` | 已过等待期 |
| `太新，装不上` | 发布不足等待期，还要等 N，现在装会被拒 |
| `已装但在等待期` | 装的就是这个太新的版本，期间任何插件增删都会被拒 |
| `已豁免，可装` | `minimumReleaseAgeExclude` 里有它，pnpm 放行 |
| `非 registry 依赖` | `github:` / `file:` / `link:` / `git+` / `http` 不走 registry，不受等待期影响 |
| `查不到发布时间` / `等待期配置无法解析` / `registry 不可达` | 明确说不知道，不臆造剩余时间 |

三个事实来源（与 dshmarket 的实现对齐）：

- **等待期多长**：`pnpm-workspace.yaml` 的 `minimumReleaseAge`（分钟）→ `.npmrc` 的 `minimum-release-age` → pnpm 默认 1440。键在但读不成数字时直接报"无法解析"，不猜。
- **谁被豁免**：`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`（裸名 / `name@version` / `name@range` / `||` 并列都认）。同一个名字只能有一行，pnpm 只读第一条。
- **发布时间**：registry 文档的 `time[version]`。registry 按市场 region 选（china → 腾讯镜像，global → npmjs），`DSHM_REGISTRY_URL` 可覆盖。**必须请求完整文档**：`accept` 带 `application/vnd.npm.install-v1+json` 会拿到精简格式，里面没有 `time` 字段。

## 边界与取舍

- **不自己实现更新。** 面板里的「更新 dsh」按钮调的是桌面应用自带的更新器（`window.dshDesktop.updates.open()`），下载、校验、重启都由宿主负责；插件不在更新流程里，所以也不会在更新前拦截你。没有这个桥（比如用浏览器打开 profile）时，它只给结论，外加一行现场诊断。
- **更新源不提供变更说明。** feed 里只有 `version` / `releaseDate` / `size` / `sha512`，所以"这次更新有没有大功能或漏洞修复"机器判断不了，那部分要人看。本插件只回答"会不会把插件搞坏"。
- **没声明就是没声明。** 无兼容声明的插件不给推测结论，也不加载试跑。
- **注册表结论有时效。** `freshness` 查的是此刻的发布时间，几个小时后结论会变。

## 开发与测试

```bash
npm test
```

| 测试 | 覆盖 |
|---|---|
| `test/semver-diff.mjs` | 与 node-semver 差分：34 个范围 × 19 个版本 × 两种 `includePrerelease` + compare 序列 = 1184 组 |
| `test/audit-diff.mjs` | 伪造账本 + 伪造 0.3.0 宿主夹具，验证 `audit` 精确挑出"更新前相容、更新后失效"的插件 |
| `test/mount.mjs` | 假 ctx 挂载：工具形状、无损 JSON 输出、命令注册、disposer 注销、缺服务降级 |
| `test/freshness.mjs` | 等待期窗口四种读法、豁免清单解析、三个判定分支 |
| `test/projection.mjs` | 投影契约形状、`apply` 纯函数性、缺快照兜底、无损 JSON、快照合并语义 |
| `test/client-mount.mjs` | 假模块加载器 + 假 ctx + 假 localStorage：两个槽位注册、五种数据状态下渲染不炸、徽章只在会失效时出现、我已知晓与指纹失效、等待期提示条与修复命令、更新桥多级查找与现场自证、存储降级探测、没触发复核时回填账本里的上次宿主 |
| `test/upgrade-path.mjs` | 修复命令只给 `covers === true` 的插件；等待期与命令进快照且是无损 JSON；复核里 `hostVersion` 不丢；自动复核的触发条件 |
| `test/matrix.mjs` | 真机多目标版本矩阵（需要真实宿主） |
| `test/smoke.mjs` | 真机单次冒烟 |

裸 node 进程探测不到宿主时，用 `DSH_APP_DIR` 指定宿主目录（形如 `...\resources\app\dsh`）。

## 目录结构

```
index.js            Cordis 插件入口（工具 + 斜杠命令 + 投影与后台刷新接线）
client.js           浏览器端：会话视图标签页与 dock 徽章（window.__ModuleLoader__ 包装）
lib/gate.js         核心：semver 子集、宿主探测、声明解析、判定、账本、发布时效
lib/status.js       状态快照：把判定结论压成 data/status.json，并给投影提供只读视图
lib/projection.js   会话投影定义（key = compatGate）
cordis.patch.yml    bundle 插入声明
data/ledger.json    账本（运行时生成，已 .gitignore）
data/status.json    面板用的状态快照（运行时生成，已 .gitignore）
test/               离线测试与真机冒烟
```

## 版本记录

| 版本 | 变化 |
|---|---|
| 0.2.1 | 面板挂到会话视图标签页；徽章改紧凑胶囊，宿主给 `openView` 时可点 |
| 0.2.2 | 徽章只在确实需要留意时出现，全部相容就不打扰 |
| 0.2.3 | 「我已知晓」+ 指纹失效：dsh 或插件有变化才重新提醒 |
| 0.2.4 | 更新后首次启动自动复核；等待期结论进面板与徽章；会失效就给可复制命令 |
| 0.2.5 | 面板加「更新 dsh」按钮，调宿主自带更新器，带确认与阶段文案 |
| 0.2.6 | 徽章改为只在**真会失效**时出现；存储三层退路（localStorage → cookie → 内存）；更新桥在本窗口 / `top` / `parent` 三级查找，并打印现场诊断 |
| 0.2.7 | 没触发复核时也显示账本里记的上次宿主；等待期剩余时间按发布时间重算 |

## License

[MIT](LICENSE) © 2026 Elevaene