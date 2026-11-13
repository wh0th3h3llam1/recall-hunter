// Test-only shim: runs background.js + content.js in one page (no extension host) so the real built
// code can be exercised against the DOM fixture. Messages are routed in-process.
(function () {
  const store = {};
  const listeners = [];
  const ev = () => ({ addListener() {} });
  const api = {
    storage: { onChanged: ev(), local: {
      async get(k) { if (k == null) return { ...store }; const ks = Array.isArray(k) ? k : typeof k === 'string' ? [k] : Object.keys(k); const o = {}; ks.forEach(x => { if (x in store) o[x] = store[x]; }); return o; },
      async set(o) { Object.assign(store, o); }, async remove(ks) { [].concat(ks).forEach(k => delete store[k]); } } },
    runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      sendMessage(msg) {
        return new Promise((res) => { const sender = { tab: { id: 1 } };
          for (const fn of listeners) { const keep = fn(msg, sender, res); if (keep === true) return; } res(undefined); });
      },
      getURL: (p) => p,
    },
    tabs: { onRemoved: ev(), onUpdated: ev(), sendMessage: async () => null, query: async () => [{ id: 1 }] },
    action: { setBadgeText(o) { document.title = '[' + o.text + '] ' + document.title.replace(/^\[.*?\] /, ''); }, setBadgeBackgroundColor() {} },
  };
  window.chrome = api;
})();
