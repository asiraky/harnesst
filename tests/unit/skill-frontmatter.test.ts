/**
 * Frontmatter of every markdown file we ship into an agent must be valid YAML.
 *
 * eve's discovery hard-fails the image build on unparseable authored-skill frontmatter, and a
 * failed build surfaces to the user only as an endless "your assistant is starting up". Two breaks
 * shipped this way inside one hour (#251 dropped an unknown key; #252 left a `": "` inside an
 * unquoted description, which YAML reads as a nested mapping), so the shape is checked here with a
 * real parser.
 *
 * `catalog/scripts/validate.mjs` cannot do this: it is deliberately dependency-free so the catalog
 * can stand alone in the eve OSS repo, and its `frontmatterKeys()` is a column-0 regex that sees
 * keys but never parses values. This test is the parsing half of that contract, and it covers
 * `assistant-template/`, which the catalog validator does not look at.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Keys eve accepts on an authored skill — mirrors SKILL_FRONTMATTER_KEYS in the catalog validator. */
const SKILL_FRONTMATTER_KEYS = ["name", "description"];

function markdownFiles(base: string): string[] {
  const abs = join(ROOT, base);
  const out: string[] = [];
  const recurse = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) recurse(p);
      else if (entry.name.endsWith(".md")) {
        out.push(relative(ROOT, p).split(sep).join("/"));
      }
    }
  };
  try {
    if (statSync(abs).isDirectory()) recurse(abs);
  } catch {
    // Nothing to walk — the emptiness assertions below catch a moved directory.
  }
  return out;
}

/** The leading `---` block's raw body, or null when the file has no frontmatter. */
function frontmatterBody(content: string): string | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  return lines.slice(1, end).join("\n");
}

/** Skill markdown, by the path shapes eve discovers: `skills/<id>.md` or `skills/<id>/SKILL.md`. */
function isSkillPath(path: string): boolean {
  const parts = path.split("/");
  const i = parts.lastIndexOf("skills");
  if (i === -1) return false;
  const rest = parts.slice(i + 1);
  if (rest.length === 1) return true;
  if (rest.length === 2 && rest[1] === "SKILL.md") return true;
  return false; // references/, assets/, scripts/ — not a skill entry point
}

const ASSISTANT_SKILLS = markdownFiles("assistant-template/agent/skills");
const SHIPPED_MARKDOWN = [
  ...markdownFiles("assistant-template"),
  ...markdownFiles("catalog/templates"),
];

describe("shipped markdown frontmatter", () => {
  it("finds the files it is meant to guard", () => {
    // A rename that moves these directories must not turn this suite into a silent no-op.
    expect(ASSISTANT_SKILLS.length).toBeGreaterThan(0);
    expect(SHIPPED_MARKDOWN.length).toBeGreaterThan(ASSISTANT_SKILLS.length);
  });

  it.each(SHIPPED_MARKDOWN)("%s parses as YAML", (path) => {
    const body = frontmatterBody(readFileSync(join(ROOT, path), "utf8"));
    if (body === null) return; // no frontmatter block is legal; a malformed one is not
    expect(() => parse(body)).not.toThrow();
  });
});

describe("authored skill frontmatter", () => {
  const skills = SHIPPED_MARKDOWN.filter(isSkillPath);

  it("finds skills in both the assistant template and the catalog", () => {
    expect(skills.some((p) => p.startsWith("assistant-template/"))).toBe(true);
    expect(skills.some((p) => p.startsWith("catalog/"))).toBe(true);
  });

  it.each(skills)("%s declares a description and no unknown keys", (path) => {
    const body = frontmatterBody(readFileSync(join(ROOT, path), "utf8"));
    // A flat skill may omit frontmatter entirely — eve infers the description from the first line.
    if (body === null) return;

    const parsed = parse(body) as unknown;
    expect(parsed, "frontmatter must be a mapping").toBeTypeOf("object");
    expect(parsed).not.toBeNull();

    const fm = parsed as Record<string, unknown>;
    expect(
      typeof fm.description === "string" && fm.description.trim().length > 0,
      "frontmatter must declare a non-empty description",
    ).toBe(true);
    expect(
      Object.keys(fm).filter((k) => !SKILL_FRONTMATTER_KEYS.includes(k)),
      "eve's discovery fails the build on keys outside the public skill shape",
    ).toEqual([]);
  });
});

describe("the break this suite was written for", () => {
  it("rejects an unquoted description containing a colon-space", () => {
    // Verbatim shape of #252: `": "` inside a plain scalar opens a nested mapping.
    const broken =
      "description: Conventions and docs, plus rules on top: how models work.";
    expect(() => parse(broken)).toThrow();
    expect(() =>
      parse(
        'description: "Conventions and docs, plus rules on top: how models work."',
      ),
    ).not.toThrow();
  });
});
