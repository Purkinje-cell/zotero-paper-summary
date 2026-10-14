/**
 * Preference-pane registration for Zotero's settings window.
 * The pane markup lives in `addon/content/preferences.xhtml`; inputs there
 * bind to `extensions.zotero.<addonRef>.*` prefs via `preference` attributes.
 *
 * Note: `addon` is only assigned after all modules are imported
 * (`src/index.ts`), so pane ID computation must stay inside functions.
 */

export function prefsPaneID(): string {
  return `${addon.data.config.addonRef}-prefs`;
}

export async function registerPreferencePane(): Promise<void> {
  await Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    id: prefsPaneID(),
    src: `${rootURI}content/preferences.xhtml`,
  });
}
