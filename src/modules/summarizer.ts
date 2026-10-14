/**
 * Hierarchical summarization orchestration: extracts the section tree,
 * summarizes leaf sections bottom-up through an OpenAI-compatible API, and
 * merges child summaries into parent syntheses. Includes in-memory state and
 * a disk cache invalidated on PDF hash / model / endpoint / language change.
 */

import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { createAbortController } from "../utils/globals";
import { chatCompletion } from "./llmClient";
import { buildSectionTree, getMaterialized, SectionNode } from "./structure";

const MAX_CONCURRENCY = 3;
const MIN_SUMMARIZE_CHARS = 300;
const CACHE_VERSION = 1;
const PROMPT_VERSION = 1;
const DEFAULT_MAX_SECTION_CHARS = 12000;

export type Stage =
  | { phase: "extracting"; progress?: number }
  | { phase: "summarizing"; done: number; total: number };

export interface ItemState {
  phase: "idle" | "working" | "done" | "error";
  error?: string;
  stage?: Stage;
}

export type CancelToken = {
  cancelled: boolean;
  signal?: AbortSignal;
  abort?: () => void;
};

export interface SummaryConfig {
  model: string;
  baseURL: string;
  language: string;
  maxSectionChars: number;
}

export interface CacheIdentity {
  sourceHash: string;
  model: string;
  baseURL: string;
  language: string;
}

const cacheWriteChains = new Map<number, Promise<void>>();
let activeLLMCalls = 0;
const llmWaiters: Array<{
  token: CancelToken;
  wake: (reserved: boolean) => void;
}> = [];

interface CacheFile {
  version: number;
  promptVersion: number;
  sourceHash?: string;
  model: string;
  baseURL: string;
  language: string;
  generatedAt: string;
  roots: SectionNode[];
}

const trees = new Map<number, SectionNode[]>();
const states = new Map<number, ItemState>();
const runTokens = new Map<number, CancelToken>();

export function getState(itemID: number): ItemState {
  let state = states.get(itemID);
  if (!state) {
    state = { phase: "idle" };
    states.set(itemID, state);
  }
  return state;
}

export function setState(itemID: number, patch: Partial<ItemState>): void {
  Object.assign(getState(itemID), patch);
}

export function getTree(itemID: number): SectionNode[] | undefined {
  return trees.get(itemID);
}

export function setTree(itemID: number, roots: SectionNode[]): void {
  trees.set(itemID, roots);
}

/** Start a new generation run, cancelling any previous run for the item. */
export function startRun(itemID: number): CancelToken {
  const previous = runTokens.get(itemID);
  if (previous) {
    previous.cancelled = true;
    previous.abort?.();
  }
  const controller = createAbortController();
  const token: CancelToken = {
    cancelled: false,
    signal: controller.signal,
    abort: () => controller.abort(),
  };
  runTokens.set(itemID, token);
  return token;
}

export function isCurrentToken(itemID: number, token: CancelToken): boolean {
  return runTokens.get(itemID) === token;
}
function acquireLLMSlot(token: CancelToken): Promise<void> {
  if (activeLLMCalls < MAX_CONCURRENCY) {
    activeLLMCalls += 1;
    return Promise.resolve().then(() => {
      if (token.cancelled) {
        releaseLLMSlot();
        throw new Error("CANCELLED");
      }
    });
  }
  const deferred = Zotero.Promise.defer();
  let reserved = false;
  llmWaiters.push({
    token,
    wake: (slotReserved) => {
      reserved = slotReserved;
      deferred.resolve();
    },
  });
  return deferred.promise.then(() => {
    if (token.cancelled) {
      if (reserved) {
        releaseLLMSlot();
      }
      throw new Error("CANCELLED");
    }
  });
}

function releaseLLMSlot(): void {
  activeLLMCalls -= 1;
  while (llmWaiters.length > 0) {
    const waiter = llmWaiters.shift()!;
    if (waiter.token.cancelled) {
      waiter.wake(false);
      continue;
    }
    activeLLMCalls += 1;
    waiter.wake(true);
    return;
  }
}

async function runLLM<T>(
  token: CancelToken,
  callback: () => Promise<T>,
): Promise<T> {
  await acquireLLMSlot(token);
  try {
    return await callback();
  } finally {
    releaseLLMSlot();
  }
}

type NodeAction = "structural" | "too-short" | "llm";

