import {
  controllerRoundRequestSchema, controllerStreamEventSchema, fastDecisionRequestSchema,
  controllerItemSchema, FAST_LIMITS,
} from "@chrome-gpt-live/shared";
import type { FastifyInstance } from "fastify";
import type { TokenCredential } from "@azure/identity";
import type { AppConfig } from "./config.js";
import { effectiveController, requireFoundryConfiguration } from "./config.js";
import { buildNextActionQuestion, decisionEndpoint, interpretNextAction } from "./decision.js";
import { controllerFor } from "./tools.js";

const SCOPE = "https://cognitiveservices.azure.com/.default";

export function registerClientController(app: FastifyInstance, config: AppConfig, credential: TokenCredential) {
  app.post("/api/decision/next-action", { bodyLimit: 300000 }, async (request, reply) => {
    const input = fastDecisionRequestSchema.parse(request.body);
    const foundry = requireFoundryConfiguration(config, input.configuration);
    if (effectiveController(config, foundry.browserControl, foundry.decisionDeployment).mode !== "md1-first") {
      return reply.code(409).send({ error: "MD-1-first is disabled, unconfigured, or protocol-locked." });
    }
    const abort = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) abort.abort(); };
    reply.raw.on("close", onClose);
    try {
      const token = await credential.getToken(SCOPE, { abortSignal: abort.signal });
      abort.signal.throwIfAborted();
      if (!token) throw new Error("No Cognitive Services token was returned.");
      const response = await fetch(decisionEndpoint(config.DECISION_PROJECT_ENDPOINT ?? foundry.projectEndpoint), {
        method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildNextActionQuestion(foundry.decisionDeployment!, input.goal, input.snapshot, input.history)),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]),
      });
      if (!response.ok) {
        request.log.warn({ statusCode: response.status }, "MD-1 next-action request failed");
        return reply.code(502).send({ error: "MD-1 next-action request failed." });
      }
      return interpretNextAction(await response.json(), input.snapshot, config.DECISION_CONFIDENCE_THRESHOLD);
    } catch {
      request.log.warn({ category: abort.signal.aborted ? "cancelled" : "provider_or_contract_failure" }, "MD-1 next-action request stopped");
      return reply.code(502).send({ error: "MD-1 request failed or returned an invalid decision." });
    } finally { reply.raw.removeListener("close", onClose); }
  });

  app.post("/api/controller/round", { bodyLimit: 300000 }, async (request, reply) => {
    const input = controllerRoundRequestSchema.parse(request.body);
    const foundry = requireFoundryConfiguration(config, input.configuration);
    if (effectiveController(config, foundry.browserControl, foundry.decisionDeployment).mode !== "md1-first") {
      return reply.code(409).send({ error: "Client controller is not enabled and protocol-verified." });
    }
    const abort = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) abort.abort(); };
    reply.raw.on("close", onClose);
    try {
      const token = await credential.getToken(SCOPE, { abortSignal: abort.signal });
      abort.signal.throwIfAborted();
      if (!token) throw new Error("No Cognitive Services token was returned.");
      const controller = controllerFor(false);
      const response = await fetch(`${foundry.openAIEndpoint}/openai/v1/responses`, {
        method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: foundry.astraDeployment, store: false, stream: true,
          include: ["reasoning.encrypted_content"], instructions: `${controller.instructions}\nThis is a sticky fallback. Never replay completed or uncertain browser mutations. Inspect uncertain state before another action. Ask for clarification when task intent is incomplete.`,
          tools: controller.tools, tool_choice: "auto", parallel_tool_calls: false,
          reasoning: { effort: config.ASTRA_REASONING_EFFORT }, text: { verbosity: "low" },
          input: input.input,
        }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(35000)]),
      });
      if (!response.ok || !response.body) {
        request.log.warn({ statusCode: response.status }, "Astra fallback request failed");
        return reply.code(502).send({ error: "Astra fallback request failed." });
      }
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(name, value);
      }
      reply.raw.setHeader("Content-Type", "application/x-ndjson");
      reply.raw.setHeader("Cache-Control", "no-store");
      reply.raw.writeHead(200);
      let completed = false;
      try {
        for await (const data of readServerEvents(response.body)) {
          if (typeof data !== "object" || data === null || !("type" in data)) continue;
          if (data.type === "response.output_text.delta" && "item_id" in data && "delta" in data) {
            const event = controllerStreamEventSchema.parse({ type: "text", itemId: data.item_id, delta: data.delta });
            reply.raw.write(`${JSON.stringify(event)}\n`);
          }
          if (["error", "response.failed", "response.incomplete", "response.cancelled"].includes(String(data.type))) {
            throw new Error("Astra fallback did not complete.");
          }
          if (data.type === "response.completed" && "response" in data) {
            const result = data.response;
            if (typeof result !== "object" || !result || !("output" in result) || !Array.isArray(result.output)) {
              throw new Error("Astra returned no complete output items.");
            }
            const output = result.output.map((item: unknown) => controllerItemSchema.parse(item));
            if (output.some((item) => item.type === "reasoning" && typeof item.encrypted_content !== "string")) {
              throw new Error("Stateless reasoning continuation was not provided.");
            }
            let text = "";
            for (const item of output) {
              if (item.type === "message" && Array.isArray(item.content)) {
                for (const content of item.content) {
                  if (content && typeof content === "object" && !Array.isArray(content) &&
                    content.type === "output_text" && typeof content.text === "string") text += content.text;
                }
              }
            }
            const event = controllerStreamEventSchema.parse({ type: "completed", output, text });
            if (new TextEncoder().encode(JSON.stringify(event)).byteLength > FAST_LIMITS.historyBytes) {
              throw new Error("Astra output exceeded the continuation budget.");
            }
            reply.raw.write(`${JSON.stringify(event)}\n`);
            completed = true;
            break;
          }
        }
        if (!completed) throw new Error("Astra stream closed before completion.");
      } catch (cause) {
        request.log.warn({ category: abort.signal.aborted ? "cancelled" : "controller_stream_failed" }, "Astra fallback stream stopped");
        if (!reply.raw.destroyed) reply.raw.write(`${JSON.stringify({
          type: "error", message: cause instanceof Error ? cause.message.slice(0, 500) : "Astra stream failed.",
        })}\n`);
      } finally { reply.raw.end(); }
    } catch {
      request.log.warn({ category: abort.signal.aborted ? "cancelled" : "provider_failure" }, "Astra fallback request stopped");
      if (!reply.raw.headersSent && !reply.raw.destroyed) return reply.code(502).send({ error: "Astra fallback request failed." });
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    } finally { reply.raw.removeListener("close", onClose); }
  });
}

export async function* readServerEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n");
      if (new TextEncoder().encode(buffer).byteLength > FAST_LIMITS.historyBytes) throw new Error("Provider event exceeded its size budget.");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data && data !== "[DONE]") {
          let parsed: unknown;
          try { parsed = JSON.parse(data); }
          catch { throw new Error("Provider returned malformed JSON."); }
          yield parsed;
        }
      }
      if (done) {
        if (buffer.trim()) throw new Error("Provider stream ended with an incomplete event.");
        break;
      }
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}
