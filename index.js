/**
 * dsh-compat-gate —— dsh 预更新兼容闸门。
 *
 * 只做静态判定：读更新源拿到目标版本，把每个已装插件的兼容声明
 * （engines.dsh / dsh.compatibility.dsh / peerDependencies 里的 @deepseek-ai/dsh*）
 * 与目标版本做 semver 比对，给出 相容 / 会失效 / 无法判断 三态与更新建议。
 * 不加载、不试跑任何插件（方案 A：无声明者报"无法判断"，不做实测以免误报）。
 *
 * 另有一份状态快照（lib/status.js）+ 一个会话投影（lib/projection.js），
 * 让 Web 客户端不执行命令也能看到最近一次判定的结论；界面在 client.js。
 */
import {
  analyze, audit, formatAudit, formatFreshness, formatLedger, formatReport, freshness,
  hostVersion, ledgerHostSnapshot, needsAudit, PLUGIN_ID,
} from './lib/gate.js';
import { compatGateDefinition } from './lib/projection.js';
import { publishStatus, refreshStatus, summarizeAudit, summarizeReport } from './lib/status.js';

export const name = PLUGIN_ID;
export const inject = ['tools'];

export const ACTIONS = ['check', 'audit', 'ledger', 'freshness'];

const DESCRIPTION = [
  '检查 dsh 是否有新版本，并判断已安装插件更新后是否还可用。',
  'action=check（默认）：读 resources/app-update.yml 指向的更新通道，把每个插件的兼容声明与目标版本做 semver 比对，',
  '给出每个插件的 相容/会失效/无法判断，以及"可以更新/需先升级插件/建议暂缓"的结论。',
  'action=audit：用当前真实运行的宿主版本重新判定一遍，并与账本里上一次记录对比，列出更新后确实失效的插件。',
  'action=ledger：查看账本历史。',
  'action=freshness：查 registry 上该包最新版本的发布时间，判断 pnpm 的新发布等待期（默认 24 小时）会不会拒绝安装。',
  'pnpm 对发布不足 24 小时的版本一律拒装（ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION）；这种版本一旦进了 lockfile，之后连其它插件的增删都会被拒。',
  '全静态判定，不加载、不试跑插件。',
].join('');

function slimReport(report) {
  return {
    hostVersion: report.host.version,
    cordisVersion: report.host.deps?.cordis ?? null,
    schemasteryVersion: report.host.deps?.schemastery ?? null,
    profile: report.profile.name,
    targetVersion: report.target.version,
    targetSource: report.target.source,
    action: report.verdict.action,
    summary: report.verdict.summary,
    plugins: report.plugins.map((p) => ({ name: p.name, version: p.version, status: p.status, reasons: p.reasons, fix: p.fix ?? null })),
  };
}

/** 把 freshness 报告压成面板要用的那一小块。 */
function slimFreshness(report) {
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const alerts = rows.filter((row) => row.verdict === 'too-young' || row.verdict === 'holds-lockfile');
  return {
    window: { valid: report?.window?.valid === true, minutes: report?.window?.minutes ?? null, source: report?.window?.source ?? null },
    registry: report?.registry?.url ?? null,
    counts: report?.counts ?? null,
    alerts: alerts.map((row) => ({ name: row.name, version: row.version ?? null, verdict: row.verdict, note: row.note ?? null })),
  };
}

