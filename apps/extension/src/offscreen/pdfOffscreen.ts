import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { OffscreenMessage } from "../messages";
import { extractPdfDocument } from "../pdf/pdfExtractor";
import { createPdfService } from "../pdf/pdfService";

GlobalWorkerOptions.workerSrc = workerUrl;

const service = createPdfService({
  fetch: (input, init) => fetch(input, init),
  extract: (data, url, signal) =>
    extractPdfDocument(getDocument, data, url, { cMapUrl: chrome.runtime.getURL("pdfjs/cmaps/"), signal }),
});

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }
  void service.handle(message.request).then(sendResponse);
  return true;
});
