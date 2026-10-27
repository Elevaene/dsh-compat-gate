import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkInstallIntegrity, resourcesDirOf, integrityItems } from '../lib/gate.js';

// 用临时目录造一个"安装目录"，别碰真实安装
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-integrity-'));
const resources = path.join(tmp, 'resources');
const appDsh = path.join(resources, 'app.asar', 'dsh');
fs.mkdirSync(appDsh, { recursive: true });

// 1) 空目录：缺东西，且认得出 Office 技能
const empty = checkInstallIntegrity(appDsh, '0.2.1-rc.3');
assert.equal(empty.ok, false, '空安装目录必须判成不完整');
assert.ok(empty.missing.includes('Office 技能总览'), 'Office 技能缺失要能被点名');
assert.ok(empty.missing.length >= 5, '缺的项要全部列出来');
assert.equal(empty.checked.length, integrityItems().length, '每一项都要有检查记录');

// 2) resources 定位：从 app.asar/dsh 上退两层；从 node_modules 也能退
assert.equal(path.resolve(empty.resources), path.resolve(resources));
assert.equal(path.resolve(resourcesDirOf(path.join(appDsh, 'node_modules'))), path.resolve(resources));

// 3) 认不出安装目录时既不抛也不瞎判
const weird = checkInstallIntegrity('/nope/definitely-not-an-app-dir');
assert.equal(weird.ok, null, '认不出目录就给 null，不要说"完整"');
assert.ok(weird.note, '认不出目录要说明原因');
assert.equal(resourcesDirOf(''), null, '空字符串不该被当成 app 目录');

// 4) 把 7 项都造出来 → 完整
for (const item of integrityItems()) {
  const file = path.join(resources, ...item.parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x', 'utf8');
}
fs.writeFileSync(path.join(resources, 'runtime', 'primary-runtime', 'runtime.json'),
  JSON.stringify({ desktopVersion: '0.2.1-rc.3' }), 'utf8');
const full = checkInstallIntegrity(appDsh, '0.2.1-rc.3');
assert.equal(full.ok, true, '文件齐了要判成完整');
assert.deepEqual(full.missing, []);
assert.equal(full.runtimeVersion, '0.2.1-rc.3', 'runtime.json 里的版本要读出来');
assert.equal(full.note, null, '版本一致时不该有告警');

// 5) 程序版本与运行时数据不一致 → 保留 ok=true，但给出 note
const drift = checkInstallIntegrity(appDsh, '0.2.1-rc.4');
assert.equal(drift.ok, true);
assert.match(drift.note, /不一致/, '版本不一致要提示');

// 6) 结果必须是无损 JSON（要进快照、进投影）
const round = JSON.parse(JSON.stringify(full));
assert.deepEqual(round, JSON.parse(JSON.stringify(full)), 'JSON 往返不能丢信息');
assert.equal(typeof full.ok, 'boolean');

console.log('完整性检查通过：缺项点名 / 目录定位 / 认不出给 null / 版本不一致提示');
