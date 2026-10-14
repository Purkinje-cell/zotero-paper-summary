/**
 * The Zotero plugin sandbox (Zotero.Plugins._loadScope) whitelists `fetch`
 * but NOT `AbortController`. Borrow the constructor from the main window;
 * the resulting AbortSignal is accepted by the privileged fetch.
 */
export function createAbortController(): AbortController {
  const ctor =
    (globalThis as { AbortController?: typeof AbortController })
      .AbortController ??
    (
      Zotero.getMainWindow() as unknown as {
        AbortController?: typeof AbortController;
      } | null
    )?.AbortController;
  if (!ctor) {
    throw new Error("AbortController is unavailable in this environment");
  }
  return new ctor();
}
