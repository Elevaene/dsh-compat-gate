/**
 * dsh-compat-gate —— dsh 预更新兼容闸门核心逻辑。
 * 约定：零依赖，只 import node: 内置模块；不 import 任何宿主 @deepseek-ai/* 包
 * （与 dsh-infinite-gen-5 相同的自包含做法，避免解析到不同 node_modules 而炸）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.dirname(HERE);
export const PLUGIN_ID = 'dsh-compat-gate';

// ═════════════════════════════ semver 子集 ═════════════════════════════
const NUMERIC = /^(0|[1-9]\d*)$/;
const IDENT = '[0-9A-Za-z-]+';
const VERSION_RE = new RegExp(`^v?(\\d+)\\.(\\d+)\\.(\\d+)(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+${IDENT}(?:\\.${IDENT})*)?$`);
const PARTIAL_RE = new RegExp(`^v?(\\d+|[xX*])(?:\\.(\\d+|[xX*]))?(?:\\.(\\d+|[xX*]))?(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+${IDENT}(?:\\.${IDENT})*)?$`);

export function parseVersion(input) {
  const m = VERSION_RE.exec(String(input).trim());
  if (!m) throw new TypeError(`非法版本号: ${input}`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

function cmpIdent(a, b) {
  const an = NUMERIC.test(a), bn = NUMERIC.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1;
  if (bn) return 1;
  return a === b ? 0 : (a < b ? -1 : 1);
}

export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const c = cmpIdent(x.pre[i], y.pre[i]);
    if (c) return c;
  }
  return 0;
}

function numOrNull(s) {
  if (s === undefined || s === 'x' || s === 'X' || s === '*') return null;
  return Number(s);
}

function parsePartial(text) {
  const m = PARTIAL_RE.exec(String(text).trim());
  if (!m) throw new TypeError(`非法范围片段: ${text}`);
  const part = { major: numOrNull(m[1]), minor: numOrNull(m[2]), patch: numOrNull(m[3]), pre: m[4] ? m[4].split('.') : [] };
  if (part.major === null) { part.minor = null; part.patch = null; part.pre = []; }
  else if (part.minor === null) { part.patch = null; part.pre = []; }
  else if (part.patch === null) part.pre = [];
  return part;
}

const V = (major, minor, patch, pre = []) => ({ major, minor, patch, pre });

function bounds(p) {
  return V(p.major ?? 0, p.minor ?? 0, p.patch ?? 0, p.pre);
}

function withPre(version, pre) {
  return V(version.major, version.minor, version.patch, pre);
}

/** 下界：x-range 缺分量在 includePrerelease 下补 `-0`（node-semver 的 replaceXRange 行为）。 */
function lowerBound(p, includePrerelease) {
  const base = bounds(p);
  if (includePrerelease && base.pre.length === 0 && (p.minor === null || p.patch === null)) return withPre(base, ['0']);
  return base;
}

/** 上界一律带 `-0`：所以 `<0.3.0` 展开后其实排除 0.3.0-rc（这也是插件里写 `<0.3.0-0` 的来源）。 */
function upperBound(major, minor, patch) {
  return V(major, minor, patch, ['0']);
}

function expandToken(token, includePrerelease) {
  if (token === '' || token === '*' || token === 'x' || token === 'X') return [];
  const m = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(token);
  const op = m[1] || '';
  const body = m[2];
  if (body === '') throw new TypeError(`非法比较符: ${token}`);
  const p = parsePartial(body);
  if (p.major === null) return [];

  if (op === '^') {
    let up;
    if (p.major > 0) up = upperBound(p.major + 1, 0, 0);
    else if (p.minor !== null && p.minor > 0) up = upperBound(0, p.minor + 1, 0);
    else if (p.minor !== null && p.patch !== null) up = upperBound(0, 0, p.patch + 1);
    else if (p.minor !== null) up = upperBound(0, p.minor + 1, 0);
    else up = upperBound(1, 0, 0);
    return [{ op: '>=', version: lowerBound(p, includePrerelease) }, { op: '<', version: up }];
  }
  if (op === '~') {
    const up = p.minor === null ? upperBound(p.major + 1, 0, 0) : upperBound(p.major, p.minor + 1, 0);
    return [{ op: '>=', version: lowerBound(p, includePrerelease) }, { op: '<', version: up }];
  }
  if (op === '' || op === '=') {
    if (p.minor === null) return [{ op: '>=', version: lowerBound(p, includePrerelease) }, { op: '<', version: upperBound(p.major + 1, 0, 0) }];
    if (p.patch === null) return [{ op: '>=', version: lowerBound(p, includePrerelease) }, { op: '<', version: upperBound(p.major, p.minor + 1, 0) }];
    return [{ op: '=', version: bounds(p) }];
  }
  if (op === '>=') return [{ op: '>=', version: lowerBound(p, includePrerelease) }];
  if (op === '>') {
    if (p.patch !== null) return [{ op: '>', version: bounds(p) }];
    const next = p.minor === null ? V(p.major + 1, 0, 0) : V(p.major, p.minor + 1, 0);
    return [{ op: '>=', version: next }];
  }
  if (op === '<') {
    // `<2` 意为 "低于 2.0.0"，缺分量补 0（不是进位），并带 `-0`。
    if (p.patch === null) return [{ op: '<', version: V(p.major, p.minor ?? 0, 0, ['0']) }];
    return [{ op: '<', version: bounds(p) }];
  }
  if (op === '<=') {
    if (p.patch === null) {
      const up = p.minor === null ? upperBound(p.major + 1, 0, 0) : upperBound(p.major, p.minor + 1, 0);
      return [{ op: '<', version: up }];
    }
    return [{ op: '<=', version: bounds(p) }];
  }
  throw new TypeError(`不支持的比较符: ${op}`);
}

function parseRangeGroup(text, includePrerelease) {
  const t = String(text).trim();
  if (!t) return [];
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(t);
  if (hyphen) {
    const lo = parsePartial(hyphen[1]);
    const hi = parsePartial(hyphen[2]);
    const out = [];
    if (lo.major !== null) out.push({ op: '>=', version: lowerBound(lo, includePrerelease) });
    if (hi.major !== null) {
      if (hi.patch === null) {
        out.push({ op: '<', version: hi.minor === null ? upperBound(hi.major + 1, 0, 0) : upperBound(hi.major, hi.minor + 1, 0) });
      } else out.push({ op: '<=', version: bounds(hi) });
    }
    return out;
  }
  const out = [];
  for (const token of t.split(/\s+/)) {
    if (!token) continue;
    for (const c of expandToken(token, includePrerelease)) out.push(c);
  }
  return out;
}

