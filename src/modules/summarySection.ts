/**
 * "Paper Summary" ItemPane section: renders per-attachment summary state
 * (idle hint / progress / tree / error) in the right-hand pane and the
 * reader context pane, with a header button to trigger generation.
 */

import { getLocaleID, getString } from "../utils/locale";
import { prefsPaneID } from "./preferences";
import {
  captureCacheIdentity,
  generateSummaryTree,
  getState,
  getSummaryConfig,
  getTree,
  isCurrentToken,
  loadCachedTree,
  saveCachedTree,
  setState,
  setTree,
  startRun,
  type Stage,
} from "./summarizer";
import type { SectionNode } from "./structure";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

// `createElementNS` is typed as returning Element; for XHTML tag names the
// concrete HTML element type is well-known, so the cast is safe.
function createElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
): HTMLElementTagNameMap[K] {
  return doc.createElementNS(XHTML_NS, tag) as HTMLElementTagNameMap[K];
}

/**
 * Resolve the PDF attachment for an item: the item itself if it is a PDF
 * attachment, otherwise the first PDF attachment of a regular item.
 */
export function resolvePDFAttachment(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  if (!item) {
    return null;
  }
  if (item.isPDFAttachment?.()) {
    return item;
  }
  if (item.isRegularItem?.()) {
    for (const id of item.getAttachments()) {
      const attachment = Zotero.Items.get(id as number);
      if (attachment?.isPDFAttachment?.()) {
        return attachment;
      }
    }
  }
  return null;
}

interface TrackedBody {
  item: Zotero.Item;
  setButtonStatus: (
    buttonType: string,
    status: { disabled?: boolean; hidden?: boolean },
  ) => void;
}

/** attachment id -> live section bodies (main pane + reader tabs). */
const trackedBodies = new Map<number, Map<HTMLElement, TrackedBody>>();
function untrackBody(body: HTMLElement): void {
  for (const [key, perItem] of trackedBodies) {
    perItem.delete(body);
    if (perItem.size === 0) {
      trackedBodies.delete(key);
    }
  }
}

/** Track a rendered body; returns the attachment id key, or null if no PDF. */
function trackBody(
  item: Zotero.Item,
  body: HTMLDivElement,
  setButtonStatus: TrackedBody["setButtonStatus"],
): number | null {
  const key = resolvePDFAttachment(item)?.id;
  untrackBody(body);
  if (key === undefined || key === null) {
    return null;
  }
  let perItem = trackedBodies.get(key);
  if (!perItem) {
    perItem = new Map();
    trackedBodies.set(key, perItem);
  }
  perItem.set(body, { item, setButtonStatus });
  return key;
}

/** Drop bodies disconnected from their document. */
function pruneBodies(key: number): Map<HTMLElement, TrackedBody> {
  const perItem = trackedBodies.get(key);
  if (!perItem) {
    return new Map();
  }
  for (const [body] of perItem) {
    if (!body.isConnected) {
      perItem.delete(body);
    }
  }
  if (perItem.size === 0) {
    trackedBodies.delete(key);
  }
  return perItem;
}

function setButtonsHidden(key: number, hidden: boolean): void {
  for (const { setButtonStatus } of pruneBodies(key).values()) {
    setButtonStatus("generate", { hidden });
  }
}

function renderStage(doc: Document, stage: Stage | undefined): HTMLElement {
  const el = createElement(doc, "div");
  el.className = "ps-status";
  if (stage?.phase === "summarizing") {
    el.textContent = getString("summary-status-llm", {
      args: { done: stage.done, total: stage.total },
    });
  } else {
    el.textContent =
      getString("summary-status-extract") +
      (stage?.phase === "extracting" && typeof stage.progress === "number"
        ? ` ${Math.round(stage.progress)}%`
        : "");
  }
  return el;
}

function renderNode(
  doc: Document,
  node: SectionNode,
  topLevel: boolean,
): HTMLElement {
  const details = createElement(doc, "details");
  details.className = "ps-node";
  details.open = topLevel;
  const summary = createElement(doc, "summary");
  summary.textContent = node.title;
  if (node.skippedReason === "structural") {
    const note = createElement(doc, "span");
    note.className = "ps-skipped";
    note.textContent = ` (${getString("summary-skipped")})`;
    summary.append(note);
  }
  const content = createElement(doc, "div");
  content.className = "ps-node-summary";
  content.textContent = node.summary ?? "";
  details.append(summary, content);
  for (const child of node.children) {
    details.append(renderNode(doc, child, false));
  }
  return details;
}

function renderState(body: HTMLElement, item: Zotero.Item): void {
  const doc = body.ownerDocument;
  body.replaceChildren();
  if (!doc) {
    return;
  }
  const key = resolvePDFAttachment(item)?.id;
  if (key === undefined || key === null) {
    return;
  }
  let phase = getState(key).phase;
  if (phase === "done" && !getTree(key)) {
    setState(key, { phase: "idle" });
    phase = "idle";
  }

  if (phase === "working") {
    body.append(renderStage(doc, getState(key).stage));
    return;
  }
  if (phase === "error") {
    const el = createElement(doc, "div");
    el.className = "ps-error";
    el.textContent = getString("summary-error", {
      args: { message: getState(key).error ?? "" },
    });
    body.append(el);
    return;
  }
  if (phase === "done") {
    const tree = getTree(key) ?? [];
    if (tree.length === 0) {
      const el = createElement(doc, "div");
      el.className = "ps-empty";
      el.textContent = getString("summary-empty");
      body.append(el);
      return;
    }
    for (const node of tree) {
      body.append(renderNode(doc, node, true));
    }
    return;
  }
  // idle
  const hint = createElement(doc, "p");
  hint.className = "ps-hint";
  hint.textContent = getString("summary-hint-idle");
  const button = createElement(doc, "button");
  button.className = "ps-generate-btn";
  button.textContent = getString("summary-generate");
  button.addEventListener("click", () => {
    void startGeneration(item);
  });
  body.append(hint, button);
}

