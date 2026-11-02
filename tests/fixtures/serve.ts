// Local static test site + a leak-recording "other port" server for E2E.
import { join, normalize } from "node:path";

const SITE_DIR = join(import.meta.dir, "site");

export type FixtureServer = { origin: string; port: number; stop: () => void };

export function startFixtureServer(opts: { port?: number } = {}): FixtureServer {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const rel = normalize(path === "/" ? "/index.html" : path);
      if (rel.includes("..")) return new Response("forbidden", { status: 403 });
      const file = Bun.file(join(SITE_DIR, rel));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file);
    },
  });
  const port = server.port as number;
  return { origin: `http://127.0.0.1:${port}`, port, stop: () => void server.stop(true) };
}

export type PingServer = { origin: string; port: number; hits: () => string[]; stop: () => void };

/** Records every request path; used to assert that page JS did (not) reach another local port. */
export function startPingServer(opts: { port?: number } = {}): PingServer {
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch(req) {
      hits.push(new URL(req.url).pathname);
      return new Response("pong", { headers: { "access-control-allow-origin": "*" } });
    },
  });
  const port = server.port as number;
  return { origin: `http://127.0.0.1:${port}`, port, hits: () => [...hits], stop: () => void server.stop(true) };
}

if (import.meta.main) {
  const s = startFixtureServer();
  console.log(s.origin);
  process.on("SIGINT", () => {
    s.stop();
    process.exit(0);
  });
}
