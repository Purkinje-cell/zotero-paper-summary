import { assert } from "chai";
import { config } from "../package.json";

const PREFS_PANE_ID = `${config.addonRef}-prefs`;

describe("preferences pane", function () {
  it("should register the plugin pane in Zotero settings", function () {
    const pane = Zotero.PreferencePanes.pluginPanes.find(
      (p) => p.pluginID === config.addonID,
    );
    assert.ok(pane, "plugin pane is registered");
    assert.equal(pane?.id, PREFS_PANE_ID);
  });
});
