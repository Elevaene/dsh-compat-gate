/**
 * 状态快照：把一次判定的结论压成一份小的、可直接渲染的 JSON，
 * 落盘到 data/status.json，供会话投影（面板）读取。
 *
 * 为什么要有这一层：面板必须在**不执行任何命令**的情况下看到结果，
 * 而投影的 wire.view 是同步函数，不能在里面做网络请求或长时间扫盘。
 * 所以结论由 analyze/audit 这类动作算好后写入快照，view 只做一次很小的
 * mtime 缓存读取。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, analyze, ledgerHostSnapshot } from './gate.js';

/**
 * 快照文件位置。每次调用时解析，这样测试可以用 DSH_COMPAT_GATE_STATUS_FILE
 * 指到临时文件，避免跑一次测试就把面板里的真实结论顶掉。
 */
export function statusFile() {
  const override = process.env.DSH_COMPAT_GATE_STATUS_FILE;
  return override && override.trim() !== '' ? override : path.join(PLUGIN_ROOT, 'data', 'status.json');
}
export const STATUS_FILE = statusFile();

const LABEL = { OK: '相容', BREAK: '会失效', UNKNOWN: '无法判断' };
export const ACTION_LABEL = {
  safe: '可以更新',
  caution: '可以更新，但有插件无法判断',
  defer: '建议暂缓更新',
  unknown: '目标版本未知，无法判定',
};

function nowIso() {
  return new Date().toISOString();
}

function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return null;
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * 发布时效摘要：哪些插件的新版还在 pnpm 等待期内、已经过了多久。
 * 剩余时间不落盘——它是"现在"的函数，落盘三分钟就过期，交给界面按
 * publishedAt + windowMs 现算。
 */
export function summarizeReleaseAge(report, plugins = []) {
  const items = [];
  for (const p of plugins) {
    const age = p.releaseAge;
    if (!age || age.tooYoung !== true || age.exempt) continue;
    items.push({
      name: p.name ?? null,
      version: age.version ?? null,
      publishedAt: age.publishedAt ?? null,
      windowMs: typeof age.windowMs === 'number' ? age.windowMs : null,
    });
  }
  return {
    window: {
      minutes: report?.releaseAge?.window?.minutes ?? null,
      source: report?.releaseAge?.window?.source ?? null,
    },
    items,
  };
}

/** 把 analyze() 的完整报告压成快照。 */
export function summarizeReport(report, source = 'check') {
  if (!report || typeof report !== 'object') return null;
  const plugins = Array.isArray(report.plugins) ? report.plugins : [];
  const counts = { ok: 0, break: 0, unknown: 0 };
  for (const p of plugins) {
    if (p.status === 'OK') counts.ok += 1;
    else if (p.status === 'BREAK') counts.break += 1;
    else counts.unknown += 1;
  }
  const lastSeen = ledgerHostSnapshot();
  return {
    source,
    // 账本里最后一次记录的宿主：面板在没有复核结果时也要能显示它
    lastHost: lastSeen.lastHost,
    lastHostAt: lastSeen.at,
    host: {
      version: report.host?.version ?? null,
      cordis: report.host?.deps?.cordis ?? null,
      schemastery: report.host?.deps?.schemastery ?? null,
      profile: report.profile?.name ?? null,
    },
    target: {
      version: report.target?.version ?? null,
      source: report.target?.source ?? null,
    },
    verdict: {
      action: report.verdict?.action ?? 'unknown',
      summary: report.verdict?.summary ?? null,
      label: ACTION_LABEL[report.verdict?.action] ?? ACTION_LABEL.unknown,
    },
    counts,
    plugins: plugins.map((p) => ({
      name: p.name,
      version: p.version ?? null,
      status: p.status ?? 'UNKNOWN',
      label: LABEL[p.status] ?? '无法判断',
      reason: Array.isArray(p.reasons) && p.reasons.length ? String(p.reasons[0]).slice(0, 240) : null,
      fix: typeof p.fix === 'string' && p.fix ? p.fix : null,
    })),
    releaseAge: summarizeReleaseAge(report, plugins),
    integrity: slimIntegrity(report.integrity),
  };
}

