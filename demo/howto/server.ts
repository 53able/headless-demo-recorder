// Serves what demo/howto/scenario.json records, on 127.0.0.1:7681 only:
//   /           a terminal (wterm in the page, a zsh PTY behind /pty)
//   /demo/*     pages that show the results (media.html, sheet.html)
//   /out/*      files under out/ (the exported videos and inspect sheets)
import { file } from "bun";
import { join, resolve, sep } from "node:path";
import terminal from "./terminal/index.html";

const port = 7681;
const origin = `http://127.0.0.1:${port}`;
const here = import.meta.dir;
const root = resolve(here, "../..");
const outDir = join(root, "out");

type Session = { cols: number; rows: number; proc?: ReturnType<typeof Bun.spawn> };

Bun.serve<Session>({
  hostname: "127.0.0.1",
  port,
  development: false,
  routes: {
    "/": terminal,
    "/demo/media.html": file(join(here, "media.html")),
    "/demo/sheet.html": file(join(here, "sheet.html")),
  },
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/pty") {
      // The PTY is a writable shell: refuse pages from any other origin (cross-site WebSocket).
      if (req.headers.get("origin") !== origin) return new Response("forbidden", { status: 403 });
      const size = (k: string, d: number) => Number(url.searchParams.get(k)) || d;
      const data = { cols: size("cols", 80), rows: size("rows", 24) };
      return server.upgrade(req, { data }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname.startsWith("/out/")) {
      const path = resolve(outDir, decodeURIComponent(url.pathname.slice("/out/".length)));
      if (!path.startsWith(outDir + sep)) return new Response("forbidden", { status: 403 });
      return new Response(file(path));
    }
    return new Response("not found", { status: 404 });
  },
  error: () => new Response("not found", { status: 404 }),
  websocket: {
    open(ws) {
      ws.data.proc = Bun.spawn(["zsh", "-i"], {
        cwd: root,
        // The shell in the recording: a short prompt, no history written (see zdotdir/.zshrc).
        env: { ...process.env, TERM: "xterm-256color", ZDOTDIR: join(here, "zdotdir"), HDR_ROOT: root },
        terminal: { cols: ws.data.cols, rows: ws.data.rows, data: (_t, d) => ws.send(d) },
      });
      ws.data.proc.exited.then(() => ws.close());
    },
    message(ws, msg) {
      const m = JSON.parse(String(msg)) as { t: "i"; d: string } | { t: "r"; cols: number; rows: number };
      const t = ws.data.proc?.terminal;
      if (m.t === "i") t?.write(m.d);
      else t?.resize(m.cols, m.rows);
    },
    close(ws) {
      ws.data.proc?.kill();
    },
  },
});
console.error(`terminal: ${origin}/  results: ${origin}/demo/media.html?src=<file under out/>`);
