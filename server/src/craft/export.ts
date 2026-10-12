/**
 * Markdown → DOCX / PPTX export — the phase-2 port of onyx `session/md_to_docx.py`
 * (plus a small md→pptx export; see the divergence note on `exportPptx`).
 *
 * onyx parses with mistune and writes with python-docx; here `marked.lexer` supplies the
 * token tree and the `docx` / `pptxgenjs` packages write the archives. The fidelity is
 * structural (headings, paragraphs, lists, code, blockquotes, tables, horizontal rules,
 * inline bold/italic/strike/code/links/images/<br>) rather than pixel-matching pandoc's
 * reference.docx — that byte-level styling is a documented difference in the port plan.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  type IParagraphOptions,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import { marked, type Token, type Tokens } from "marked";
import PptxGenJS from "pptxgenjs";

const MONOSPACE_FONT = "Courier New";
const CODE_SIZE_HALF_POINTS = 18; // 9pt

const HEADING_LEVELS: (typeof HeadingLevel)[keyof typeof HeadingLevel][] = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

type Fmt = {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
};

const PLAIN = (): Fmt => ({
  bold: false,
  italic: false,
  strike: false,
  code: false,
});

/** Flatten inline tokens to plain text (link labels, image alt text). */
function collectText(tokens: Token[] | undefined): string {
  let out = "";
  for (const token of tokens ?? []) {
    if (
      token.type === "text" ||
      token.type === "escape" ||
      token.type === "codespan"
    ) {
      out += token.text;
    } else if ("tokens" in token) {
      out += collectText(token.tokens);
    }
  }
  return out;
}

/** Render inline tokens into docx TextRuns, carrying bold/italic/strike/code down. */
function inlineRuns(
  tokens: Token[] | undefined,
  fmt: Fmt,
  out: TextRun[],
): void {
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text":
      case "escape":
        out.push(
          new TextRun({
            text: token.text,
            bold: fmt.bold,
            italics: fmt.italic,
          }),
        );
        break;
      case "strong":
        inlineRuns(token.tokens, { ...fmt, bold: true }, out);
        break;
      case "em":
        inlineRuns(token.tokens, { ...fmt, italic: true }, out);
        break;
      case "del":
        inlineRuns(token.tokens, { ...fmt, strike: true }, out);
        break;
      case "codespan":
        out.push(
          new TextRun({
            text: token.text,
            bold: fmt.bold,
            font: { name: MONOSPACE_FONT },
          }),
        );
        break;
      case "link":
        out.push(
          new TextRun({
            text: collectText(token.tokens) || token.href || "",
            italics: fmt.italic,
          }),
        );
        break;
      case "image": {
        const alt = collectText(token.tokens);
        out.push(
          new TextRun({
            text: alt ? `[image: ${alt}]` : "[image]",
            italics: true,
          }),
        );
        break;
      }
      case "br":
        out.push(new TextRun({ text: "", break: 1 }));
        break;
      case "html":
        if (/<br\s*\/?>/i.test(token.text))
          out.push(new TextRun({ text: "", break: 1 }));
        break;
      default:
        if ("tokens" in token && token.tokens)
          inlineRuns(token.tokens, fmt, out);
        else if ("text" in token) {
          out.push(
            new TextRun({
              text: token.text,
              bold: fmt.bold,
              italics: fmt.italic,
            }),
          );
        }
    }
  }
}

/** Build a styled paragraph from inline tokens. */
function paragraphFrom(
  tokens: Token[],
  options: Partial<IParagraphOptions> = {},
): Paragraph {
  const runs: TextRun[] = [];
  inlineRuns(tokens, PLAIN(), runs);
  return new Paragraph({
    children: runs.length ? runs : [new TextRun({ text: "" })],
    ...options,
  });
}

