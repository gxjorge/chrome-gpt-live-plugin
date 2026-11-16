export function waitForNavigationStart(tabId: number, fromUrl: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (navigated: boolean) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(navigated);
    };
    const changed = (tab: chrome.tabs.Tab) =>
      tab.status === "loading" || Boolean(tab.pendingUrl) || (tab.url !== undefined && tab.url !== fromUrl);
    const onUpdated = (updatedId: number, _info: unknown, tab: chrome.tabs.Tab) => {
      if (updatedId === tabId && changed(tab)) {
        finish(true);
      }
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    void chrome.tabs.get(tabId).then((tab) => {
      if (changed(tab)) {
        finish(true);
      }
    }, () => finish(false));
  });
}

export function waitForTabReady(tabId: number, timeoutMs = 15000): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (tab?: chrome.tabs.Tab, error?: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) {
        reject(error);
      } else if (tab) {
        resolve(tab);
      }
    };
    const inspect = () => {
      void chrome.tabs.get(tabId).then((tab) => {
        if (tab.status === "complete" && !tab.pendingUrl) {
          finish(tab);
        }
      }, (cause: unknown) => finish(undefined, new Error(
        cause instanceof Error ? cause.message : "The conversation tab is unavailable.",
      )));
    };
    const onUpdated = (updatedId: number) => {
      if (updatedId === tabId) {
        inspect();
      }
    };
    const onRemoved = (removedId: number) => {
      if (removedId === tabId) {
        finish(undefined, new Error("The conversation tab was closed while loading."));
      }
    };
    const timeout = setTimeout(() => finish(undefined, new Error(
      "The page is still loading after 15 seconds. Inspect the current page before retrying; do not repeat a submission.",
    )), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    inspect();
  });
}
