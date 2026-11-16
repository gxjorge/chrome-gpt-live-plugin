import type { getDocument as GetDocument, PDFDocumentProxy } from "pdfjs-dist";
import { MAX_PDF_PAGES, type PdfDocumentData, type PdfOutlineEntry } from "./pdfContext";

type ExtractOptions = { cMapUrl?: string; maxPages?: number; signal?: AbortSignal };
type OutlineNode = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];

const MAX_OUTLINE_ENTRIES = 40;
const MAX_LINKS = 80;

export async function extractPdfDocument(
  getDocument: typeof GetDocument,
  data: Uint8Array,
  url: string,
  options: ExtractOptions = {},
): Promise<PdfDocumentData> {
  const task = getDocument({
    data,
    ...(options.cMapUrl ? { cMapUrl: options.cMapUrl, cMapPacked: true } : {}),
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  const abort = () => void task.destroy();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const pdf = await task.promise;
    const maxPages = options.maxPages ?? MAX_PDF_PAGES;
    const pageLimit = Math.min(pdf.numPages, maxPages);
    const pages: string[][] = [];
    const links: PdfDocumentData["links"] = [];
    for (let number = 1; number <= pageLimit; number++) {
      options.signal?.throwIfAborted();
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      pages.push(linesFromItems(content.items));
      if (links.length < MAX_LINKS) {
        for (const annotation of await page.getAnnotations().catch(() => [])) {
          const href = (annotation as { subtype?: unknown; url?: unknown }).url;
          if ((annotation as { subtype?: unknown }).subtype === "Link" && typeof href === "string" && /^https?:/i.test(href) &&
            links.length < MAX_LINKS && !links.some((link) => link.href === href)) {
            links.push({ text: href, href });
          }
        }
      }
      page.cleanup();
    }
    const [metadata, outline] = await Promise.all([
      pdf.getMetadata().catch(() => undefined),
      readOutline(pdf).catch(() => []),
    ]);
    const info = (metadata?.info ?? {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    return {
      url,
      title: text(metadata?.metadata?.get("dc:title")) || text(info.Title),
      author: text(info.Author),
      subject: text(info.Subject),
      pageCount: pdf.numPages,
      pages,
      outline,
      links,
      truncated: pdf.numPages > pageLimit,
    };
  } catch (cause) {
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    throw cause;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await task.destroy();
  }
}

function linesFromItems(items: readonly unknown[]): string[] {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    if (typeof item !== "object" || item === null || !("str" in item) || typeof item.str !== "string") continue;
    line += item.str;
    if ("hasEOL" in item && item.hasEOL) {
      lines.push(line);
      line = "";
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function readOutline(pdf: PDFDocumentProxy): Promise<PdfOutlineEntry[]> {
  const entries: PdfOutlineEntry[] = [];
  const visit = async (nodes: OutlineNode[], level: number) => {
    for (const node of nodes) {
      if (entries.length >= MAX_OUTLINE_ENTRIES) return;
      const page = await destinationPage(pdf, node.dest);
      entries.push({ title: node.title, level, ...(page ? { page } : {}) });
      if (node.items?.length) await visit(node.items, level + 1);
    }
  };
  await visit((await pdf.getOutline()) ?? [], 1);
  return entries;
}

async function destinationPage(pdf: PDFDocumentProxy, destination: unknown): Promise<number | undefined> {
  try {
    const explicit = typeof destination === "string" ? await pdf.getDestination(destination) : destination;
    if (!Array.isArray(explicit)) return undefined;
    const target: unknown = explicit[0];
    const index = typeof target === "number"
      ? target
      : await pdf.getPageIndex(target as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
    return index + 1;
  } catch {
    return undefined;
  }
}
