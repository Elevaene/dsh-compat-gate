import { analyze, formatReport } from '../lib/gate.js';
for (const target of [null, '0.3.0-0', '0.3.0']) {
  const report = await analyze({ target, useFeed: target === null });
  console.log(`\n=========== target=${target ?? '(取自更新源)'} ===========`);
  console.log(formatReport(report));
}