export function apply(ctx, config = {}) {
  ctx.effect(() => {
    const dispose = ctx.tools.register({
      name: 'compat_gate',
      description: DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ACTIONS, description: 'check=比对更新源（默认）；audit=按当前宿主核对并与上次对比；ledger=看账本' },
          target: { type: 'string', description: '只判定某个指定版本（例如 "0.3.0"）；省略则读更新源' },
          persist: { type: 'boolean', description: '是否写入账本，默认 true' },
          name: { type: 'string', description: 'freshness 用：只查这个包（省略则查全部已装插件）' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2) }],
      },
      async execute(args = {}) {
        const action = ACTIONS.includes(args.action) ? args.action : 'check';
        const target = typeof args.target === 'string' && args.target.trim() ? args.target.trim() : null;
        const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : null;
        const persist = args.persist !== false;

        if (action === 'ledger') return { action, text: formatLedger() };

        if (action === 'freshness') {
          const report = await freshness({ names: name ? [name] : null });
          publishStatus({ freshness: slimFreshness(report) });
          return { action, text: formatFreshness(report), freshness: report };
        }

        if (action === 'audit') {
          const result = await audit({ persist });
          const summarized = summarizeAudit(result);
          if (summarized) publishStatus(summarized);
          return {
            action,
            text: formatAudit(result),
            audit: result.ok
              ? { host: result.host, previousHost: result.previousHost, versionChanged: result.versionChanged, broken: result.broken, fixed: result.fixed }
              : result,
          };
        }

        const report = await analyze({ target, persist });
        const summarized = summarizeReport(report, 'check');
        if (summarized) publishStatus(summarized);
        return { action, text: formatReport(report), report: slimReport(report) };
      },
    });
    if (typeof dispose !== 'function') throw new Error('DSH 工具注册器必须返回 disposer');
    return dispose;
  }, `${PLUGIN_ID}: tool surface`);

  // 斜杠命令是可选增强：宿主没有 commands 服务时不应拖累插件加载。
  try {
    ctx.inject(['commands'], (scope) => {
      const commands = scope.get('commands');
      if (!commands || typeof commands.register !== 'function') return;
      commands.register({
        name: 'compat',
        description: '检查 dsh 更新后已装插件是否还可用（check / audit / ledger / 版本号）',
        input: { hint: 'check | audit | ledger | freshness [包名] | <版本号>' },
        async handler(invocation) {
          try {
            const raw = String(invocation?.rawInput ?? '').trim();
            if (raw === 'ledger') return { kind: 'success', text: formatLedger() };
            if (raw === 'audit') {
              const result = await audit({ persist: true });
              const summarized = summarizeAudit(result);
              if (summarized) publishStatus(summarized);
              return { kind: 'success', text: formatAudit(result) };
            }
            if (raw === 'freshness' || raw.startsWith('freshness ')) {
              const only = raw.slice('freshness'.length).trim().split(/\s+/)[0];
              const report = await freshness({ names: only ? [only] : null });
              publishStatus({ freshness: slimFreshness(report) });
              return { kind: 'success', text: formatFreshness(report) };
            }
            const target = raw && !ACTIONS.includes(raw) ? raw : null;
            const report = await analyze({ target, persist: true });
            const summarized = summarizeReport(report, 'check');
            if (summarized) publishStatus(summarized);
            return { kind: 'success', text: formatReport(report) };
          } catch (error) {
            return { kind: 'error', text: `兼容闸门出错：${error?.message ?? error}` };
          }
        },
      });
    });
  } catch { /* 命令注册失败不影响工具面 */ }

  // 会话投影：把快照推给 Web 客户端。宿主没有该服务时静默跳过（可选增强）。
  try {
    const projections = ctx.get('sessionProjections');
    if (projections !== undefined && typeof projections.register === 'function') {
      ctx.effect(() => projections.register(compatGateDefinition()), `${PLUGIN_ID}: compatGate projection`);
    }
  } catch { /* 投影注册失败不影响工具面 */ }

  // 启动后台刷新一次快照：延迟执行且不阻塞加载，失败只记录不打扰。
  try {
    ctx.effect(() => {
      let alive = true;
      // 账本里上次记录的宿主版本与当前运行的不一样 = dsh 刚更新过，
      // 于是先自动补一次"更新后复核"（纯本地判定、不联网、不花额度），
      // 再把面板刷到"下一跳"的预测上。
      const timer = setTimeout(async () => {
        if (!alive) return;
        const host = hostVersion();
        const last = ledgerHostSnapshot();
        const baseline = !last.lastHost;
        const updated = needsAudit(host, last.lastHost);
        if (updated) {
          try {
            const result = await audit({ persist: true });
            const summarized = summarizeAudit(result);
            if (summarized && alive) publishStatus(summarized);
          } catch { /* 复核失败不影响后面的预测刷新 */ }
        }
        if (!alive) return;
        // 账本还空着就留一条基线：否则以后真更新了也没有"上一次"可比，
        // 自动复核永远不会触发。之后的启动保持 persist=false，账本不被刷屏。
        await refreshStatus({
          timeoutMs: 8000,
          source: updated ? 'startup-after-update' : 'startup',
          persist: baseline,
        }).catch(() => {});
      }, 3000);
      if (typeof timer.unref === 'function') timer.unref();
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    }, `${PLUGIN_ID}: startup status refresh`);
  } catch { /* 后台刷新失败不影响加载 */ }
}