/** 安装完整性压成快照（不存每个文件的绝对路径）。 */
export function slimIntegrity(integrity) {
  if (!integrity || typeof integrity !== 'object') return null;
  return {
    ok: integrity.ok === true ? true : (integrity.ok === false ? false : null),
    missing: Array.isArray(integrity.missing) ? integrity.missing.map(String) : [],
    appVersion: integrity.appVersion ?? null,
    runtimeVersion: integrity.runtimeVersion ?? null,
    note: integrity.note ?? null,
  };
}

/** 把 audit() 的结果压成快照（更新后复核）。 */
export function summarizeAudit(result, source = 'audit') {
  if (!result || typeof result !== 'object' || result.ok === false) return null;
  const broken = Array.isArray(result.broken) ? result.broken : [];
  const fixed = Array.isArray(result.fixed) ? result.fixed : [];
  return {
    source,
    audit: {
      // audit() 返回的 host 是版本字符串，不是对象——两种形状都接受，别把版本弄丢
      hostVersion: typeof result.host === 'string' ? result.host : (result.host?.version ?? null),
      previousHost: result.previousHost ?? null,
      versionChanged: result.versionChanged === true,
      broken: broken.map((b) => ({
        name: b.name,
        version: b.version ?? null,
        reason: b.reason ? String(b.reason).slice(0, 240) : null,
        fix: typeof b.fix === 'string' && b.fix ? b.fix : null,
      })),
      fixed: fixed.map((f) => ({ name: f.name, version: f.version ?? null })),
    },
    verdict: {
      action: broken.length ? 'defer' : 'safe',
      summary: broken.length ? `确认 ${broken.length} 个插件在更新后失效` : '没有发现失效的插件',
      label: broken.length ? ACTION_LABEL.defer : ACTION_LABEL.safe,
    },
  };
}

/**
 * 合并写入快照。只覆盖传入的顶层字段，未传的保留上一次的值，
 * 这样 audit 与 check 的结果可以共存于同一份快照。
 * 写失败不抛（面板缺数据比插件加载失败代价小）。
 */
export function publishStatus(patch = {}, file = statusFile()) {
  const previous = readJsonFile(file) ?? {};
  const next = { ...previous, ...patch, updatedAt: nowIso() };
  if (patch.error === undefined) delete next.lastError;
  else next.lastError = String(patch.error);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    return next;
  }
  return next;
}

/** 读快照（带 mtime 缓存，避免投影每次组装都读盘解析）。 */
const cache = new Map();
export function readStatus(file = statusFile()) {
  try {
    const stat = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
    const value = readJsonFile(file);
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch {
    cache.delete(file);
    return null;
  }
}

/**
 * 投影的 wire.view 专用：永远返回无损 JSON，永不抛异常。
 * 面板拿不到数据时要能显示"还没有结果"，而不是让整份会话视图崩掉。
 *
 * 同一份快照必须返回**同一个对象**：宿主用 Object.is 判断投影值变没变，
 * 每次新建对象会让它在每个会话事件之后都重推一遍视图。
 */
const viewCache = new Map();
export function statusView(file = statusFile()) {
  let stat = null;
  try { stat = fs.statSync(file); } catch { /* 还没有快照 */ }
  const missing = stat === null;
  const mtimeMs = stat === null ? null : stat.mtimeMs;
  const size = stat === null ? null : stat.size;
  const previous = viewCache.get(file);
  if (previous && previous.missing === missing && previous.mtimeMs === mtimeMs && previous.size === size) {
    return previous.view;
  }
  let view;
  if (missing) {
    view = { ok: false, reason: 'no-status', hint: '还没有判定结果，执行一次 /compat 即可生成。' };
  } else {
    const status = readJsonFile(file);
    view = status
      ? { ok: true, ...status }
      : { ok: false, reason: 'unreadable', hint: '快照读不出来，执行一次 /compat 重新生成。' };
  }
  viewCache.set(file, { missing, mtimeMs, size, view });
  return view;
}

/**
 * 启动/命令之后刷新快照。失败时保留上一次结果，只把错误记进 lastError。
 */
export async function refreshStatus(options = {}) {
  try {
    const report = await analyze({ persist: false, ...options });
    return publishStatus(summarizeReport(report, options.source ?? 'check'));
  } catch (error) {
    try {
      publishStatus({ error: String(error?.message ?? error) });
    } catch { /* 连错误都写不进去就算了 */ }
    return null;
  }
}