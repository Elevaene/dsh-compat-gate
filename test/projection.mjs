/**
 * 投影与状态快照测试：契约形状、无损 JSON、缺文件兜底。
 * 不写仓库内的真实 data/status.json（用系统临时目录）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compatGateDefinition, PROJECTION_KEY } from '../lib/projection.js';
import { publishStatus, readStatus, statusView, summarizeAudit, summarizeReport } from '../lib/status.js';

function assertLossless(value, label = 'value') {
  const seen = new Set();
  const walk = (node, at) => {
    if (node === undefined) throw new Error(`${label}: ${at} 是 undefined`);
    if (typeof node === 'number' && Object.is(node, -0)) throw new Error(`${label}: ${at} 是 -0`);
    if (typeof node === 'number' && !Number.isFinite(node)) throw new Error(`${label}: ${at} 不是有限数`);
    if (typeof node === 'function' || typeof node === 'symbol' || typeof node === 'bigint') throw new Error(`${label}: ${at} 类型 ${typeof node}`);
    if (node && typeof node === 'object') {
      if (seen.has(node)) throw new Error(`${label}: ${at} 有环引用`);
      seen.add(node);
      for (const [k, v] of Object.entries(node)) walk(v, `${at}.${k}`);
      seen.delete(node);
    }
  };
  walk(value, '$');
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label} 与 JSON 往返不一致`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-gate-projection-'));
const tmpStatus = path.join(tmpDir, 'status.json');

// ── 1. 投影定义符合 dsh-session-projection 的契约 ──
const def = compatGateDefinition();
assert.equal(def.key, PROJECTION_KEY);
assert.equal(typeof def.stateVersion, 'number');
assert.equal(typeof def.stateSchema.parse, 'function');
assert.equal(typeof def.init, 'function');
assert.equal(typeof def.apply, 'function');
assert.equal(typeof def.wire.view, 'function');
assert.equal(typeof def.wire.viewSchema.parse, 'function');
assert.equal(def.init.length, 0, 'init 必须可无参调用（缺省 header 时也不能崩）');

// ── 2. apply 是纯函数：无关事件返回同一个 state ──
const s0 = def.init();
assert.deepEqual(s0, { revision: 0, lastEvent: null });
assert.equal(def.apply(s0, null), s0);
assert.equal(def.apply(s0, { type: 'message/user' }), s0);
assert.equal(def.apply(s0, { type: 'tool/result', data: { message: { name: 'other_tool', toolCallId: 'x' } } }), s0);
const s1 = def.apply(s0, { type: 'command/done', data: { name: 'compat' } });
assert.equal(s1.revision, 1);
assert.equal(s1.lastEvent, 'command');
assert.equal(s0.revision, 0, 'apply 不得改写入参');
const s2 = def.apply(s0, { type: 'tool/result', data: { message: { name: 'compat_gate', toolCallId: 'call-1' } } });
assert.equal(s2.revision, 1);
assert.equal(s2.lastEvent, 'tool');

// ── 3. view 在没有任何快照时也必须返回无损 JSON，而不是抛异常 ──
const empty = statusView(tmpStatus);
assert.equal(empty.ok, false);
assert.equal(empty.reason, 'no-status');
assert.equal(typeof empty.hint, 'string');
assertLossless(empty, 'statusView(empty)');

// ── 4. 写入快照后可以读回，并保持无损 ──
const published = publishStatus({
  source: 'check',
  host: { version: '0.2.1-rc.2', cordis: '4.0.5', schemastery: '3.18.5', profile: 'web' },
  target: { version: '0.2.1-rc.3', source: 'feed' },
  verdict: { action: 'caution', summary: '4 个相容，1 个无法判断', label: '可以更新，但有插件无法判断' },
  counts: { ok: 4, break: 0, unknown: 1 },
  plugins: [{ name: 'billion-context', version: '0.1.208', status: 'UNKNOWN', label: '无法判断', reason: '没有任何 dsh 兼容声明' }],
}, tmpStatus);
assert.equal(published.counts.ok, 4);
assertLossless(published, 'publishStatus');
const readBack = readStatus(tmpStatus);
assert.deepEqual(readBack, published);
const view = statusView(tmpStatus);
assert.equal(view.ok, true);
assert.equal(view.verdict.action, 'caution');
assertLossless(view, 'statusView(published)');

// ── 5. 合并语义：后一次写入只覆盖传入字段，并清掉 lastError ──
publishStatus({ error: '网络不可达' }, tmpStatus);
assert.equal(readStatus(tmpStatus).lastError, '网络不可达');
publishStatus({ source: 'audit' }, tmpStatus);
const merged = readStatus(tmpStatus);
assert.equal(merged.lastError, undefined, '成功写入应清掉 lastError');
assert.equal(merged.counts.ok, 4, '未传的字段要保留');
assert.equal(merged.source, 'audit');

// ── 6. summarizeReport / summarizeAudit 的压缩结果 ──
const fakeReport = {
  host: { version: '0.2.1-rc.2', deps: { cordis: '4.0.5', schemastery: '3.18.5' } },
  profile: { name: 'web' },
  target: { version: '0.3.0', source: 'explicit' },
  verdict: { action: 'defer', summary: '3 个插件会失效' },
  plugins: [
    { name: 'a', version: '1.0.0', status: 'OK', reasons: [] },
    { name: 'b', version: '2.0.0', status: 'BREAK', reasons: ['peerDependencies 要求 <0.3.0'] },
    { name: 'c', version: '3.0.0', status: 'UNKNOWN', reasons: ['没有任何 dsh 兼容声明'] },
  ],
};
const summarized = summarizeReport(fakeReport, 'check');
assert.deepEqual(summarized.counts, { ok: 1, break: 1, unknown: 1 });
assert.equal(summarized.verdict.label, '建议暂缓更新');
assert.equal(summarized.plugins[1].label, '会失效');
assert.equal(summarized.plugins[1].reason, 'peerDependencies 要求 <0.3.0');
assertLossless(summarized, 'summarizeReport');
assert.equal(summarizeReport(null), null);

const summarizedAudit = summarizeAudit({ ok: true, host: { version: '0.3.0' }, previousHost: '0.2.1-rc.2', versionChanged: true, broken: [{ name: 'b', version: '2.0.0' }], fixed: [] });
assert.equal(summarizedAudit.verdict.action, 'defer');
assert.equal(summarizedAudit.audit.broken.length, 1);
assertLossless(summarizedAudit, 'summarizeAudit');
assert.equal(summarizeAudit({ ok: false, reason: 'no-ledger' }), null);

// 临时目录由系统回收；按 A2 规则这里不做删除。
console.log('projection 测试通过：契约形状 / 纯函数 apply / 缺快照兜底 / 无损 JSON / 合并语义 / 压缩摘要');