import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd());
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("recent transcriptions are reachable and expose local recovery controls", () => {
  const sidebar = read("components/workspace-sidebar.tsx");
  const palette = read("components/command-palette.tsx");
  const page = read("app/transcriptions/page.tsx");
  const content = read("app/transcriptions/transcriptions-content.tsx");

  assert.match(sidebar, /href: "\/transcriptions"/);
  assert.match(palette, /href: "\/transcriptions"/);
  assert.match(page, /Flowtype history/);
  assert.match(content, /listRecent/);
  assert.match(content, /copyRecent/);
  assert.match(content, /Saved for recovery/);
  assert.match(content, /maximum of 10 transcripts/);
});
