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
import { PLUGIN_ROOT, analyze } from './gate.js';

export const STATUS_FILE = path.join(PLUGIN_ROOT, 'data', 'status.json');

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
  return {
    source,
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
    })),
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
      hostVersion: result.host?.version ?? null,
      previousHost: result.previousHost ?? null,
      versionChanged: result.versionChanged === true,
      broken: broken.map((b) => ({ name: b.name, version: b.version ?? null, reason: b.reason ? String(b.reason).slice(0, 240) : null })),
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
export function publishStatus(patch = {}, file = STATUS_FILE) {
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
export function readStatus(file = STATUS_FILE) {
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
 */
export function statusView(file = STATUS_FILE) {
  try {
    const status = readStatus(file);
    if (!status) return { ok: false, reason: 'no-status', hint: '还没有判定结果，执行一次 /compat 即可生成。' };
    return { ok: true, ...status };
  } catch (error) {
    return { ok: false, reason: 'read-failed', hint: String(error?.message ?? error) };
  }
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