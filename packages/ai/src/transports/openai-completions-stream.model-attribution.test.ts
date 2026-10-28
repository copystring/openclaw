import { describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../providers/openai-completions.js";
import {
  replyContext,
  startSse,
  withServer,
  writeSse,
} from "./openai-completions-suite.test-support.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsChunk, makeCompletionsModel } from "./openai-completions.test-support.js";

const keepalive = makeCompletionsChunk({}, null, {
  id: "chatcmpl-keepalive",
  model: "keepalive",
  created: 0,
});

describe.each([
  { name: "direct", createStream: streamOpenAICompletions },
  { name: "managed", createStream: createOpenAICompletionsTransportStreamFn() },
])("$name response attribution", ({ createStream }) => {
  it.each([
    ["text", makeCompletionsChunk({ content: "OK" }, null)],
    ["requested model", makeCompletionsChunk({ content: "OK" }, null)],
    ["hidden reasoning", makeCompletionsChunk({ reasoning_content: "Consider the answer." }, null)],
    [
      "tool call",
      makeCompletionsChunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
        },
        null,
      ),
    ],
    ["finish", makeCompletionsChunk({}, "stop")],
    [
      "usage",
      makeCompletionsChunk({}, null, {
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
      }),
    ],
  ] as const)(
    "attributes %s to the response rather than an empty keepalive",
    async (_kind, answer) => {
      await withServer(
        (_request, response) => {
          startSse(response);
          writeSse(response, keepalive);
          writeSse(
            response,
            makeCompletionsChunk({ role: "assistant", content: "" }, null, {
              id: "transport-role",
              model: "transport-placeholder",
            }),
          );
          writeSse(response, {
            ...answer,
            id: "chatcmpl-served",
            model: _kind === "requested model" ? "test-model" : "served-model",
          });
          writeSse(response, keepalive);
          writeSse(response, makeCompletionsChunk({}, "stop", { id: "", model: "" }));
          response.end("data: [DONE]\n\n");
        },
        async (baseUrl) => {
          const model = makeCompletionsModel({
            provider: "compatible-proxy",
            baseUrl,
            reasoning: true,
          });
          const stream = await createStream(model, replyContext(), {
            apiKey: "synthetic-test-key",
            reasoning: "off",
            reasoningEffort: "off",
          });
          const result = await stream.result();
          expect(result.stopReason).not.toBe("error");
          expect(result.responseModel).toBe(
            _kind === "requested model" ? undefined : "served-model",
          );
          expect(result.responseId).toBe("chatcmpl-served");
          if (_kind === "text") {
            expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "OK" })]);
          }
          if (_kind === "hidden reasoning") {
            expect(result.content).toEqual([]);
          }
        },
      );
    },
  );

  it("does not invent a response identity when only keepalives precede a provider error", async () => {
    await withServer(
      (_request, response) => {
        startSse(response);
        writeSse(response, keepalive);
        writeSse(response, { ...keepalive, choices: [], usage: {} });
        writeSse(response, {
          error: { message: "Synthetic upstream failure", type: "server_error" },
        });
        response.end();
      },
      async (baseUrl) => {
        const model = makeCompletionsModel({ provider: "compatible-proxy", baseUrl });
        const stream = await createStream(model, replyContext(), { apiKey: "synthetic-test-key" });
        const result = await stream.result();
        expect(result.stopReason).toBe("error");
        expect(result.errorMessage).toContain("Synthetic upstream failure");
        expect(result.responseModel).toBeUndefined();
        expect(result.responseId).toBeUndefined();
      },
    );
  });
});
