import { assert } from "chai";
import {
  buildSectionTree,
  classifySectionRole,
  getNestedBlockPlainText,
  type Materialized,
  type SDTBlock,
  type SectionNode,
} from "../src/modules/structure";

function paragraph(text: string): SDTBlock {
  return { type: "paragraph", content: [{ text }] };
}

function heading(text: string): SDTBlock {
  return { type: "heading", content: [{ text }] };
}

const LONG_FRONT_MATTER =
  "This paper studies hierarchical summarization. ".repeat(10);

function buildFixture(frontMatter: string): Materialized {
  return {
    catalog: {
      outline: [
        { title: "1. Introduction", ref: [1] },
        {
          title: "2. Methods",
          ref: [3],
          children: [{ title: "2.1 Setup", ref: [5] }],
        },
        { title: "References", ref: [7] },
      ],
    },
    content: [
      paragraph(frontMatter),
      heading("1. Introduction"),
      paragraph("Intro body text."),
      heading("2. Methods"),
      paragraph("Methods own body paragraph."),
      heading("2.1 Setup"),
      paragraph("Setup body text."),
      heading("References"),
      paragraph("Reference list body."),
    ],
  };
}

function findNode(roots: SectionNode[], title: string): SectionNode {
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if (node.title === title) {
      return node;
    }
    stack.push(...node.children);
  }
  throw new Error(`Node not found: ${title}`);
}

describe("structure", function () {
  describe("classifySectionRole", function () {
    it("classifies common section titles", function () {
      assert.equal(classifySectionRole("1. INTRODUCTION"), "introduction");
      assert.equal(classifySectionRole("II. Related Work"), "background");
      assert.equal(classifySectionRole("3.2 Experiments"), "experiments");
      assert.equal(classifySectionRole("Acknowledgements"), "acknowledgments");
      assert.equal(classifySectionRole("References"), "references");
      assert.equal(classifySectionRole("结论"), "conclusion");
      assert.equal(classifySectionRole("A Novel Architecture"), "other");
      assert.equal(classifySectionRole("2. Methods"), "methods");
      assert.equal(classifySectionRole("Methodical Analysis"), "other");
      assert.equal(classifySectionRole("ResultsX"), "other");
    });
  });

  describe("getNestedBlockPlainText", function () {
    it("joins nested block text", function () {
      const table: SDTBlock = {
        type: "table",
        content: [
          { type: "table-cell", content: [{ text: "alpha" }] },
          { type: "table-cell", content: [{ text: "beta" }] },
        ],
      };
      assert.equal(getNestedBlockPlainText(table), "alpha\nbeta");
    });
  });

  describe("buildSectionTree", function () {
    it("builds roots with synthetic Abstract, nesting, and exact boundaries", function () {
      const roots = buildSectionTree(buildFixture(LONG_FRONT_MATTER));
      // Synthetic front-matter root + 3 outline roots
      assert.lengthOf(roots, 4);

      const abstract = roots[0];
      assert.equal(abstract.title, "Abstract");
      assert.equal(abstract.role, "abstract");
      assert.equal(abstract.blockStart, -1);
      assert.equal(abstract.ownText, LONG_FRONT_MATTER);
      assert.equal(abstract.id, "0");

      const intro = findNode(roots, "1. Introduction");
      assert.equal(intro.role, "introduction");
      assert.equal(intro.ownText, "Intro body text.");

      const methods = findNode(roots, "2. Methods");
      assert.equal(methods.role, "methods");
      // ownText of Methods is exactly the paragraph between heading 2 and 2.1
      assert.equal(methods.ownText, "Methods own body paragraph.");
      assert.lengthOf(methods.children, 1);
      assert.equal(methods.children[0].title, "2.1 Setup");
      assert.equal(methods.children[0].ownText, "Setup body text.");
      assert.equal(methods.children[0].id, `${methods.id}.0`);

      const references = findNode(roots, "References");
      assert.equal(references.role, "references");
      assert.equal(references.ownText, "Reference list body.");
      // skippedReason is assigned by the summarizer, not the tree builder
      assert.isUndefined(references.skippedReason);
    });

    it("skips synthetic Abstract for short front matter", function () {
      const roots = buildSectionTree(buildFixture("F".repeat(100)));
      assert.lengthOf(roots, 3);
      assert.isUndefined(roots.find((node) => node.title === "Abstract"));
    });

    it("returns a single Full Text root for an empty outline", function () {
      const materialized: Materialized = {
        catalog: {},
        content: buildFixture("F".repeat(100)).content,
      };
      const roots = buildSectionTree(materialized);
      assert.lengthOf(roots, 1);
      assert.equal(roots[0].title, "Full Text");
      assert.equal(roots[0].role, "other");
      assert.include(roots[0].ownText, "Intro body text.");
      assert.include(roots[0].ownText, "Setup body text.");
      assert.include(roots[0].ownText, "Reference list body.");
      assert.notInclude(roots[0].ownText, "2.1 Setup");
    });
  });
});
