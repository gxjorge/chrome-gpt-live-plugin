import type { PageContext } from "@chrome-gpt-live/shared";
import { buildPdfPageContext, locatePdfPassage, stripFragment, type PdfDocumentData, type PdfLocation } from "./pdfContext";

export const MAX_PDF_BYTES = 50 * 1024 * 1024;
const CACHE_SIZE = 3;
const CACHE_TTL_MS = 10 * 60 * 1000;
const EXTRACT_TIMEOUT_MS = 15000;
const INSPECT_HINT = "Use inspect_viewport to read the visible part of the PDF instead.";

export type PdfRequest =
  | { type: "PDF_CONTEXT"; url: string; query?: string }
  | { type: "PDF_LOCATE"; url: string; citationId?: string | undefined; text?: string | undefined };

export type PdfResponse =
  | { ok: true; page: PageContext }
  | { ok: true; location: PdfLocation }
  | { ok: false; error: string };

export type PdfServiceDeps = {
  fetch: typeof fetch;
  extract: (data: Uint8Array, url: string, signal: AbortSignal) => Promise<PdfDocumentData>;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
};

type CacheEntry = { promise: Promise<PdfDocumentData>; loadedAt: number };

export function createPdfService(deps: PdfServiceDeps) {
  const cache = new Map<string, CacheEntry>();
  const now = deps.now ?? Date.now;

  const load = (url: string): Promise<PdfDocumentData> => {
    const key = stripFragment(url);
    const cached = cache.get(key);
    if (cached && now() - cached.loadedAt < CACHE_TTL_MS) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.promise;
    }
    const promise = loadDocument(key, deps);
    const entry = { promise, loadedAt: now() };
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > CACHE_SIZE) {
      cache.delete(cache.keys().next().value!);
    }
    promise.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    return promise;
  };

  return {
    async handle(request: PdfRequest): Promise<PdfResponse> {
      try {
        const document = await load(request.url);
        if (request.type === "PDF_CONTEXT") {
          return { ok: true, page: buildPdfPageContext(document, request.url, request.query, new Date(now())) };
        }
        const location = locatePdfPassage(document, { citationId: request.citationId, text: request.text });
        return location
          ? { ok: true, location }
          : { ok: false, error: "That passage was not found in this PDF. Call get_page_context with a query to find it first." };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

async function loadDocument(url: string, deps: PdfServiceDeps): Promise<PdfDocumentData> {
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new PdfError(`Reading the PDF took longer than ${Math.round(timeoutMs / 1000)} seconds. ${INSPECT_HINT}`)), timeoutMs);
  try {
    const data = await fetchPdfBytes(url, deps.fetch, controller.signal, deps.maxBytes ?? MAX_PDF_BYTES);
    return await deps.extract(data, url, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPdfBytes(url: string, fetcher: typeof fetch, signal: AbortSignal, maxBytes = MAX_PDF_BYTES): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetcher(url, { credentials: "include", signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new PdfError(`The PDF could not be downloaded (${error instanceof Error ? error.message : String(error)}). ${INSPECT_HINT}`);
  }
  if (!response.ok && response.status !== 0) {
    throw new PdfError(`The PDF could not be downloaded (HTTP ${response.status}). ${INSPECT_HINT}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) throw tooLarge(maxBytes);

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } else {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw tooLarge(maxBytes);
    chunks.push(buffer);
    total = buffer.byteLength;
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!hasPdfHeader(data)) {
    throw new PdfError(`This tab does not contain a readable PDF file. ${INSPECT_HINT}`);
  }
  return data;
}

function hasPdfHeader(data: Uint8Array): boolean {
  // PDF readers accept the %PDF- marker anywhere in the first 1 KB.
  const head = new TextDecoder("latin1").decode(data.subarray(0, 1024));
  return head.includes("%PDF-");
}

function tooLarge(maxBytes: number): PdfError {
  return new PdfError(`This PDF is larger than ${Math.round(maxBytes / 1024 / 1024)} MB, so its text was not read. ${INSPECT_HINT}`);
}

function errorMessage(error: unknown): string {
  if (error instanceof PdfError) return error.message;
  const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  if (name === "PasswordException") {
    return `This PDF is password-protected, so its text cannot be read. ${INSPECT_HINT}`;
  }
  if (name === "InvalidPDFException" || name === "FormatError") {
    return `This PDF appears to be damaged or unsupported. ${INSPECT_HINT}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `The PDF text could not be read: ${message}. ${INSPECT_HINT}`;
}

export class PdfError extends Error {
  override name = "PdfError";
}
