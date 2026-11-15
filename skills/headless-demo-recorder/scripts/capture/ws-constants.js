// agent-browser replaces window.WebSocket when --allowed-domains is set, copying only the prototype.
// WebSocket.OPEN and friends become undefined, so pages that check `socket.readyState === WebSocket.OPEN`
// before sending (ttyd, many WS clients) never send. Since 0.42.0 it replaces it again after the page has
// loaded, so patching once at load is not enough (measured on 0.41.1, 0.42.0 and 0.43.0): window.WebSocket
// becomes an accessor that adds the constants to whatever is assigned to it, the replacement included.
(() => {
  const C = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
  const patch = (W) => {
    try {
      if (typeof W === "function" && W.OPEN === undefined) Object.assign(W, C);
    } catch {}
    return W;
  };
  let current = patch(window.WebSocket);
  try {
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      enumerable: false,
      get: () => current,
      set: (v) => {
        current = patch(v);
      },
    });
  } catch {}
  // A replacement made with defineProperty bypasses the setter: patch what is there at these points too.
  const fix = () => patch(window.WebSocket);
  queueMicrotask(fix);
  document.addEventListener("DOMContentLoaded", fix);
  addEventListener("load", fix);
})();
