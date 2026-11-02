// 計画 §5-1(a): 実際のモデルが、ツールの結果として返した画像を判読できるか。
// 失敗したら session.prompt(text, { images }) で添付する方式を試す。
// 実行: bun tests/integration/pi-image.ts [--model provider/id] [--path tool|attach|both]
//   既定のモデルは ~/.pi/agent/settings.json の defaultProvider/defaultModel（読むだけで書き換えない）。
//   認証は ~/.pi/agent/auth.json（ModelRuntime.create() の既定）。実モデルを呼ぶので CI には含めない。
// 終了コード: どちらかの経路で正解すれば 0、両方失敗で 1。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const args = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = argOf("--path") ?? "both";

const settings = JSON.parse(readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf8")) as {
  defaultProvider?: string;
  defaultModel?: string;
};
const modelRef = argOf("--model") ?? `${settings.defaultProvider}/${settings.defaultModel}`;
const slash = modelRef.indexOf("/");
const providerId = modelRef.slice(0, slash);
const modelId = modelRef.slice(slash + 1);

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 0/O・1/I を除く
const code = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => ALPHABET[b % ALPHABET.length]).join("");

const work = mkdtempSync(join(tmpdir(), "pi-image-"));
const agentDir = join(work, "agent");
const pngPath = join(work, "code.png");
execFileSync("mkdir", ["-p", agentDir]);
execFileSync(
  "ffmpeg",
  [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=white:s=640x240",
    "-vf",
    `drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text=${code}:fontsize=140:fontcolor=black:x=(w-tw)/2:y=(h-th)/2`,
    "-frames:v", "1", pngPath,
  ],
  { stdio: "inherit" },
);
const image: ImageContent = { type: "image", data: readFileSync(pngPath).toString("base64"), mimeType: "image/png" };
console.log(`model=${modelRef} code=${code} png=${pngPath} bytes=${readFileSync(pngPath).length}`);

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel(providerId, modelId);
if (!model) {
  console.error(`FAIL: model not found: ${modelRef}`);
  process.exit(1);
}
console.log(`model.input=${JSON.stringify(model.input)} auth=${modelRuntime.hasConfiguredAuth(providerId)}`);

function lastAssistantText(session: AgentSession): string {
  const msg = [...session.messages].reverse().find((m) => m.role === "assistant");
  if (!msg || msg.role !== "assistant") return "";
  if (msg.stopReason === "error") return `<error: ${msg.errorMessage}>`;
  return msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

async function makeSession(withTool: boolean, onToolRun: () => void) {
  const tool = defineTool({
    name: "get_image",
    label: "Get image",
    description: "Returns the image the user is asking about.",
    parameters: Type.Object({}),
    execute: async () => {
      onToolRun();
      return { content: [{ type: "text", text: "Here is the image." }, image], details: {} };
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: work,
    agentDir,
    settingsManager,
    noExtensions: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    systemPrompt: "You are a concise assistant.",
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: work,
    agentDir,
    model,
    thinkingLevel: "low",
    modelRuntime,
    tools: withTool ? ["get_image"] : [],
    noTools: withTool ? undefined : "all",
    customTools: withTool ? [tool] : [],
    resourceLoader,
    sessionManager: SessionManager.inMemory(work),
    settingsManager,
  });
  return session;
}

const judge = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "").includes(code);
const results: Record<string, { pass: boolean; reply: string; toolRuns?: number }> = {};

try {
  if (mode === "tool" || mode === "both") {
    let toolRuns = 0;
    const session = await makeSession(true, () => toolRuns++);
    try {
      await session.prompt(
        "Call the get_image tool. The image shows a 5-character code. Reply with only that code.",
      );
      const reply = lastAssistantText(session);
      results.tool = { pass: toolRuns > 0 && judge(reply), reply, toolRuns };
    } finally {
      session.dispose();
    }
    console.log(`[tool-result] toolRuns=${results.tool.toolRuns} reply=${JSON.stringify(results.tool.reply)} pass=${results.tool.pass}`);
  }
  if (mode === "attach" || (mode === "both" && !results.tool?.pass)) {
    const session = await makeSession(false, () => {});
    try {
      await session.prompt("The attached image shows a 5-character code. Reply with only that code.", {
        images: [image],
      });
      const reply = lastAssistantText(session);
      results.attach = { pass: judge(reply), reply };
    } finally {
      session.dispose();
    }
    console.log(`[attach] reply=${JSON.stringify(results.attach.reply)} pass=${results.attach.pass}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const anyPass = Object.values(results).some((r) => r.pass);
console.log(`RESULT ${JSON.stringify({ model: modelRef, code, results })}`);
console.log(anyPass ? "PASS pi-image" : "FAIL pi-image (stop condition: both paths failed)");
process.exitCode = anyPass ? 0 : 1;