function testComparator(target, c) {
  if (!c.version) return true;
  const d = compareVersions(target, c.version);
  switch (c.op) {
    case '>=': return d >= 0;
    case '>': return d > 0;
    case '<=': return d <= 0;
    case '<': return d < 0;
    case '=': return d === 0;
    default: throw new TypeError(`未知比较符: ${c.op}`);
  }
}

/**
 * 范围判定。includePrerelease 默认 true —— 这是 dsh 生态的实际语义：
 * 关掉它时 dsh-cline-pass（>=0.1.2-alpha.3 <0.3.0）在**当前 0.2.1-rc.2 上就会误判 BREAK**。
 */
export function satisfies(version, range, options = {}) {
  const includePrerelease = options.includePrerelease !== false;
  const target = typeof version === 'string' ? parseVersion(version) : version;
  const text = String(range ?? '').trim();
  for (const group of text.split('||')) {
    const comparators = parseRangeGroup(group, includePrerelease);
    if (!includePrerelease && target.pre.length) {
      const sameTuple = comparators.some((c) => c.version && c.version.pre.length
        && c.version.major === target.major && c.version.minor === target.minor && c.version.patch === target.patch);
      if (!sameTuple) continue;
    }
    if (!comparators.every((c) => testComparator(target, c))) continue;
    return true;
  }
  return false;
}
export function safeSatisfies(version, range, options) {
  try { return satisfies(version, range, options); } catch (error) { return null; }
}

// ═════════════════════════════ 环境探测 ═════════════════════════════
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 定位宿主：优先 env、import.meta.resolve、再从 process.execPath 逐级向上找
 * <dir>/resources/app/dsh/node_modules/@deepseek-ai/dsh/package.json。
 */
export function detectHost() {
  const tried = [];
  const probes = [];

  for (const key of ['DSH_APP_DIR', 'DSH_RESOURCES_PATH', 'DSH_APP_PATH']) {
    const value = process.env[key];
    if (!value) continue;
    const base = value.replace(/[\\/]+$/, '');
    if (path.basename(base) === 'node_modules') probes.push({ label: `env:${key}`, dir: base });
    else if (path.basename(base) === 'dsh') probes.push({ label: `env:${key}`, dir: path.join(base, 'node_modules') });
    else {
      probes.push({ label: `env:${key}`, dir: path.join(base, 'resources', 'app', 'dsh', 'node_modules') });
      probes.push({ label: `env:${key}`, dir: path.join(base, 'dsh', 'node_modules') });
    }
  }

  try {
    const req = createRequire(import.meta.url);
    const resolved = req.resolve('@deepseek-ai/dsh/package.json');
    probes.push({ label: 'require.resolve', dir: path.dirname(path.dirname(path.dirname(path.dirname(resolved)))) });
  } catch { /* 插件目录外解析不到属正常 */ }

  let cur = path.dirname(process.execPath);
  for (let i = 0; i < 6; i++) {
    probes.push({ label: `execPath+${i}`, dir: path.join(cur, 'resources', 'app', 'dsh', 'node_modules') });
    const next = path.dirname(cur);
    if (next === cur) break;
    cur = next;
  }

  for (const probe of probes) {
    const file = path.join(probe.dir, '@deepseek-ai', 'dsh', 'package.json');
    tried.push(file);
    const pkg = readJson(file);
    if (pkg && typeof pkg.version === 'string') {
      return { version: pkg.version, appDshDir: path.dirname(path.dirname(path.dirname(path.dirname(file)))), via: probe.label, tried };
    }
  }
  return { version: null, appDshDir: null, via: null, tried };
}

const HOST_DEPS = {
  cordis: ['@deepseek-ai/cordis', 'cordis'],
  schemastery: ['@deepseek-ai/schemastery', 'schemastery'],
};

/** 宿主自带的非 dsh-* 依赖版本（cordis / schemastery），用于校验插件的对应 peer 声明。 */
export function detectHostDeps(appDshDir) {
  const out = { cordis: null, schemastery: null };
  if (!appDshDir) return out;
  for (const [key, names] of Object.entries(HOST_DEPS)) {
    for (const name of names) {
      const pkg = readJson(path.join(appDshDir, 'node_modules', name, 'package.json'));
      if (pkg?.version) { out[key] = pkg.version; break; }
    }
  }
  return out;
}

/** profile 定位：env → 含本插件的那个 profile → 'web' → 第一个 profile。 */
export function detectProfile(home = dshHome()) {
  const root = path.join(home, 'profiles');
  const names = (() => { try { return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } })();
  const env = process.env.DSH_PROFILE;
  if (env && names.includes(env)) return { name: env, dir: path.join(root, env), via: 'env:DSH_PROFILE' };
  for (const name of names) {
    const pkg = readJson(path.join(root, name, 'package.json'));
    const deps = { ...(pkg?.dependencies ?? {}) };
    if (Object.keys(deps).includes(PLUGIN_ID)) return { name, dir: path.join(root, name), via: 'self-in-dependencies' };
  }
  if (names.includes('web')) return { name: 'web', dir: path.join(root, 'web'), via: 'default-web' };
  if (names.length) return { name: names[0], dir: path.join(root, names[0]), via: 'first-profile' };
  return { name: null, dir: null, via: null };
}

// ═════════════════════════════ 插件与声明扫描 ═════════════════════════════
const HOST_BUNDLE = /^@deepseek-ai\//;

export function declarationsOf(pkg) {
  const out = [];
  const push = (site, range) => { if (typeof range === 'string' && range.trim()) out.push({ site, range: range.trim() }); };
  push('dsh.compatibility.dsh', pkg?.dsh?.compatibility?.dsh);
  push('engines.dsh', pkg?.engines?.dsh);
  for (const [dep, range] of Object.entries(pkg?.peerDependencies ?? {})) {
    if (dep === '@deepseek-ai/dsh' || dep.startsWith('@deepseek-ai/dsh-')) push(`peerDependencies["${dep}"]`, range);
  }
  return out;
}

