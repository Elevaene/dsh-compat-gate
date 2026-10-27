import fs from 'node:fs';
import { createRequire } from 'node:module';
import { satisfies, compareVersions, parseVersion } from '../lib/gate.js';

// 宿主的 semver 用来做差分对照。安装目录可能是 resources/app（解包安装），
// 也可能是 resources/app.asar（桌面版，普通 node 读不进去），所以按候选顺序找，
// 都没有就跳过——别让一个环境差异把整套测试卡死。
const here = new URL('../', import.meta.url);
const candidates = [];
if (process.env.DSH_COMPAT_GATE_SEMVER) candidates.push(process.env.DSH_COMPAT_GATE_SEMVER);
candidates.push('file:///D:/Software/DeepSeek%20Harness/resources/app/node_modules/');
try {
  const backups = fs.readdirSync(new URL('backups/', here)).filter((name) => name.startsWith('host-semver-')).sort();
  if (backups.length) candidates.push(new URL('backups/' + backups[backups.length - 1] + '/node_modules/', here).href);
} catch { /* 没有导出的副本就继续找下一个 */ }
let semver = null;
for (const base of candidates) {
  try { semver = createRequire(base)('semver'); break; } catch { /* 换下一个 */ }
}
if (!semver) {
  console.log('跳过差分测试：读不到宿主的 semver（可用 DSH_COMPAT_GATE_SEMVER 指定 package.json 所在目录）');
  process.exit(0);
}

const ranges = [
  '>=0.1.2-alpha.3 <0.3.0',
  '>=0.2.0-rc.1 <0.3.0-0',
  '^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.2.0-rc.1 || ^0.2.1-alpha.3 || ^0.2.1-rc.1',
  '^4.0.5', '^4.0.2', '^4.0.1', '^3.18.1', '^3.18.5',
  '1.1.0', '*', 'x', '', '^1', '~1.2', '1.2', '1', '>=1 <2', '1.2.3 - 2.3.4',
  '^0.0.3', '~0.2.3', '~0', '^0', '^0.0', '^0.2', '>0.2.1-rc.2', '<=0.2.1', '<0.3.0-0', '=0.2.1',
  '0.2.x', '0.2.1 || 1.0.0', '>=0.2.1-rc.1 <0.2.2',
];
const versions = [
  '0.1.0-alpha.1', '0.1.2-alpha.3', '0.2.0-rc.1', '0.2.1-alpha.3', '0.2.1-rc.1',
  '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1', '0.2.2', '0.3.0-0', '0.3.0', '1.0.0', '0.0.3', '0.0.4', '1.2.3', '2.3.4', '2.3.5', '4.0.5', '3.18.5',
];

let checked = 0; const bad = [];
for (const mode of [true, false]) {
  for (const r of ranges) {
    for (const v of versions) {
      let expected;
      try { expected = semver.satisfies(v, r, { includePrerelease: mode }); } catch (e) { expected = `ERR:${e.message}`; }
      let actual;
      try { actual = satisfies(v, r, { includePrerelease: mode }); } catch (e) { actual = `ERR:${e.message}`; }
      checked++;
      if (expected !== actual) bad.push(`[includePrerelease=${mode}] ${v} vs "${r}": 期望 ${expected} 实得 ${actual}`);
    }
  }
}
for (const [a, b] of [['0.2.1-rc.1','0.2.1-rc.2'], ['0.2.1-rc.2','0.2.1'], ['0.2.1','0.2.2'], ['0.3.0-0','0.3.0'], ['0.1.0-alpha.1','0.1.0-alpha.2'], ['1.0.0-alpha','1.0.0-alpha.1']]) {
  const e = semver.compare(a, b); const g = compareVersions(a, b); checked++;
  if (e !== g) bad.push(`compare(${a},${b}) 期望 ${e} 实得 ${g}`);
}

console.log(`对照 ${checked} 组，不一致 ${bad.length} 组`);
for (const line of bad.slice(0, 40)) console.log('  ✗ ' + line);
if (!bad.length) console.log('semver 子集与 node-semver 行为一致（含 includePrerelease 两种模式）');