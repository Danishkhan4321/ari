import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const dashboardRoot = join(__dirname, "..");

test("retired surfaces are absent from visible navigation", () => {
  const sidebar = readFileSync(join(dashboardRoot, "components", "sidebar.tsx"), "utf8");
  const palette = readFileSync(join(dashboardRoot, "components", "command-palette.tsx"), "utf8");
  const home = readFileSync(join(dashboardRoot, "app", "page.tsx"), "utf8");

  for (const source of [sidebar, palette, home]) {
    assert.equal(source.includes('href: "/notes"'), false);
    assert.equal(source.includes('href: "/productivity"'), false);
  }
});

test("Team tabs keep chat and hide sprint and board entry points", () => {
  const team = readFileSync(join(dashboardRoot, "app", "team", "team-content.tsx"), "utf8");
  assert.equal(team.includes('{ value: "chat",       label: "Team Chat" }'), true);
  assert.equal(team.includes('{ value: "sprints"'), false);
  assert.equal(team.includes('{ value: "board"'), false);
});

test("dashboard has a JSON fallback for unknown API routes", () => {
  const fallback = readFileSync(join(dashboardRoot, "app", "api", "[...path]", "route.ts"), "utf8");
  assert.equal(fallback.includes("NextResponse.json"), true);
  assert.equal(fallback.includes('status: 404'), true);
  assert.equal(fallback.includes("<!DOCTYPE"), false);
});
