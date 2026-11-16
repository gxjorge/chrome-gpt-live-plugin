import { describe, expect, it, vi } from "vitest";
import type { PdfDocumentData } from "./pdfContext";
import { createPdfService, fetchPdfBytes } from "./pdfService";

const pdfBytes = new TextEncoder().encode("%PDF-1.4\n...");

function document(url: string): PdfDocumentData {
  return {
    url,
    title: "Doc",
    author: "",
    subject: "",
    pageCount: 1,
    pages: [["Hello PDF readers, this is page one."]],
    outline: [],
    links: [],
    truncated: false,
  };
}

function setup(overrides: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {}) {
  const fetcher = overrides.fetch ?? vi.fn(async () => new Response(pdfBytes, { status: 200 }));
  const extract = vi.fn(async (_data: Uint8Array, url: string, _signal: AbortSignal) => document(url));
  const service = createPdfService({ fetch: fetcher, extract, ...(overrides.now ? { now: overrides.now } : {}), ...(overrides.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {}) });
  return { service, fetcher, extract };
}

describe("createPdfService", () => {
  it("returns page context and passage locations from one cached download", async () => {
    const { service, fetcher, extract } = setup();

    const context = await service.handle({ type: "PDF_CONTEXT", url: "https://example.com/a.pdf#page=1", query: "readers" });
    const location = await service.handle({ type: "PDF_LOCATE", url: "https://example.com/a.pdf#page=4", citationId: "pdf-p1-1" });

    expect(context).toMatchObject({ ok: true, page: { url: "https://example.com/a.pdf#page=1", title: "Doc", citations: [{ id: "pdf-p1-1", page: 1 }] } });
    expect(location).toMatchObject({ ok: true, location: { page: 1, citationId: "pdf-p1-1", matched: true } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("https://example.com/a.pdf", expect.objectContaining({ credentials: "include" }));
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent reads and expires old entries", async () => {
    let time = 0;
    const { service, fetcher } = setup({ now: () => time });

    await Promise.all([
      service.handle({ type: "PDF_CONTEXT", url: "https://example.com/a.pdf" }),
      service.handle({ type: "PDF_CONTEXT", url: "https://example.com/a.pdf" }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);

    time = 11 * 60 * 1000;
    await service.handle({ type: "PDF_CONTEXT", url: "https://example.com/a.pdf" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps only the most recent documents", async () => {
    const { service, fetcher } = setup();

    for (const name of ["a", "b", "c", "d", "a"]) {
      await service.handle({ type: "PDF_CONTEXT", url: `https://example.com/${name}.pdf` });
    }

    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("retries after a failed read", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("nope", { status: 404 }))
      .mockResolvedValueOnce(new Response(pdfBytes, { status: 200 }));
    const { service } = setup({ fetch: fetcher });

    await expect(service.handle({ type: "PDF_CONTEXT", url: "https://example.com/a.pdf" })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("HTTP 404"),
    });
    await expect(service.handle({ type: "PDF_CONTEXT", url: "https://example.com/a.pdf" })).resolves.toMatchObject({ ok: true });
  });

  it("explains missing passages, password protection, and timeouts", async () => {
    const { service, extract } = setup({ timeoutMs: 20 });

    await expect(service.handle({ type: "PDF_LOCATE", url: "https://example.com/a.pdf", text: "absent" })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("get_page_context"),
    });

    extract.mockRejectedValueOnce(Object.assign(new Error("No password given"), { name: "PasswordException" }));
    await expect(service.handle({ type: "PDF_CONTEXT", url: "https://example.com/locked.pdf" })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("password-protected"),
    });

    extract.mockImplementationOnce((_data, _url, signal) => new Promise<PdfDocumentData>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    await expect(service.handle({ type: "PDF_CONTEXT", url: "https://example.com/slow.pdf" })).resolves.toEqual({
      ok: false,
      error: expect.stringContaining("took longer than"),
    });
  });
});

describe("fetchPdfBytes", () => {
  const signal = new AbortController().signal;

  it("accepts PDF bytes from local files and web servers", async () => {
    const fetcher = vi.fn(async () => new Response(pdfBytes, { status: 200 }));

    await expect(fetchPdfBytes("file:///C:/a.pdf", fetcher, signal)).resolves.toEqual(pdfBytes);
  });

  it("rejects non-PDF and oversized responses", async () => {
    await expect(fetchPdfBytes("https://example.com/a", vi.fn(async () => new Response("<html>")), signal)).rejects.toThrow("readable PDF");
    await expect(
      fetchPdfBytes("https://example.com/a.pdf", vi.fn(async () => new Response(pdfBytes, { headers: { "content-length": "999" } })), signal, 10),
    ).rejects.toThrow("larger than");
    await expect(
      fetchPdfBytes("https://example.com/a.pdf", vi.fn(async () => new Response(new Uint8Array(32))), signal, 10),
    ).rejects.toThrow("larger than");
  });

  it("reports network failures", async () => {
    await expect(
      fetchPdfBytes("https://example.com/a.pdf", vi.fn(async () => { throw new TypeError("Failed to fetch"); }), signal),
    ).rejects.toThrow("could not be downloaded (Failed to fetch)");
  });
});
