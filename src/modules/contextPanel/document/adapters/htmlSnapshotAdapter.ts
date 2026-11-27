import type {
  DocumentAdapter,
  DocumentExtraction,
  DocumentSegment,
} from "../types";
import { fnv1aHex } from "../../../../utils/hash";
import {
  getAttachmentContentType,
  getAttachmentSourceRevision,
  getDocumentTitle,
} from "./shared";

/** Zotero stores web-page snapshots as `text/html` attachments. */
export const HTML_SNAPSHOT_CONTENT_TYPES = [
  "text/html",
  "application/xhtml+xml",
] as const;
export const HTML_SNAPSHOT_RETRY_DELAY_MS = 60_000;
export const MAX_HTML_SNAPSHOT_TEXT_CHARS = 4_000_000;
/** Segments longer than this are split so retrieval stays bounded. */
const MAX_SEGMENT_CHARS = 6_000;

const capabilities: DocumentAdapter["capabilities"] = {
  selectionText: true,
  panelChat: true,
  structuredSections: true,
  navigableLocators: false,
  screenshot: true,
  fullDocumentTranslation: false,
};

/** One run of readable text, optionally introduced by a heading. */
export type HtmlTextBlock = {
  text: string;
  /** 1–6 for `<h1>`–`<h6>`; absent for body text. */
  headingLevel?: number;
};

// Elements whose content is never part of the article text.
const SKIPPED_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "head",
  "button",
  "select",
  "input",
  "textarea",
  "form",
]);

// Page chrome that is dropped when no explicit main-content region exists.
const CHROME_ELEMENTS = new Set(["nav", "header", "footer", "aside"]);
const CHROME_ROLES = new Set([
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "search",
]);

const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "blockquote",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "thead",
  "tfoot",
  "tr",
  "ul",
  "br",
  "hr",
]);

// Standard DOM node types; the Node global may be absent in Zotero's sandbox.
const ELEMENT_NODE_TYPE = 1;
const TEXT_NODE_TYPE = 3;

function normalizeText(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isHidden(element: Element): boolean {
  if (element.hasAttribute("hidden")) return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  const style = (element.getAttribute("style") || "").toLowerCase();
  return /display\s*:\s*none|visibility\s*:\s*hidden/.test(style);
}

function isChrome(element: Element): boolean {
  const tag = element.localName.toLowerCase();
  if (CHROME_ELEMENTS.has(tag)) return true;
  const role = (element.getAttribute("role") || "").toLowerCase();
  return CHROME_ROLES.has(role);
}

function textLength(element: Element): number {
  return normalizeText(element.textContent).length;
}

/**
 * Pick the region holding the article. Prefer explicit `<main>`/`<article>`
 * markup when it carries a meaningful share of the page text, so sidebars
 * and site navigation do not crowd out the content.
 */
function findContentRoot(doc: Document): {
  root: Element | null;
  dropChrome: boolean;
} {
  const body: Element | null = doc.body || doc.documentElement;
  if (!body) return { root: null, dropChrome: true };
  const bodyLength = Math.max(1, textLength(body));
  const candidates = Array.from(
    doc.querySelectorAll('main, [role="main"], article'),
  ) as Element[];
  let best: Element | null = null;
  let bestLength = 0;
  for (const candidate of candidates) {
    const length = textLength(candidate);
    if (length > bestLength) {
      best = candidate;
      bestLength = length;
    }
  }
  if (best && bestLength >= 200 && bestLength / bodyLength >= 0.25) {
    return { root: best, dropChrome: false };
  }
  return { root: body, dropChrome: true };
}

/** Walk the DOM in document order, emitting heading and paragraph blocks. */
export function collectHtmlTextBlocks(doc: Document): HtmlTextBlock[] {
  const { root, dropChrome } = findContentRoot(doc);
  const blocks: HtmlTextBlock[] = [];
  let buffer = "";

  const flush = () => {
    const text = normalizeText(buffer);
    buffer = "";
    if (text) blocks.push({ text });
  };

  const visit = (node: Node) => {
    if (node.nodeType === TEXT_NODE_TYPE) {
      buffer += node.nodeValue || "";
      return;
    }
    if (node.nodeType !== ELEMENT_NODE_TYPE) return;
    const element = node as Element;
    const tag = element.localName.toLowerCase();
    if (SKIPPED_ELEMENTS.has(tag) || isHidden(element)) return;
    if (dropChrome && element !== root && isChrome(element)) return;

    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      flush();
      const text = normalizeText(element.textContent);
      if (text) blocks.push({ text, headingLevel: Number(heading[1]) });
      return;
    }
    const isBlock = BLOCK_ELEMENTS.has(tag);
    if (isBlock) flush();
    if (tag === "td" || tag === "th") buffer += " ";
    for (const child of Array.from(element.childNodes) as Node[]) visit(child);
    if (tag === "td" || tag === "th") buffer += " |";
    if (isBlock) flush();
  };

  if (root) visit(root);
  flush();
  return blocks;
}