export function dependencyRangesOf(pkg) {
  const out = [];
  const peers = pkg?.peerDependencies ?? {};
  const push = (of, site, range) => { if (typeof range === 'string' && range.trim()) out.push({ of, site, range: range.trim() }); };
  push('cordis', 'peerDependencies["@deepseek-ai/cordis"]', peers['@deepseek-ai/cordis']);
  push('cordis', 'peerDependencies["cordis"]', peers.cordis);
  push('schemastery', 'peerDependencies["@deepseek-ai/schemastery"]', peers['@deepseek-ai/schemastery']);
  push('schemastery', 'peerDependencies["schemastery"]', peers.schemastery);
  return out;
}

export function scanPlugins(profileDir) {
  if (!profileDir) return { plugins: [], error: 'profile 未定位' };
  const pkg = readJson(path.join(profileDir, 'package.json'));
  if (!pkg) return { plugins: [], error: `读不到 ${path.join(profileDir, 'package.json')}` };
  const names = new Set([
    ...(pkg.dsh?.profile?.bundles ?? []),
    ...Object.keys(pkg.dependencies ?? {}),
  ]);
  const plugins = [];
  for (const name of names) {
    if (HOST_BUNDLE.test(name)) continue;
    const dir = path.join(profileDir, 'node_modules', ...name.split('/'));
    const manifest = readJson(path.join(dir, 'package.json'));
    if (!manifest) { plugins.push({ name, version: null, dir, missing: true, declarations: [], dependencies: [] }); continue; }
    let real = dir;
    try { real = fs.realpathSync(dir); } catch { /* 保持原路径 */ }
    plugins.push({
      name,
      version: typeof manifest.version === 'string' ? manifest.version : null,
      dir: real,
      declaredBy: (pkg.dsh?.profile?.bundles ?? []).includes(name) ? 'bundles' : 'dependencies',
      declarations: declarationsOf(manifest),
      dependencies: dependencyRangesOf(manifest),
    });
  }
  return { plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)), error: null };
}

export function readMarketCache(profileDir) {
  const file = path.join(profileDir ?? '', '.dsh-market', 'discovery-compatibility-v1.json');
  const cache = readJson(file);
  if (!cache?.entries) return { file, entries: {}, available: false };
  return { file, entries: cache.entries, available: true };
}

// ═════════════════════════════ 判定 ═════════════════════════════
export const STATUS = { OK: 'OK', BREAK: 'BREAK', UNKNOWN: 'UNKNOWN' };

export function evaluatePlugin(plugin, { hostVersion, hostDeps = {} }) {
  const checks = [];
  const reasons = [];

  if (plugin.missing) {
    return { status: STATUS.UNKNOWN, checks, reasons: ['package.json 缺失，无法读取兼容声明'] };
  }

  if (!hostVersion) {
    const checks = (plugin.declarations ?? []).map((decl) => ({ kind: 'dsh', site: decl.site, range: decl.range, ok: null }));
    return { status: STATUS.UNKNOWN, checks, reasons: ['宿主版本未识别，无法判定'] };
  }

  for (const decl of plugin.declarations ?? []) {
    const ok = safeSatisfies(hostVersion, decl.range);
    checks.push({ kind: 'dsh', site: decl.site, range: decl.range, ok });
  }
  for (const dep of plugin.dependencies ?? []) {
    const current = hostDeps[dep.of];
    if (!current) continue;
    const ok = safeSatisfies(current, dep.range);
    checks.push({ kind: dep.of, site: dep.site, range: dep.range, ok });
  }

  const failed = checks.filter((c) => c.ok === false);
  if (failed.length) {
    const dshFailed = failed.filter((c) => c.kind === 'dsh');
    const ranges = [...new Set(dshFailed.map((c) => c.range))];
    if (ranges.length === 1) reasons.push(`${dshFailed.length} 处 dsh 声明均为 "${ranges[0]}"，不含 ${hostVersion}`);
    else if (ranges.length > 1) reasons.push(`${ranges.map((r) => `"${r}"`).join(' / ')} 均不含 ${hostVersion}`);
    for (const c of failed.filter((x) => x.kind !== 'dsh')) {
      reasons.push(`宿主 ${c.kind} ${hostDeps[c.kind]} 不满足 ${c.site} = "${c.range}"`);
    }
  }
  const unparsable = checks.filter((c) => c.ok === null);
  if (unparsable.length) reasons.push(`${unparsable.length} 处声明无法解析`);

  let status;
  if (!checks.length) status = STATUS.UNKNOWN;
  else if (checks.some((c) => c.ok === false)) status = STATUS.BREAK;
  else if (checks.every((c) => c.ok === true)) status = STATUS.OK;
  else status = STATUS.UNKNOWN;

  if (status === STATUS.UNKNOWN && !reasons.length) {
    reasons.push(plugin.declarations?.length
      ? '声明无法解析'
      : '没有任何 dsh 兼容声明（engines.dsh / dsh.compatibility.dsh / peerDependencies）');
  }
  return { status, checks, reasons };
}

function marketHint(plugin, market, targetVersion) {
  const entry = market.entries?.[plugin.name];
  if (!entry?.facts) return null;
  const latest = entry.facts.version;
  if (!latest) return null;
  const newer = plugin.version ? compareVersions(latest, plugin.version) > 0 : true;
  if (!newer) return { latest, newer: false };
  const ranges = [];
  if (entry.facts.enginesDsh) ranges.push({ site: 'engines.dsh', range: entry.facts.enginesDsh });
  for (const [dep, range] of Object.entries(entry.facts.peerDependencies ?? {})) {
    if (dep === '@deepseek-ai/dsh' || dep.startsWith('@deepseek-ai/dsh-')) ranges.push({ site: `peerDependencies["${dep}"]`, range });
  }
  const covers = ranges.length && targetVersion ? ranges.every((r) => safeSatisfies(targetVersion, r.range) !== false) : null;
  return { latest, newer: true, covers, ranges, checkedAt: entry.checkedAt ?? null };
}

