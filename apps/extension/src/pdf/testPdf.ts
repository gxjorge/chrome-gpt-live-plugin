/** Builds a small text PDF for tests. Lines use Helvetica so pdf.js can extract them without font files. */
export function makeTestPdf(
  pages: string[][],
  options: {
    title?: string;
    author?: string;
    links?: { page: number; url: string }[];
    outline?: { title: string; page: number }[];
  } = {},
): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  const escape = (text: string) => text.replace(/[\\()]/g, (character) => `\\${character}`);
  const catalogId = add("");
  const pagesId = add("");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const infoId = add(`<< /Title (${escape(options.title ?? "Test PDF")}) /Author (${escape(options.author ?? "Test author")}) >>`);
  const pageIds = pages.map((lines, index) => {
    const stream = ["BT", "/F1 12 Tf", "14 TL", "72 740 Td", ...lines.map((line) => `(${escape(line)}) Tj T*`), "ET"].join("\n");
    const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const annotIds = (options.links ?? [])
      .filter((link) => link.page === index + 1)
      .map((link) => add(`<< /Type /Annot /Subtype /Link /Rect [72 700 300 720] /Border [0 0 0] /A << /S /URI /URI (${escape(link.url)}) >> >>`));
    const annots = annotIds.length ? ` /Annots [${annotIds.map((id) => `${id} 0 R`).join(" ")}]` : "";
    return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R${annots} >>`);
  });
  let outlines = "";
  if (options.outline?.length) {
    const outlinesId = add("");
    const firstItemId = objects.length + 1;
    options.outline.forEach((item, index) => {
      const id = firstItemId + index;
      const links = [
        index > 0 ? `/Prev ${id - 1} 0 R` : "",
        index < options.outline!.length - 1 ? `/Next ${id + 1} 0 R` : "",
      ].join(" ");
      add(`<< /Title (${escape(item.title)}) /Parent ${outlinesId} 0 R ${links} /Dest [${pageIds[item.page - 1]} 0 R /XYZ 0 792 0] >>`);
    });
    objects[outlinesId - 1] = `<< /Type /Outlines /First ${firstItemId} 0 R /Last ${objects.length} 0 R /Count ${options.outline.length} >>`;
    outlines = ` /Outlines ${outlinesId} 0 R`;
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R${outlines} >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(output, (character) => character.charCodeAt(0));
}
