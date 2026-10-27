import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_RELEASE_AGE_MS, NPM_CHINA, NPM_GLOBAL, describeAge, detectProfile, evaluateReleaseAge,
  exclusionOf, formatFreshness, freshness, isNonRegistrySpec, readRegistry,
  readReleaseAgeExcludes, readReleaseAgeWindow,
} from '../lib/gate.js';

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `cg-${label}-`));
const write = (dir, name, text) => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
};

// ── 1) 等待期窗口：默认 / pnpm-workspace.yaml / .npmrc / 坏值 ──
const d1 = tmp('default');
let window = readReleaseAgeWindow(d1);
assert.equal(window.ms, DEFAULT_RELEASE_AGE_MS);
assert.equal(window.minutes, 1440);
assert.equal(window.valid, true);
console.log('✓ 未配置 → pnpm 默认 1440 分钟');

const d2 = tmp('yaml');
write(d2, 'pnpm-workspace.yaml', 'packages:\n  - .\nminimumReleaseAge: 60\n');
window = readReleaseAgeWindow(d2);
assert.equal(window.minutes, 60);
assert.equal(window.ms, 3600000);
console.log('✓ pnpm-workspace.yaml minimumReleaseAge: 60 → 3600000ms');

const d3 = tmp('npmrc');
write(d3, '.npmrc', 'minimum-release-age=30\n');
assert.equal(readReleaseAgeWindow(d3).minutes, 30);
console.log('✓ .npmrc minimum-release-age=30 → 30 分钟');

const d4 = tmp('bad');
write(d4, 'pnpm-workspace.yaml', 'minimumReleaseAge: 一小时\n');
const bad = readReleaseAgeWindow(d4);
assert.equal(bad.valid, false);
assert.equal(bad.ms, null);
console.log('✓ 配置读不成数字 → valid:false，不臆造剩余时间');

// ── 2) 真 profile：豁免清单 + registry ──
const profile = detectProfile();
assert.ok(profile.dir, '真 profile 应能定位');
const excludes = readReleaseAgeExcludes(profile.dir);
console.log('真 profile 豁免清单：', excludes);
// 豁免清单随 profile 变化（web 有 2 条，desktop 有 4 条），只锁格式与已知条目，不锁全等
assert.ok(excludes.includes('billion-context@0.1.208'), 'billion-context 必须在豁免清单里');
assert.ok(excludes.includes('dsh-cline-pass@0.2.12'), 'dsh-cline-pass 必须在豁免清单里');
for (const item of excludes) {
  const at = item.lastIndexOf('@');
  assert.ok(at > 0 && at < item.length - 1, '豁免条目应是 名字@版本：' + item);
}
const registry = readRegistry(profile.dir);
// 桌面 profile 没有 .npmrc 时会落回默认源，所以只锁是已知源之一
assert.ok([NPM_CHINA, NPM_GLOBAL].includes(registry.url), 'registry 应是已知源之一：' + registry.url);
console.log(`✓ registry = ${registry.url}（${registry.source}）`);

// ── 3) 豁免匹配：裸名 / 精确版本 / 范围 ──
assert.equal(exclusionOf('dsh-cline-pass', '0.2.12', excludes).rule, 'pinned');
assert.equal(exclusionOf('billion-context', '0.1.209', excludes), null);
assert.equal(exclusionOf('foo', '1.2.3', ['foo']).rule, 'bare');
assert.equal(exclusionOf('foo', '1.2.3', ['foo@^1.0.0']).rule, 'range');
assert.equal(exclusionOf('foo', '2.0.0', ['foo@^1.0.0']), null);
console.log('✓ 豁免匹配：裸名 / 精确版本 / semver 范围');

// ── 4) 时效计算 ──
const now = Date.parse('2026-10-26T12:00:00.000Z');
const young = evaluateReleaseAge('2026-10-26T01:00:00.000Z', { now });
assert.equal(young.tooYoung, true);
assert.equal(young.remainingMs, 13 * 3600000);
const old = evaluateReleaseAge('2026-10-24T01:00:00.000Z', { now });
assert.equal(old.tooYoung, false);
assert.equal(old.remainingMs, 0);
assert.equal(evaluateReleaseAge(null, { now }).known, false);
assert.equal(describeAge(13 * 3600000), '13 小时 0 分');
assert.equal(describeAge(45 * 60000), '45 分');
assert.equal(describeAge(50 * 3600000), '2 天 2 小时');
console.log('✓ 时效计算与时长格式化');

