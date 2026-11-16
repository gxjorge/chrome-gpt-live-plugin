import {
  browserActionSchema,
  irreversibleActionPattern,
  pageContextSchema,
  paymentPattern,
} from "@chrome-gpt-live/shared";
import { describe, expect, it } from "vitest";

describe("browser safety policy", () => {
  it("blocks payment and checkout language", () => {
    expect(paymentPattern.test("Enter credit card number")).toBe(true);
    expect(paymentPattern.test("Proceed to checkout")).toBe(true);
    expect(paymentPattern.test("Read the next paragraph")).toBe(false);
  });

  it("requires confirmation language for irreversible actions", () => {
    expect(irreversibleActionPattern.test("Publish this post")).toBe(true);
    expect(irreversibleActionPattern.test("Delete my account")).toBe(true);
    expect(irreversibleActionPattern.test("Scroll down")).toBe(false);
  });

  it("rejects malformed controller actions", () => {
    const result = browserActionSchema.safeParse({
      name: "navigate",
      arguments: { url: "javascript:alert(1)" },
    });
    expect(result.success).toBe(false);
  });

  it("only navigates to web URLs even though local PDFs can be read", () => {
    expect(browserActionSchema.safeParse({ name: "navigate", arguments: { url: "file:///C:/docs/a.pdf" } }).success).toBe(false);
    const page = {
      url: "file:///C:/docs/a.pdf#page=2",
      title: "a.pdf",
      description: "",
      byline: "",
      excerpt: "[Page 1]\nHello",
      headings: [],
      links: [],
      citations: [{ id: "pdf-p1-1", text: "Hello", page: 1 }],
      controls: [],
      document: { type: "pdf", pageCount: 3, truncated: false },
      capturedAt: new Date().toISOString(),
    };
    expect(pageContextSchema.parse(page)).toEqual(page);
    expect(pageContextSchema.safeParse({ ...page, url: "javascript:alert(1)" }).success).toBe(false);
    expect(pageContextSchema.safeParse({ ...page, citations: [{ id: "x", text: "y", page: 0 }] }).success).toBe(false);
  });
});
