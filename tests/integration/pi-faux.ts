// 計画 §5-1(b): faux provider で台本どおりにツールを呼ぶスタブが createAgentSession 上で動くか。
// 実行: bun tests/integration/pi-faux.ts   （成功で exit 0、失敗で exit 1）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL = "probe_tool";
const agentDir = mkdtempSync(join(tmpdir(), "pi-faux-agent-"));
const cwd = mkdtempSync(join(tmpdir(), "pi-faux-cwd-"));
const faux = registerFauxProvider({ provider: "faux-probe" });

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  console.log(`ok - ${msg}`);
}

try {
  const model = faux.getModel();
  // ModelRuntime は自分の provider 一覧にない provider へは送れない。
  // registerProvider で faux の api を指す provider を登録すると、provider-composer が
  // compat のグローバル api-registry（getApiProvider）へフォールバックし、faux の stream に届く。
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider(model.provider, {
    name: "Faux probe",
    baseUrl: "http://faux.invalid",
    apiKey: "faux-key",
    api: faux.api,
    models: [
      {
        id: model.id,
        name: model.name,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
    ],
  });
  const runtimeModel = modelRuntime.getModel(model.provider, model.id);
  check(runtimeModel, `ModelRuntime が faux モデル ${model.provider}/${model.id} を解決できる`);

  let toolRuns = 0;
  let receivedArg = "";
  const probe = defineTool({
    name: TOOL,
    label: "Probe",
    description: "Integration probe tool",
    parameters: Type.Object({ value: Type.String() }),
    execute: async (_id, params) => {
      toolRuns++;
      receivedArg = params.value;
      return { content: [{ type: "text", text: `probe-ok:${params.value}` }], details: {} };
    },
  });

  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(TOOL, { value: "hello" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("done")),
  ]);

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: runtimeModel,
    thinkingLevel: "off",
    modelRuntime,
    tools: [TOOL],
    customTools: [probe],
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });

  try {
    const active = session.getActiveToolNames();
    console.log(`active tools: ${JSON.stringify(active)}`);
    check(JSON.stringify(active) === JSON.stringify([TOOL]), `有効ツールが [${TOOL}] と完全一致する`);

    await session.prompt("call the probe tool");

    check(toolRuns === 1, `カスタムツールが1回だけ実行された (runs=${toolRuns})`);
    check(receivedArg === "hello", `台本の引数がツールに渡った (value=${receivedArg})`);
    check(faux.state.callCount === 2, `faux が2回呼ばれた (callCount=${faux.state.callCount})`);
    check(faux.getPendingResponseCount() === 0, "台本を使い切った");
    const last = session.messages.at(-1);
    const lastText =
      last && last.role === "assistant"
        ? last.content.map((c) => (c.type === "text" ? c.text : "")).join("")
        : "";
    check(lastText === "done", `最後のアシスタント応答が "done" (got=${JSON.stringify(lastText)})`);
    const toolResult = session.messages.find((m) => m.role === "toolResult");
    check(
      toolResult && toolResult.role === "toolResult" && !toolResult.isError,
      "toolResult メッセージがエラーなしで記録された",
    );
  } finally {
    session.dispose();
  }
  console.log("PASS pi-faux");
} catch (e) {
  console.error("FAIL pi-faux:", e);
  process.exitCode = 1;
} finally {
  faux.unregister();
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
