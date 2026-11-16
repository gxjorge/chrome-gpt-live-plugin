import type { Citation, PageContext } from "@chrome-gpt-live/shared";

export const MAX_PDF_PAGES = 400;
const PASSAGE_CHARS = 500;
const MAX_EXCERPT_CHARS = 12000;
const MAX_CITATIONS = 40;
const MAX_QUOTE_CHARS = 80;

export type PdfOutlineEntry = { title: string; level: number; page?: number };

export type PdfDocumentData = {
  url: string;
  title: string;
  author: string;
  subject: string;
  pageCount: number;
  /** Text lines for each extracted page; index 0 is page 1. */
  pages: string[][];
  outline: PdfOutlineEntry[];
  links: { text: string; href: string }[];
  truncated: boolean;
};

export type PdfLocation = {
  page: number;
  text: string;
  quote?: string;
  citationId?: string;
  matched: boolean;
};

type Passage = { id: string; page: number; text: string; firstLine: string };

const passageCache = new WeakMap<PdfDocumentData, Passage[]>();

export function buildPdfPageContext(document: PdfDocumentData, url: string, query?: string, now = new Date()): PageContext {
  const passages = passagesFor(document);
  let selected = passages;
  if (query) {
    const normalized = normalizeSearchText(query);
    const terms = searchTerms(normalized);
    selected = passages
      .map((passage) => {
        const text = normalizeSearchText(passage.text);
        return { passage, score: (text.includes(normalized) ? terms.length + 1 : 0) + terms.filter((term) => text.includes(term)).length };
      })
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((match) => match.passage);
  }
  const citations: Citation[] = selected.slice(0, MAX_CITATIONS)
    .map((passage) => ({ id: passage.id, text: passage.text, page: passage.page }));
  const description = [
    cleanText(document.subject),
    passages.length ? "" : "This PDF has no extractable text; it may contain scanned images. Use inspect_viewport to read the visible page.",
    document.truncated ? `Text was read from the first ${document.pages.length} of ${document.pageCount} pages.` : "",
  ].filter(Boolean).join(" ");

  return {
    url,
    title: cleanText(document.title) || fileNameFromUrl(document.url) || "PDF document",
    description,
    byline: cleanText(document.author),
    excerpt: query
      ? citations.map((citation) => `[Page ${citation.page}] ${citation.text}`).join("\n").slice(0, MAX_EXCERPT_CHARS)
      : fullExcerpt(document),
    headings: document.outline.slice(0, 40).map((entry) => ({
      level: Math.min(6, Math.max(1, entry.level)),
      text: entry.page ? `${cleanText(entry.title)} (page ${entry.page})` : cleanText(entry.title),
    })).filter((heading) => heading.text),
    links: document.links.slice(0, 80),
    citations,
    controls: [],
    document: { type: "pdf", pageCount: document.pageCount, truncated: document.truncated },
    capturedAt: now.toISOString(),
  };
}

export function locatePdfPassage(
  document: PdfDocumentData,
  target: { citationId?: string | undefined; text?: string | undefined },
): PdfLocation | undefined {
  const passages = passagesFor(document);
  const requested = cleanText(target.text ?? "");
  const wanted = normalizeSearchText(requested);
  const cited = target.citationId ? passages.find((passage) => passage.id === target.citationId) : undefined;

  if (cited && (!wanted || normalizeSearchText(cited.text).includes(wanted))) {
    return withQuote({ page: cited.page, text: cited.text, citationId: cited.id, matched: true }, wanted ? requested : cited.firstLine);
  }
  if (wanted) {
    const passage = passages.find((candidate) => normalizeSearchText(candidate.text).includes(wanted));
    if (passage) {
      return withQuote({ page: passage.page, text: passage.text, citationId: passage.id, matched: true }, requested);
    }
    const pageIndex = document.pages.findIndex((lines) => normalizeSearchText(lines.join(" ")).includes(wanted));
    if (pageIndex >= 0) {
      return withQuote({ page: pageIndex + 1, text: requested, matched: true }, requested);
    }
  }
  if (cited) {
    return withQuote({ page: cited.page, text: cited.text, citationId: cited.id, matched: false }, cited.firstLine);
  }
  const citedPage = Number(/^pdf-p(\d+)-\d+$/.exec(target.citationId ?? "")?.[1]);
  if (citedPage >= 1 && citedPage <= document.pageCount) {
    return { page: citedPage, text: "", matched: false };
  }
  return undefined;
}