export function recommend({ targetVersion, currentVersion, results }) {
  const breaks = results.filter((r) => r.status === STATUS.BREAK);
  const unknowns = results.filter((r) => r.status === STATUS.UNKNOWN);
  const fixable = breaks.filter((r) => r.market?.newer && r.market?.covers === true);
  const hardBreaks = breaks.filter((r) => !fixable.includes(r));
  const drift = targetVersion && currentVersion ? compareVersions(targetVersion, currentVersion) : 0;

  if (!targetVersion) {
    return {
      action: 'unknown',
      summary: '无法确定目标版本（宿主版本未识别且更新源不可达），本次不做判断。',
      hardBreaks: [], fixable: [], unknowns: unknowns.map((r) => r.name), drift: 0,
    };
  }
  if (hardBreaks.length) {
    return {
      action: 'defer',
      summary: `建议暂缓更新：${hardBreaks.length} 个插件声明的兼容范围不包含 ${targetVersion}，且没有已知的新版插件可覆盖。`,
      hardBreaks: hardBreaks.map((r) => r.name),
      fixable: fixable.map((r) => r.name),
      unknowns: unknowns.map((r) => r.name),
      drift,
    };
  }
  if (breaks.length) {
    return {
      action: 'update-plugins-first',
      summary: `可以更新，但需先升级插件：${breaks.length} 个插件在当前版本上会失效，其市场最新版声明覆盖 ${targetVersion}。`,
      hardBreaks: [],
      fixable: breaks.map((r) => r.name),
      unknowns: unknowns.map((r) => r.name),
      drift,
    };
  }
  if (unknowns.length) {
    return {
      action: 'caution',
      summary: `可以更新：已声明的插件全部相容，但有 ${unknowns.length} 个插件没有兼容声明，无法静态判断（方案 A：不实测加载）。`,
      hardBreaks: [], fixable: [],
      unknowns: unknowns.map((r) => r.name),
      drift,
    };
  }
  return { action: 'update', summary: `可以放心更新：全部插件声明的兼容范围都包含 ${targetVersion}。`, hardBreaks: [], fixable: [], unknowns: [], drift };
}

// ═════════════════════════════ 更新源 ═════════════════════════════
export function readFeedConfig(appDshDir) {
  const candidates = [];
  if (appDshDir) {
    const resources = path.dirname(path.dirname(appDshDir));
    candidates.push(path.join(resources, 'app-update.yml'));
    candidates.push(path.join(path.dirname(resources), 'app-update.yml'));
  }
  for (const file of candidates) {
    let text;
    try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch { continue; }
    const pick = (key) => { const m = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(text); return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null; };
    return { file, provider: pick('provider'), url: pick('url'), channel: pick('channel') };
  }
  return { file: null, provider: null, url: null, channel: null };
}

