/// <reference types="mocha" />
import { assert } from "chai";
import { config } from "../package.json";
import { registerSummarySection } from "../src/modules/summarySection";
import { getState } from "../src/modules/summarizer";

type Section =
  _ZoteroTypes.ItemPaneManagerSection.ItemDetailsSectionOptions<string>;
type Props = _ZoteroTypes.ItemPaneManagerSection.SectionHookArgs;

describe("summary section lifecycle", function () {
  let section: Section;
  let body: HTMLDivElement;
  let props: Props;
  let finishExtraction: (() => void) | undefined;
  let originalSDT: typeof Zotero.SDT;
  let globals: Array<[string, PropertyDescriptor | undefined]>;
  let nextID = 900000;

  function pdf(): Zotero.Item {
    return {
      id: ++nextID,
      isPDFAttachment: () => true,
      attachmentHash: Promise.resolve(null),
    } as unknown as Zotero.Item;
  }

  beforeEach(function () {
    const instance = (Zotero as unknown as Record<string, typeof addon>)[
      config.addonInstance
    ];
    globals = ["addon", "ztoolkit"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]);
    Object.defineProperties(globalThis, {
      addon: { configurable: true, value: instance },
      ztoolkit: { configurable: true, value: instance.data.ztoolkit },
    });
    const register = Zotero.ItemPaneManager.registerSection;
    try {
      Zotero.ItemPaneManager.registerSection = (options) => {
        section = options;
        return "summary-lifecycle-test";
      };
      registerSummarySection();
    } finally {
      Zotero.ItemPaneManager.registerSection = register;
    }
    originalSDT = Zotero.SDT;
    Zotero.SDT = {
      getReader: () => {
        const deferred = Zotero.Promise.defer();
        finishExtraction = () => deferred.resolve();
        return deferred.promise.then(() => null);
      },
    } as typeof Zotero.SDT;
    const doc = Zotero.getMainWindow().document;
    body = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    doc.documentElement!.append(body);
    props = {
      paneID: "paper-summary",
      doc,
      body,
      item: pdf(),
      tabType: "reader",
      editable: true,
      setEnabled: ((enabled: boolean) => !enabled) as Props["setEnabled"],
      setL10nArgs: () => {},
      setSectionSummary: (summary) => summary,
      setSectionButtonStatus: () => {},
    };
    section.onItemChange!(props);
    section.onRender!(props);
  });

  afterEach(async function () {
    finishExtraction?.();
    await Zotero.Promise.delay(0);
    finishExtraction = undefined;
    section.onDestroy!({ paneID: props.paneID, doc: props.doc, body });
    body.remove();
    Zotero.SDT = originalSDT;
    for (const [name, descriptor] of globals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  it("shows progress and extraction errors after the same item is assigned again", async function () {
    // Zotero skips onRender when the item/tab dependencies have not changed.
    section.onItemChange!(props);
    body.querySelector<HTMLButtonElement>(".ps-generate-btn")!.click();
    assert.exists(body.querySelector(".ps-status"));
    assert.notExists(body.querySelector(".ps-generate-btn"));
    await Zotero.Promise.delay(0);
    assert.isFunction(finishExtraction);
    finishExtraction!();
    await Zotero.Promise.delay(0);
    assert.equal(getState(props.item.id).phase, "error");
    assert.exists(body.querySelector(".ps-error"));
  });

  it("does not replace another attachment's pane when an earlier run finishes", async function () {
    const previous = props.item;
    body.querySelector<HTMLButtonElement>(".ps-generate-btn")!.click();
    await Zotero.Promise.delay(0);
    props = { ...props, item: pdf() };
    section.onItemChange!(props);
    section.onRender!(props);
    finishExtraction!();
    await Zotero.Promise.delay(0);
    assert.equal(getState(previous.id).phase, "error");
    assert.exists(body.querySelector(".ps-generate-btn"));
    assert.notExists(body.querySelector(".ps-error"));
  });
});
