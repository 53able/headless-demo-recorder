import { expect, test } from "bun:test";

// agent-browser replaces window.WebSocket under --allowed-domains and drops its constants; since 0.42.0 it
// does so again after the page has loaded. ws-constants.js must keep `readyState === WebSocket.OPEN` true
// for a socket opened well after load, or pages like ttyd never send. Drives the real agent-browser.
test("ws-constants.js: a page that opens a WebSocket after load can send under --allowed-domains", async () => {
  const got: string[] = [];
  const page = (port: number) => `<p id=s>wait</p><script>
setTimeout(() => { const ws = new WebSocket('ws://127.0.0.1:${port}/ws'); ws.onopen = () => {
  document.getElementById('s').textContent = ws.readyState === WebSocket.OPEN ? (ws.send('hi'), 'sent') : 'not-open:' + WebSocket.OPEN; }; }, 1500);
</script>`;
  const srv = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server): Response | undefined {
      if (new URL(req.url).pathname === "/ws" && server.upgrade(req)) return;
      return new Response(page(server.port!), { headers: { "content-type": "text/html" } });
    },
    websocket: { message(_ws, m) { got.push(String(m)); } },
  });
  const init = new URL("../skills/headless-demo-recorder/scripts/capture/ws-constants.js", import.meta.url).pathname;
  const s = ["--session", `hdr-ws-constants-test-${process.pid}`, "--allowed-domains", "127.0.0.1", "--init-script", init];
  const ab = async (...args: string[]) => {
    const p = Bun.spawn(["agent-browser", ...s, ...args], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out.trim();
  };
  try {
    await ab("open", `http://127.0.0.1:${srv.port}/`);
    for (let i = 0; i < 40 && got.length === 0; i++) await Bun.sleep(150);
    expect(await ab("get", "text", "#s")).toBe("sent");
    expect(got).toEqual(["hi"]);
  } finally {
    await ab("close");
    srv.stop(true);
  }
}, 60_000);
