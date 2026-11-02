import { WTerm } from "@wterm/dom";

const el = document.getElementById("terminal")!;
let ws: WebSocket | undefined;
const send = (m: object) => ws?.readyState === 1 && ws.send(JSON.stringify(m));
const term = new WTerm(el, {
  onData: (d) => send({ t: "i", d }),
  onResize: (cols, rows) => send({ t: "r", cols, rows }),
});
await term.init();
ws = new WebSocket(`ws://${location.host}/pty?cols=${term.cols}&rows=${term.rows}`);
ws.binaryType = "arraybuffer";
ws.onmessage = (e) => term.write(new Uint8Array(e.data));
term.focus();
