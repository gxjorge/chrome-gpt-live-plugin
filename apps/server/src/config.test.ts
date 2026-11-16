import { describe, expect, it } from "vitest";
import { loadConfig, requireFoundryConfiguration, resolveFoundryConfiguration } from "./config.js";

const saved = {
  projectEndpoint: "https://example.services.ai.azure.com/api/projects/example-project",
  liveDeployment: "saved-live",
  astraDeployment: "saved-controller",
};

describe("Foundry configuration precedence", () => {
  it("has no personal resource defaults and can boot before configuration", () => {
    const config = loadConfig({});
    expect(config.FOUNDRY_PROJECT_ENDPOINT).toBeUndefined();
    expect(config.AZURE_OPENAI_ENDPOINT).toBeUndefined();
    expect(resolveFoundryConfiguration(config)).toMatchObject({
      ready: false, values: { liveDeployment: "gpt-live-1", astraDeployment: "gpt-6-astra" },
    });
    expect(config.ASTRA_REASONING_EFFORT).toBe("low");
  });

  it("resolves a saved project to its Azure OpenAI resource", () => {
    expect(requireFoundryConfiguration(loadConfig({}), saved)).toEqual({
      ...saved, openAIEndpoint: "https://example.openai.azure.com",
    });
  });

  it("overrides saved values per environment field, deriving the endpoint from the effective project", () => {
    const resolved = resolveFoundryConfiguration(loadConfig({
      FOUNDRY_PROJECT_ENDPOINT: "https://environment.services.ai.azure.com/api/projects/environment-project/",
      GPT_LIVE_DEPLOYMENT: "environment-live",
    }), saved);
    expect(resolved).toEqual({
      values: {
        projectEndpoint: "https://environment.services.ai.azure.com/api/projects/environment-project",
        openAIEndpoint: "https://environment.openai.azure.com",
        liveDeployment: "environment-live", astraDeployment: "saved-controller",
      },
      overrides: { projectEndpoint: true, openAIEndpoint: false, liveDeployment: true, astraDeployment: false, decisionDeployment: false },
      ready: true,
    });
  });

  it("honors a separately configured GPT-Live resource endpoint", () => {
    const resolved = resolveFoundryConfiguration(loadConfig({ AZURE_OPENAI_ENDPOINT: "https://voice-resource.openai.azure.com/" }), saved);
    expect(resolved.values.openAIEndpoint).toBe("https://voice-resource.openai.azure.com");
    expect(resolved.overrides.openAIEndpoint).toBe(true);
  });

  it("ignores empty environment values rather than locking out saved settings", () => {
    expect(requireFoundryConfiguration(loadConfig({
      FOUNDRY_PROJECT_ENDPOINT: "", AZURE_OPENAI_ENDPOINT: " ", GPT_LIVE_DEPLOYMENT: "", ASTRA_DEPLOYMENT: " ",
    }), saved)).toMatchObject(saved);
  });

  it("allows deeper reasoning and rejects invalid effort or endpoint settings", () => {
    expect(loadConfig({ ASTRA_REASONING_EFFORT: "high" }).ASTRA_REASONING_EFFORT).toBe("high");
    expect(() => loadConfig({ ASTRA_REASONING_EFFORT: "unsupported" })).toThrow();
    expect(() => loadConfig({ AZURE_OPENAI_ENDPOINT: "https://attacker.example" })).toThrow();
    expect(() => loadConfig({ FOUNDRY_PROJECT_ENDPOINT: "not a URL" })).toThrow();
  });
});
