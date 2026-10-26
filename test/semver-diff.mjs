import { createRequire } from 'node:module';
import { satisfies, compareVersions, parseVersion } from '../lib/gate.js';

const require = createRequire('file:///D:/Software/DeepSeek%20Harness/resources/app/node_modules/');
const semver = require('semver');

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