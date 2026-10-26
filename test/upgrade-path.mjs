/**
 * 升级路径测试（v0.2.4）：
 *  - fixCommandFor：只给"市场最新版真的覆盖目标版本"的插件拼命令，covers 为 null/false 时闭嘴；
 *  - summarizeReport：修复命令与发布等待期必须进快照（之前 releaseAge 被扔掉了）；
 *  - summarizeAudit：更新后复核里，确认失效的插件也要带命令。
 */
import assert from 'node:assert/strict';
import { fixCommandFor, needsAudit } from '../lib/gate.js';
import { summarizeReport, summarizeAudit, summarizeReleaseAge } from '../lib/status.js';

// ── fixCommandFor ──
assert.equal(
  fixCommandFor({ name: 'dsh-ops', market: { latest: '0.4.2', newer: true, covers: true } }, 'web'),
  'dsh plugin --profile web add dsh-ops@0.4.2',
);
assert.equal(
  fixCommandFor({ name: 'dsh-ops', market: { latest: '0.4.2', newer: true, covers: true } }),
  'dsh plugin --profile web add dsh-ops@0.4.2',
  'profile 默认 web',
);
assert.equal(fixCommandFor({ name: 'x', market: { latest: '1.0.0', newer: true, covers: false } }), null, '新版也覆盖不了就别给命令');
assert.equal(fixCommandFor({ name: 'x', market: { latest: '1.0.0', newer: true, covers: null } }), null, 'covers 未知时不给命令');
assert.equal(fixCommandFor({ name: 'x', market: { latest: '1.0.0', newer: false } }), null, '没有更新版就不给命令');
assert.equal(fixCommandFor({ name: 'x', market: null }), null);
assert.equal(fixCommandFor(null), null);

// ── 什么时候要自动补一次"更新后复核" ──
assert.equal(needsAudit('0.3.0', '0.2.1-rc.2'), true, '宿主版本变了就要自动复核');
assert.equal(needsAudit('0.2.1-rc.2', '0.2.1-rc.2'), false, '版本没变不要覆盖上一次的预测结论');
assert.equal(needsAudit(null, '0.2.1-rc.2'), false, '认不出当前版本就不复核');
assert.equal(needsAudit('0.3.0', null), false, '账本还没有记录时不必复核');

// ── summarizeReport：修复命令 + 等待期 ──
const nowIso = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
const report = {
  host: { version: '0.2.1-rc.2', deps: { cordis: '4.0.5', schemastery: '3.18.5' } },
  profile: { name: 'web' },
  target: { version: '0.3.0', source: 'feed' },
  verdict: { action: 'defer', summary: '建议暂缓' },
  releaseAge: { window: { minutes: 1440, source: 'pnpm default' } },
  plugins: [
    { name: 'dsh-ops', version: '0.4.1', status: 'BREAK', reasons: ['声明 ^0.2.0-rc.2 不含 0.3.0'],
      fix: 'dsh plugin --profile web add dsh-ops@0.4.2' },
    { name: 'dshmarket', version: '1.70.2', status: 'OK', reasons: [],
      releaseAge: { version: '1.70.3', publishedAt: nowIso, windowMs: 86400000, tooYoung: true, exempt: null } },
    { name: 'old-plugin', version: '1.0.0', status: 'OK', reasons: [],
      releaseAge: { version: '1.1.0', publishedAt: '2026-01-01T00:00:00.000Z', windowMs: 86400000, tooYoung: false } },
    { name: 'exempt-plugin', version: '2.0.0', status: 'OK', reasons: [],
      releaseAge: { version: '2.0.1', publishedAt: nowIso, windowMs: 86400000, tooYoung: true, exempt: 'exempt-plugin@2.0.1' } },
  ],
};

const snap = summarizeReport(report, 'check');
assert.equal(snap.source, 'check');
assert.equal(snap.counts.break, 1);
assert.equal(snap.plugins[0].fix, 'dsh plugin --profile web add dsh-ops@0.4.2', '修复命令必须进快照');
assert.equal(snap.plugins[1].fix, null);
assert.deepEqual(snap.releaseAge.window, { minutes: 1440, source: 'pnpm default' });
assert.equal(snap.releaseAge.items.length, 1, '只有真在等待期、且没被豁免的才进快照');
assert.equal(snap.releaseAge.items[0].name, 'dshmarket');
assert.equal(snap.releaseAge.items[0].version, '1.70.3');
assert.equal(snap.releaseAge.items[0].windowMs, 86400000);
assert.ok(!('remainingMs' in snap.releaseAge.items[0]), '剩余时间不落盘，由界面现算');
assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap, '快照必须是无损 JSON（要经投影送到浏览器）');

// summarizeReleaseAge 单独喂空数据也不能抛
assert.deepEqual(summarizeReleaseAge(null, []).items, []);
assert.deepEqual(summarizeReleaseAge(null, undefined).window, { minutes: null, source: null });

// ── summarizeAudit：确认失效的也要带命令 ──
const auditSnap = summarizeAudit({
  ok: true,
  host: { version: '0.3.0' },
  previousHost: '0.2.1-rc.2',
  versionChanged: true,
  broken: [{ name: 'dsh-ops', version: '0.4.1', reason: '声明 ^0.2.0-rc.2 不含 0.3.0', fix: 'dsh plugin --profile web add dsh-ops@0.4.2' }],
  fixed: [{ name: 'dshmarket', version: '1.70.2' }],
});
assert.equal(auditSnap.audit.broken[0].fix, 'dsh plugin --profile web add dsh-ops@0.4.2');
assert.equal(auditSnap.audit.hostVersion, '0.3.0', 'audit() 的 host 是版本字符串，别名不能丢');
assert.equal(summarizeAudit({ ok: true, host: { version: '0.3.0' }, broken: [], fixed: [] }).audit.hostVersion, '0.3.0', '也接受对象形状');
assert.equal(auditSnap.audit.broken.length, 1);
assert.equal(auditSnap.verdict.action, 'defer');
assert.deepEqual(JSON.parse(JSON.stringify(auditSnap)), auditSnap);

// 没有 fix 字段时补 null，不能变成 undefined（会破坏无损 JSON）
const auditNoFix = summarizeAudit({ ok: true, host: { version: '0.3.0' }, versionChanged: true, broken: [{ name: 'x', version: '1.0.0' }], fixed: [] });
assert.equal(auditNoFix.audit.broken[0].fix, null);

console.log('升级路径测试通过：修复命令 / 等待期进快照 / 复核带命令');
