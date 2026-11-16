import type { TokenCredential } from "@azure/identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { browserTools } from "./tools.js";

const { projectConstructor, responsesCreate } = vi.hoisted(() => ({
  projectConstructor: vi.fn(), responsesCreate: vi.fn(),
}));
vi.mock("@azure/ai-projects", () => ({
  AIProjectClient: class {
    constructor(endpoint: string) { projectConstructor(endpoint); }
    getOpenAIClient() { return { responses: { create: responsesCreate } }; }
  },
}));
const savedConfiguration = {
  projectEndpoint: "https://example.services.ai.azure.com/api/projects/example-project",
  liveDeployment: "custom-live",
  astraDeployment: "custom-controller",
};
const credential = { getToken: vi.fn(async () => ({ token: "unit-test-token", expiresOnTimestamp: Date.now() + 60_000 })) };

describe("GPT-Live session broker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    responsesCreate.mockResolvedValue({ output_text: "Synthetic inspection." });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("identifies the companion without requesting credentials for installation readiness", async () => {
    const app = buildApp(loadConfig({}), credential);
    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, service: "chrome-gpt-live", pid: process.pid });
      expect(credential.getToken).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("uses Bearer authentication and the configured GPT-Live/Astra pair", async () => {
    const config = loadConfig({
      FOUNDRY_PROJECT_ENDPOINT: savedConfiguration.projectEndpoint,
      AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com/",
    });
    const getToken = vi.fn<TokenCredential["getToken"]>().mockResolvedValue({
      token: "unit-test-token",
      expiresOnTimestamp: Date.now() + 60_000,
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        session: { id: "session-test" },
        transport: { type: "webrtc", sdp: "test-sdp-answer" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp(config, { getToken });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/live/session",
        payload: { sdp: "test-sdp-offer" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        sessionId: "session-test",
        sdp: "test-sdp-answer",
      });
      expect(getToken).toHaveBeenCalledWith("https://cognitiveservices.azure.com/.default");
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        "https://example.openai.azure.com/openai/v1/live/sessions",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer unit-test-token",
            "Content-Type": "application/json",
          },
          body: expect.any(String),
        }),
      );
      const request = fetchMock.mock.calls[0]?.[1];
      expect(JSON.parse(String(request?.body))).toMatchObject({
        session: {
          model: "gpt-live-1",
          delegation: {
            type: "responses",
            responses: {
              model: "gpt-6-astra",
              tools: browserTools,
              parallel_tool_calls: false,
              reasoning: { effort: "low" },
              text: { verbosity: "low" },
            },
          },
        },
        transport: { type: "webrtc", sdp: "test-sdp-offer" },
      });
    } finally {
      await app.close();
    }
  });

  it("surfaces upstream failures instead of reporting a connected session", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        { error: { message: "The requested deployment is unavailable." } },
        { status: 404 },
      ),
    ));
    const app = buildApp(loadConfig({ FOUNDRY_PROJECT_ENDPOINT: savedConfiguration.projectEndpoint }), {
      getToken: async () => ({ token: "unit-test-token", expiresOnTimestamp: Date.now() + 60_000 }),
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/live/session",
        payload: { sdp: "test-sdp-offer" },
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        error: "GPT-Live session creation failed.",
        detail: "The requested deployment is unavailable.",
      });
    } finally {
      await app.close();
    }
  });

  it("uses saved project and deployment settings when no environment overrides exist", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ session: { id: "test-session" }, transport: { sdp: "answer" } }));
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp(loadConfig({}), credential);
    try {
      const response = await app.inject({ method: "POST", url: "/api/live/session", payload: { sdp: "offer", configuration: savedConfiguration } });
      expect(response.statusCode).toBe(200);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.openai.azure.com/openai/v1/live/sessions");
      expect(fetchMock.mock.calls[0]?.[1].redirect).toBe("error");
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toMatchObject({
        session: { model: "custom-live", delegation: { responses: { model: "custom-controller" } } },
      });
    } finally { await app.close(); }
  });

  it("applies environment precedence to both native delegation and visual inspection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ session: { id: "test-session" }, transport: { sdp: "answer" } }));
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp(loadConfig({
      FOUNDRY_PROJECT_ENDPOINT: "https://environment.services.ai.azure.com/api/projects/environment-project",
      AZURE_OPENAI_ENDPOINT: "https://environment-live.openai.azure.com",
      GPT_LIVE_DEPLOYMENT: "environment-live", ASTRA_DEPLOYMENT: "environment-controller",
    }), credential);
    try {
      expect((await app.inject({ method: "POST", url: "/api/live/session", payload: { sdp: "offer", configuration: savedConfiguration } })).statusCode).toBe(200);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://environment-live.openai.azure.com/openai/v1/live/sessions");
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toMatchObject({
        session: { model: "environment-live", delegation: { responses: { model: "environment-controller" } } },
      });
      const viewport = await app.inject({ method: "POST", url: "/api/controller/viewport", payload: {
        configuration: savedConfiguration, screenshot: "data:image/png;base64,AA==", question: "What is visible?",
        page: { url: "https://example.com", title: "Example", description: "", byline: "", excerpt: "", headings: [], links: [], citations: [], capturedAt: "2026-09-23T00:00:00Z" },
      } });
      expect(viewport.statusCode).toBe(200);
      expect(projectConstructor).toHaveBeenCalledWith("https://environment.services.ai.azure.com/api/projects/environment-project");
      expect(responsesCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "environment-controller" }));
    } finally { await app.close(); }
  });

  it("returns only non-credential settings and their override status to the UI", async () => {
    const app = buildApp(loadConfig({ FOUNDRY_PROJECT_ENDPOINT: savedConfiguration.projectEndpoint, AZURE_CLIENT_ID: "unit-test-managed-identity" }), credential);
    try {
      const response = await app.inject({ method: "POST", url: "/api/configuration", payload: { liveDeployment: "saved-live" } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        values: { projectEndpoint: savedConfiguration.projectEndpoint, openAIEndpoint: "https://example.openai.azure.com", liveDeployment: "saved-live", astraDeployment: "gpt-6-astra" },
        overrides: { projectEndpoint: true, openAIEndpoint: false, liveDeployment: false, astraDeployment: false, decisionDeployment: false },
        ready: true,
      });
      expect(response.body).not.toContain("unit-test-managed-identity");
      expect(credential.getToken).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("requires configuration before acquiring Azure credentials", async () => {
    const app = buildApp(loadConfig({}), credential);
    try {
      const settings = await app.inject({ method: "POST", url: "/api/configuration", payload: {} });
      expect(settings.statusCode).toBe(200);
      expect(settings.json()).toMatchObject({ ready: false });
      const session = await app.inject({ method: "POST", url: "/api/live/session", payload: { sdp: "offer" } });
      expect(session.statusCode).toBe(400);
      expect(credential.getToken).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it.each([
    "https://attacker.example/api/projects/example",
    "https://example.services.ai.azure.com.attacker.example/api/projects/example",
    "http://example.services.ai.azure.com/api/projects/example",
    "https://user:password@example.services.ai.azure.com/api/projects/example",
    "https://example.services.ai.azure.com/api/projects/example?secret=value",
    "not a URL",
  ])("rejects unsafe or invalid project endpoints before acquiring credentials: %s", async (projectEndpoint) => {
    const app = buildApp(loadConfig({}), credential);
    try {
      const response = await app.inject({ method: "POST", url: "/api/live/session", payload: {
        sdp: "offer", configuration: { ...savedConfiguration, projectEndpoint },
      } });
      expect(response.statusCode).toBe(400);
      expect(credential.getToken).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("asks the configured fast decision deployment to pick a click target", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      model: "microsoft-decision-1",
      answers: { target: { type: "choice", choice: "t1", confidence: 0.93, probabilities: { t0: 0.05, t1: 0.93, none: 0.02 } } },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp(loadConfig({ DECISION_CONFIDENCE_THRESHOLD: "0.9" }), credential);
    const payload = {
      goal: "open pricing",
      page: { title: "Home", url: "https://example.com/" },
      targets: [
        { id: "t0", kind: "link", label: "Docs", href: "https://example.com/docs" },
        { id: "t1", kind: "link", label: "Pricing", href: "https://example.com/pricing" },
      ],
      configuration: { ...savedConfiguration, decisionDeployment: "MD-1" },
    };
    try {
      const response = await app.inject({ method: "POST", url: "/api/decision/click-target", payload });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        target: "t1", confidence: 0.93, confident: true,
        ranked: [{ id: "t1", probability: 0.93 }, { id: "t0", probability: 0.05 }],
      });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://example.services.ai.azure.com/providers/microsoft/v1/systemone");
      expect(init).toMatchObject({ method: "POST", redirect: "error" });
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "MD-1", state: { goal: "open pricing" }, questions: { target: { type: "choice" } } });
      expect(Object.keys(body.questions.target.criteria)).toEqual(["t0", "t1", "none"]);
      expect(body.questions.target.criteria.t1).toBe('link "Pricing" -> https://example.com/pricing');

      fetchMock.mockResolvedValueOnce(Response.json({
        answers: { target: { type: "choice", choice: "none", confidence: 0.8, probabilities: { t0: 0.1, t1: 0.1, none: 0.8 } } },
      }));
      const unsure = await app.inject({ method: "POST", url: "/api/decision/click-target", payload });
      expect(unsure.json()).toMatchObject({ target: null, confident: false });

      fetchMock.mockResolvedValueOnce(Response.json({ error: { message: "Rate limit exceeded." } }, { status: 429 }));
      const off = await app.inject({ method: "POST", url: "/api/decision/click-target", payload: { ...payload, configuration: savedConfiguration } });
      expect(off.statusCode).toBe(409);
      const limited = await app.inject({ method: "POST", url: "/api/decision/click-target", payload });
      expect(limited.statusCode).toBe(502);
      expect(limited.json()).toEqual({ error: "Decision model request failed.", detail: "Rate limit exceeded." });
    } finally { await app.close(); }
  });
});
