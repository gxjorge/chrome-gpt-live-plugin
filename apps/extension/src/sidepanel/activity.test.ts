import type { PageContext } from "@chrome-gpt-live/shared";
import { describe, expect, it } from "vitest";
import { pageLabel } from "./activity";

const page: PageContext = {
  url: "https://example.com/article", title: "Article", description: "", byline: "", excerpt: "",
  headings: [], links: [], citations: [], capturedAt: "2026-09-23T00:00:00Z",
};

describe("pageLabel", () => {
  it("labels websites by host and PDFs by page count and source", () => {
    expect(pageLabel(page)).toBe("example.com");
    expect(pageLabel({ ...page, url: "https://example.com/a.pdf", document: { type: "pdf", pageCount: 12, truncated: false } }))
      .toBe("PDF · 12 pages · example.com");
    expect(pageLabel({ ...page, url: "file:///C:/Docs/a.pdf", document: { type: "pdf", pageCount: 1, truncated: false } }))
      .toBe("PDF · 1 page · Local file");
  });
});
