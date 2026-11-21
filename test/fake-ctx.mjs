/**
 * Minimal stand-in for the DSH host context.
 *
 * Only the four surfaces this plugin touches are modelled: on / effect / get /
 * tools.register. It lets the wiring be tested without booting a host.
 */
export function createFakeCtx() {
  const listeners = new Map();
  const registered = [];
  const disposers = [];

  const ctx = {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      const off = () => listeners.get(event)?.delete(fn);
      disposers.push(off);
      return off;
    },
    off(event, fn) { listeners.get(event)?.delete(fn); },
    effect(fn, _label) {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
    get: () => undefined,
    tools: {
      register(def) { registered.push(def); return () => {}; },
    },
    // test helpers
    __emitWaterfall: async (event, payload) => {
      const fns = [...(listeners.get(event) ?? [])];
      let i = 0;
      const next = async () => {
        if (i < fns.length) return fns[i++](payload, next);
        return { kind: 'enter', messages: [{ role: 'user', content: [], id: 'seed' }] };
      };
      return next();
    },
    __emit: async (event, payload) => {
      for (const fn of [...(listeners.get(event) ?? [])]) await fn(payload);
    },
    __listeners: (event) => [...(listeners.get(event) ?? [])].length,
    __registered: registered,
    __disposeAll: () => disposers.forEach((d) => d()),
  };
  return ctx;
}
