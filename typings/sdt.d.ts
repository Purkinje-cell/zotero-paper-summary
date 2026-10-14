/**
 * Hand-written typings for `Zotero.SDT` (Structured Document Text),
 * which zotero-types 4.1.0-beta.4 predates. SDT exists only in Zotero 10+;
 * it is declared optional so callers must guard with `Zotero.SDT?.getReader`.
 */
declare namespace Zotero {
  let SDT:
    | {
        /**
         * Get (or build) the structured-document reader for an attachment.
         * Never rejects; resolves null when the document is unavailable,
         * password-protected, or extraction fails.
         */
        getReader(
          itemID: number,
          options?: {
            isPriority?: boolean;
            onProgress?: (p: number) => void;
          },
        ): Promise<{
          materialize(): Promise<
            import("../src/modules/structure").Materialized
          >;
        } | null>;
      }
    | undefined;
}
