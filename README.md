# dsh-compat-gate（兼容闸门）

在**更新 dsh 之前**，判断你现在装着的插件在新版本上还能不能用。

## 它怎么判断

dsh 生态里"插件声明兼容哪个宿主版本"有三种互不统一的写法，本插件三种都读：

| 写法 | 出现在 |
|---|---|
| `dsh.compatibility.dsh` | `dsh` 字段（dsh-cline-pass 用这个） |
| `engines.dsh` | `engines` 字段（dsh-token-metrics 用这个） |
| `peerDependencies["@deepseek-ai/dsh*"]` | 老实话（dsh-infinite-gen-5、dshmarket 用这个） |

另外校验宿主自带的 `cordis` / `schemastery` 版本是否满足插件的对应 peer 声明。

每个插件得到三态之一：

- **相容** —— 所有声明范围都包含目标版本。
- **会失效** —— 至少一条声明范围不包含目标版本（会把每条不满足的声明和范围列出来）。
- **无法判断** —— 一条 dsh 兼容声明都没有。**这是刻意的**：这类插件与内核耦合浅，静态判定做不了，
  实测加载又会误报（误报比漏报更伤信任），所以一律报"无法判断"，不去试跑。

结论只有四档：`update`（可以放心更新）/ `caution`（只有无法判断的）/ `update-plugins-first`
（会失效但插件市场有新版可覆盖）/ `defer`（建议暂缓更新）。

## semver 语义：必须 includePrerelease

dsh 是 `0.2.1-rc.N` 这种预发布线。用标准 `includePrerelease: false` 判定时，
`>=0.1.2-alpha.3 <0.3.0`、`>=0.2.0-rc.1 <0.3.0-0` 这类范围**在当前版本上就会误判为不满足**，
100% 误报。因此本插件固定 `includePrerelease: true`。

内置的 semver 子集（`lib/gate.js` 顶部）不是抄的近似实现：它以 node-semver 为差分基准，
`test/semver-diff.mjs` 对 1184 组（版本 × 范围 × 两种 includePrerelease 模式 + compare 序列）
逐条对照，当前 0 处不一致。它复刻了两个容易写错的细节：

- 上界一律补 `-0`：`^0.2.1` 实际展开成 `>=0.2.1 <0.3.0-0`，所以 `0.3.0-0` 不算满足。
- `includePrerelease` 下 x-range 的**下界**也补 `-0`：`^0.2` 展开成 `>=0.2.0-0 <0.3.0-0`，
  这样 `0.2.0-rc.1` 才算满足。

## 目标版本从哪来

读 `resources/app-update.yml`（由 `process.execPath` 逐级向上找到宿主目录，或用 `DSH_APP_DIR`
显式指定），拿到 `url` + `channel`，再拉 `<url><channel>.yml` 解析 `version`。
当前机器上是 `provider: generic` + `nightly` 通道。

**更新源不提供变更说明**（只有 version / releaseDate / size / sha512），所以"这次更新有没有大功能或漏洞修复"
机器判断不了——那部分仍需人看。本插件的职责是：把"会不会把插件搞坏"这件事变成确定的答案。

## 用法

工具 `compat_gate`：

```
action=check   （默认）读更新源，判定全部已装插件，写入账本
action=check   target="0.3.0"   只判定指定版本，不碰网络
action=audit   用当前真实运行的宿主版本判定，并与账本上一次对比 → 更新后到底谁坏了
action=ledger  看账本历史
```

斜杠命令：`/compat`、`/compat audit`、`/compat ledger`、`/compat 0.3.0`。

`audit` 是"更新后检查"那一半：账本里记着上次的宿主版本与各插件结论，版本一变再跑一遍，
**上次相容、现在会失效**的插件就是实证失效清单。

## 发布时效预警（pnpm 的新发布等待期）

`action=freshness`（或 `/compat freshness [包名]`）回答另一类"现在装会不会失败"：

