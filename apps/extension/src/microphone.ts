export class MicrophonePermissionError extends Error {
  constructor() {
    super("Enable microphone access in the Microphone setup tab, then return to your article and click Activate.");
    this.name = "MicrophonePermissionError";
  }
}

export function isMicrophonePermissionError(cause: unknown): boolean {
  return cause instanceof Error && [
    "MicrophonePermissionError",
    "NotAllowedError",
    "PermissionDeniedError",
  ].includes(cause.name);
}

export function microphoneErrorMessage(cause: unknown): string {
  if (isMicrophonePermissionError(cause)) {
    return "Microphone access was not granted. Open Microphone setup and allow access there. If it is blocked, check Chrome's microphone settings and Windows Settings > Privacy & security > Microphone.";
  }
  if (cause instanceof Error && cause.name === "NotFoundError") {
    return "No microphone was found. Connect a microphone and select it in Chrome's microphone settings.";
  }
  if (cause instanceof Error && cause.name === "NotReadableError") {
    return "Chrome could not open the microphone. Check Windows microphone access and whether another application is using the device.";
  }
  return cause instanceof Error ? cause.message : "Could not access the microphone.";
}

export async function captureMicrophone(): Promise<MediaStream> {
  const permission = await navigator.permissions.query({ name: "microphone" });
  if (permission.state !== "granted") {
    // Chrome can dismiss permission prompts from side panels. Prompt in a normal tab instead.
    throw new MicrophonePermissionError();
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
}

export async function requestMicrophonePermission(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
}
