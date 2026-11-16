import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it, vi } from "vitest";
import { extractPdfDocument } from "./pdfExtractor";
import { makeTestPdf } from "./testPdf";

const getDocumentForTests = getDocument as unknown as Parameters<typeof extractPdfDocument>[0];

describe("extractPdfDocument", () => {
  it("extracts lines, metadata, links, and outline pages with pdf.js", async () => {
    const data = makeTestPdf(
      [
        ["Quarterly report", "Revenue grew by 12 percent in the third quarter."],
        ["Appendix", "Methodology (draft) and sources."],
      ],
      {
        title: "Q3 Report",
        author: "Finance Team",
        links: [{ page: 1, url: "https://example.com/details" }],
        outline: [{ title: "Summary", page: 1 }, { title: "Appendix", page: 2 }],
      },
    );

    const document = await extractPdfDocument(getDocumentForTests, data, "https://example.com/q3.pdf");

    expect(document).toMatchObject({
      url: "https://example.com/q3.pdf",
      title: "Q3 Report",
      author: "Finance Team",
      pageCount: 2,
      truncated: false,
      links: [{ text: "https://example.com/details", href: "https://example.com/details" }],
      outline: [
        { title: "Summary", level: 1, page: 1 },
        { title: "Appendix", level: 1, page: 2 },
      ],
    });
    expect(document.pages[0]?.join(" ")).toContain("Revenue grew by 12 percent in the third quarter.");
    expect(document.pages[1]?.join(" ")).toContain("Methodology (draft) and sources.");
  });

  it("stops at the page limit and reports truncation", async () => {
    const data = makeTestPdf([["One"], ["Two"], ["Three"]]);

    const document = await extractPdfDocument(getDocumentForTests, data, "file:///C:/docs/a.pdf", { maxPages: 2 });

    expect(document.pageCount).toBe(3);
    expect(document.pages).toHaveLength(2);
    expect(document.truncated).toBe(true);
  });

  it("rejects with the abort reason when cancelled", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    controller.abort(reason);

    await expect(
      extractPdfDocument(getDocumentForTests, makeTestPdf([["One"]]), "https://example.com/a.pdf", { signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it("reads nested outline entries and named destinations from pdf.js", async () => {
    const page = {
      getTextContent: vi.fn(async () => ({ items: [{ str: "Hello", hasEOL: false }, { str: " world", hasEOL: true }, { str: "Next" }] })),
      getAnnotations: vi.fn(async () => [
        { subtype: "Link", url: "https://example.com/a" },
        { subtype: "Link", url: "https://example.com/a" },
        { subtype: "Link", url: "mailto:someone@example.com" },
        { subtype: "Text" },
      ]),
      cleanup: vi.fn(),
    };
    const pageRef = { num: 9, gen: 0 };
    const pdf = {
      numPages: 3,
      getPage: vi.fn(async () => page),
      getMetadata: vi.fn(async () => ({ info: { Title: "Info title", Subject: "Specs" }, metadata: { get: () => "XMP title" } })),
      getOutline: vi.fn(async () => [
        { title: "Intro", dest: [0], items: [{ title: "Details", dest: "named", items: [] }] },
        { title: "Broken", dest: null, items: [] },
      ]),
      getDestination: vi.fn(async () => [pageRef]),
      getPageIndex: vi.fn(async () => 2),
    };
    const destroy = vi.fn(async () => undefined);
    const fakeGetDocument = vi.fn(() => ({ promise: Promise.resolve(pdf), destroy }));

    const document = await extractPdfDocument(fakeGetDocument as never, new Uint8Array(), "https://example.com/a.pdf", {
      cMapUrl: "chrome-extension://id/pdfjs/cmaps/",
    });

    expect(fakeGetDocument).toHaveBeenCalledWith(expect.objectContaining({ cMapUrl: "chrome-extension://id/pdfjs/cmaps/", cMapPacked: true }));
    expect(document.pages[0]).toEqual(["Hello world", "Next"]);
    expect(document.title).toBe("XMP title");
    expect(document.subject).toBe("Specs");
    expect(document.links).toEqual([{ text: "https://example.com/a", href: "https://example.com/a" }]);
    expect(document.outline).toEqual([
      { title: "Intro", level: 1, page: 1 },
      { title: "Details", level: 2, page: 3 },
      { title: "Broken", level: 1 },
    ]);
    expect(pdf.getPageIndex).toHaveBeenCalledWith(pageRef);
    expect(page.cleanup).toHaveBeenCalledTimes(3);
    expect(destroy).toHaveBeenCalled();
  });
});
