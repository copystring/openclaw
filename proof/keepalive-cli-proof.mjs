import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const repo = path.resolve(process.argv[2]);
const proofRoot = path.resolve(process.argv[3]);
await mkdir(proofRoot, { recursive: true });
const cases = ["served-model", "requested-model"];
const observations = [];
let currentCase;
const server = createServer(async (request, response) => {
  let body = "";
  for await (const part of request) body += part;
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  const payload = JSON.parse(body);
  const observation = {
    case: currentCase,
    route: "POST /v1/chat/completions",
    requestedModel: payload.model,
    streaming: payload.stream,
    authorizationPresent: Boolean(request.headers.authorization),
    frames: [],
  };
  observations.push(observation);
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.flushHeaders();
  const frame = (id, model, delta, finish_reason = null) => {
    const chunk = {
      id,
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta, finish_reason }],
    };
    observation.frames.push(chunk);
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };
  frame("chatcmpl-keepalive", "keepalive", {});
  setTimeout(() => {
    frame("chatcmpl-served", currentCase, { role: "assistant", content: "CLI proof OK." });
    frame("chatcmpl-served", currentCase, {}, "stop");
    response.end("data: [DONE]\n\n");
  }, 250);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const results = [];
async function readAssistantMessages(root, sessionId) {
  const messages = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) messages.push(...(await readAssistantMessages(file, sessionId)));
    else if (entry.name.endsWith(".sqlite")) {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        if (
          !db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='transcript_events'",
            )
            .get()
        )
          continue;
        for (const row of db
          .prepare(
            "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
          )
          .all(sessionId)) {
          if (!row.event_json) continue;
          const event = JSON.parse(row.event_json);
          if (event.message?.role === "assistant") messages.push(event.message);
        }
      } finally {
        db.close();
      }
    }
  }
  return messages;
}
try {
  for (const servedModel of cases) {
    currentCase = servedModel;
    const caseRoot = path.join(proofRoot, servedModel);
    const workspace = path.join(caseRoot, "workspace");
    await mkdir(workspace, { recursive: true });
    const configPath = path.join(caseRoot, "openclaw.json");
    const config = {
      agents: {
        defaults: {
          workspace,
          skipBootstrap: true,
          model: { primary: "proof/requested-model" },
          thinkingDefault: "off",
          timeoutSeconds: 30,
        },
      },
      models: {
        mode: "replace",
        providers: {
          proof: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: "openai-completions",
            auth: "none",
            models: [
              {
                id: "requested-model",
                name: "Synthetic proof alias",
                reasoning: false,
                input: ["text"],
                contextWindow: 128000,
                maxTokens: 1024,
              },
            ],
          },
        },
      },
      plugins: { enabled: false },
      tools: { profile: "minimal" },
      logging: { level: "debug", consoleLevel: "error" },
    };
    await writeFile(configPath, JSON.stringify(config, null, 2));
    const args = [
      "openclaw.mjs",
      "agent",
      "--local",
      "--agent",
      "main",
      "--session-id",
      `keepalive-proof-${servedModel}`,
      "--message",
      "Reply with CLI proof OK.",
      "--json",
      "--timeout",
      "30",
    ];
    const child = spawn(process.execPath, args, {
      cwd: repo,
      windowsHide: true,
      env: {
        ...process.env,
        OPENCLAW_HOME: caseRoot,
        OPENCLAW_STATE_DIR: path.join(caseRoot, "state"),
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_UPDATE_CHECK: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const exit = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    await writeFile(path.join(caseRoot, "stdout.json"), stdout);
    await writeFile(path.join(caseRoot, "stderr.log"), stderr);
    const result = {
      servedModel,
      exit,
      requestCount: observations.filter((item) => item.case === servedModel).length,
    };
    results.push(result);
    console.log(JSON.stringify(result));
    if (exit !== 0) {
      console.log(
        stderr
          .slice(-5000)
          .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<redacted-address>")
          .replaceAll(repo, "<repo>")
          .replaceAll(proofRoot, "<isolated-state>"),
      );
      throw new Error(`CLI proof failed with exit ${exit}`);
    }
    const parsed = JSON.parse(stdout);
    const sessionId = parsed.meta?.agentMeta?.sessionId;
    assert.equal(sessionId, `keepalive-proof-${servedModel}`);
    const assistants = await readAssistantMessages(path.join(caseRoot, "state"), sessionId);
    assert.equal(assistants.length, 1);
    const assistant = assistants[0];
    const receipt = parsed.meta?.agentMeta?.terminalReceipt;
    const terminalReply = parsed.meta?.terminalReply;
    const expectedRoute =
      servedModel === "requested-model"
        ? undefined
        : "Model route changed: proof/requested-model → proof/served-model.";
    const observation = observations.filter((item) => item.case === servedModel);
    assert.equal(observation.length, 1);
    assert.equal(observation[0].requestedModel, "requested-model");
    assert.equal(observation[0].streaming, true);
    assert.equal(observation[0].authorizationPresent, false);
    assert.equal(receipt?.effective?.responseModel, servedModel);
    assert.equal(terminalReply?.modelRouteChange, expectedRoute);
    assert.equal(terminalReply?.text, "CLI proof OK.");
    assert.equal(assistant?.responseId, "chatcmpl-served");
    assert.equal(assistant?.responseModel ?? assistant?.model, servedModel);
    Object.assign(result, {
      terminalReply,
      requested: receipt.requested,
      effective: receipt.effective,
      rerouted: receipt.rerouted,
      persistedAssistant: {
        role: assistant.role,
        model: assistant.model,
        responseModel: assistant.responseModel,
        responseId: assistant.responseId,
        stopReason: assistant.stopReason,
      },
      assertions: "passed",
    });
    console.log(JSON.stringify(result, null, 2));
  }
  assert.equal(results.length, cases.length);
  assert.ok(results.every((result) => result.assertions === "passed"));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(path.join(proofRoot, "requests.json"), JSON.stringify(observations, null, 2));
  await writeFile(path.join(proofRoot, "results.json"), JSON.stringify(results, null, 2));
}