function splitLongText(text: string): string[] {
  if (text.length <= MAX_SEGMENT_CHARS) return [text];
  const parts: string[] = [];
  let current = "";
  for (const paragraph of text.split("\n\n")) {
    if (current && current.length + paragraph.length + 2 > MAX_SEGMENT_CHARS) {
      parts.push(current);
      current = "";
    }
    if (paragraph.length > MAX_SEGMENT_CHARS) {
      for (let i = 0; i < paragraph.length; i += MAX_SEGMENT_CHARS) {
        parts.push(paragraph.slice(i, i + MAX_SEGMENT_CHARS));
      }
      continue;
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Group text blocks into non-overlapping sections keyed by their heading
 * path, so retrieval can cite "Background" or "How to prevent" by name.
 */
export function buildHtmlSnapshotExtraction(
  blocks: HtmlTextBlock[],
  pageTitle = "",
): DocumentExtraction {
  type Section = { headingPath: string[]; paragraphs: string[] };
  const sections: Section[] = [];
  const headingStack: Array<{ level: number; text: string }> = [];
  let current: Section = { headingPath: [], paragraphs: [] };

  for (const block of blocks) {
    if (block.headingLevel) {
      if (current.paragraphs.length) sections.push(current);
      while (
        headingStack.length &&
        headingStack[headingStack.length - 1].level >= block.headingLevel
      ) {
        headingStack.pop();
      }
      headingStack.push({ level: block.headingLevel, text: block.text });
      current = {
        headingPath: headingStack.map((entry) => entry.text),
        paragraphs: [block.text],
      };
      continue;
    }
    current.paragraphs.push(block.text);
  }
  if (current.paragraphs.length) sections.push(current);

  const segments: DocumentSegment[] = [];
  for (const section of sections) {
    const sectionText = section.paragraphs.join("\n\n").trim();
    if (!sectionText) continue;
    const title =
      section.headingPath[section.headingPath.length - 1] ||
      normalizeText(pageTitle) ||
      undefined;
    for (const text of splitLongText(sectionText)) {
      const order = segments.length + 1;
      segments.push({
        id: `html-${order}`,
        title,
        text,
        headingPath: section.headingPath.length
          ? section.headingPath
          : title
            ? [title]
            : undefined,
        role: "content",
        order,
        readingOrder: order,
        source: section.headingPath.length ? "heading" : "body",
        confidence: section.headingPath.length ? "derived" : "fallback",
        linear: true,
      });
    }
  }

  let text = segments.map((segment) => segment.text).join("\n\n");
  let completeness: DocumentExtraction["completeness"] = text
    ? "complete"
    : "unavailable";
  if (text.length > MAX_HTML_SNAPSHOT_TEXT_CHARS) {
    text = text.slice(0, MAX_HTML_SNAPSHOT_TEXT_CHARS);
    completeness = "partial";
  }
  return {
    text,
    segments,
    completeness,
    fingerprint: `html-snapshot-v1:${segments.length}:${text.length}:${fnv1aHex(text)}`,
  };
}

async function readSnapshotHtml(item: Zotero.Item): Promise<string> {
  if (typeof item.getFilePathAsync !== "function") return "";
  const filePath = await item.getFilePathAsync();
  if (!filePath) return "";
  const charset =
    String(
      (item as Zotero.Item & { attachmentCharset?: string })
        .attachmentCharset || "",
    ).trim() || "utf-8";
  return String((await Zotero.File.getContentsAsync(filePath, charset)) || "");
}

async function readZoteroAttachmentText(
  item: Zotero.Item,
): Promise<DocumentExtraction> {
  try {
    const text = String(
      (await (item as Zotero.Item & { attachmentText?: Promise<string> })
        .attachmentText) || "",
    ).trim();
    return {
      text,
      completeness: text ? "partial" : "unavailable",
    };
  } catch (err) {
    ztoolkit.log("LLM: snapshot attachment text fallback failed", err);
    return {
      text: "",
      completeness: "unavailable",
      warnings: ["Web snapshot text extraction failed"],
    };
  }
}

export async function extractHtmlSnapshotText(
  item: Zotero.Item,
): Promise<DocumentExtraction> {
  try {
    const html = await readSnapshotHtml(item);
    if (html.trim()) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const pageTitle = normalizeText(doc.title) || getDocumentTitle(item);
      const extraction = buildHtmlSnapshotExtraction(
        collectHtmlTextBlocks(doc),
        pageTitle,
      );
      ztoolkit.log(
        `LLM: HTML snapshot extraction segments=${extraction.segments?.length || 0}, ` +
          `chars=${extraction.text.length}, completeness=${extraction.completeness}`,
      );
      if (extraction.text) return extraction;
    }
  } catch (err) {
    ztoolkit.log("LLM: HTML snapshot extraction failed", err);
  }
  // Fall back to Zotero's own full-text index for unusual snapshots.
  return readZoteroAttachmentText(item);
}

export const htmlSnapshotDocumentAdapter: DocumentAdapter = {
  async navigate(item) {
    await Zotero.Reader.open(item.id);
  },
  kind: "html",
  contentTypes: HTML_SNAPSHOT_CONTENT_TYPES,
  capabilities,
  presentation: {
    noun: "page",
    fullTextHeading: "Web Page Full Text (complete document):",
    excerptsHeading: "Web Page Text:",
    relevantSectionsNotice: "Relevant sections extracted from the web page",
    partialRelevantSectionsNotice:
      "Relevant sections extracted from Zotero's indexed snapshot text",
  },
  contextPolicy: {
    // Most pages fit whole; long ones fall back to section retrieval.
    strategy: "full-or-retrieval",
    useEmbeddings: false,
    maxChunks: 16,
    maxLength: 50_000,
    eagerWarmup: true,
  },
  selectionContextPolicy: {
    strategy: "retrieval",
    allowUnattributedSelection: true,
    maxChunks: 8,
    maxLength: 12_000,
  },
  emptyCacheRetryDelayMs: HTML_SNAPSHOT_RETRY_DELAY_MS,
  supports(item): item is Zotero.Item {
    return Boolean(
      item?.isAttachment?.() &&
      (HTML_SNAPSHOT_CONTENT_TYPES as readonly string[]).includes(
        getAttachmentContentType(item),
      ),
    );
  },
  describe(item) {
    return {
      item,
      kind: "html",
      title: getDocumentTitle(item),
      capabilities,
    };
  },
  getSourceRevision: getAttachmentSourceRevision,
  extract: extractHtmlSnapshotText,
};
