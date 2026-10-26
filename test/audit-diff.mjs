import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, LEDGER, audit, formatAudit } from '../lib/gate.js';

const emptyLedger = { schema: 'dsh-compat-gate/ledger/v1', checks: [] };
const seed = {
  schema: 'dsh-compat-gate/ledger/v1',
  checks: [],
  last: {
    at: '2026-10-20T00:00:00.000Z',
    host: '0.2.1-rc.2',
    target: '0.2.1-rc.3',
    source: 'audit',
    verdict: { action: 'audit', summary: '宿主 0.2.1-rc.2' },
    statuses: [
      { name: 'billion-context', version: '0.1.208', status: 'UNKNOWN' },
      { name: 'dsh-cline-pass', version: '0.2.12', status: 'OK' },
      { name: 'dsh-infinite-gen-5', version: '1.1.0', status: 'OK' },
      { name: 'dshmarket', version: '1.70.2', status: 'OK' },
    ],
  },
};
fs.writeFileSync(LEDGER, JSON.stringify(seed, null, 2), 'utf8');

process.env.DSH_APP_DIR = path.join(PLUGIN_ROOT, 'test', 'fixtures', 'fake-app-0.3.0', 'dsh');
const result = await audit({ persist: false });

assert.equal(result.ok, true, '审计应成功');
assert.equal(result.host, '0.3.0');
assert.equal(result.previousHost, '0.2.1-rc.2');
assert.equal(result.versionChanged, true);
const brokenNames = result.broken.map((b) => b.name).sort();
assert.deepEqual(brokenNames, ['dsh-cline-pass', 'dsh-infinite-gen-5', 'dshmarket'], `失效清单不符: ${brokenNames}`);
assert.deepEqual(result.fixed, []);
console.log(formatAudit(result));
console.log('\n✓ 伪 0.3.0 宿主 → 精确识别出 3 个"更新前相容、更新后失效"的插件');

fs.writeFileSync(LEDGER, JSON.stringify(emptyLedger, null, 2), 'utf8');
console.log('✓ 已把账本复原为空（未删除文件）');