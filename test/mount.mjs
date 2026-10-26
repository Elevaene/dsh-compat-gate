import assert from 'node:assert/strict';
import { apply, name, inject, ACTIONS } from '../index.js';

// ── 假 ctx：只实现本插件用到的四个面 ──
const tools = [];
const effects = [];
const commands = [];
const ctx = {
  tools: { register(definition) { tools.push(definition); return () => tools.pop(); } },
  effect(fn, label) { const dispose = fn(); assert.equal(typeof dispose, 'function', `effect(${label}) 必须返回 disposer`); effects.push({ label, dispose }); return dispose; },
  inject(keys, callback) {
    assert.deepEqual(keys, ['commands']);
    callback({ get: (k) => (k === 'commands' ? { register: (cmd) => { commands.push(cmd); return () => commands.pop(); } } : undefined) });
  },
};

assert.equal(name, 'dsh-compat-gate');
assert.deepEqual(inject, ['tools']);
apply(ctx, {});

assert.equal(tools.length, 1, '应注册 1 个工具');
const def = tools[0];
assert.equal(def.name, 'compat_gate');
assert.equal(typeof def.execute, 'function');
assert.equal(typeof def.output.render, 'function');
assert.equal(def.parameters.type, 'object');
assert.deepEqual(def.parameters.properties.action.enum, ACTIONS);
assert.equal(def.parameters.additionalProperties, false);
console.log('✓ 工具注册形状：name/parameters/output.render/execute 齐全');

// ── 输出必须是无损 JSON（dsh 的 json_output 会校验）──
function assertLossless(value, path = '$') {
  if (value === undefined) throw new Error(`${path} 含 undefined`);
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} 非有限数`);
    assert.ok(!Object.is(value, -0), `${path} 是 -0`);
  }
  if (Array.isArray(value)) { value.forEach((v, i) => assertLossless(v, `${path}[${i}]`)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertLossless(v, `${path}.${k}`);
  }
}

const results = {};
for (const args of [{ action: 'ledger' }, { action: 'audit', persist: false }, { action: 'check', target: '0.3.0', persist: false }, { action: 'check', persist: false }]) {
  const value = await def.execute(args);
  assertLossless(value);
  assert.ok(typeof value.text === 'string' && value.text.length > 0, `${args.action} 应有 text`);
  const rendered = def.output.render(args, value);
  assert.equal(rendered[0].type, 'text');
  assert.ok(rendered[0].text.length > 0);
  results[`${args.action}${args.target ? ':' + args.target : ''}`] = value.text.split('\n')[0];
}
console.log('✓ execute 全部 action 返回无损 JSON 且可 render');
for (const [k, v] of Object.entries(results)) console.log(`   ${k} → ${v}`);

// ── 命令面 ──
assert.equal(commands.length, 1, '应注册 1 个斜杠命令');
assert.equal(commands[0].name, 'compat');
const out = await commands[0].handler({ rawInput: 'audit' });
  assert.equal(typeof out, 'object', 'handler 必须返回 CommandResult 对象，不能返回字符串');
  assert.equal(out.kind, 'success', 'handler 的 kind 应为 success');
  assert.ok(typeof out.text === 'string' && out.text.length > 0, 'handler 应带 text');
  const bad = await commands[0].handler({ rawInput: 'freshness __不存在的包__' });
  assert.ok(['success', 'error'].includes(bad.kind), 'kind 只能是 success / error');
console.log('✓ /compat 命令已注册且 handler 可调用');

// ── disposer 可用 ──
effects[0].dispose();
assert.equal(tools.length, 0, 'dispose 后应注销工具');
console.log('✓ disposer 注销工具');

// ── 无 commands 服务时不得抛错 ──
const bare = { tools: ctx.tools, effect: ctx.effect, inject(keys, cb) { throw new Error('no such service'); } };
apply(bare, {});
console.log('✓ 缺少 commands 服务时插件仍能加载');
console.log('\n全部通过');