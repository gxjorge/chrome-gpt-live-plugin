import { useState } from "react";
import { createRoot } from "react-dom/client";
import { microphoneErrorMessage, requestMicrophonePermission } from "../microphone";
import "../sidepanel/styles.css";

export function MicrophoneSetup() {
  const [state, setState] = useState<"idle" | "requesting" | "granted">("idle");
  const [error, setError] = useState("");

  async function allowMicrophone(): Promise<void> {
    setError("");
    setState("requesting");
    try {
      await requestMicrophonePermission();
      setState("granted");
    } catch (cause) {
      setState("idle");
      setError(microphoneErrorMessage(cause));
    }
  }

  return (
    <main className="permission-setup">
      <div className="eyebrow">CHROME GPT LIVE</div>
      <h1>Microphone setup</h1>
      <p>
        Chrome needs a normal browser tab to ask for microphone access.
        Click below, then choose Allow in Chrome's permission prompt.
      </p>
      <p>
        This only checks access and immediately releases the microphone.
        No audio is recorded or sent to Foundry during setup.
      </p>
      <button
        className="talk-button"
        disabled={state !== "idle"}
        onClick={() => void allowMicrophone()}
      >
        {state === "granted" ? "Microphone enabled" : state === "requesting" ? "Waiting for permission..." : "Allow microphone"}
      </button>
      {state === "granted" && (
        <p role="status">Microphone access is enabled. Close this tab, return to your article, and click Activate in the side panel.</p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <p>
        If access is blocked, open <code>chrome://settings/content/microphone</code>,
        select your microphone, and remove Chrome GPT Live from the blocked list if present.
        Also check Windows Settings &gt; Privacy &amp; security &gt; Microphone.
        Then return here and try again.
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<MicrophoneSetup />);
