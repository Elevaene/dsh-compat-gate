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
// 假的 localStorage：只支持“我已知晓”用到的 get/set/remove
const ackStore = new Map();
globalThis.window.localStorage = {
  getItem: (key) => (ackStore.has(key) ? ackStore.get(key) : null),
  setItem: (key, value) => { ackStore.set(key, String(value)); },
  removeItem: (key) => { ackStore.delete(key); },
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
    { name: 'dsh-cline-pass', version: '0.2.12', status: 'OK', label: '相容', reason: null, fix: null },
    { name: 'billion-context', version: '0.1.208', status: 'UNKNOWN', label: '无法判断', reason: '没有任何 dsh 兼容声明' },
    { name: 'dsh-ops', version: '0.4.1', status: 'BREAK', label: '会失效', reason: '声明 ^0.2.0-rc.2 不含 0.3.0',
      fix: 'dsh plugin --profile web add dsh-ops@0.4.2' },
  ],
  releaseAge: {
    window: { minutes: 1440, source: 'pnpm default' },
    // 两个小时前发布、等待期 24 小时 → 界面上永远还有约 22 小时
    items: [{ name: 'dshmarket', version: '1.70.3', publishedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), windowMs: 86400000 }],
  },
  audit: { hostVersion: '0.3.0', previousHost: '0.2.1-rc.2', versionChanged: true, broken: [{ name: 'dshmarket', version: '1.70.2' }], fixed: [] },
};

