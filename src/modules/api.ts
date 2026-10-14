/**
 * Window-callable plugin API (exposed as `Zotero.<addonInstance>.api`).
 * Used by static UI such as the preference pane's oncommand handlers.
 */

import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { testChatConnection } from "./llmClient";

export interface PluginApi {
  /** oncommand handler for the preference-pane "Test connection" button. */
  testLLMConnection(button: Element): Promise<void>;
}

export function createApi(): PluginApi {
  return {
    /**
     * Reads the just-typed pref values (pane inputs bind to prefs on every
     * keystroke), probes the endpoint, and reports success or the exact
     * error next to the button.
     */
    async testLLMConnection(button: Element): Promise<void> {
      const label = button.ownerDocument?.getElementById(
        `zotero-prefpane-${addon.data.config.addonRef}-llmTestResult`,
      );
      if (!label) {
        return;
      }
      label.textContent = getString("pref-test-running");
      const result = await testChatConnection({
        baseURL: getPref("llmBaseURL"),
        apiKey: getPref("llmAPIKey"),
        model: getPref("llmModel"),
      });
      label.textContent = result.ok
        ? getString("pref-test-ok", {
            args: { ms: result.ms, reply: result.reply?.slice(0, 60) ?? "" },
          })
        : getString("pref-test-fail", {
            args: { message: result.error ?? "" },
          });
    },
  };
}
