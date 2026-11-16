import { AIProjectClient } from "@azure/ai-projects";
import cors from "@fastify/cors";
import Fastify from "fastify";
import {
  clickTargetDecisionRequestSchema,
  liveSessionRequestSchema,
  foundryConfigurationSchema,
  viewportAnalysisRequestSchema,
} from "@chrome-gpt-live/shared";
import type { TokenCredential } from "@azure/identity";
import type { AppConfig } from "./config.js";
import { effectiveController, requireFoundryConfiguration, resolveFoundryConfiguration } from "./config.js";
import { buildClickTargetQuestion, decisionEndpoint, interpretClickTargetAnswer } from "./decision.js";
import { astraInstructions, clientLiveInstructions, controllerFor, liveInstructions } from "./tools.js";
import { registerClientController } from "./clientController.js";

const COGNITIVE_SCOPE = "https://cognitiveservices.azure.com/.default";

export function buildApp(config: AppConfig, credential: TokenCredential) {
  const app = Fastify({ logger: true, bodyLimit: 12 * 1024 * 1024 });

  void app.register(cors, {
    origin: (origin, callback) => {
      if (
        !origin ||
        origin.startsWith("chrome-extension://") ||
        origin === "http://localhost:5173"
      ) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed."), false);
    },
    methods: ["GET", "POST"],
  });

  app.get("/health", async () => ({
    ok: true,
    service: "chrome-gpt-live",
    pid: process.pid,
    liveDeployment: resolveFoundryConfiguration(config).values.liveDeployment,
    controllerDeployment: resolveFoundryConfiguration(config).values.astraDeployment,
    decisionDeployment: resolveFoundryConfiguration(config).values.decisionDeployment,
  }));

  app.post("/api/configuration", async (request) =>
    resolveFoundryConfiguration(config, foundryConfigurationSchema.parse(request.body)),
  );
  registerClientController(app, config, credential);

  app.post("/api/live/session", async (request, reply) => {
    const input = liveSessionRequestSchema.parse(request.body);
    const foundry = requireFoundryConfiguration(config, input.configuration);
    const controller = controllerFor(Boolean(foundry.decisionDeployment));
    const mode = effectiveController(config, foundry.browserControl, foundry.decisionDeployment).mode;
    const token = await credential.getToken(COGNITIVE_SCOPE);
    if (!token) {
      throw new Error("Microsoft Entra ID did not return a Cognitive Services token.");
    }

    const response = await fetch(
      `${foundry.openAIEndpoint}/openai/v1/live/sessions`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            model: foundry.liveDeployment,
            instructions: mode === "md1-first" ? clientLiveInstructions : liveInstructions,
            audio: { output: { voice: config.GPT_LIVE_VOICE } },
            delegation: mode === "md1-first" ? { type: "client" } : {
              type: "responses",
              responses: {
                model: foundry.astraDeployment,
                instructions: controller.instructions,
                tools: controller.tools,
                tool_choice: "auto",
                parallel_tool_calls: false,
                reasoning: { effort: config.ASTRA_REASONING_EFFORT },
                text: { verbosity: "low" },
              },
            },
          },
          transport: { type: "webrtc", sdp: input.sdp },
        }),
      },
    );

    const body = await response.text();
    if (!response.ok) {
      request.log.error(
        { statusCode: response.status, foundryResponse: body.slice(0, 2000) },
        "GPT-Live session creation failed",
      );
      return reply.code(502).send({
        error: "GPT-Live session creation failed.",
        detail: safeServiceDetail(body),
      });
    }

    const result = JSON.parse(body) as {
      session?: { id?: string };
      transport?: { sdp?: string };
    };
    if (!result.session?.id || !result.transport?.sdp) {
      throw new Error("GPT-Live returned an incomplete WebRTC session response.");
    }
    return { sessionId: result.session.id, sdp: result.transport.sdp, ...(mode === "md1-first" ? { controllerMode: mode } : {}) };
  });

  app.post("/api/controller/viewport", async (request) => {
    const input = viewportAnalysisRequestSchema.parse(request.body);
    const foundry = requireFoundryConfiguration(config, input.configuration);
    const project = new AIProjectClient(foundry.projectEndpoint, credential);
    const openAI = project.getOpenAIClient();
    const response = await openAI.responses.create({
      model: foundry.astraDeployment,
      instructions: astraInstructions,
      reasoning: { effort: config.ASTRA_REASONING_EFFORT },
      text: { verbosity: "low" },
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                input.question,
                `Page: ${input.page.title}`,
                `URL: ${input.page.url}`,
                `Article excerpt: ${input.page.excerpt.slice(0, 5000)}`,
              ].join("\n"),
            },
            {
              type: "input_image",
              image_url: input.screenshot,
              detail: "low",
            },
          ],
        },
      ],
    });
    return { analysis: response.output_text };
  });

  app.post("/api/decision/click-target", async (request, reply) => {
    const input = clickTargetDecisionRequestSchema.parse(request.body);
    const foundry = requireFoundryConfiguration(config, input.configuration);
    if (!foundry.decisionDeployment) {
      return reply.code(409).send({ error: "No decision deployment is configured." });
    }
    const token = await credential.getToken(COGNITIVE_SCOPE);
    if (!token) {
      throw new Error("Microsoft Entra ID did not return a Cognitive Services token.");
    }
    const response = await fetch(decisionEndpoint(config.DECISION_PROJECT_ENDPOINT ?? foundry.projectEndpoint), {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(buildClickTargetQuestion(foundry.decisionDeployment, input.goal, input.page, input.targets)),
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.text();
    if (!response.ok) {
      request.log.warn({ statusCode: response.status, decisionResponse: body.slice(0, 1000) }, "Decision model request failed");
      return reply.code(502).send({ error: "Decision model request failed.", detail: safeServiceDetail(body) });
    }
    return interpretClickTargetAnswer(JSON.parse(body), input.targets, config.DECISION_CONFIDENCE_THRESHOLD);
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const caught = error instanceof Error ? error : new Error(String(error));
    const statusCode = caught.name === "ZodError" ? 400 : 500;
    void reply.code(statusCode).send({
      error: statusCode === 400 ? "Invalid request." : "The companion service failed.",
      detail: caught.message,
    });
  });

  return app;
}

function safeServiceDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? "No service detail was provided.";
  } catch {
    return body.slice(0, 500);
  }
}
