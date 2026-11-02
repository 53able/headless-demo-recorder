// agent-browser の --allowed-domains にポート付きパターンを書いたとき、
// 同じホストの別ポートへの通信（ページの fetch・直接の open）が遮断されるか。
// 実行: bun tests/integration/ab-ports.ts
//   127.0.0.1 上に2つの HTTP サーバー（A, B）を立て、パターンごとに独立した --session で検証する。
//   B へのリクエストはサーバー側で記録するので、ブラウザの表示に頼らず「届いたか」を判定できる。
//   セッションの close とサーバーの停止は finally で必ず行う。
// 注意: spawnSync はイベントループを止め、同じプロセスの Bun.serve が応答できなくなるため、非同期の Bun.spawn を使う。

type Hit = { path: string; at: number };
const hitsB: Hit[] = [];
const hitsA: Hit[] = [];

const serverA = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    hitsA.push({ path: new URL(req.url).pathname, at: Date.now() });
    return new Response("<!doctype html><title>A</title><h1 id=a>PAGE-A</h1>", {
      headers: { "content-type": "text/html" },
    });
  },
});
const serverB = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    hitsB.push({ path: new URL(req.url).pathname, at: Date.now() });
    return new Response("B-OK", {
      headers: { "content-type": "text/html", "access-control-allow-origin": "*" },
    });
  },
});
const A = `http://127.0.0.1:${serverA.port}`;
const B = `http://127.0.0.1:${serverB.port}`;

// 利用者の AGENT_BROWSER_* を引き継がない
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("AGENT_BROWSER_")) env[k] = v;

async function run(argv: string[], timeoutMs: number) {
  const p = Bun.spawn(["agent-browser", ...argv], { env, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code: p.signalCode ? null : code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function ab(session: string, allowed: string, ...cmd: string[]) {
  const out = await run(["--session", session, "--allowed-domains", allowed, ...cmd], 60_000);
  console.log(`  $ agent-browser --session ${session} --allowed-domains "${allowed}" ${cmd.join(" ")}`);
  console.log(`    exit=${out.code} stdout=${JSON.stringify(out.stdout.slice(0, 300))} stderr=${JSON.stringify(out.stderr.slice(0, 300))}`);
  return out;
}

async function closeSession(session: string) {
  const r = await run(["--session", session, "close"], 30_000);
  console.log(`  [cleanup] close ${session} exit=${r.code}`);
}

const fetchJs = (path: string) =>
  `(async () => { try { const r = await fetch('${B}${path}'); return 'FETCH-OK:' + r.status + ':' + (await r.text()); } catch (e) { return 'FETCH-ERR:' + String(e); } })()`;

type CaseResult = {
  pattern: string;
  openA: { code: number | null; reachedA: boolean };
  fetchB: { output: string; reachedB: boolean };
  openB: { code: number | null; output: string; reachedB: boolean; urlAfter: string };
};

async function runCase(label: string, pattern: string): Promise<CaseResult> {
  const session = `abports-${label}-${process.pid}-${Date.now()}`;
  console.log(`\n== case ${label}: --allowed-domains "${pattern}"  (A=${A}, B=${B})`);
  try {
    const aBefore = hitsA.length;
    const oa = await ab(session, pattern, "open", `${A}/page`);
    const reachedA = hitsA.slice(aBefore).some((h) => h.path === "/page");

    const fBefore = hitsB.length;
    const fe = await ab(session, pattern, "eval", fetchJs("/from-fetch"));
    await Bun.sleep(300);
    const reachedByFetch = hitsB.slice(fBefore).some((h) => h.path === "/from-fetch");

    const nBefore = hitsB.length;
    const ob = await ab(session, pattern, "open", `${B}/from-nav`);
    await Bun.sleep(300);
    const reachedByNav = hitsB.slice(nBefore).some((h) => h.path === "/from-nav");
    const url = await ab(session, pattern, "get", "url");

    return {
      pattern,
      openA: { code: oa.code, reachedA },
      fetchB: { output: fe.stdout || fe.stderr, reachedB: reachedByFetch },
      openB: { code: ob.code, output: ob.stdout || ob.stderr, reachedB: reachedByNav, urlAfter: url.stdout },
    };
  } finally {
    await closeSession(session);
  }
}

const results: Record<string, CaseResult> = {};
try {
  results.portQualified = await runCase("port", `127.0.0.1:${serverA.port}`);
  results.hostOnly = await runCase("host", "127.0.0.1");
} finally {
  serverA.stop(true);
  serverB.stop(true);
}

console.log(`\nRESULT ${JSON.stringify(results, null, 2)}`);
const pq = results.portQualified;
const ho = results.hostOnly;
if (pq && ho) {
  const accepted = pq.openA.code === 0 && pq.openA.reachedA;
  const blocked = !pq.fetchB.reachedB && !pq.openB.reachedB;
  console.log(`port-qualified pattern accepted (A opened): ${accepted}`);
  console.log(`port B blocked under port-qualified pattern: ${blocked}`);
  console.log(`host-only pattern: A opened=${ho.openA.reachedA}, B reached by fetch=${ho.fetchB.reachedB}, by open=${ho.openB.reachedB}`);
  // agent-browser 0.32.1 で記録した挙動。変われば README の --allow-origin の警告を見直す。
  const asRecorded = !accepted && blocked && ho.openA.reachedA && ho.fetchB.reachedB && ho.openB.reachedB;
  console.log(asRecorded ? "AS-RECORDED ab-ports" : "BEHAVIOR-CHANGED ab-ports: revisit the --allow-origin warning in README");
  process.exitCode = asRecorded ? 0 : 2;
} else {
  process.exitCode = 1;
}

export {};
