// Persistence with redaction applied BEFORE anything reaches disk (plan §3, AC-09).

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MASK = "***";
/** Shorter secrets are only masked on exact match, so a 1-char value cannot mangle every string. */
const MIN_SUBSTRING = 3;

export class Redactor {
  private secrets = new Set<string>();

  add(value: string): void {
    if (value && value !== MASK) this.secrets.add(value);
  }

  get size(): number {
    return this.secrets.size;
  }

  redactString(s: string): string {
    let out = s;
    // Longest first so a secret that contains another one is masked whole.
    for (const v of [...this.secrets].sort((a, b) => b.length - a.length)) {
      if (out === v) return MASK;
      if (v.length >= MIN_SUBSTRING && out.includes(v)) out = out.split(v).join(MASK);
    }
    return out;
  }

  /** Deep copy with every secret masked in string values and object keys. */
  apply<T>(x: T): T {
    return this.walk(x) as T;
  }

  private walk(x: unknown): unknown {
    if (typeof x === "string") return this.redactString(x);
    if (Array.isArray(x)) return x.map((v) => this.walk(v));
    if (x instanceof Error) return { name: x.name, message: this.redactString(x.message), ...this.walkObj(x as unknown as Record<string, unknown>) };
    if (x && typeof x === "object") return this.walkObj(x as Record<string, unknown>);
    return x;
  }

  private walkObj(o: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[this.redactString(k)] = this.walk(v);
    return out;
  }
}

export type AuditEntry = { t: string; tool: string; args: unknown; result?: unknown; error?: unknown; budget: unknown };

export type Summary = { exitCode: number; reason: string; durationMs: number; toolCalls: number; captures: number; rerenders: number; [k: string]: unknown };

/** Every write under runs/<id>/ goes through here so redaction cannot be skipped. */
export class Audit {
  constructor(readonly runDir: string, readonly redactor: Redactor) {}

  async append(entry: AuditEntry): Promise<void> {
    const path = join(this.runDir, "tools.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(this.redactor.apply(entry))}\n`);
  }

  /** Write `runs/<id>/<rel>` as pretty JSON, redacted. */
  async writeJson(rel: string, value: unknown): Promise<string> {
    const path = join(this.runDir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(this.redactor.apply(value), null, 2));
    return path;
  }

  writeSummary(summary: Summary): Promise<string> {
    return this.writeJson("summary.json", summary);
  }
}