pnpm 有 `minimumReleaseAge` 机制——某个版本发布不足这个时长就**拒绝安装**，报
`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` / `ERR_PNPM_NO_MATURE_MATCHING_VERSION`。
默认 **1440 分钟（24 小时）**，这就是"插件上传不到 24 小时、用 npm 装就报错"的原因。

还有更难受的第二面：一旦这种"还在等待期"的版本进了 lockfile，pnpm 在**任何**改动前都会校验整个
lockfile，此后连**别的**插件的安装/更新/卸载都会被拒（dshmarket 源码里记作 #39、#944）。

判定方式：

| 结论 | 含义 |
|---|---|
| `可装` | 已过等待期 |
| `太新，装不上` | 发布不足等待期，还要等 N，现在装会被拒 |
| `已装但在等待期` | 装的就是这个太新的版本，期间任何插件增删都会被拒 |
| `已豁免，可装` | `minimumReleaseAgeExclude` 里有它，pnpm 放行 |
| `非 registry 依赖` | `github:` / `file:` / `link:` / `git+` / `http` 不走 registry，不受等待期影响 |
| `查不到发布时间` / `等待期配置无法解析` / `registry 不可达` | 明确说不知道，不臆造剩余时间 |

三个事实来源，与 dshmarket 的实现保持一致：

- **等待期多长**：`pnpm-workspace.yaml` 的 `minimumReleaseAge`（分钟）→ `.npmrc` 的 `minimum-release-age` → pnpm 默认 1440。键存在但读不成数字时直接报"无法解析"，不猜。
- **谁被豁免**：`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`（裸名 / `name@version` / `name@range` / `||` 并列都认）。提醒：同一名字只能有一行，pnpm 只读第一条。
- **发布时间从哪读**：registry 文档的 `time[version]`。registry 按市场 region 选（china → `https://mirrors.cloud.tencent.com/npm`，global → `https://registry.npmjs.org`），`DSHM_REGISTRY_URL` 可覆盖。**必须请求完整文档**：`accept` 带 `application/vnd.npm.install-v1+json` 会拿到精简格式，里面没有 `time` 字段。

`action=check` 也会顺带预警：只要某个插件的市场最新版比已装版本新，就查它的发布时间，
太新则在报告末尾单独列一段"⚠ 发布时效预警"。

## 已知边界

- 装在 profile 里的插件**拦不住 Electron 外壳自己的更新流程**
  （`D:\Software\DeepSeek Harness\resources\app\lib\main.js`）。它能做的是主动查源、给结论、留账本，
  以及在更新后立刻告诉你哪些插件真的坏了。真要"更新前弹窗拦住"，得改外壳或另做一个启动器。
- 只读插件声明，不读插件代码，所以声明与实现不符时它判断不了。
- 声明区间写得很宽（如只有 `>=0.2.0`）时，它也只会如实说"相容"。

## 测试

```
node test/semver-diff.mjs    # 与 node-semver 差分：1184 组
node test/audit-diff.mjs     # 伪 0.3.0 宿主 → 必须精确识别出 3 个失效插件
node test/mount.mjs          # 假 ctx 挂载：工具形状 / 无损 JSON / 命令 / disposer / 缺服务降级
node test/freshness.mjs      # 等待期窗口读法 / 豁免匹配 / too-young / holds-lockfile / 非 registry 依赖
node test/matrix.mjs         # 真机三档目标版本的可读报告
```

`test/smoke.mjs` / `test/matrix.mjs` 在裸 node 下运行时需要
`DSH_APP_DIR` 指向宿主目录，否则探测不到宿主版本（在 dsh 进程内运行时走 `process.execPath`，不需要）。

## 布局

```
index.js            Cordis 插件：注册 compat_gate 工具 + /compat 命令
lib/gate.js         semver 子集 + 宿主/profile 探测 + 声明扫描 + 判定 + 更新源 + 账本 + 渲染
data/ledger.json    账本（运行后生成）
test/               差分、挂载、审计、报告
```

零运行时依赖：只 import `node:*`，不 import 任何 `@deepseek-ai/*` 宿主包
（插件从 `~/.dsh/plugins/<id>` 出发按 realpath 解析，解析不到宿主 node_modules）。