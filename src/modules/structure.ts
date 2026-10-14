/**
 * Pure document-structure utilities for SDT (Structured Document Text)
 * extraction results.
 *
 * This module MUST stay Zotero-free at module top level (Zotero is only
 * touched inside function bodies) so that mocha can import it directly.
 */

export interface SDTBlock {
  type: string;
  content?: Array<SDTBlock | { text: string }>;
  text?: string;
}

export interface SDTOutlineItem {
  title: string;
  ref?: number[];
  children?: SDTOutlineItem[];
}

export interface Materialized {
  catalog: { outline?: SDTOutlineItem[] };
  content: SDTBlock[];
}

export type SectionRole =
  | "abstract"
  | "introduction"
  | "background"
  | "methods"
  | "experiments"
  | "results"
  | "discussion"
  | "conclusion"
  | "references"
  | "acknowledgments"
  | "appendix"
  | "other";

export interface SectionNode {
  /** Preorder path: "0", "0.1", ... Reassigned after tree construction. */
  id: string;
  title: string;
  role: SectionRole;
  /** Index of the heading block in `content`; -1 for synthetic nodes. */
  blockStart: number;
  /** Body text between this heading and the next heading in document order. */
  ownText: string;
  children: SectionNode[];
  summary?: string;
  skippedReason?: "structural" | "too-short";
}

type TextNode = SDTBlock | { text: string };

/**
 * Extract plain text from a (possibly nested) SDT block node.
 * Zotero ships this helper only inside a CJS worker module that plugins
 * cannot import, so it is reimplemented here.
 */
export function getNestedBlockPlainText(node: TextNode): string {
  const block = node as SDTBlock;
  if (block.text !== undefined) {
    return block.text;
  }
  return (block.content ?? [])
    .map((child) => getNestedBlockPlainText(child))
    .filter(Boolean)
    .join("\n");
}

/** Block types whose text counts as section body text. */
const TEXT_BLOCK_TYPES = new Set(["paragraph", "listitem", "caption", "table"]);

function textOfBlocks(blocks: SDTBlock[]): string {
  return blocks
    .filter((block) => TEXT_BLOCK_TYPES.has(block.type))
    .map((block) => getNestedBlockPlainText(block))
    .filter(Boolean)
    .join("\n\n");
}

const ROLE_KEYWORDS: Array<[SectionRole, string[]]> = [
  ["references", ["references", "bibliography", "参考文献"]],
  [
    "acknowledgments",
    [
      "acknowledg",
      "acknowledgment",
      "acknowledgments",
      "acknowledgement",
      "acknowledgements",
      "致谢",
    ],
  ],
  [
    "appendix",
    ["appendix", "appendices", "supplementary", "supplemental", "附录"],
  ],
  ["abstract", ["abstract", "summary", "摘要"]],
  ["introduction", ["introduction", "引言"]],
  [
    "background",
    [
      "background",
      "related work",
      "related works",
      "literature review",
      "prior work",
      "preliminaries",
      "相关工作",
    ],
  ],
  [
    "methods",
    [
      "method",
      "methods",
      "methodology",
      "approach",
      "proposed",
      "system design",
      "方法",
    ],
  ],
  [
    "experiments",
    [
      "experiment",
      "experiments",
      "experimental setup",
      "experimental evaluation",
      "evaluation",
      "implementation",
      "实验",
      "评估",
    ],
  ],
  ["results", ["results", "findings", "结果"]],
  ["discussion", ["discussion", "limitations", "讨论"]],
  [
    "conclusion",
    ["conclusion", "conclusions", "concluding remarks", "future work", "结论"],
  ],
];

const CJK_RE = /[\u4e00-\u9fff]/;
const ENUMERATION_RE = /^(\s*[([]?(\d+(\.\d+)*|[ivxlcdm]+|[a-z])[.:)\]-]?\s+)+/;

/**
 * Normalize a section title: lowercase and strip leading enumerations like
 * "1.2 ", "II. ", "(a) ".
 */
export function normalizeSectionTitle(title: string): string {
  return title.toLowerCase().replace(ENUMERATION_RE, "").trim();
}

/**
 * Classify a section title into a coarse section role.
 * First matching role in ROLE_KEYWORDS order wins.
 */