/** A code block as one paragraph, one monospace run per line. */
function codeParagraph(raw: string): Paragraph {
  const text = raw.replace(/\n$/, "");
  if (text === "") {
    return new Paragraph({
      children: [
        new TextRun({
          text: "",
          font: { name: MONOSPACE_FONT },
          size: CODE_SIZE_HALF_POINTS,
        }),
      ],
      spacing: { before: 120, after: 120 },
    });
  }
  const lines = text.split("\n");
  return new Paragraph({
    children: lines.map(
      (line, index) =>
        new TextRun({
          text: line,
          font: { name: MONOSPACE_FONT },
          size: CODE_SIZE_HALF_POINTS,
          break: index === 0 ? undefined : 1,
        }),
    ),
    spacing: { before: 120, after: 120 },
  });
}

/** A GFM table → a borderless docx Table (only the header row is underlined via bold). */
function renderTable(token: Tokens.Table): Table | null {
  const headerCells = token.header ?? [];
  const bodyRows = token.rows ?? [];
  const numCols = headerCells.length || bodyRows[0]?.length || 0;
  if (numCols === 0) return null;

  const toCell = (cell: Tokens.TableCell, bold: boolean): TableCell => {
    const runs: TextRun[] = [];
    inlineRuns(cell.tokens ?? [], { ...PLAIN(), bold }, runs);
    const alignment =
      cell.align === "center"
        ? AlignmentType.CENTER
        : cell.align === "right"
          ? AlignmentType.RIGHT
          : AlignmentType.LEFT;
    return new TableCell({
      children: [
        new Paragraph({
          children: runs.length ? runs : [new TextRun({ text: "" })],
          alignment,
        }),
      ],
    });
  };

  const rows: TableRow[] = [];
  if (headerCells.length) {
    rows.push(
      new TableRow({
        tableHeader: true,
        children: headerCells.map((cell) => toCell(cell, true)),
      }),
    );
  }
  for (const row of bodyRows) {
    rows.push(
      new TableRow({
        children: row.slice(0, numCols).map((cell) => toCell(cell, false)),
      }),
    );
  }
  return new Table({
    rows,
    borders: {
      top: { style: BorderStyle.NONE, size: 0, color: "auto" },
      bottom: { style: BorderStyle.NONE, size: 0, color: "auto" },
      left: { style: BorderStyle.NONE, size: 0, color: "auto" },
      right: { style: BorderStyle.NONE, size: 0, color: "auto" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "auto" },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: "auto" },
    },
  });
}

/** Recursively render a list into paragraphs (bullets via style level, numbers inline). */
function renderList(
  token: Tokens.List,
  out: (Paragraph | Table)[],
  depth = 0,
): void {
  const start = typeof token.start === "number" ? token.start : 1;
  let counter = start;
  for (const item of token.items ?? []) {
    if (item.type !== "list_item") continue;
    let renderedMarker = false;
    for (const child of item.tokens ?? []) {
      if (child.type === "space") continue;
      if (child.type === "list") {
        renderList(child as Tokens.List, out, depth + 1);
        continue;
      }
      const runs: TextRun[] = [];
      if (!renderedMarker) {
        if (token.ordered) {
          runs.push(new TextRun({ text: `${counter}.  ` }));
          counter += 1;
        } else {
          runs.push(new TextRun({ text: "•  " }));
        }
        renderedMarker = true;
      }
      const childTokens = child.type === "paragraph" ? child.tokens : [child];
      inlineRuns(childTokens, PLAIN(), runs);
      out.push(
        new Paragraph({
          children: runs.length ? runs : [new TextRun({ text: "" })],
          bullet: token.ordered ? undefined : { level: Math.min(depth, 3) },
          indent: { left: (depth + 1) * 360 },
        }),
      );
    }
  }
}

