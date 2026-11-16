import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFoundryConfiguration, loadFoundryConfiguration, resolveFoundryConfiguration, saveFoundryConfiguration } from "./configuration";

const saved = {
  projectEndpoint: "https://example.services.ai.azure.com/api/projects/example-project",
  liveDeployment: "saved-live", astraDeployment: "saved-controller",
};
const storage = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("chrome", { storage: { local: storage } });
});
afterEach(() => vi.unstubAllGlobals());

describe("private profile configuration", () => {
  it("loads and saves only in local Chrome storage", async () => {
    storage.get.mockResolvedValue({ foundryConfiguration: saved });
    expect(await loadFoundryConfiguration()).toEqual(saved);
    await saveFoundryConfiguration(saved);
    expect(storage.set).toHaveBeenCalledWith({ foundryConfiguration: saved });
    await clearFoundryConfiguration();
    expect(storage.remove).toHaveBeenCalledWith("foundryConfiguration");
  });

  it("returns empty settings for a new installation and rejects corrupted or credential-bearing data", async () => {
    storage.get.mockResolvedValue({});
    expect(await loadFoundryConfiguration()).toEqual({});
    storage.get.mockResolvedValue({ foundryConfiguration: { projectEndpoint: "not a URL" } });
    await expect(loadFoundryConfiguration()).rejects.toThrow();
    storage.get.mockResolvedValue({ foundryConfiguration: { ...saved, apiKey: "not-a-real-key" } });
    await expect(loadFoundryConfiguration()).rejects.toThrow();
  });

  it("resolves with the companion without overwriting the saved configuration", async () => {
    const effective = {
      values: { ...saved, liveDeployment: "environment-live", openAIEndpoint: "https://example.openai.azure.com", decisionDeployment: "MD-1" },
      overrides: { projectEndpoint: false, liveDeployment: true, astraDeployment: false, decisionDeployment: false, openAIEndpoint: false }, ready: true,
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(effective));
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolveFoundryConfiguration(saved)).toEqual(effective);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual(saved);
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("surfaces companion and persistence failures rather than reporting success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Invalid settings" }, { status: 400 })));
    await expect(resolveFoundryConfiguration(saved)).rejects.toThrow("companion rejected configuration (400)");
    storage.set.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(saveFoundryConfiguration(saved)).rejects.toThrow("Storage unavailable");
  });
});