// ── 5) 非 registry 依赖 ──
for (const spec of ['github:a/b#c', 'file:../../plugins/x', 'link:../y', 'git+https://x/y.git', 'https://x/y.tgz', 'workspace:*']) {
  assert.equal(isNonRegistrySpec(spec), true, spec);
}
for (const spec of ['1.70.2', '^0.1.0', '>=1 <2', 'latest']) {
  assert.equal(isNonRegistrySpec(spec), false, spec);
}
console.log('✓ github:/file:/link:/git+/http/workspace 不算 registry 依赖');

// ── 6) 伪 profile（等待期 69 天）→ 已装但仍在等待期 ──
const fake = tmp('young');
write(fake, 'package.json', JSON.stringify({ name: 'fake-profile', dependencies: { dshmarket: '1.70.2' }, dsh: { profile: { bundles: ['dshmarket'] } } }, null, 2));
write(fake, 'node_modules/dshmarket/package.json', JSON.stringify({ name: 'dshmarket', version: '1.70.2' }));
write(fake, 'pnpm-workspace.yaml', 'packages:\n  - .\nminimumReleaseAge: 100000\n');
process.env.DSHM_REGISTRY_URL = NPM_CHINA;
const held = await freshness({ profileDir: fake, names: ['dshmarket'] });
// registry 里 latest 会随时间前移，所以这里只看"装的是不是最新"对应的结论，不写死时间点
const row6 = held.rows[0];
assert.equal(row6.verdict, row6.version === row6.installed ? 'holds-lockfile' : 'too-young', JSON.stringify(row6));
console.log('\n【伪 profile：等待期 69 天，已装同版本】');
console.log(formatFreshness(held));

// ── 7) 已装落后 → too-young ──
write(fake, 'node_modules/dshmarket/package.json', JSON.stringify({ name: 'dshmarket', version: '1.60.0' }));
const youngRow = await freshness({ profileDir: fake, names: ['dshmarket'] });
assert.equal(youngRow.rows[0].verdict, 'too-young', JSON.stringify(youngRow.rows[0]));
assert.ok(youngRow.rows[0].remainingMs > 0);
console.log('\n✓ 已装落后且新版太新 → too-young，剩余 ' + describeAge(youngRow.rows[0].remainingMs));

// ── 8) 写进豁免清单后放行 ──
write(fake, 'pnpm-workspace.yaml', 'packages:\n  - .\nminimumReleaseAge: 100000\nminimumReleaseAgeExclude:\n  - dshmarket@' + row6.version + '\n');
assert.equal((await freshness({ profileDir: fake, names: ['dshmarket'] })).rows[0].verdict, 'exempt');
console.log('✓ minimumReleaseAgeExclude 命中 → exempt');

// ── 9) 真 profile 全量 ──
delete process.env.DSHM_REGISTRY_URL;
const real = await freshness();
console.log('\n【真 profile 全量】');
console.log(formatFreshness(real));
const byName = new Map(real.rows.map((row) => [row.name, row]));
// 豁免条目写的是精确版本（xxx@1.2.3），插件又发了新版本时就不再命中，
// 所以这里只锁"结论合法"，不锁具体值——否则一个上游发版就把测试打红。
const allowed = ['exempt', 'ready', 'too-young', 'holds-lockfile', 'unknown-time'];
for (const name of ['billion-context', 'dsh-cline-pass']) {
  const row = byName.get(name);
  assert.ok(row, name + ' 应该出现在真 profile 的清单里');
  assert.ok(allowed.includes(row.verdict), name + ' 的结论应该是合法值，实际 ' + row.verdict);
}
assert.equal(byName.get('dsh-token-metrics').verdict, 'not-registry');
assert.equal(byName.get('dsh-infinite-gen-5').verdict, 'not-registry');
assert.ok(['ready', 'too-young', 'holds-lockfile'].includes(byName.get('dshmarket').verdict));
console.log('\n全部通过');