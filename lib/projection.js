/**
 * 会话投影：把 data/status.json 的快照推给 Web 客户端。
 *
 * 投影是"日志派生状态"的通道 —— 宿主会把 wire.view 的返回值随会话视图
 * 一起发给浏览器，全程不经过模型，因此面板刷新不消耗额度。
 *
 * 约定来自 dsh-session-projection：{ key, stateVersion, stateSchema,
 * init(header, inheritedEventCount), apply(state, event), wire:{ viewSchema, view } }。
 * view 必须同步、纯数据、可 JSON 序列化。
 */
import { statusView } from './status.js';

export const PROJECTION_KEY = 'compatGate';

const anySchema = { parse: (value) => value };

/** 兼容闸门的投影定义。 */
export function compatGateDefinition() {
  return {
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: anySchema,
    // 状态本身不承载数据（数据在 data/status.json 里，随时可能被命令改写），
    // 这里只保留一个修订号，让面板在命令执行后有机会重画。
    init: () => ({ revision: 0, lastEvent: null }),
    apply(state, event) {
      if (!event || typeof event !== 'object') return state;
      const data = event.data;
      if (event.type === 'command/done' && data?.name === 'compat') {
        return { revision: state.revision + 1, lastEvent: 'command' };
      }
      if (event.type === 'tool/result') {
        const callId = data?.message?.toolCallId ?? data?.toolCallId;
        if (typeof callId === 'string' && callId.length > 0 && data?.message?.name === 'compat_gate') {
          return { revision: state.revision + 1, lastEvent: 'tool' };
        }
      }
      return state;
    },
    wire: {
      viewSchema: anySchema,
      // 面板每次组装视图都会读到磁盘上的最新快照；读失败由 statusView 兜底。
      view: () => statusView(),
    },
  };
}