function getText(url, { timeoutMs = 15000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'cache-control': 'no-cache' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(getText(next, { timeoutMs, redirects: redirects - 1 }));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} ${url}`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error(`超时 ${timeoutMs}ms：${url}`)));
    req.on('error', reject);
  });
}

export async function fetchUpdateFeed({ appDshDir, timeoutMs = 15000 } = {}) {
  const config = readFeedConfig(appDshDir);
  if (!config.url || !config.channel) return { ok: false, config, error: 'app-update.yml 未提供 url/channel' };
  const url = `${config.url.replace(/\/?$/, '/')}${config.channel}.yml`;
  const text = await getText(url, { timeoutMs });
  const pick = (key) => { const m = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(text); return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null; };
  const version = pick('version');
  if (!version) return { ok: false, config, url, error: '更新源未返回 version 字段', raw: text.slice(0, 400) };
  return {
    ok: true, config, url, version,
    releaseDate: pick('releaseDate'),
    size: pick('size') ? Number(pick('size')) : null,
    sha512: pick('sha512'),
  };
}

// ═════════════════════════════ 发布时效（pnpm 的 minimumReleaseAge 等待期）═════════════════════════════
/**
 * pnpm 有"新发布等待期"：某个版本发布不足 minimumReleaseAge 分钟时，pnpm 拒绝安装，
 * 报 ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION / ERR_PNPM_NO_MATURE_MATCHING_VERSION。
 * 默认 1440 分钟（24 小时）——这就是"插件上传不到 24 小时，npm 安装报错"的原因。
 *
 * 更麻烦的一面：一旦这种"还在等待期"的版本进了 lockfile，pnpm 在改动前会校验整个
 * lockfile，此后**任何**插件的安装/更新/卸载都会被拒（dshmarket install.js / pnpm-compat.js
 * 里记为 #39、#944）。所以除了"新品太新，装不上"，还要预警"已装但仍在等待期，会连累其它安装"。
 */
export const DEFAULT_RELEASE_AGE_MS = 24 * 60 * 60 * 1000;
/** 与 dshmarket lib/regions.js 的 NPM 常量保持一致（registry 由 region 决定）。 */
export const NPM_GLOBAL = 'https://registry.npmjs.org';
export const NPM_CHINA = 'https://mirrors.cloud.tencent.com/npm';

function tryReadText(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch { return null; }
}

/**
 * profile 的等待期窗口（毫秒）。与 dshmarket readMinimumReleaseAgeMs 的读法一致：
 * pnpm-workspace.yaml 的 minimumReleaseAge（分钟）→ .npmrc 的 minimum-release-age（分钟）→ pnpm 默认 1440。
 * 键存在但读不成数字时返回 valid:false —— 不臆造剩余时间。
 */
export function readReleaseAgeWindow(profileDir) {
  const dir = profileDir ?? '';
  const workspace = tryReadText(path.join(dir, 'pnpm-workspace.yaml'));
  if (workspace !== null && /^minimumReleaseAge\s*:/m.test(workspace)) {
    const match = /^minimumReleaseAge:\s*(\d+)\s*(?:#.*)?$/m.exec(workspace);
    if (!match) return { ms: null, minutes: null, source: 'pnpm-workspace.yaml: minimumReleaseAge', valid: false };
    const minutes = Number(match[1]);
    return { ms: minutes * 60000, minutes, source: 'pnpm-workspace.yaml: minimumReleaseAge', valid: true };
  }
  const npmrc = tryReadText(path.join(dir, '.npmrc'));
  if (npmrc !== null && /^minimum-release-age\s*=/m.test(npmrc)) {
    const match = /^minimum-release-age\s*=\s*(\d+)\s*(?:#.*)?$/m.exec(npmrc);
    if (!match) return { ms: null, minutes: null, source: '.npmrc: minimum-release-age', valid: false };
    const minutes = Number(match[1]);
    return { ms: minutes * 60000, minutes, source: '.npmrc: minimum-release-age', valid: true };
  }
  return { ms: DEFAULT_RELEASE_AGE_MS, minutes: DEFAULT_RELEASE_AGE_MS / 60000, source: 'pnpm 默认值（profile 未配置）', valid: true };
}

/** profile pnpm-workspace.yaml 里 minimumReleaseAgeExclude 的条目（裸名 / name@version / name@range，可 || 并列）。 */
export function readReleaseAgeExcludes(profileDir) {
  const text = tryReadText(path.join(profileDir ?? '', 'pnpm-workspace.yaml'));
  if (!text) return [];
  const out = [];
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^minimumReleaseAgeExclude\s*:/.test(line)) {
      inBlock = true;
      const rest = line.slice(line.indexOf(':') + 1).trim();
      if (rest.startsWith('[')) {
        for (const item of rest.replace(/^\[/, '').replace(/\].*$/, '').split(',')) {
          const value = item.trim().replace(/^['"]|['"]$/g, '');
          if (value) out.push(value);
        }
        inBlock = false;
      }
      continue;
    }
    if (!inBlock) continue;
    if (/^\s*-\s+/.test(line)) {
      const value = line.replace(/^\s*-\s+/, '').replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '').trim();
      if (value) out.push(value);
      continue;
    }
    if (/^\s*(#.*)?$/.test(line)) continue;
    inBlock = false;
  }
  return out;
}

/** 该 name@version 是否被 minimumReleaseAgeExclude 豁免。 */
export function exclusionOf(name, version, excludes = []) {
  for (const entry of excludes) {
    for (const token of String(entry).split(/\s*\|\|\s*/)) {
      const text = token.trim();
      if (!text) continue;
      if (text === name) return { entry, rule: 'bare' };
      if (text.startsWith(`${name}@`)) {
        const range = text.slice(name.length + 1).trim();
        if (!version) return { entry, rule: 'pinned', range };
        if (range === version) return { entry, rule: 'pinned', range };
        if (safeSatisfies(version, range) === true) return { entry, rule: 'range', range };
      }
    }
  }
  return null;
}

/** 市场与 pnpm 实际读的 registry：DSHM_REGISTRY_URL → 市场 region → profile .npmrc → npmjs 默认。 */
export function readRegistry(profileDir) {
  const fromEnv = process.env.DSHM_REGISTRY_URL;
  if (typeof fromEnv === 'string' && /^https?:\/\//.test(fromEnv.trim())) {
    return { url: fromEnv.trim().replace(/\/+$/, ''), region: null, source: 'env:DSHM_REGISTRY_URL' };
  }
  const state = readJson(path.join(profileDir ?? '', '.dsh-market', 'state.json'));
  const region = state?.region === 'china' ? 'china' : state?.region === 'global' ? 'global' : null;
  if (region === 'china') return { url: NPM_CHINA, region, source: '.dsh-market/state.json (region=china)' };
  if (region === 'global') return { url: NPM_GLOBAL, region, source: '.dsh-market/state.json (region=global)' };
  const npmrc = tryReadText(path.join(profileDir ?? '', '.npmrc'));
  const match = npmrc && /^registry\s*=\s*(\S+)\s*$/m.exec(npmrc);
  if (match) return { url: match[1].replace(/\/+$/, ''), region: null, source: '.npmrc: registry' };
  return { url: NPM_GLOBAL, region: null, source: '默认 registry.npmjs.org' };
}

function getJson(url, { timeoutMs = 15000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    // 必须请求完整文档：accept 里带 install-v1+json 会拿到精简格式，其中**没有 time 字段**。
    const req = https.get(url, { timeout: timeoutMs, headers: { accept: 'application/json', 'cache-control': 'no-cache' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(getJson(new URL(res.headers.location, url).toString(), { timeoutMs, redirects: redirects - 1 }));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} ${url}`)); return; }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error(`registry 返回的不是 JSON：${url}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`超时 ${timeoutMs}ms：${url}`)));
    req.on('error', reject);
  });
}

/** registry 文档里的发布时间表：{ ok, latest, times: {版本: ISO}, registry }。主 registry 失败时改试另一个。 */
export async function fetchRegistryTimes(name, { registry = NPM_GLOBAL, timeoutMs = 15000 } = {}) {
  const primary = String(registry ?? NPM_GLOBAL).replace(/\/+$/, '');
  const alternates = [primary, primary === NPM_CHINA ? NPM_GLOBAL : NPM_CHINA];
  let lastError = null;
  for (const base of alternates) {
    const url = `${base}/${name}`;
    try {
      const doc = await getJson(url, { timeoutMs });
      const times = doc?.time && typeof doc.time === 'object' ? doc.time : null;
      return { name, ok: true, registry: base, url, latest: doc?.['dist-tags']?.latest ?? null, times, error: null };
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
  }
  return { name, ok: false, registry: primary, url: `${primary}/${name}`, latest: null, times: null, error: lastError };
}

export function evaluateReleaseAge(publishedAt, { now = Date.now(), windowMs = DEFAULT_RELEASE_AGE_MS } = {}) {
  const at = publishedAt ? Date.parse(publishedAt) : NaN;
  if (!Number.isFinite(at)) return { known: false, at: null, ageMs: null, remainingMs: null, tooYoung: null };
  const ageMs = Math.max(0, now - at);
  const remainingMs = Math.max(0, windowMs - ageMs);
  return { known: true, at, ageMs, remainingMs, tooYoung: ageMs < windowMs };
}

export function describeAge(ms) {
  if (!Number.isFinite(ms)) return '未知';
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时 ${minutes % 60} 分`;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时`;
}

/** file: / link: / github: / git+ / http(s) tarball / workspace: 这类不是 registry 依赖，不受等待期影响。 */
export function isNonRegistrySpec(spec) {
  if (typeof spec !== 'string') return true;
  return /^(file:|link:|portal:|workspace:|github:|gitlab:|bitbucket:|git\+|git:|https?:)/.test(spec.trim());
}

const AGE_VERDICT = {
  'too-young': '太新，装不上',
  'holds-lockfile': '已装但在等待期',
  ready: '可装',
  exempt: '已豁免，可装',
  'unknown-time': '查不到发布时间',
  'unknown-window': '等待期配置无法解析',
  unreachable: 'registry 不可达',
  'not-registry': '非 registry 依赖',
};

/** formatReport 里的一行尾注。 */
export function releaseAgeNote(row) {
  const age = row?.releaseAge;
  if (!age) return '';
  if (age.exempt) return `；${age.version} 已在 minimumReleaseAgeExclude 豁免，可装`;
  if (!age.known) return '';
  if (age.tooYoung) return `，但发布仅 ${describeAge(age.ageMs)}，还要等 ${describeAge(age.remainingMs)} 才过 pnpm 等待期——现在装/更新会被拒（ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION）`;
  return '（已过 pnpm 等待期）';
}

/**
 * 发布时效报告：对指定包（或全部已装插件）查最新版本的发布时间，
 * 判断 pnpm 会不会因为"太新"拒绝安装。
 */
export async function freshness(options = {}) {
  const { names = null, timeoutMs = 15000, now = Date.now() } = options;
  const profile = options.profileDir
    ? { name: path.basename(options.profileDir), dir: options.profileDir, via: 'explicit' }
    : detectProfile();
  const window = options.windowMs
    ? { ms: options.windowMs, minutes: Math.round(options.windowMs / 60000), source: '调用方指定', valid: true }
    : readReleaseAgeWindow(profile.dir);
  const excludes = readReleaseAgeExcludes(profile.dir);
  const registry = readRegistry(profile.dir);
  const scanned = scanPlugins(profile.dir);
  const profilePkg = readJson(path.join(profile.dir ?? '', 'package.json'));
  const specs = profilePkg?.dependencies ?? {};
  const installedByName = new Map(scanned.plugins.map((p) => [p.name, p.version]));

  const targets = names && names.length ? names.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()) : scanned.plugins.map((p) => p.name);
  const rows = [];

  for (const name of targets) {
    const spec = typeof specs[name] === 'string' ? specs[name] : null;
    const installed = installedByName.get(name) ?? null;
    const row = {
      name, spec, installed,
      version: null, publishedAt: null, registry: registry.url,
      known: null, ageMs: null, remainingMs: null, tooYoung: null,
      exempt: null, verdict: null, note: '',
    };

    if (spec && isNonRegistrySpec(spec)) {
      rows.push({ ...row, verdict: 'not-registry', note: `依赖写法 ${spec.split(':')[0]}:，不经过 registry，不受 pnpm 等待期影响` });
      continue;
    }
    if (!window.valid) {
      rows.push({ ...row, verdict: 'unknown-window', note: 'profile 里 minimumReleaseAge 无法解析，不臆测剩余时间' });
      continue;
    }

    const fetched = await fetchRegistryTimes(name, { registry: registry.url, timeoutMs });
    if (!fetched.ok) {
      rows.push({ ...row, verdict: 'unreachable', note: `取不到 registry 元数据：${fetched.error}` });
      continue;
    }
    const version = fetched.latest ?? installed;
    const publishedAt = version ? fetched.times?.[version] ?? null : null;
    const age = evaluateReleaseAge(publishedAt, { now, windowMs: window.ms });
    const exempt = version ? exclusionOf(name, version, excludes) : null;
    const base = { ...row, registry: fetched.registry, version, publishedAt, ...age, exempt };

    if (!age.known) {
      rows.push({ ...base, verdict: 'unknown-time', note: `registry 没有 ${version} 的发布时间` });
    } else if (exempt) {
      rows.push({ ...base, verdict: 'exempt', note: `${exempt.rule === 'bare' ? '整个包' : exempt.range ?? version} 在 minimumReleaseAgeExclude 里，可装` });
    } else if (!age.tooYoung) {
      rows.push({ ...base, verdict: 'ready', note: `发布 ${describeAge(age.ageMs)}，已过等待期` });
    } else if (version && installed === version) {
      rows.push({ ...base, verdict: 'holds-lockfile', note: `已装但仍在等待期（还差 ${describeAge(age.remainingMs)}）：pnpm 改动前校验整个 lockfile，期间任何插件的安装/更新/卸载都会被拒` });
    } else {
      rows.push({ ...base, verdict: 'too-young', note: `发布仅 ${describeAge(age.ageMs)}，还要等 ${describeAge(age.remainingMs)} 才过等待期，现在安装会报 ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` });
    }
  }

  const count = (verdict) => rows.filter((row) => row.verdict === verdict).length;
  return {
    schema: 'dsh-compat-gate/freshness/v1',
    at: new Date(now).toISOString(),
    profile,
    registry: { url: registry.url, region: registry.region, source: registry.source },
    window,
    excludes,
    rows,
    summary: {
      total: rows.length,
      tooYoung: count('too-young'),
      holdsLockfile: count('holds-lockfile'),
      ready: count('ready'),
      exempt: count('exempt'),
      unknownTime: count('unknown-time'),
      unknownWindow: count('unknown-window'),
      unreachable: count('unreachable'),
      notRegistry: count('not-registry'),
    },
  };
}

export function formatFreshness(report) {
  const lines = [];
  lines.push(`宿主 dsh：${detectHost().version ?? '未识别'}　profile：${report.profile.name ?? '未识别'}  ${report.profile.dir ?? ''}`);
  lines.push(`pnpm 等待期：${report.window.valid ? `${report.window.minutes} 分钟（来源 ${report.window.source}）` : `无法解析（${report.window.source}）`}`);
  lines.push(`registry：${report.registry.url}（来源 ${report.registry.source}）`);
  lines.push(report.excludes.length ? `已豁免：${report.excludes.join('、')}` : '已豁免：无');
  lines.push('');
  lines.push('包                        版本        发布时间              结论');
  lines.push('─'.repeat(100));
  for (const row of report.rows) {
    const name = row.name.length > 24 ? `${row.name.slice(0, 23)}…` : row.name.padEnd(24);
    const version = String(row.version ?? '—').padEnd(11);
    const at = (row.publishedAt ? row.publishedAt.replace(/\.\d+Z$/, 'Z') : '—').padEnd(21);
    const label = AGE_VERDICT[row.verdict] ?? row.verdict ?? '-';
    lines.push(`${name}${version}${at}${label}`);
    if (row.note) lines.push(`${' '.repeat(26)}└ ${row.note}`);
  }
  const alerts = report.rows.filter((row) => row.verdict === 'too-young' || row.verdict === 'holds-lockfile');
  if (alerts.length) {
    lines.push('');
    lines.push(`⚠ 发布时效预警：${alerts.length} 个版本还没过 pnpm 等待期`);
    for (const row of alerts) {
      lines.push(`  ${row.name}@${row.version}：${row.verdict === 'too-young' ? `还要等 ${describeAge(row.remainingMs)} 才能装` : `已装但仍在等待期（还差 ${describeAge(row.remainingMs)}），期间任何插件增删都会被拒`}`);
    }
    lines.push('  处置：等过了等待期再操作；确需立刻装，在 profile 的 pnpm-workspace.yaml 里给这个名字加 minimumReleaseAgeExclude（同一名字只能有一行，pnpm 只读第一条）。');
  }
  return lines.join('\n');
}
// ═════════════════════════════ 账本 ═════════════════════════════
const LEDGER = path.join(PLUGIN_ROOT, 'data', 'ledger.json');

export function readLedger() {
  const data = readJson(LEDGER);
  return data && typeof data === 'object' ? data : { schema: 'dsh-compat-gate/ledger/v1', checks: [] };
}

export function recordCheck(entry) {
  const ledger = readLedger();
  ledger.checks = [...(ledger.checks ?? []), entry].slice(-50);
  ledger.last = entry;
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    return { ok: true, file: LEDGER };
  } catch (error) {
    return { ok: false, file: LEDGER, error: String(error?.message ?? error) };
  }
}

// ═════════════════════════════ 主分析 ═════════════════════════════
export async function analyze(options = {}) {
  const { target = null, useFeed = true, persist = false, timeoutMs = 15000 } = options;
  const host = detectHost();
  const hostDeps = detectHostDeps(host.appDshDir);
  const profile = detectProfile();
  const scanned = scanPlugins(profile.dir);
  const market = readMarketCache(profile.dir);

  let feed = null;
  let targetVersion = target;
  let targetSource = target ? 'explicit' : null;
  if (!targetVersion && useFeed) {
    try {
      feed = await fetchUpdateFeed({ appDshDir: host.appDshDir, timeoutMs });
      if (feed.ok) { targetVersion = feed.version; targetSource = `feed:${feed.url}`; }
    } catch (error) {
      feed = { ok: false, error: String(error?.message ?? error) };
    }
  }

  const results = scanned.plugins.map((plugin) => {
    const evaluation = evaluatePlugin(plugin, { hostVersion: targetVersion ?? host.version, hostDeps });
    return { ...plugin, ...evaluation, market: marketHint(plugin, market, targetVersion) };
  });

  // 发布时效：只对"市场有比已装更新的版本"的插件查发布时间（通常 0~2 个请求），
  // 预警 pnpm 的新发布等待期会让安装/更新直接被拒。
  const releaseAgeWindow = readReleaseAgeWindow(profile.dir);
  const releaseAgeExcludes = readReleaseAgeExcludes(profile.dir);
  const releaseAgeRegistry = readRegistry(profile.dir);
  if (options.age !== false) {
    for (const row of results) {
      if (!row.market?.newer || !row.market.latest) continue;
      const fetched = await fetchRegistryTimes(row.name, { registry: releaseAgeRegistry.url, timeoutMs });
      const publishedAt = fetched.times?.[row.market.latest] ?? null;
      const age = evaluateReleaseAge(publishedAt, { windowMs: releaseAgeWindow.ms ?? DEFAULT_RELEASE_AGE_MS });
      row.releaseAge = {
        version: row.market.latest,
        publishedAt,
        registry: fetched.registry,
        windowMs: releaseAgeWindow.ms,
        exempt: exclusionOf(row.name, row.market.latest, releaseAgeExcludes),
        ...age,
      };
    }
  }

  const verdict = recommend({ targetVersion, currentVersion: host.version, results });

  return {
    schema: 'dsh-compat-gate/report/v1',
    at: new Date().toISOString(),
    host: {
      version: host.version,
      via: host.via,
      dir: host.appDshDir,
      deps: hostDeps,
      tip: host.version !== null ? null
        : '宿主版本没认出来：在 dsh 应用内运行能自动定位；用普通 node 直接跑时，请把 DSH_APP_DIR 指向 <安装目录>\\resources\\app\\dsh。',
    },
    profile,
    target: { version: targetVersion, source: targetSource, releaseDate: feed?.releaseDate ?? null, feed },
    market: { available: market.available, file: market.file },
    releaseAge: {
      window: releaseAgeWindow,
      excludes: releaseAgeExcludes,
      registry: { url: releaseAgeRegistry.url, region: releaseAgeRegistry.region, source: releaseAgeRegistry.source },
    },
    plugins: results,
    verdict,
    persisted: persist ? recordCheck({ at: new Date().toISOString(), host: host.version, target: targetVersion, source: targetSource, verdict: { action: verdict.action, summary: verdict.summary }, statuses: results.map((r) => ({ name: r.name, version: r.version, status: r.status })) }) : null,
  };
}

// ═════════════════════════════ 文本渲染 ═════════════════════════════
const LABEL = { OK: '相容', BREAK: '会失效', UNKNOWN: '无法判断' };

export function formatReport(report) {
  const lines = [];
  lines.push(`宿主 dsh：${report.host.version ?? '未识别'}（cordis ${report.host.deps?.cordis ?? '?'} / schemastery ${report.host.deps?.schemastery ?? '?'}）  探测方式 ${report.host.via ?? '-'}`);
  lines.push(`profile：${report.profile.name ?? '未识别'}  ${report.profile.dir ?? ''}`);
  if (report.target.version) {
    lines.push(`目标版本：${report.target.version}（来源 ${report.target.source}${report.target.releaseDate ? `，发布 ${report.target.releaseDate}` : ''}）`);
  } else {
    lines.push(`目标版本：未取得${report.target.feed?.error ? `（${report.target.feed.error}）` : ''}`);
  }
  lines.push('');
  lines.push('插件                      版本        结论      说明');
  lines.push('─'.repeat(96));
  for (const p of report.plugins) {
    const name = p.name.length > 24 ? `${p.name.slice(0, 23)}…` : p.name.padEnd(24);
    const version = String(p.version ?? '—').padEnd(11);
    const status = LABEL[p.status]?.padEnd(8) ?? p.status.padEnd(8);
    const uniqueRanges = [...new Set(p.declarations.map((d) => d.range))];
    const note = p.status === STATUS.OK
      ? (p.market?.newer
        ? `声明相容；市场有新版 ${p.market.latest}${releaseAgeNote(p)}`
        : `声明：${uniqueRanges.join(' / ')}${p.declarations.length > uniqueRanges.length ? `（${p.declarations.length} 处声明同范围）` : ''}`)
      : p.reasons.join('；');
    lines.push(`${name}${version}${status}${note}`);
  }
  lines.push('');
  lines.push(`判定：${report.verdict.action}`);
  lines.push(`说明：${report.verdict.summary}`);
  if (report.verdict.fixable?.length) lines.push(`需先升级的插件：${report.verdict.fixable.join('、')}`);
  if (report.verdict.unknowns?.length) lines.push(`无法判断的插件：${report.verdict.unknowns.join('、')}`);
  const ageAlerts = report.plugins.filter((p) => p.releaseAge?.tooYoung && !p.releaseAge?.exempt);
  if (ageAlerts.length) {
    lines.push('');
    lines.push(`⚠ 发布时效预警：${ageAlerts.length} 个插件的新版还在 pnpm 等待期内，现在点安装/更新会被拒`);
    for (const p of ageAlerts) {
      lines.push(`  ${p.name}@${p.releaseAge.version} 发布于 ${p.releaseAge.publishedAt ?? '?'}，还要等 ${describeAge(p.releaseAge.remainingMs)}`);
    }
    if (report.releaseAge?.window?.source) lines.push(`  等待期：${report.releaseAge.window.minutes ?? '?'} 分钟（来源 ${report.releaseAge.window.source}）`);
  }
  if (report.persisted) lines.push(`账本：${report.persisted.ok ? report.persisted.file : `写入失败 ${report.persisted.error}`}`);
  return lines.join('\n');
}

// ═════════════════════════════ 更新后核对 ═════════════════════════════
/**
 * 用"当前真实运行的宿主版本"重新判定一遍，并与账本里上一次记录对比：
 * 上一次还算 OK 的插件现在变成 BREAK，就是"更新后确实不能用"的实证。
 */
export async function audit(options = {}) {
  const { persist = true } = options;
  const host = detectHost();
  if (!host.version) return { ok: false, error: '宿主版本未识别，无法核对' };

  const report = await analyze({ target: host.version, useFeed: false, persist: false });
  const ledger = readLedger();
  const previous = ledger.last && ledger.last.host !== host.version ? ledger.last : null;
  const before = new Map((previous?.statuses ?? []).map((s) => [s.name, s]));

  const changes = report.plugins.map((p) => {
    const old = before.get(p.name);
    return {
      name: p.name,
      version: p.version,
      previousVersion: old?.version ?? null,
      was: old?.status ?? null,
      now: p.status,
    };
  });

  const broken = changes.filter((c) => c.was === STATUS.OK && c.now === STATUS.BREAK);
  const fixed = changes.filter((c) => c.was === STATUS.BREAK && c.now === STATUS.OK);
  const result = {
    ok: true,
    host: host.version,
    previousHost: previous?.host ?? null,
    versionChanged: Boolean(previous),
    changes,
    broken,
    fixed,
    report,
    persisted: persist ? recordCheck({
      at: new Date().toISOString(), host: host.version, target: host.version, source: 'audit',
      verdict: { action: 'audit', summary: `宿主 ${host.version}` },
      statuses: report.plugins.map((p) => ({ name: p.name, version: p.version, status: p.status })),
    }) : null,
  };
  return result;
}

export function formatAudit(result) {
  if (!result?.ok) return `核对失败：${result?.error ?? '未知原因'}`;
  const lines = [`宿主 dsh：${result.host}${result.previousHost ? `（上次记录 ${result.previousHost}）` : '（首次记录）'}`];
  if (!result.versionChanged) {
    lines.push('版本未变化，没有可对比的历史记录；已记入账本供下次对比。');
  } else {
    lines.push(`自 ${result.previousHost} → ${result.host}：`);
    if (result.broken.length) {
      lines.push(`  确认失效 ${result.broken.length} 个：${result.broken.map((c) => `${c.name}@${c.version}`).join('、')}`);
    }
    if (result.fixed.length) {
      lines.push(`  已恢复 ${result.fixed.length} 个：${result.fixed.map((c) => `${c.name}@${c.version}`).join('、')}`);
    }
    if (!result.broken.length && !result.fixed.length) lines.push('  结论未变。');
  }
  lines.push('');
  lines.push('当前各插件（按实际运行的宿主判定）：');
  for (const c of result.changes) {
    lines.push(`  ${c.name}@${c.version ?? '?'}  ${LABEL[c.now] ?? c.now}${c.was && c.was !== c.now ? `（上次 ${LABEL[c.was] ?? c.was}）` : ''}`);
  }
  if (result.persisted) lines.push(`账本：${result.persisted.ok ? result.persisted.file : `写入失败 ${result.persisted.error}`}`);
  return lines.join('\n');
}

export function formatLedger() {
  const ledger = readLedger();
  const checks = ledger.checks ?? [];
  if (!checks.length) return '账本为空：还没有任何记录。';
  const lines = [`账本共 ${checks.length} 条记录（最新 ${checks[checks.length - 1].at}）：`];
  for (const c of checks.slice(-10).reverse()) {
    const statuses = (c.statuses ?? []).map((s) => `${s.name}:${LABEL[s.status] ?? s.status}`).join(' ');
    lines.push(`  ${c.at} 宿主 ${c.host} → 目标 ${c.target ?? '-'}  判定 ${c.verdict?.action ?? '-'}  ${statuses}`);
  }
  return lines.join('\n');
}
export { LEDGER };