/** 在元素树里找 props.plugin.name === name 的 PluginRow 元素（假 react 不会执行子组件）。 */
const findPluginRow = (node, name) => {
  if (node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findPluginRow(child, name);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node.type === 'function' && node.props && node.props.plugin && node.props.plugin.name === name) return node;
  for (const child of node.children ?? []) {
    const hit = findPluginRow(child, name);
    if (hit) return hit;
  }
  return null;
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

// 徽章只在"真的会有插件失效"时出现；单纯"无法判断"是常态，不进徽章
const Badge = exports_.__internals.CompatGateBadge;
const breakView = { ...sampleView, counts: { ok: 3, break: 1, unknown: 1 } };
const badgeRisky = Badge({ useProjection: () => breakView });
const cleanView = {
  ...sampleView,
  counts: { ok: 5, break: 0, unknown: 0 },
  verdict: { ...sampleView.verdict, action: 'safe' },
};
const badgeClean = Badge({ useProjection: () => cleanView });
const textOf = (node) => {
  if (node == null || typeof node !== 'object') return String(node ?? '');
  if (Array.isArray(node)) return node.map(textOf).join('');
  return (node.children ?? []).map(textOf).join('');
};
assert.match(textOf(badgeRisky), /1 个会失效/);
assert.equal(Badge({ useProjection: () => sampleView }), null, '只有"无法判断"时不冒徽章，重启不再天天弹');
assert.equal(badgeClean, null, '全部相容时徽章不出现，避免和常驻标签页重复');
assert.equal(Badge({ useProjection: () => ({ ok: false, reason: 'no-status' }) }), null, '没有数据时徽章也不出现');

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
const clickable = Badge({ useProjection: () => breakView, openView: (id, arg) => { opened = [id, arg]; } });
clickable.props.onClick();
assert.deepEqual(opened, ['compat-gate', '']);

// dock 槽标准属性里没有 openView：必须渲染成不可点的 span，而不是点了没反应的按钮
const noOpen = Badge({ useProjection: () => breakView });
assert.equal(noOpen.type, 'span');
assert.equal(noOpen.props.onClick, undefined);
assert.equal(typeof noOpen.props.title, 'string');


// ── 我已知晓：确认后徽章不再出现；dsh 或插件一变，徽章自动回来 ──
const { fingerprintOf, acknowledged, AckRow, CompatGatePanel } = exports_.__internals;
const fp = fingerprintOf(sampleView);
assert.match(fp, /^0.2.1-rc.2|0.2.1-rc.3|/, '指纹要以宿主与目标版本开头');
assert.ok(fp.includes('billion-context@0.1.208:UNKNOWN'), '指纹要带插件版本与结论');
assert.equal(fingerprintOf({ ok: false }), '', '没有结果时指纹为空，不应该被当成已知晓');

assert.ok(Badge({ useProjection: () => breakView }), '没确认过时徽章要出现');
const ackRowBefore = AckRow({ view: sampleView });
assert.match(textOf(ackRowBefore), /我已知晓/);
assert.equal(ackRowBefore.children[1].type, 'button');
ackRowBefore.children[1].props.onClick();
assert.equal(acknowledged(sampleView), true, '点过之后必须记住');
assert.equal(Badge({ useProjection: () => breakView }), null, '已知晓后徽章不再出现');
assert.match(textOf(AckRow({ view: sampleView })), /取消标记/, '确认后按钮变成取消标记');

// 插件版本变了 → 指纹不同 → 徽章自己回来
const changedView = { ...breakView, plugins: [{ name: 'billion-context', version: '0.1.209', status: 'UNKNOWN' }] };
assert.equal(acknowledged(changedView), false, '插件版本变了就不算同一个已知晓');
assert.ok(Badge({ useProjection: () => changedView }), '出现新情况时徽章要重新出现');

// 取消标记
AckRow({ view: sampleView }).children[1].props.onClick();
assert.equal(acknowledged(sampleView), false);
assert.ok(Badge({ useProjection: () => breakView }));

// 面板里必须能看到这一行
// 假 react 不会真的调用子组件，所以要遍历元素树找 AckRow，而不是取父元素文字
const hasComponent = (node, type) => {
  if (node == null || typeof node !== 'object') return false;
  if (node.type === type) return true;
  return (node.children ?? []).some((child) => hasComponent(child, type));
};
assert.ok(hasComponent(CompatGatePanel({ useProjection: () => sampleView }), AckRow), '面板里必须挂上“我已知晓”那一行');
const safePanel = CompatGatePanel({ useProjection: () => cleanView });
assert.ok(safePanel, '全部相容时面板仍可渲染');

console.log('client 挂载测试通过：2 个槽位（session 作用域）/ 5 种数据状态 / 徽章文案与可点性 / 我已知晓 / 文案助手');
// ── 等待期与修复命令（v0.2.4）──

const { ageItemsOf, describeWait, PluginRow } = exports_.__internals;
const ages = ageItemsOf(sampleView);
assert.equal(ages.length, 1, '只算还没过等待期的版本');
assert.ok(ages[0].remainingMs > 21 * 3600 * 1000 && ages[0].remainingMs < 23 * 3600 * 1000, '剩余时间应约 22 小时');
assert.equal(ageItemsOf({ releaseAge: { items: [{ name: 'x', version: '1', publishedAt: '2020-01-01T00:00:00.000Z', windowMs: 86400000 }] } }).length, 0, '早过了等待期的要过滤掉');
assert.equal(ageItemsOf({ releaseAge: { items: [{ name: 'x', version: '1', publishedAt: 'bad', windowMs: 86400000 }] } }).length, 0, '时间读不出来的不算');
assert.equal(ageItemsOf({}).length, 0);
assert.equal(describeWait(22 * 3600 * 1000), '22 小时');
assert.equal(describeWait(90 * 60000), '1 小时 30 分钟');
assert.equal(describeWait(120000), '2 分钟');

const panelText = textOf(CompatGatePanel({ useProjection: () => sampleView }));
assert.match(panelText, /还在 pnpm 等待期内/, '面板要显示等待期提示条');
assert.match(panelText, /dshmarket@1.70.3 还要等/, '等待期提示要带版本与剩余时间');
// 命令在 PluginRow 内部，父元素文本里看不到，直接渲染那一行来断言
assert.match(textOf(PluginRow({ plugin: sampleView.plugins[2], index: 2 })), /dsh plugin --profile web add dsh-ops@0.4.2/, '会失效的插件要给可复制的修复命令');
assert.ok(!textOf(PluginRow({ plugin: sampleView.plugins[0], index: 0 })).includes('先升级'), '没有修复命令的行不显示"先升级"');
const opsRow = findPluginRow(CompatGatePanel({ useProjection: () => sampleView }), 'dsh-ops');
assert.ok(opsRow, '插件行必须渲染');
assert.equal(opsRow.props.plugin.fix, 'dsh plugin --profile web add dsh-ops@0.4.2', '插件行要带上修复命令');

const badge = Badge({ useProjection: () => breakView });
assert.match(textOf(badge), /等待期 1/, '徽章文案要带上还在等待期的版本数');
assert.ok(!textOf(Badge({ useProjection: () => ({ ...breakView, releaseAge: { items: [] } }) })).includes('等待期'), '没有等待期就不提');

// ── 界面里直接更新 dsh（v0.2.5）：桥只在桌面窗口里有，浏览器打开时要说清原因 ──
const { UpdateRow, updateBridge, describePhase, startUpdate } = exports_.__internals;
assert.equal(updateBridge(), null, '浏览器里没有 window.dshDesktop，桥必须是 null');
assert.match(textOf(UpdateRow({ view: sampleView })), /没法直接更新/, '没有桥时要说明为什么没有按钮');
assert.ok(hasComponent(CompatGatePanel({ useProjection: () => sampleView }), UpdateRow), '面板里要挂上更新那一行');

const updateCalls = [];
globalThis.window.dshDesktop = {
  updates: {
    open: () => { updateCalls.push("open"); return Promise.resolve(); },
    status: () => Promise.resolve({ phase: 'idle' }),
    subscribe: () => () => undefined,
  },
};
assert.ok(updateBridge(), '桌面窗口里能拿到更新桥');
assert.match(textOf(UpdateRow({ view: sampleView })), /更新 dsh 到 0\.2\.1-rc\.3/, '目标版本更高时按钮写明升到哪个版本');
assert.match(textOf(UpdateRow({ view: { host: { version: '0.2.1-rc.2' }, target: { version: '0.2.1-rc.2' } } })), /检查 dsh 更新/, '没有新版本时按钮退化成检查更新');
assert.equal(await startUpdate(updateBridge()), true, '点击更新要把请求交给宿主更新器');
assert.equal(updateCalls.length, 1, '宿主更新器只被调用一次');
assert.equal(await startUpdate({ open: () => Promise.reject(new Error('boom')) }), false, '宿主拒绝时要返回 false');
assert.match(describePhase({ phase: 'error', failure: 'boom' }), /boom/, '错误原因要带出来');
assert.equal(await startUpdate(null), false, '没有桥时什么都不做');
assert.equal(describePhase({ phase: 'downloading', percent: 42 }), '正在下载更新 42%');
assert.equal(describePhase({ phase: 'available', version: '9.9.9' }), '发现新版本 9.9.9，准备下载…');
assert.equal(describePhase(null), '');
delete globalThis.window.dshDesktop;

console.log('更新按钮测试通过：桥探测 / 按钮文案 / 交给宿主更新器 / 错误与阶段文案');

// ── v0.2.6：桥多级查找 / 现场自证 / 存储降级 ──
const { ackStorageKind, diagnosticText } = exports_.__internals;
assert.equal(ackStorageKind(), 'localStorage', '假 localStorage 能用时就用它，不该降级到内存');
assert.match(diagnosticText(), /^现场：/, '要打印现场，便于判断为什么没有按钮');
assert.match(diagnosticText(), /dshDesktop/, '现场信息里要交代 dshDesktop 的可见情况');

// 桥挂在顶层窗口时也要找到（真机可能是外壳套了一层）
const topUpdates = { open: () => Promise.resolve() };
globalThis.window.top = { dshDesktop: { updates: topUpdates } };
assert.equal(updateBridge(), topUpdates, '自身窗口没有时去 window.top 找');
delete globalThis.window.top;
assert.equal(updateBridge(), null, '哪一级都没有就返回 null');

console.log('v0.2.6 通过：桥多级查找 / 现场自证 / 存储探测');
// ── v0.2.7：没有复核结果时也要显示账本里真实的「上次记录宿主」 ──
const noAuditView = { ...breakView, audit: undefined, lastHost: '0.2.1-rc.1' };
const noAuditText = textOf(CompatGatePanel({ useProjection: () => noAuditView }));
assert.match(noAuditText, /上次记录宿主 0.2.1-rc.1/, '没有复核结果时显示账本里的真实版本，不是短横');
assert.match(noAuditText, /当前 0.2.1-rc.2/, '当前宿主取快照里的版本');
assert.match(noAuditText, /（已变化）/, '账本版本与当前不同时要标已变化');
const noLedgerView = { ...breakView, audit: undefined, lastHost: null };
assert.match(textOf(CompatGatePanel({ useProjection: () => noLedgerView })), /上次记录宿主 —/, '账本真没有记录时才显示短横');
console.log('v0.2.7 通过：账本上次宿主回填');