export function classifySectionRole(title: string): SectionRole {
  const normalized = normalizeSectionTitle(title);
  if (!normalized) {
    return "other";
  }
  for (const [role, keywords] of ROLE_KEYWORDS) {
    for (const keyword of keywords) {
      if (CJK_RE.test(keyword)) {
        if (normalized.includes(keyword)) {
          return role;
        }
      } else if (
        new RegExp(`\\b${keyword.replace(/\s+/g, "\\s+")}\\b`).test(normalized)
      ) {
        return role;
      }
    }
  }
  return "other";
}

function syntheticNode(
  title: string,
  ownText: string,
  children: SectionNode[] = [],
): SectionNode {
  return {
    id: "",
    title,
    role: classifySectionRole(title),
    blockStart: -1,
    ownText,
    children,
  };
}

/**
 * Build a section tree from a materialized SDT document.
 *
 * - Empty outline -> single synthetic "Full Text" root.
 * - Substantial front matter (>= 300 chars before the first heading) becomes a
 *   synthetic "Abstract" sibling root.
 * - `ownText` of each node is the body text between its heading block and the
 *   next heading block in document order.
 */
export function buildSectionTree(m: Materialized): SectionNode[] {
  const outline = m.catalog?.outline ?? [];
  const content = m.content ?? [];

  if (outline.length === 0) {
    return [syntheticNode("Full Text", textOfBlocks(content))];
  }

  // Build nodes preserving outline nesting.
  const build = (items: SDTOutlineItem[]): SectionNode[] =>
    items.map((item) => {
      const node: SectionNode = {
        id: "",
        title: item.title,
        role: "other",
        blockStart: typeof item.ref?.[0] === "number" ? item.ref[0] : -1,
        ownText: "",
        children: item.children?.length ? build(item.children) : [],
      };
      return node;
    });
  const roots = build(outline);

  // Compute ownText from document order (preorder == document order for a
  // well-formed outline; sort defensively by blockStart).
  const withBlocks: SectionNode[] = [];
  const collect = (nodes: SectionNode[]) => {
    for (const node of nodes) {
      if (node.blockStart >= 0) {
        withBlocks.push(node);
      }
      if (node.children.length > 0) {
        collect(node.children);
      }
    }
  };
  collect(roots);
  withBlocks.sort((a, b) => a.blockStart - b.blockStart);

  for (let i = 0; i < withBlocks.length; i++) {
    const node = withBlocks[i];
    const nextStart = withBlocks[i + 1]?.blockStart ?? content.length;
    node.ownText = textOfBlocks(
      content.slice(
        node.blockStart + 1,
        Math.max(nextStart, node.blockStart + 1),
      ),
    );
  }

  // Front matter before the first heading becomes a synthetic Abstract root.
  const firstBlock = withBlocks[0]?.blockStart ?? -1;
  if (firstBlock > 0) {
    const frontMatter = textOfBlocks(content.slice(0, firstBlock));
    if (frontMatter.trim().length >= 300) {
      roots.unshift(syntheticNode("Abstract", frontMatter));
    }
  }

  // Assign preorder-path ids and roles after all insertions.
  const assign = (nodes: SectionNode[], prefix: string) => {
    nodes.forEach((node, index) => {
      node.id = prefix === "" ? String(index) : `${prefix}.${index}`;
      node.role = classifySectionRole(node.title);
      assign(node.children, node.id);
    });
  };
  assign(roots, "");

  return roots;
}

/**
 * Whether the running Zotero exposes Zotero.SDT (Zotero 10+).
 */
export function isSDTSupported(): boolean {
  return typeof Zotero.SDT?.getReader === "function";
}

/**
 * Materialize the structured document of a PDF attachment via Zotero.SDT.
 * Returns null when SDT is unavailable or extraction fails (getReader never
 * rejects; it resolves null).
 */
export async function getMaterialized(
  attachment: Zotero.Item,
  onProgress?: (p: number) => void,
): Promise<Materialized | null> {
  if (typeof Zotero.SDT?.getReader !== "function") {
    return null;
  }
  const reader = await Zotero.SDT.getReader(attachment.id, {
    isPriority: true,
    onProgress,
  });
  if (!reader) {
    return null;
  }
  try {
    return await reader.materialize();
  } catch {
    return null;
  }
}
