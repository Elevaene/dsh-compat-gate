/**
 * dsh-compat-gate 的浏览器端：把宿主算好的兼容性快照画出来。
 *
 * 数据来自会话投影 compatGate（宿主侧 lib/projection.js），随会话视图下发，
 * 不经过模型、不消耗额度，也不需要额外执行命令。
 *
 * 槽位作用域（实测，宿主 dsh-cordis-client-runner 内嵌的契约清单）：
 *   - conversation.view        scope=session，标准属性含 useProjection，渲染时还额外传 openView
 *   - conversation.input.dock  scope=session，标准属性含 useProjection，但没有 openView
 *   - main / sidebar.panellist scope=root，标准属性里**没有** useProjection
 * 所以面板必须挂在 conversation.view；挂在 main 只会永远拿到空数据。
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
const VERSION = '0.2.8';
    const PROJECTION_KEY = 'compatGate';
    const VIEW_ID = 'compat-gate';
    const LABEL = '兼容闸门';

    const TONE = {
      safe: { fg: '#10b981', bg: 'rgba(16,185,129,0.12)', tag: '可以更新' },
      caution: { fg: '#f59e0b', bg: 'rgba(245,158,11,0.12)', tag: '需留意' },
      current: { fg: '#10b981', bg: 'rgba(16,185,129,0.12)', tag: '已经是最新' },
      defer: { fg: '#ef4444', bg: 'rgba(239,68,68,0.12)', tag: '建议暂缓' },
      unknown: { fg: '#94a3b8', bg: 'rgba(148,163,184,0.12)', tag: '无法判定' },
    };
    const STATUS_TONE = { OK: '#10b981', BREAK: '#ef4444', UNKNOWN: '#94a3b8' };

    // ── 我已知晓：把“看过了”记在浏览器本地；指纹不变就不再弹徽章 ──
    const ACK_KEY = PLUGIN_ID + '/ack';
    const ackListeners = new Set();
    const useStateHook = typeof react.useState === 'function' ? react.useState : null;
    const useEffectHook = typeof react.useEffect === 'function' ? react.useEffect : null;

    /** 订阅“已知晓状态变化”，让徽章与面板一起刷新；测试用的假 react 没有 hook，直接跳过。 */
    function useAckTick() {
      if (!useStateHook) return 0;
      const [tick, setTick] = useStateHook(0);
      if (useEffectHook) {
        useEffectHook(() => {
          const bump = () => setTick((n) => n + 1);
          ackListeners.add(bump);
          return () => ackListeners.delete(bump);
        }, []);
      }
      return tick;
    }

    /** 指纹：宿主版本 + 目标版本 + 每个插件的名字@版本@结论。任一处变化都算新情况，徽章要回来。 */
    function fingerprintOf(view) {
      if (!view || view.ok === false) return '';
      const host = (view.host && view.host.version) || '-';
      const target = (view.target && view.target.version) || '-';
      const parts = (Array.isArray(view.plugins) ? view.plugins : [])
        .map((p) => (p.name || '?') + '@' + (p.version || '?') + ':' + (p.status || '?'))
        .sort();
      return host + '|' + target + '|' + parts.join(',');
    }

    // 自定义协议的原点（dsh-app://app）上 localStorage 可能根本没生效，退路依次是 cookie、进程内内存。
    const ACK_COOKIE = 'dsh_compat_gate_ack';
    const ackMemory = new Map();
    let ackKindCache = '';

    function ackBackends() {
      const win = typeof window === 'undefined' ? null : window;
      const doc = typeof document === 'undefined' ? null : document;
      const list = [];
      if (win && win.localStorage) {
        list.push({
          kind: 'localStorage',
          read: () => win.localStorage.getItem(ACK_KEY) || '',
          write: (value) => {
            if (value) win.localStorage.setItem(ACK_KEY, value);
            else win.localStorage.removeItem(ACK_KEY);
          },
        });
      }
      if (doc && typeof doc.cookie === 'string') {
        list.push({
          kind: 'cookie',
          read: () => {
            const hit = String(doc.cookie || '').split('; ').filter((part) => part.indexOf(ACK_COOKIE + '=') === 0)[0];
            return hit ? decodeURIComponent(hit.slice(ACK_COOKIE.length + 1)) : '';
          },
          write: (value) => {
            doc.cookie = ACK_COOKIE + '=' + encodeURIComponent(value) + '; path=/; max-age=' + (value ? 31536000 : 0) + '; SameSite=Lax';
          },
        });
      }
      list.push({
        kind: 'memory',
        read: () => ackMemory.get(ACK_COOKIE) || '',
        write: (value) => { if (value) ackMemory.set(ACK_COOKIE, value); else ackMemory.delete(ACK_COOKIE); },
      });
      return list;
    }

    function readAck() {
      for (const backend of ackBackends()) {
        try {
          const value = backend.read();
          if (value) return value;
        } catch (error) { /* 这个后端用不了，试下一个 */ }
      }
      return '';
    }

    /** 真正存得进去的那一种存储；面板据此说明“标记只在本次运行有效”。 */
    function ackStorageKind() {
      if (ackKindCache) return ackKindCache;
      const probe = 'probe-' + Date.now();
      for (const backend of ackBackends()) {
        try {
          const before = backend.read();
          backend.write(probe);
          const ok = backend.read() === probe;
          backend.write(before);
          if (ok) { ackKindCache = backend.kind; return ackKindCache; }
        } catch (error) { /* 试下一个 */ }
      }
      ackKindCache = 'memory';
      return ackKindCache;
    }

    function writeAck(value) {
      for (const backend of ackBackends()) {
        try {
          backend.write(value);
          if (value === '' || backend.read() === value) break;
        } catch (error) { /* 试下一个 */ }
      }
      ackListeners.forEach((fn) => fn());
    }

    function acknowledged(view) {
      const fp = fingerprintOf(view);
      return fp !== '' && readAck() === fp;
    }
    // ── 在界面里直接更新 dsh：桌面应用把更新器暴露成 window.dshDesktop.updates ──
    /** 只有桌面窗口（dsh-app://app 主框架）才有这个桥；用浏览器打开 profile 时为 null。 */
    function updateBridge() {
      const win = typeof window === 'undefined' ? null : window;
      if (!win) return null;
      const paths = [
        (w) => w.dshDesktop,
        (w) => (w.top && w.top !== w ? w.top.dshDesktop : null),
        (w) => (w.parent && w.parent !== w ? w.parent.dshDesktop : null),
      ];
      for (const get of paths) {
        try {
          const desktop = get(win);
          const updates = desktop && desktop.updates;
          if (updates && typeof updates.open === 'function') return updates;
        } catch (error) { /* 跨域读不到就试下一条路 */ }
      }
      return null;
    }

    /** 没有更新桥时把现场信息印在面板上，一眼分清“浏览器打开”还是“外壳没暴露接口”。 */
    function diagnosticText() {
      try {
        const win = typeof window === 'undefined' ? null : window;
        const loc = win && win.location ? win.location : null;
        const page = loc ? String(loc.protocol) + '//' + String(loc.host) : '未知页面';
        let frame = '主框架';
        try { frame = win && win.top && win.top !== win ? '在 iframe 里' : '主框架'; } catch (error) { frame = '跨域 iframe'; }
        let desktop = 'dshDesktop 无';
        try {
          if (win && win.dshDesktop) {
            const keys = Object.keys(win.dshDesktop);
            desktop = 'dshDesktop: ' + (keys.length ? keys.join('/') : '空对象');
          }
        } catch (error) { desktop = 'dshDesktop 读不到'; }
        return '现场：' + page + ' · ' + frame + ' · ' + desktop;
      } catch (error) {
        return '现场：读取失败';
      }
    }

    const UPDATE_PHASE_TEXT = {
      idle: '还没检查过更新',
      checking: '正在检查更新…',
      available: '发现新版本，准备下载…',
      downloading: '正在下载更新',
      ready: '已下载完成，dsh 即将重启安装',
      error: '更新过程出错',
    };

    // 宿主把自己更新器的状态推给所有窗口，这里缓存最近一次，任何挂载点都能复用。
    let updatePhase = null;
    const updatePhaseListeners = new Set();

    function describePhase(state) {
      if (!state || typeof state.phase !== 'string' || state.phase === '') return '';
      const base = UPDATE_PHASE_TEXT[state.phase] || state.phase;
      if (state.phase === 'downloading' && typeof state.percent === 'number') return base + ' ' + state.percent + '%';
      if (state.phase === 'available' && state.version) return '发现新版本 ' + state.version + '，准备下载…';
      if (state.phase === 'error' && state.failure) return base + '（' + state.failure + '）';
      return base;
    }

    function setUpdatePhase(state) {
      updatePhase = state && typeof state.phase === 'string' ? state : null;
      updatePhaseListeners.forEach((fn) => fn());
    }

    function describeFailure(error) {
      const message = error && error.message ? String(error.message) : '';
      return message === '' ? 'open-failed' : message;
    }

    /**
     * 把更新交给宿主自己的更新器：检查 → 下载 → 关闭重启，全程由桌面应用负责。
     * 我们只负责按一下——插件跑在服务端进程里，碰不到 electron-updater。
     */
    function startUpdate(bridge) {
      if (!bridge || typeof bridge.open !== 'function') return Promise.resolve(false);
      setUpdatePhase({ phase: 'checking' });
      try {
        return Promise.resolve(bridge.open()).then(() => true).catch((error) => {
          setUpdatePhase({ phase: 'error', failure: describeFailure(error) });
          return false;
        });
      } catch (error) {
        setUpdatePhase({ phase: 'error', failure: describeFailure(error) });
        return Promise.resolve(false);
      }
    }

    /** 订阅宿主更新器状态：先拉一次当前快照，再跟着 presentation 事件刷新。 */
    function useUpdatePhase(bridge) {
      if (!useStateHook) return updatePhase;
      const [state, setState] = useStateHook(updatePhase);
      if (useEffectHook) {
        useEffectHook(() => {
          const bump = () => setState(updatePhase);
          updatePhaseListeners.add(bump);
          if (bridge && typeof bridge.status === 'function') {
            try {
              Promise.resolve(bridge.status()).then(setUpdatePhase).catch(() => undefined);
            } catch (error) { /* 拿不到当前状态就等推送 */ }
          }
          let off = null;
          if (bridge && typeof bridge.subscribe === 'function') {
            try { off = bridge.subscribe(setUpdatePhase); } catch (error) { off = null; }
          }
          return () => {
            updatePhaseListeners.delete(bump);
            if (typeof off === 'function') off();
          };
        }, []);
      }
      return state;
    }

    function useConfirmFlag() {
      if (!useStateHook) return [false, () => undefined];
      return useStateHook(false);
    }

    /** 面板里的“更新 dsh”一行：更新会关闭并自动重开 dsh，所以先确认再动手。 */
    function UpdateRow(props) {
      const view = (props && props.view) || null;
      const bridge = updateBridge();
      const phase = useUpdatePhase(bridge);
      const [confirming, setConfirming] = useConfirmFlag();
      const hostVersion = (view && view.host && view.host.version) || '';
      const targetVersion = (view && view.target && view.target.version) || '';
      const changed = targetVersion !== '' && hostVersion !== '' && targetVersion !== hostVersion;
      const phaseText = describePhase(phase);
      const wrap = { marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12 };
      const hint = { opacity: 0.72, flex: '1 1 auto', minWidth: 0 };
      if (!bridge) {
        return el('div', { style: { marginTop: 10, display: 'block', fontSize: 12 } },
          el('div', { style: hint }, '这里没法直接更新：没拿到桌面应用的更新接口，请在应用菜单里更新 dsh。'),
          el('div', { style: { marginTop: 2, opacity: 0.45, fontSize: 11 } }, diagnosticText()));
      }
      const label = changed ? '更新 dsh 到 ' + targetVersion : '检查 dsh 更新';
      const buttonStyle = {
        font: 'inherit', fontSize: 12, padding: '3px 12px', borderRadius: 999, cursor: 'pointer',
        border: '1px solid rgba(16,185,129,0.5)', background: 'rgba(16,185,129,0.14)', color: 'inherit', whiteSpace: 'nowrap',
      };
      const ghostStyle = { ...buttonStyle, border: '1px solid rgba(148,163,184,0.45)', background: 'transparent' };
      if (confirming) {
        return el('div', { style: wrap },
          el('span', { style: hint }, '更新会关闭 dsh 并自动重开，没保存的内容会丢。现在更新？'),
          el('button', { type: 'button', onClick: () => { setConfirming(false); startUpdate(bridge); }, style: buttonStyle }, '确认更新'),
          el('button', { type: 'button', onClick: () => setConfirming(false), style: ghostStyle }, '取消'));
      }
      return el('div', { style: wrap },
        el('span', { style: hint }, '更新交给桌面应用自己做：检查、下载、重启都在窗口里完成，不用再去终端敲命令。'),
        phaseText ? el('span', { style: { color: '#10b981' } }, phaseText) : null,
        el('button', { type: 'button', onClick: () => setConfirming(true), style: buttonStyle }, label));
    }

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

    /**
     * 还在 pnpm 最短发布等待期内的新版本。剩余时间由界面现算：
     * 快照里存"发布于 + 等待期"，不存 remainingMs，否则三分钟后就过期。
     */
    function ageItemsOf(view, now = Date.now()) {
      const list = view && view.releaseAge && Array.isArray(view.releaseAge.items) ? view.releaseAge.items : [];
      const out = [];
      for (const item of list) {
        const published = item && item.publishedAt ? Date.parse(item.publishedAt) : NaN;
        const windowMs = item && typeof item.windowMs === 'number' ? item.windowMs : null;
        if (!Number.isFinite(published) || windowMs === null) continue;
        const remainingMs = published + windowMs - now;
        if (remainingMs <= 0) continue;
        out.push({ name: item.name || '?', version: item.version || null, remainingMs });
      }
      return out;
    }

    function describeWait(ms) {
      const minutes = Math.max(1, Math.ceil(ms / 60000));
      if (minutes < 60) return minutes + ' 分钟';
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest ? hours + ' 小时 ' + rest + ' 分钟' : hours + ' 小时';
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
          p.reason ? el('div', { style: { fontSize: 12, opacity: 0.72, marginTop: 2, wordBreak: 'break-word' } }, p.reason) : null,
          p.fix ? el('div', { style: { fontSize: 12, marginTop: 3, wordBreak: 'break-all' } },
            el('span', { style: { opacity: 0.6 } }, '先升级：'),
            el('code', { style: { padding: '1px 6px', borderRadius: 4, background: 'rgba(148,163,184,0.16)', userSelect: 'all' } }, p.fix)) : null));
    }

    /** 数量小结：相容 / 会失效 / 无法判断。 */
    function countRow(view) {
      const counts = (view && view.counts) || {};
      const items = [
        ['相容', counts.ok || 0, STATUS_TONE.OK],
        ['会失效', counts.break || 0, STATUS_TONE.BREAK],
        ['无法判断', counts.unknown || 0, STATUS_TONE.UNKNOWN],
      ];
      return el('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 } },
        items.map((item, i) => el('span', {
          key: 'c' + i,
          style: { fontSize: 12, padding: '2px 9px', borderRadius: 999, color: item[2],
            background: 'rgba(148,163,184,0.1)', border: '1px solid ' + item[2] + '33' },
        }, item[0] + ' ' + item[1])));
    }

    function EmptyHint(props) {
      const view = props.view || {};
      return el('div', { style: { padding: 16, fontSize: 13, opacity: 0.8, lineHeight: 1.7 } },
        el('div', null, view.hint || '还没有判定结果。'),
        el('div', { style: { marginTop: 6 } }, '在会话里执行 ',
          el('code', { style: { padding: '1px 6px', borderRadius: 4, background: 'rgba(148,163,184,0.18)' } }, '/compat'),
          ' 生成一次结果，之后这里会自动显示最新结论（执行命令不消耗额度）。'));
    }

    /** “我已知晓”一行：确认过就把徽章收起来，指纹一变自动恢复提醒。 */
    function AckRow(props) {
      const view = props.view;
      const fp = fingerprintOf(view);
      const acked = fp !== '' && readAck() === fp;
      const action = view && view.verdict ? view.verdict.action : null;
      if (!acked && action === 'safe') return null;
      const tint = acked ? 'rgba(16,185,129,0.14)' : 'rgba(245,158,11,0.14)';
      const line = (acked
        ? '已标记知晓：徽章先不出现，等 dsh 或插件下次变化再说。'
        : '看过了？点右边，输入框上方那枚徽章就不再出现，直到 dsh 或插件下次变化。')
        + (ackStorageKind() === 'memory' ? '（这台机器的页面存储用不了，标记只在本次运行有效）' : '');
      return el('div', { style: { marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12 } },
        el('span', { style: { opacity: 0.72, flex: '1 1 auto', minWidth: 0 } }, line),
        el('button', {
          type: 'button',
          onClick: () => writeAck(acked ? '' : fp),
          style: { font: 'inherit', fontSize: 12, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
            border: '1px solid rgba(148,163,184,0.45)', background: tint, color: 'inherit', whiteSpace: 'nowrap' },
        }, acked ? '取消标记' : '我已知晓'));
    }

    function CompatGatePanel(props) {
      const view = props && typeof props.useProjection === 'function' ? props.useProjection(PROJECTION_KEY) : null;
      if (!view || view.ok === false) return el(EmptyHint, { view });
      const tone = toneOf(view);
      const audit = view.audit;
      // 没有复核结果时也把账本里记的真实宿主显示出来，别让两格退化成短横让人误会
      const auditHost = (audit && audit.hostVersion) || (view.host && view.host.version) || '—';
      const auditLastHost = (audit && audit.previousHost) || view.lastHost || '—';
      const auditChanged = audit ? audit.versionChanged === true : Boolean(view.lastHost && view.host && view.host.version && view.lastHost !== view.host.version);
      const plugins = Array.isArray(view.plugins) ? view.plugins : [];
      const ages = ageItemsOf(view);
      useAckTick();
      return el('div', { style: { padding: 16, fontFamily: 'inherit', color: 'inherit', lineHeight: 1.6, overflow: 'auto' } },
        el('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          el('div', { style: { fontSize: 16, fontWeight: 700 } }, LABEL),
          el('span', { style: { padding: '2px 10px', borderRadius: 999, fontSize: 12, color: tone.fg, background: tone.bg, border: '1px solid ' + tone.fg + '44' } },
            view.verdict && view.verdict.label ? view.verdict.label : tone.tag),
          el('span', { style: { fontSize: 12, opacity: 0.55 } }, 'v' + VERSION)),
        el('div', { style: { marginTop: 10, fontSize: 13 } },
          el('span', { style: { opacity: 0.6 } }, '版本 '), describeTarget(view)),
        el('div', { style: { marginTop: 4, fontSize: 13, opacity: 0.85 } }, describeVerdict(view)),
        el(UpdateRow, { key: 'update', view }),
        countRow(view),
        el(AckRow, { key: 'ack', view }),
        ages.length
          ? el('div', { style: { marginTop: 10, padding: '6px 10px', borderRadius: 8, fontSize: 12, color: '#b45309',
              background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.35)' } },
              el('div', null, '⚠ ' + ages.length + ' 个插件的新版还在 pnpm 等待期内，现在装会被拒'),
              ages.map((item, i) => el('div', { key: 'age' + i, style: { marginTop: 2, opacity: 0.9 } },
                item.name + (item.version ? '@' + item.version : '') + ' 还要等 ' + describeWait(item)))) : null,
        el('div', { style: { marginTop: 12, padding: '8px 10px', borderRadius: 8, background: 'rgba(148,163,184,0.1)', fontSize: 13 } },
          el('div', { style: { fontWeight: 600 } }, '更新后复核'),
          el('div', null, '上次记录宿主 ' + auditLastHost + '，当前 ' + auditHost + (auditChanged ? '（已变化）' : '（未变化）')),
          audit
            ? (audit.broken && audit.broken.length
              ? el('div', { style: { marginTop: 4 } }, '确认失效：' + audit.broken.map((b) => b.name + (b.version ? '@' + b.version : '')).join('、'))
              : el('div', { style: { marginTop: 4, opacity: 0.75 } }, '没有发现失效插件'))
            : el('div', { style: { marginTop: 4, opacity: 0.75 } }, '这次运行宿主没变，不做复核；上面那个就是账本里记的版本')),
        plugins.length
          ? el('div', { style: { marginTop: 14 } },
              el('div', { style: { fontSize: 12, opacity: 0.6, marginBottom: 4 } }, '已安装插件（' + plugins.length + '）'),
              el('div', null, plugins.map((p, i) => el(PluginRow, { key: p.name + ':' + i, plugin: p, index: i }))))
          : null,
        el('div', { style: { marginTop: 14, fontSize: 12, opacity: 0.55, display: 'flex', gap: 12, flexWrap: 'wrap' } },
          el('span', null, timeText(view) ? '更新于 ' + timeText(view) : '尚未更新'),
          el('span', null, '在会话里执行 /compat 刷新，不消耗额度')));
    }

    /**
     * 输入框上方的小徽章。dock 槽拿得到 useProjection（有数据），但标准属性里没有 openView，
     * 所以只在宿主真的传了 openView 时才做成按钮，否则是不可点的纯展示，避免"点了没反应"。
     */
    function CompatGateBadge(props) {
      const view = props && typeof props.useProjection === 'function' ? props.useProjection(PROJECTION_KEY) : null;
      const action = view && view.verdict ? view.verdict.action : null;
      // 全部相容时干脆不出现：标签页已经常驻在会话顶部，再来一枚"全部相容"就是噪音。
      const breakCount = (view && view.counts && view.counts.break) || 0;
      if (!view || view.ok === false) return null;
      if (breakCount === 0) return null;
      useAckTick();
      if (acknowledged(view)) return null;
      const tone = toneOf(view);
      const ages = ageItemsOf(view);
      const text = LABEL + ' · ' + breakCount + ' 个会失效' + (ages.length ? ' · 等待期 ' + ages.length : '');
      const base = {
        display: 'inline-flex', alignSelf: 'flex-start', flex: '0 0 auto', width: 'fit-content', maxWidth: '100%',
        alignItems: 'center', gap: 6, margin: '0 0 4px 0', padding: '2px 9px', fontSize: 12, lineHeight: 1.5,
        color: tone.fg, background: tone.bg, border: '1px solid ' + tone.fg + '44', borderRadius: 999,
      };
      const children = [
        el('span', { key: 'dot', style: { width: 7, height: 7, borderRadius: 4, background: tone.fg, flex: '0 0 auto' } }),
        el('span', { key: 'text', style: { whiteSpace: 'nowrap' } }, text),
      ];
      if (props && typeof props.openView === 'function') {
        return el('button', {
          type: 'button',
          onClick: () => props.openView(VIEW_ID, ''),
          title: '打开' + LABEL + '面板',
          style: { ...base, cursor: 'pointer', font: 'inherit' },
        }, children);
      }
      return el('span', { style: base, title: '在会话顶部的「' + LABEL + '」标签页查看详情' }, children);
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

      // 会话视图：唯一能同时拿到 useProjection 与 openView 的槽位，面板挂这里。
      safe('conversation.view', () => ctx.slots.register(
        { name: 'conversation.view', id: VIEW_ID, order: 26, label: () => LABEL },
        (props) => el(CompatGatePanel, props)));

      // 输入框上方的紧凑徽章：只做提示，能点才点。
      safe('conversation.input.dock', () => ctx.slots.register(
        { name: 'conversation.input.dock', id: 'compat-gate-badge', order: 33 },
        (props) => el(CompatGateBadge, props)));
    }

    exports.name = PLUGIN_ID;
    exports.inject = inject;
    exports.apply = apply;
    exports.__internals = {
      describeVerdict, describeTarget, toneOf, timeText, CompatGatePanel, CompatGateBadge, countRow, AckRow,
      fingerprintOf, acknowledged, ageItemsOf, describeWait, PluginRow, PROJECTION_KEY, VIEW_ID,
      UpdateRow, updateBridge, describePhase, startUpdate, ackStorageKind, diagnosticText,
    };
    return module.exports;
  },
});