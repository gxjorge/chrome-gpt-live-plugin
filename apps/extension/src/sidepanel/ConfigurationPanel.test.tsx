// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigurationPanel } from "./ConfigurationPanel";

let root: Root;
const stored = {
  projectEndpoint: "https://saved.services.ai.azure.com/api/projects/saved-project",
  liveDeployment: "saved-live", astraDeployment: "saved-controller", decisionDeployment: "saved-decision",
};
const effective = {
  values: {
    projectEndpoint: "https://environment.services.ai.azure.com/api/projects/environment-project",
    openAIEndpoint: "https://environment.openai.azure.com",
    liveDeployment: "environment-live", astraDeployment: "saved-controller", decisionDeployment: "saved-decision",
  },
  overrides: { projectEndpoint: true, liveDeployment: true, astraDeployment: false, decisionDeployment: false, openAIEndpoint: false },
  ready: true,
};
const storage = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("chrome", { storage: { local: storage } });
  storage.get.mockResolvedValue({ foundryConfiguration: stored });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(effective)));
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("configuration panel", () => {
  it("keeps MD-1-first off by default and saves an explicit opt-in without copying environment settings", async () => {
    await act(async () => root.render(<ConfigurationPanel onClose={vi.fn()} onSaved={vi.fn()} />));
    const select = document.querySelector("select")!;
    expect(select.value).toBe("astra");
    await act(async () => {
      select.value = "md1-first";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(storage.set).toHaveBeenCalledWith({ foundryConfiguration: { ...stored, browserControl: "md1-first" } });
    expect(document.body.textContent).toContain("protocol-verification release lock");
  });
  it("labels environment overrides and locks only the affected fields", async () => {
    await act(async () => root.render(<ConfigurationPanel onClose={vi.fn()} onSaved={vi.fn()} />));
    const project = document.querySelector<HTMLInputElement>("#setting-projectEndpoint")!;
    const live = document.querySelector<HTMLInputElement>("#setting-liveDeployment")!;
    const astra = document.querySelector<HTMLInputElement>("#setting-astraDeployment")!;
    expect(project.value).toBe(effective.values.projectEndpoint);
    expect(project.readOnly).toBe(true);
    expect(live.value).toBe("environment-live");
    expect(live.readOnly).toBe(true);
    expect(astra.value).toBe("saved-controller");
    expect(astra.readOnly).toBe(false);
    expect(document.body.textContent).toContain("Managed by .env / environment");
  });

  it("preserves underlying saved settings without copying displayed environment values", async () => {
    const onSaved = vi.fn();
    await act(async () => root.render(<ConfigurationPanel onClose={vi.fn()} onSaved={onSaved} />));
    await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(storage.set).toHaveBeenCalledWith({ foundryConfiguration: stored });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(JSON.stringify(storage.set.mock.calls)).not.toContain("environment");
  });

  it("keeps the form open and exposes errors when saving fails", async () => {
    const onSaved = vi.fn();
    storage.set.mockRejectedValueOnce(new Error("Local storage could not be written"));
    await act(async () => root.render(<ConfigurationPanel onClose={vi.fn()} onSaved={onSaved} />));
    await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(onSaved).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Local storage could not be written");
  });
});