/** Top-level token stream → docx block children. */
function docxChildren(tokens: Token[]): (Paragraph | Table)[] {
  const blocks: (Paragraph | Table)[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        continue;
      case "heading": {
        const runs: TextRun[] = [];
        inlineRuns(token.tokens, PLAIN(), runs);
        blocks.push(
          new Paragraph({
            children: runs.length ? runs : [new TextRun({ text: "" })],
            heading: HEADING_LEVELS[Math.min(token.depth, 6) - 1],
          }),
        );
        break;
      }
      case "paragraph":
        blocks.push(paragraphFrom(token.tokens ?? []));
        break;
      case "code":
        blocks.push(codeParagraph(token.text));
        break;
      case "blockquote":
        for (const child of token.tokens ?? []) {
          if (child.type === "paragraph")
            blocks.push(paragraphFrom(child.tokens ?? []));
          else blocks.push(...docxChildren([child]));
        }
        break;
      case "list":
        renderList(token as Tokens.List, blocks, 0);
        break;
      case "table": {
        const table = renderTable(token as Tokens.Table);
        if (table) blocks.push(table);
        break;
      }
      case "hr":
        blocks.push(
          new Paragraph({
            children: [],
            border: {
              bottom: { style: BorderStyle.SINGLE, size: 6, color: "auto" },
            },
          }),
        );
        break;
      default:
        if ("tokens" in token && token.tokens)
          blocks.push(...docxChildren(token.tokens));
    }
  }
  return blocks;
}

/** Render Markdown text to the bytes of a .docx file. */
export async function exportDocx(markdown: string): Promise<Uint8Array> {
  const tokens = marked.lexer(markdown);
  const document = new Document({
    sections: [{ children: docxChildren(tokens) }],
  });
  const buffer = await Packer.toBuffer(document);
  return new Uint8Array(buffer);
}

// --------------------------------------------------------------------------- //
// PPTX
// --------------------------------------------------------------------------- //

/**
 * Render Markdown to a .pptx deck: `#` → title slide, `##` → section divider, other
 * headings/paragraphs/list items → bullet slides, fenced code → a monospace slide. This is an
 * OpenBot addition — onyx has no md→pptx endpoint (its agent authors .pptx via the pptx skill,
 * and its `pptx-preview` endpoint renders a finished deck to slide images). Documented divergence.
 */
export async function exportPptx(markdown: string): Promise<Uint8Array> {
  const tokens = marked.lexer(markdown);
  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_WIDE";

  // The first `#` heading is the deck title and opens slide 1; everything else
  // flows in token order so slide order mirrors the markdown.
  const title = tokens.find(
    (token) => token.type === "heading" && token.depth === 1,
  );
  if (title && title.type === "heading") {
    const titleSlide = pres.addSlide();
    titleSlide.addText(title.text, {
      x: 0.8,
      y: 2.6,
      w: 11.8,
      h: 1.4,
      fontSize: 40,
      bold: true,
    });
  }

  let slide = pres.addSlide();
  const bulletRows: { text: string; bold: boolean }[] = [];

  const flushBulletSlide = () => {
    if (bulletRows.length === 0) return;
    slide.addText(
      bulletRows.map((row) => ({
        text: row.text,
        options: { bullet: true, bold: row.bold },
      })),
      { x: 0.8, y: 0.9, w: 11.8, h: 6.0, fontSize: 20 },
    );
    bulletRows.length = 0;
  };

  for (const token of tokens) {
    switch (token.type) {
      case "heading":
        if (token.depth === 1) continue; // the title, already rendered above
        flushBulletSlide();
        if (token.depth === 2) {
          slide = pres.addSlide();
          slide.addText(token.text, {
            x: 0.8,
            y: 2.4,
            w: 11.8,
            h: 1.6,
            fontSize: 32,
            bold: true,
          });
          continue;
        }
        bulletRows.push({ text: token.text, bold: true });
        break;
      case "paragraph":
        if (token.text.trim())
          bulletRows.push({ text: token.text, bold: false });
        break;
      case "list":
        for (const item of token.items) {
          if (item.type === "list_item") {
            bulletRows.push({ text: collectText(item.tokens), bold: false });
          }
        }
        break;
      case "code":
        flushBulletSlide();
        slide = pres.addSlide();
        slide.addText(token.text.replace(/\n$/, ""), {
          x: 0.5,
          y: 0.5,
          w: 12.3,
          h: 6.5,
          fontSize: 14,
          fontFace: MONOSPACE_FONT,
        });
        break;
      case "hr":
        flushBulletSlide();
        slide = pres.addSlide();
        break;
      default:
        break;
    }
  }
  flushBulletSlide();

  const data = (await pres.write({ outputType: "nodebuffer" })) as Uint8Array;
  return data;
}