function nodeAction(node: SectionNode): NodeAction {
  if (node.role === "references" || node.role === "acknowledgments") {
    return "structural";
  }
  if (
    node.children.length === 0 &&
    node.ownText.trim().length < MIN_SUMMARIZE_CHARS
  ) {
    return "too-short";
  }
  return "llm";
}

function countLLMNodes(nodes: SectionNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (nodeAction(node) === "llm") {
      count += 1;
    }
    count += countLLMNodes(node.children);
  }
  return count;
}

export function getSummaryConfig(): SummaryConfig {
  const maxChars = Number(getPref("maxSectionChars"));
  return {
    model: getPref("llmModel"),
    baseURL: getPref("llmBaseURL"),
    language: getPref("summaryLanguage"),
    maxSectionChars:
      Number.isFinite(maxChars) && maxChars > 0
        ? maxChars
        : DEFAULT_MAX_SECTION_CHARS,
  };
}

function truncate(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[...truncated]`;
}

function systemPrompt(language: string): string {
  const base =
    "You are an expert academic reading assistant. Summarize sections of research papers concisely and faithfully.";
  const suffix =
    language === "en"
      ? "Write the summary in English."
      : language === "zh"
        ? "用中文撰写摘要。"
        : "Write the summary in the same language as the section text.";
  return `${base} ${suffix}`;
}

function leafPrompt(node: SectionNode, maxChars: number): string {
  return [
    `Section title: ${node.title}`,
    `Section type: ${node.role}`,
    "",
    "Section text:",
    truncate(node.ownText, maxChars),
    "",
    "Summarize this section of an academic paper in 3-6 sentences, capturing its key contributions, methods, and findings. Output plain text only.",
  ].join("\n");
}

function mergePrompt(node: SectionNode, maxChars: number): string {
  const lines = [`Section title: ${node.title}`];
  if (node.ownText.trim()) {
    lines.push("", "Section preamble:", truncate(node.ownText, maxChars));
  }
  lines.push("", "Subsection summaries:");
  for (const child of node.children) {
    if (child.summary) {
      lines.push(`### ${child.title}`, child.summary, "");
    }
  }
  lines.push(
    `Write a concise 3-6 sentence synthesis of the whole "${node.title}" section from the subsection summaries. Output plain text only.`,
  );
  return lines.join("\n");
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
}

/**
 * Generate the full summary tree for a PDF attachment. Post-order: children
 * are summarized first (bounded concurrency), parents merge child summaries.
 * Throws STRUCTURE_UNAVAILABLE when extraction fails, and CANCELLED when the
 * run's token is cancelled or superseded.
 */
export async function generateSummaryTree(
  attachment: Zotero.Item,
  onStage: (stage: Stage) => void,
  token: CancelToken,
  generationConfig: SummaryConfig = getSummaryConfig(),
): Promise<SectionNode[]> {
  const apiKey = getPref("llmAPIKey");
  if (token.cancelled) {
    throw new Error("CANCELLED");
  }
  const materialized = await getMaterialized(attachment, (progress) => {
    if (!token.cancelled) {
      onStage({ phase: "extracting", progress });
    }
  });
  if (token.cancelled) {
    throw new Error("CANCELLED");
  }
  if (!materialized) {
    throw new Error("STRUCTURE_UNAVAILABLE");
  }

  const roots = buildSectionTree(materialized);
  const total = countLLMNodes(roots) + (roots.length > 1 ? 1 : 0);
  let done = 0;

  const processNode = async (node: SectionNode): Promise<void> => {
    await mapLimit(node.children, MAX_CONCURRENCY, processNode);
    if (token.cancelled) {
      throw new Error("CANCELLED");
    }
    const action = nodeAction(node);
    if (action === "structural") {
      node.skippedReason = "structural";
      return;
    }
    if (action === "too-short") {
      node.summary = node.ownText.trim();
      node.skippedReason = "too-short";
      return;
    }
    const user =
      node.children.length > 0
        ? mergePrompt(node, generationConfig.maxSectionChars)
        : leafPrompt(node, generationConfig.maxSectionChars);
    const summary = await runLLM(token, () =>
      chatCompletion({
        baseURL: generationConfig.baseURL,
        apiKey,
        model: generationConfig.model,
        system: systemPrompt(generationConfig.language),
        user,
        signal: token.signal,
      }),
    );
    if (token.cancelled) {
      throw new Error("CANCELLED");
    }
    node.summary = summary;
    done += 1;
    if (!token.cancelled) {
      onStage({ phase: "summarizing", done, total });
    }
  };

  await mapLimit(roots, MAX_CONCURRENCY, processNode);
  if (token.cancelled) {
    throw new Error("CANCELLED");
  }

  if (roots.length > 1) {
    const overview: SectionNode = {
      id: "overview",
      title: "Paper Overview",
      role: "other",
      blockStart: -1,
      ownText: "",
      children: roots,
    };
    await processNode(overview);
    return [overview];
  }
  return roots;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSectionNode(value: unknown): value is SectionNode {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.role === "string" &&
    typeof value.blockStart === "number" &&
    typeof value.ownText === "string" &&
    Array.isArray(value.children) &&
    value.children.every(isSectionNode)
  );
}

