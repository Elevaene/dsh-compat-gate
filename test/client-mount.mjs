/**
 * 客户端模块测试：不启动浏览器，用一个假的 window.__ModuleLoader__ 与假的 ctx，
 * 验证 client.js 的模块包装、槽位注册、以及每个组件在缺数据时也不炸。
 */
import assert from 'node:assert/strict';

// ── 假的模块加载器与 react ──
let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) { loaded = definition; },
  },
};

const react = {
  createElement: (type, props, ...children) => ({ $$el: true, type, props: props ?? null, children }),
};
const requireStub = (id) => {
  if (id === 'react') return react;
  throw new Error(`client.js 不允许 require(${id})`);
};

await import('../client.js');
assert.ok(loaded, 'client.js 必须调用 window.__ModuleLoader__.load');
assert.equal(loaded.id, 'dsh-compat-gate');
assert.equal(typeof loaded.factory, 'function');

const exports_ = loaded.factory(requireStub);
assert.equal(exports_.name, 'dsh-compat-gate');
assert.deepEqual(exports_.inject, ['slots']);
assert.equal(typeof exports_.apply, 'function');
assert.ok(exports_.__internals, '应导出 __internals 供回归测试');

// ── 假的 slots 服务 ──
const registrations = [];
const disposers = [];
const ctx = {
  logger: { warn: () => {} },
  slots: {
    inject(name, register) {
      assert.equal(typeof name, 'string');
      register();
    },
    register(definition, component) {
      registrations.push({ definition, component });
      const dispose = () => {};
      disposers.push(dispose);
      return dispose;
    },
  },
};

exports_.apply(ctx);
const slots = registrations.map((r) => r.definition.name);
assert.deepEqual(slots, ['conversation.view', 'conversation.input.dock'], '只挂会话视图与 dock 徽章；main / sidebar.panellist 是 root 作用域，拿不到 useProjection');
for (const r of registrations) {
  assert.equal(typeof r.component, 'function', `${r.definition.name} 必须挂一个组件`);
}
const viewReg = registrations.find((r) => r.definition.name === 'conversation.view');
assert.equal(typeof viewReg.definition.label, 'function');
assert.equal(viewReg.definition.label(), '兼容闸门');
assert.equal(typeof viewReg.definition.order, 'number');


// ── 组件渲染：四种数据状态都不能抛 ──
const sampleView = {
  ok: true,
  updatedAt: '2026-10-26T07:30:00.000Z',
  host: { version: '0.2.1-rc.2', cordis: '4.0.5', schemastery: '3.18.5', profile: 'web' },
  target: { version: '0.2.1-rc.3', source: 'feed' },
  verdict: { action: 'caution', summary: '4 个相容 / 1 个无法判断', label: '可以更新，但有插件无法判断' },
  counts: { ok: 4, break: 0, unknown: 1 },
  plugins: [
    { name: 'dsh-cline-pass', version: '0.2.12', status: 'OK', label: '相容', reason: null },
    { name: 'billion-context', version: '0.1.208', status: 'UNKNOWN', label: '无法判断', reason: '没有任何 dsh 兼容声明' },
  ],
  audit: { hostVersion: '0.3.0', previousHost: '0.2.1-rc.2', versionChanged: true, broken: [{ name: 'dshmarket', version: '1.70.2' }], fixed: [] },
};

const cases = [
  ['有完整数据', { useProjection: () => sampleView, openView: () => {} }],
  ['没有投影服务', {}],
  ['投影返回 null', { useProjection: () => null }],
  ['投影报没有结果', { useProjection: () => ({ ok: false, reason: 'no-status', hint: '还没有判定结果' }) }],
  ['有数据但没有 audit 段', { useProjection: () => ({ ...sampleView, audit: undefined, plugins: [] }) }],
];

for (const [label, props] of cases) {
  for (const r of registrations) {
    const out = r.component(props);
    assert.ok(out && typeof out === 'object', `${label} / ${r.definition.name} 必须返回元素`);
  }
}

// 徽章在"全部相容"和"有待看项"两种情况下文案不同
const Badge = exports_.__internals.CompatGateBadge;
const badgeRisky = Badge({ useProjection: () => sampleView });
const badgeClean = Badge({ useProjection: () => ({ ...sampleView, counts: { ok: 5, break: 0, unknown: 0 } }) });
const textOf = (node) => {
  if (node == null || typeof node !== 'object') return String(node ?? '');
  if (Array.isArray(node)) return node.map(textOf).join('');
  return (node.children ?? []).map(textOf).join('');
};
assert.match(textOf(badgeRisky), /1 项待看/);
assert.match(textOf(badgeClean), /全部相容/);

// 文案助手
const { describeVerdict, describeTarget, toneOf, timeText } = exports_.__internals;
assert.equal(describeVerdict(null), '还没有判定结果');
assert.equal(describeVerdict({ ok: false }), '还没有判定结果');
assert.match(describeVerdict(sampleView), /1 个无法判断/);
assert.match(describeVerdict(sampleView), /共 5 个插件/);
assert.equal(describeVerdict({ ok: true, counts: { ok: 3, break: 0, unknown: 0 } }), '全部相容（共 3 个插件）');
assert.match(describeTarget(sampleView), /0\.2\.1-rc\.2.*0\.2\.1-rc\.3/);
assert.equal(describeTarget({ ok: false }), '—');
assert.equal(toneOf(sampleView).tag, '需留意');
assert.equal(toneOf({ ok: true, verdict: { action: 'defer' } }).tag, '建议暂缓');
assert.equal(toneOf(null).tag, '无法判定');
assert.match(timeText(sampleView), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
assert.equal(timeText({}), null);

// 徽章点击必须调用 openView，否则面板打不开
let opened = null;
const clickable = Badge({ useProjection: () => sampleView, openView: (id, arg) => { opened = [id, arg]; } });
clickable.props.onClick();
assert.deepEqual(opened, ['compat-gate', '']);

// dock 槽标准属性里没有 openView：必须渲染成不可点的 span，而不是点了没反应的按钮
const noOpen = Badge({ useProjection: () => sampleView });
assert.equal(noOpen.type, 'span');
assert.equal(noOpen.props.onClick, undefined);
assert.equal(typeof noOpen.props.title, 'string');

console.log('client 挂载测试通过：2 个槽位（session 作用域）/ 5 种数据状态 / 徽章文案与可点性 / 文案助手');