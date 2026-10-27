// 桌面版把 dsh 树放在 resources\app.asar 里，没有 resources\app 目录——
// 老代码只探 'app' 这个名字，于是桌面端全报"宿主版本未识别"。这里锁住新版行为。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAppDirName, resourceAppDirs, versionFromRuntimes } from '../lib/gate.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detect-'));
const resources = path.join(root, 'resources');
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
};

fs.mkdirSync(path.join(resources, 'app.asar', 'dsh'), { recursive: true });
fs.mkdirSync(path.join(resources, 'app.asar.unpacked', 'dsh'), { recursive: true });
write(path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }));
write(path.join(resources, 'app-update.yml'), 'provider: generic\nurl: https://example.com/feeds/\nchannel: nightly\n');
write(path.join(resources, 'runtime', 'primary-runtime', 'runtime.json'), JSON.stringify({ desktopVersion: '9.9.9' }));

assert.equal(isAppDirName('app'), true);
assert.equal(isAppDirName('app.asar'), true);
assert.equal(isAppDirName('app.asar.unpacked'), true);
assert.equal(isAppDirName('app-update.yml'), false, 'app-update.yml 不是 dsh 树');
assert.equal(isAppDirName('dsh'), false);

const dirs = resourceAppDirs(resources);
assert.deepEqual(dirs.map((d) => path.basename(d)).sort(), ['app.asar', 'app.asar.unpacked'], '只有 app.asar 时也要认出来');
assert.ok(path.basename(dirs[dirs.length - 1]).includes('unpacked'), 'app.asar.unpacked 必须排在最后');
assert.deepEqual(resourceAppDirs(path.join(root, 'not-there')), [], '目录不存在时返回空数组，不抛');

const fallback = versionFromRuntimes(root);
assert.ok(fallback, '读不到 package.json 时要能从 runtime.json 兜底');
assert.equal(fallback.version, '9.9.9');
assert.equal(fallback.via, 'runtime.json:primary-runtime');

const nested = versionFromRuntimes(path.join(root, 'not-there'));
assert.ok(nested && nested.version === '9.9.9', '从子目录也要能向上找到 resources');

console.log('桌面版探测测试通过：app.asar 识别 / unpacked 排后 / runtime.json 兜底');