function renderAll(key: number): void {
  for (const [body, { item }] of pruneBodies(key)) {
    renderState(body, item);
  }
}

async function startGeneration(item: Zotero.Item): Promise<void> {
  const attachment = resolvePDFAttachment(item);
  if (!attachment) {
    return;
  }
  const key = attachment.id;
  const token = startRun(key);
  const generationConfig = getSummaryConfig();
  setState(key, { phase: "working", error: undefined, stage: undefined });
  setButtonsHidden(key, true);
  renderAll(key);
  try {
    const identity = await captureCacheIdentity(attachment, generationConfig);
    if (!isCurrentToken(key, token) || token.cancelled) {
      return;
    }
    const roots = await generateSummaryTree(
      attachment,
      (stage) => {
        if (!isCurrentToken(key, token) || token.cancelled) {
          return;
        }
        setState(key, { stage });
        renderAll(key);
      },
      token,
      generationConfig,
    );
    if (!isCurrentToken(key, token) || token.cancelled) {
      return;
    }
    ztoolkit.log(
      `Generated summary tree for attachment ${key}: ${roots.length} root(s)`,
    );
    setTree(key, roots);
    setState(key, { phase: "done", stage: undefined });
    await saveCachedTree(attachment, roots, token, identity);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ztoolkit.log(`Summary generation failed for attachment ${key}: ${message}`);
    if (
      message !== "CANCELLED" &&
      isCurrentToken(key, token) &&
      !token.cancelled
    ) {
      setState(key, {
        phase: "error",
        error:
          message === "STRUCTURE_UNAVAILABLE"
            ? getString("summary-unsupported")
            : message,
      });
    }
    // CANCELLED or stale errors leave the newer run's state untouched.
  } finally {
    if (isCurrentToken(key, token) && !token.cancelled) {
      setButtonsHidden(key, false);
      renderAll(key);
    }
  }
}

export function registerSummarySection(): void {
  Zotero.ItemPaneManager.registerSection({
    paneID: "paper-summary",
    pluginID: addon.data.config.addonID,
    header: {
      l10nID: getLocaleID("summary-section-header"),
      icon: "chrome://zotero/skin/16/universal/book.svg",
    },
    sidenav: {
      l10nID: getLocaleID("summary-section-sidenav"),
      icon: "chrome://zotero/skin/20/universal/save.svg",
    },
    onDestroy: ({ body }) => {
      untrackBody(body);
    },
    onItemChange: ({
      body,
      item,
      setEnabled,
      setSectionButtonStatus,
      tabType,
    }) => {
      // Zotero can assign the same item again without calling onRender.
      // Keep the body tracked so generation can still update its contents.
      const enabled =
        tabType === "reader" && resolvePDFAttachment(item) !== null;
      setEnabled(enabled);
      if (enabled) {
        trackBody(item, body, setSectionButtonStatus);
      } else {
        untrackBody(body);
      }
    },
    onRender: ({ body, item, setSectionButtonStatus }) => {
      const key = trackBody(item, body, setSectionButtonStatus);
      if (key === null) {
        body.replaceChildren();
        return;
      }
      if (getState(key).phase === "working") {
        setSectionButtonStatus("generate", { hidden: true });
      }
      renderState(body, item);
    },
    onAsyncRender: async ({ item }) => {
      const attachment = resolvePDFAttachment(item);
      if (!attachment) {
        return;
      }
      const key = attachment.id;
      if (getState(key).phase !== "idle" || getTree(key)) {
        return;
      }
      const cached = await loadCachedTree(attachment);
      // A generation run may have started while reading the cache.
      if (!cached || getState(key).phase !== "idle" || getTree(key)) {
        return;
      }
      setTree(key, cached);
      setState(key, { phase: "done" });
      renderAll(key);
    },
    sectionButtons: [
      {
        type: "generate",
        icon: "chrome://zotero/skin/16/universal/book.svg",
        l10nID: getLocaleID("summary-section-generate-tooltip"),
        onClick: ({ item }) => {
          void startGeneration(item);
        },
      },
      {
        type: "settings",
        icon: "chrome://zotero/skin/20/universal/cog.svg",
        onClick: () => {
          Zotero.Utilities.Internal.openPreferences(prefsPaneID());
        },
      },
    ],
  });
}

export function registerSummaryStyles(win: _ZoteroTypes.MainWindow): void {
  const doc = win.document;
  const styles = ztoolkit.UI.createElement(doc, "link", {
    properties: {
      type: "text/css",
      rel: "stylesheet",
      href: `chrome://${addon.data.config.addonRef}/content/zoteroPane.css`,
    },
  });
  doc.documentElement?.appendChild(styles);
}
