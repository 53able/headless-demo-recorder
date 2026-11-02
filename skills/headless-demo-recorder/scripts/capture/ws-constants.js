// agent-browser (<= 0.41.1) replaces window.WebSocket when --allowed-domains is set, copying
// only the prototype. WebSocket.OPEN and friends become undefined, so pages that check
// `socket.readyState === WebSocket.OPEN` before sending (ttyd, many WS clients) never send.
(() => {
  const fix = () => {
    if (WebSocket.OPEN === undefined) Object.assign(WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  };
  fix();
  queueMicrotask(fix);
  document.addEventListener("DOMContentLoaded", fix);
})();