/** Builds a Chrome PDF viewer URL that opens a page and requests a text-fragment highlight. */
export function pdfViewerUrl(url: string, page: number, quote?: string): string {
  const directive = quote ? `:~:text=${encodeURIComponent(quote).replace(/-/g, "%2D")}` : "";
  return `${stripFragment(url)}#page=${page}${directive}`;
}

export function stripFragment(url: string): string {
  const index = url.indexOf("#");
  return index === -1 ? url : url.slice(0, index);
}

export function fragmentQuote(text: string): string | undefined {
  let quote = cleanText(text);
  if (quote.length > MAX_QUOTE_CHARS) {
    const cut = quote.slice(0, MAX_QUOTE_CHARS);
    const space = cut.lastIndexOf(" ");
    quote = space > 20 ? cut.slice(0, space) : cut;
  }
  // A trailing hyphenated fragment usually continues on the next line and would not match.
  quote = quote.replace(/\s+\S*-$/, "").replace(/[\s,;:]+$/, "");
  return quote.length >= 3 ? quote : undefined;
}

export function fileNameFromUrl(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(name);
  } catch {
    return "";
  }
}

export function normalizeSearchText(text: string): string {
  return cleanText(text.normalize("NFKC").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u00ad\u200b]/g, "")).toLowerCase();
}

function withQuote(location: PdfLocation, source: string): PdfLocation {
  const quote = fragmentQuote(source);
  return quote ? { ...location, quote } : location;
}

function passagesFor(document: PdfDocumentData): Passage[] {
  let passages = passageCache.get(document);
  if (!passages) {
    passages = document.pages.flatMap((lines, index) => pagePassages(lines, index + 1));
    passageCache.set(document, passages);
  }
  return passages;
}

function pagePassages(rawLines: string[], page: number): Passage[] {
  const passages: Passage[] = [];
  let current: string[] = [];
  let length = 0;
  const flush = () => {
    const text = current.join(" ");
    if (text.length >= 8) {
      passages.push({ id: `pdf-p${page}-${passages.length + 1}`, page, text, firstLine: current[0]! });
    }
    current = [];
    length = 0;
  };
  for (const line of rawLines.flatMap(splitLongLine)) {
    if (!line) {
      if (length >= 200) flush();
      continue;
    }
    if (length > 0 && length + line.length + 1 > PASSAGE_CHARS) flush();
    current.push(line);
    length += line.length + 1;
    if (length >= 300 && /[.!?:]["')\]]?$/.test(line)) flush();
  }
  flush();
  return passages;
}

function splitLongLine(raw: string): string[] {
  const line = cleanText(raw);
  if (line.length <= PASSAGE_CHARS) return [line];
  const parts: string[] = [];
  let rest = line;
  while (rest.length > PASSAGE_CHARS) {
    const space = rest.lastIndexOf(" ", PASSAGE_CHARS);
    const cut = space > PASSAGE_CHARS / 2 ? space : PASSAGE_CHARS;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function fullExcerpt(document: PdfDocumentData): string {
  let excerpt = "";
  for (const [index, lines] of document.pages.entries()) {
    const text = cleanText(lines.join(" "));
    if (!text) continue;
    excerpt += `${excerpt ? "\n\n" : ""}[Page ${index + 1}]\n${text}`;
    if (excerpt.length >= MAX_EXCERPT_CHARS) break;
  }
  return excerpt.slice(0, MAX_EXCERPT_CHARS);
}

function searchTerms(normalized: string): string[] {
  return normalized.split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1);
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
