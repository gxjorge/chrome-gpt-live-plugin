import { pageContextSchema } from "@chrome-gpt-live/shared";
import { describe, expect, it } from "vitest";
import {
  buildPdfPageContext,
  fileNameFromUrl,
  fragmentQuote,
  locatePdfPassage,
  pdfViewerUrl,
  type PdfDocumentData,
} from "./pdfContext";

const now = new Date("2026-01-01T00:00:00.000Z");

function pdf(overrides: Partial<PdfDocumentData> = {}): PdfDocumentData {
  return {
    url: "https://example.com/files/report%20final.pdf",
    title: "",
    author: "Ada Lovelace",
    subject: "Annual results",
    pageCount: 3,
    pages: [
      ["Annual report", "", "Revenue grew by 12 percent in the third quarter."],
      ["Methodology", "We surveyed 400 customers across five regions."],
      ["Appendix", "Contact the finance team for raw data."],
    ],
    outline: [{ title: "Methodology", level: 1, page: 2 }, { title: "Deep", level: 9 }],
    links: [{ text: "https://example.com/raw", href: "https://example.com/raw" }],
    truncated: false,
    ...overrides,
  };
}

describe("buildPdfPageContext", () => {
  it("maps extracted PDF text into a valid page context with page-numbered citations", () => {
    const page = buildPdfPageContext(pdf(), "https://example.com/files/report%20final.pdf#page=2", undefined, now);

    expect(pageContextSchema.parse(page)).toEqual(page);
    expect(page).toMatchObject({
      url: "https://example.com/files/report%20final.pdf#page=2",
      title: "report final.pdf",
      byline: "Ada Lovelace",
      description: "Annual results",
      controls: [],
      document: { type: "pdf", pageCount: 3, truncated: false },
      capturedAt: now.toISOString(),
      headings: [{ level: 1, text: "Methodology (page 2)" }, { level: 6, text: "Deep" }],
    });
    expect(page.citations.map((citation) => [citation.id, citation.page])).toEqual([
      ["pdf-p1-1", 1],
      ["pdf-p2-1", 2],
      ["pdf-p3-1", 3],
    ]);
    expect(page.excerpt).toContain("[Page 2]\nMethodology We surveyed 400 customers");
  });

  it("ranks citations by query and labels excerpt lines with page numbers", () => {
    const page = buildPdfPageContext(pdf(), "https://example.com/a.pdf", "customers regions", now);

    expect(page.citations).toHaveLength(1);
    expect(page.citations[0]).toMatchObject({ id: "pdf-p2-1", page: 2 });
    expect(page.excerpt).toBe(`[Page 2] ${page.citations[0]!.text}`);
  });

  it("explains scanned and truncated PDFs", () => {
    const page = buildPdfPageContext(pdf({ title: "Scan", subject: "", pages: [[], []], pageCount: 500, truncated: true }), "file:///C:/scan.pdf", undefined, now);

    expect(page.title).toBe("Scan");
    expect(page.citations).toEqual([]);
    expect(page.description).toContain("inspect_viewport");
    expect(page.description).toContain("first 2 of 500 pages");
    expect(page.document).toEqual({ type: "pdf", pageCount: 500, truncated: true });
  });

  it("splits long pages into bounded passages", () => {
    const sentence = "This sentence is part of a long paragraph about PDF extraction.";
    const page = buildPdfPageContext(pdf({ pages: [[Array.from({ length: 40 }, () => sentence).join(" ")]], pageCount: 1 }), "https://example.com/a.pdf", undefined, now);

    expect(page.citations.length).toBeGreaterThan(3);
    expect(page.citations.every((citation) => citation.text.length <= 500)).toBe(true);
    expect(page.citations.map((citation) => citation.id).slice(0, 2)).toEqual(["pdf-p1-1", "pdf-p1-2"]);
  });
});

describe("locatePdfPassage", () => {
  it("uses the cited passage and requested text", () => {
    expect(locatePdfPassage(pdf(), { citationId: "pdf-p2-1", text: "400 customers" })).toEqual({
      page: 2,
      text: "Methodology We surveyed 400 customers across five regions.",
      citationId: "pdf-p2-1",
      quote: "400 customers",
      matched: true,
    });
  });

  it("quotes the first line when only a citation is given", () => {
    expect(locatePdfPassage(pdf(), { citationId: "pdf-p3-1" })).toMatchObject({ page: 3, quote: "Appendix", matched: true });
  });

  it("finds text on another page when the citation does not contain it", () => {
    expect(locatePdfPassage(pdf(), { citationId: "pdf-p1-1", text: "finance team" })).toMatchObject({ page: 3, citationId: "pdf-p3-1", matched: true });
  });

  it("matches text across line breaks and typographic quotes", () => {
    const document = pdf({ pages: [["The \u201cbest\u201d results", "came from region one."]], pageCount: 1 });

    expect(locatePdfPassage(document, { text: "\"best\" results came from" })).toMatchObject({ page: 1, matched: true });
  });

  it("falls back to the cited page when the text is not found", () => {
    expect(locatePdfPassage(pdf(), { citationId: "pdf-p2-1", text: "not in the document" })).toMatchObject({ page: 2, matched: false });
    expect(locatePdfPassage(pdf(), { citationId: "pdf-p3-9" })).toEqual({ page: 3, text: "", matched: false });
    expect(locatePdfPassage(pdf(), { citationId: "pdf-p9-1" })).toBeUndefined();
    expect(locatePdfPassage(pdf(), { text: "missing" })).toBeUndefined();
  });
});

describe("PDF viewer URLs", () => {
  it("builds page and text-fragment URLs without the old fragment", () => {
    expect(pdfViewerUrl("https://example.com/a.pdf#page=1", 3)).toBe("https://example.com/a.pdf#page=3");
    expect(pdfViewerUrl("file:///C:/docs/a.pdf", 2, "state-of-the-art results, 2024")).toBe(
      "file:///C:/docs/a.pdf#page=2:~:text=state%2Dof%2Dthe%2Dart%20results%2C%202024",
    );
  });

  it("keeps fragment quotes short and drops partial trailing words", () => {
    expect(fragmentQuote("  Revenue   grew,  ")).toBe("Revenue grew");
    expect(fragmentQuote("The results are discussed in the follow-")).toBe("The results are discussed in the");
    expect(fragmentQuote("ab")).toBeUndefined();
    const quote = fragmentQuote("word ".repeat(40));
    expect(quote!.length).toBeLessThanOrEqual(80);
    expect(quote!.endsWith("word")).toBe(true);
  });

  it("reads file names from URLs", () => {
    expect(fileNameFromUrl("file:///C:/My%20Docs/plan.pdf")).toBe("plan.pdf");
    expect(fileNameFromUrl("not a url")).toBe("");
  });
});
