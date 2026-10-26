import { analyze, formatReport, detectHost, detectProfile } from '../lib/gate.js';

const host = detectHost();
const profile = detectProfile();
console.log('--- 探测 ---');
console.log('宿主版本:', host.version, '| 方式:', host.via);
console.log('宿主目录:', host.appDshDir);
console.log('execPath:', process.execPath);
console.log('profile:', profile.name, '| 方式:', profile.via, '|', profile.dir);
console.log('试过:', host.tried?.length ?? 0, '个候选路径');
console.log('');

const report = await analyze({ useFeed: true, persist: false });
console.log(formatReport(report));
console.log('');
console.log('--- 明细 ---');
for (const p of report.plugins) {
  console.log(`${p.name}@${p.version ?? '?'} → ${p.status} | 声明数 ${p.declarations.length} | ${p.dir}`);
  for (const c of p.checks) console.log(`    [${c.ok === null ? '?' : c.ok ? '✓' : '✗'}] ${c.site} = ${c.range}`);
  if (p.market) console.log(`    market: latest=${p.market.latest} newer=${p.market.newer} covers=${p.market.covers}`);
}