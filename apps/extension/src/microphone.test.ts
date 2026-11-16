import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureMicrophone,
  MicrophonePermissionError,
  isMicrophonePermissionError,
  microphoneErrorMessage,
  requestMicrophonePermission,
} from "./microphone";

describe("microphone permission flow", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["prompt", "denied"])("does not request microphone access from the panel when permission is %s", async (state) => {
    const getUserMedia = vi.fn();
    const query = vi.fn().mockResolvedValue({ state });
    vi.stubGlobal("navigator", { permissions: { query }, mediaDevices: { getUserMedia } });

    await expect(captureMicrophone()).rejects.toBeInstanceOf(MicrophonePermissionError);
    expect(query).toHaveBeenCalledWith({ name: "microphone" });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("captures audio from the panel once access has been granted", async () => {
    const stream = { getTracks: () => [] };
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal("navigator", {
      permissions: { query: vi.fn().mockResolvedValue({ state: "granted" }) },
      mediaDevices: { getUserMedia },
    });

    await expect(captureMicrophone()).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  });

  it("releases every microphone track immediately after setup", async () => {
    const stops = [vi.fn(), vi.fn()];
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => stops.map((stop) => ({ stop })),
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await requestMicrophonePermission();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    stops.forEach((stop) => expect(stop).toHaveBeenCalledExactlyOnceWith());
  });

  it("surfaces dismissed permissions without retrying or reporting success", async () => {
    const denied = new DOMException("Permission dismissed", "NotAllowedError");
    const getUserMedia = vi.fn().mockRejectedValue(denied);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await expect(requestMicrophonePermission()).rejects.toBe(denied);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(isMicrophonePermissionError(denied)).toBe(true);
    expect(microphoneErrorMessage(denied)).toContain("Microphone setup");
  });

  it("distinguishes hardware failures from permission failures", () => {
    const absent = new DOMException("No device", "NotFoundError");
    const busy = new DOMException("Device busy", "NotReadableError");
    expect(isMicrophonePermissionError(absent)).toBe(false);
    expect(microphoneErrorMessage(absent)).toContain("No microphone");
    expect(microphoneErrorMessage(busy)).toContain("another application");
    expect(microphoneErrorMessage(new Error("Broker unavailable"))).toBe("Broker unavailable");
  });
});