function cacheDir(): string {
  return PathUtils.join(
    Zotero.DataDirectory.dir,
    `${config.addonRef}-summary-cache`,
  );
}

function cachePath(attachment: Zotero.Item): string {
  return PathUtils.join(
    cacheDir(),
    `${attachment.libraryID}-${attachment.key}.json`,
  );
}

export async function captureCacheIdentity(
  attachment: Zotero.Item,
  summaryConfig: SummaryConfig = getSummaryConfig(),
): Promise<CacheIdentity | null> {
  try {
    const sourceHash = await attachment.attachmentHash;
    if (typeof sourceHash !== "string" || !sourceHash) {
      return null;
    }
    return {
      sourceHash,
      model: summaryConfig.model,
      baseURL: summaryConfig.baseURL,
      language: summaryConfig.language,
    };
  } catch {
    return null;
  }
}

function sameIdentity(left: CacheIdentity, right: CacheIdentity): boolean {
  return (
    left.sourceHash === right.sourceHash &&
    left.model === right.model &&
    left.baseURL === right.baseURL &&
    left.language === right.language
  );
}

function cacheMatchesIdentity(
  data: Record<string, unknown>,
  identity: CacheIdentity,
): boolean {
  return (
    data.version === CACHE_VERSION &&
    data.promptVersion === PROMPT_VERSION &&
    data.sourceHash === identity.sourceHash &&
    data.model === identity.model &&
    data.baseURL === identity.baseURL &&
    data.language === identity.language
  );
}

export async function saveCachedTree(
  attachment: Zotero.Item,
  roots: SectionNode[],
  token?: CancelToken,
  identity?: CacheIdentity | null,
): Promise<void> {
  const key = attachment.id;
  const previous = cacheWriteChains.get(key) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      if (token && (!isCurrentToken(key, token) || token.cancelled)) {
        return;
      }
      if (identity === null) {
        return;
      }
      const snapshot = identity ?? (await captureCacheIdentity(attachment));
      if (!snapshot) {
        return;
      }
      const current = await captureCacheIdentity(attachment);
      if (!current || !sameIdentity(snapshot, current)) {
        return;
      }
      if (token && (!isCurrentToken(key, token) || token.cancelled)) {
        return;
      }
      await IOUtils.makeDirectory(cacheDir(), {
        createAncestors: true,
        ignoreExisting: true,
      });
      if (token && (!isCurrentToken(key, token) || token.cancelled)) {
        return;
      }
      const file: CacheFile = {
        version: CACHE_VERSION,
        promptVersion: PROMPT_VERSION,
        sourceHash: snapshot.sourceHash,
        model: snapshot.model,
        baseURL: snapshot.baseURL,
        language: snapshot.language,
        generatedAt: new Date().toISOString(),
        roots,
      };
      await IOUtils.writeJSON(cachePath(attachment), file);
    });
  cacheWriteChains.set(key, operation);
  try {
    await operation;
  } catch (err) {
    ztoolkit.log("Failed to save summary cache", err);
  } finally {
    if (cacheWriteChains.get(key) === operation) {
      cacheWriteChains.delete(key);
    }
  }
}

export async function loadCachedTree(
  attachment: Zotero.Item,
): Promise<SectionNode[] | null> {
  try {
    const identity = await captureCacheIdentity(attachment);
    if (!identity) {
      return null;
    }
    const data: unknown = JSON.parse(
      await IOUtils.readUTF8(cachePath(attachment)),
    );
    if (!isObject(data) || !cacheMatchesIdentity(data, identity)) {
      return null;
    }
    if (!Array.isArray(data.roots) || !data.roots.every(isSectionNode)) {
      return null;
    }
    return data.roots;
  } catch {
    return null;
  }
}
