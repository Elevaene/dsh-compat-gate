/**
 * dsh-compat-gate 的浏览器端：把宿主算好的兼容性快照画出来。
 *
 * 数据来自会话投影 compatGate（宿主侧 lib/projection.js），随会话视图下发，
 * 不经过模型、不消耗额度，也不需要额外执行命令。
 *
 * 客户端模块由 dsh 的模块加载器托管：必须用 window.__ModuleLoader__.load 包装，
 * react 通过 factory 的 require 取得；这里不使用 JSX，避免引入构建步骤。
 */
window.__ModuleLoader__.load({
  id: 'dsh-compat-gate',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const el = react.createElement;

    const PLUGIN_ID = 'dsh-compat-gate';
    const VERSION = '0.2.0';
    const PROJECTION_KEY = 'compatGate';
    const VIEW_ID = 'compat-gate';
    const LABEL = '兼容闸门';

    const TONE = {
      safe: { fg: '#10b981', bg: 'rgba(16,185,129,0.12)', tag: '可以更新' },
      caution: { fg: '#f59e0b', bg: 'rgba(245,158,11,0.12)', tag: '需留意' },
      defer: { fg: '#ef4444', bg: 'rgba(239,68,68,0.12)', tag: '建议暂缓' },
      unknown: { fg: '#94a3b8', bg: 'rgba(148,163,184,0.12)', tag: '无法判定' },
    };
    const STATUS_TONE = { OK: '#10b981', BREAK: '#ef4444', UNKNOWN: '#94a3b8' };

    function toneOf(view) {
      const action = view && view.verdict && view.verdict.action ? view.verdict.action : 'unknown';
      return TONE[action] || TONE.unknown;
    }

    /** 一句话摘要：面板与徽章共用，也便于离线测试。 */
    function describeVerdict(view) {
      if (!view || view.ok === false) return '还没有判定结果';
      const counts = view.counts || {};
      const total = (counts.ok || 0) + (counts.break || 0) + (counts.unknown || 0);
      const parts = [];
      if (counts.break) parts.push(counts.break + ' 个会失效');
      if (counts.unknown) parts.push(counts.unknown + ' 个无法判断');
      if (!parts.length) parts.push('全部相容');
      return total ? parts.join('，') + '（共 ' + total + ' 个插件）' : parts.join('，');
    }

    function describeTarget(view) {
      if (!view || view.ok === false) return '—';
      const host = view.host && view.host.version ? view.host.version : '未知宿主';
      const target = view.target && view.target.version ? view.target.version : '未取到新版本';
      return host + '  \u2192  ' + target;
    }

    function timeText(view) {
      if (!view || !view.updatedAt) return null;
      const d = new Date(view.updatedAt);
      if (Number.isNaN(d.getTime())) return String(view.updatedAt);
      const pad = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function chip(text, color) {
      return el('span', {
        style: {
          display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 12,
          color: color, background: 'rgba(148,163,184,0.14)', border: '1px solid ' + color + '33',
        },
      }, text);
    }

    function rowStyle(odd) {
      return { display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 8px',
        background: odd ? 'rgba(148,163,184,0.06)' : 'transparent', borderRadius: 6 };
    }

    function PluginRow(props) {
      const p = props.plugin || {};
      const color = STATUS_TONE[p.status] || STATUS_TONE.UNKNOWN;
      return el('div', { style: rowStyle(props.index % 2 === 1) },
        el('span', { style: { width: 8, height: 8, borderRadius: 4, background: color, flex: '0 0 auto', marginTop: 6 } }),
        el('div', { style: { minWidth: 0, flex: '1 1 auto' } },
          el('div', { style: { fontSize: 13 } },
            el('span', { style: { fontWeight: 600 } }, p.name || '(未命名)'),
            el('span', { style: { opacity: 0.6, marginLeft: 6 } }, p.version ? String(p.version) : ''),
            el('span', { style: { marginLeft: 8 } }, chip(p.label || p.status || '未知', color))),
          p.reason ? el('div', { style: { fontSize: 12, opacity: 0.72, marginTop: 2, wordBreak: 'break-word' } }, p.reason) : null));
    }

    function EmptyHint(props) {
      const view = props.view || {};
      return el('div', { style: { fontSize: 13, opacity: 0.75, lineHeight: 1.7 } },
        el('div', null, view.hint || '还没有判定结果。'),
        el('div', { style: { marginTop: 6 } }, '在会话里执行 ',
          el('code', { style: { padding: '1px 6px', borderRadius: 4, background: 'rgba(148,163,184,0.18)' } }, '/compat'),
          ' 生成一次结果，之后面板会自动显示最新结论（执行命令不消耗额度）。'));
    }

    function CompatGatePanel(props) {
      const view = props && typeof props.useProjection === 'function' ? props.useProjection(PROJECTION_KEY) : null;
      if (!view || view.ok === false) return el(EmptyHint, { view });
      const tone = toneOf(view);
      const audit = view.audit;
      const plugins = Array.isArray(view.plugins) ? view.plugins : [];
      return el('div', { style: { padding: 16, fontFamily: 'inherit', color: 'inherit', lineHeight: 1.6 } },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          el('div', { style: { fontSize: 16, fontWeight: 700 } }, LABEL),
          el('span', { style: { padding: '2px 10px', borderRadius: 999, fontSize: 12, color: tone.fg, background: tone.bg, border: '1px solid ' + tone.fg + '44' } },
            view.verdict && view.verdict.label ? view.verdict.label : tone.tag),
          el('span', { style: { fontSize: 12, opacity: 0.6 } }, VERSION)),
        el('div', { style: { marginTop: 10, fontSize: 13 } },
          el('span', { style: { opacity: 0.6 } }, '版本 '), describeTarget(view)),
        el('div', { style: { marginTop: 4, fontSize: 13, opacity: 0.85 } }, describeVerdict(view)),
        audit ? el('div', { style: { marginTop: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(148,163,184,0.1)', fontSize: 13 } },
          el('div', { style: { fontWeight: 600 } }, '更新后复核'),
          el('div', null, '上次记录宿主 ' + (audit.previousHost || '—') + '，当前 ' + (audit.hostVersion || '—') + (audit.versionChanged ? '（已变化）' : '（未变化）')),
          audit.broken && audit.broken.length
            ? el('div', { style: { marginTop: 4 } }, '确认失效：' + audit.broken.map((b) => b.name + (b.version ? '@' + b.version : '')).join('、'))
            : el('div', { style: { marginTop: 4, opacity: 0.75 } }, '没有发现失效插件')) : null,
        plugins.length
          ? el('div', { style: { marginTop: 12 } },
              el('div', { style: { fontSize: 12, opacity: 0.6, marginBottom: 4 } }, '已安装插件（' + plugins.length + '）'),
              el('div', null, plugins.map((p, i) => el(PluginRow, { key: p.name + ':' + i, plugin: p, index: i }))))
          : null,
        el('div', { style: { marginTop: 12, fontSize: 12, opacity: 0.55, display: 'flex', gap: 12, flexWrap: 'wrap' } },
          el('span', null, timeText(view) ? '更新于 ' + timeText(view) : '尚未更新'),
          el('span', null, '在会话里执行 /compat 刷新，不会消耗额度')));
    }

    function CompatGateBadge(props) {
      const view = props && typeof props.useProjection === 'function' ? props.useProjection(PROJECTION_KEY) : null;
      const tone = toneOf(view);
      const counts = (view && view.counts) || {};
      const risky = (counts.break || 0) + (counts.unknown || 0);
      const open = () => {
        if (props && typeof props.openView === 'function') return props.openView(VIEW_ID, '');
        return undefined;
      };
      return el('button', {
        type: 'button',
        onClick: open,
        title: '点击打开' + LABEL + '面板',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6, margin: '0 6px 6px 0',
          padding: '3px 10px', fontSize: 12, cursor: 'pointer',
          color: tone.fg, background: tone.bg, border: '1px solid ' + tone.fg + '44', borderRadius: 999,
        },
      },
        el('span', { style: { width: 7, height: 7, borderRadius: 4, background: tone.fg } }),
        el('span', null, LABEL + ' · ' + (risky ? risky + ' 项待看' : '全部相容')));
    }

    const inject = ['slots'];

    function apply(ctx) {
      const safe = (slot, register) => {
        try {
          ctx.slots.inject(slot, register);
        } catch (error) {
          if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(PLUGIN_ID + ': 注册 ' + slot + ' 失败', error);
        }
      };

      safe('conversation.input.dock', () => ctx.slots.register(
        { name: 'conversation.input.dock', id: 'compat-gate-badge', order: 33 },
        (props) => el(CompatGateBadge, props)));

      safe('conversation.view', () => ctx.slots.register(
        { name: 'conversation.view', id: VIEW_ID, order: 26, label: () => LABEL },
        (props) => el(CompatGatePanel, props)));

      safe('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: VIEW_ID, order: 56, label: () => LABEL },
        () => el('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'currentColor' },
          el('path', { d: 'M8 1.2 2 4v4.2c0 3.1 2.5 5.6 6 6.6 3.5-1 6-3.5 6-6.6V4L8 1.2Zm0 1.7 4.7 2.2v3.1c0 2.3-1.8 4.2-4.7 5.1-2.9-.9-4.7-2.8-4.7-5.1V5.1L8 2.9Zm-.7 2.6v2.6H4.9v1.5h2.4v2.5h1.4V9.6h2.4V8.1H8.7V5.5H7.3Z' }))));

      safe('main', () => ctx.slots.register(
        { name: 'main', key: VIEW_ID },
        (props) => el(CompatGatePanel, props)));
    }

    exports.name = PLUGIN_ID;
    exports.inject = inject;
    exports.apply = apply;
    exports.__internals = { describeVerdict, describeTarget, toneOf, timeText, CompatGatePanel, CompatGateBadge, PROJECTION_KEY, VIEW_ID };
    return module.exports;
  },
});