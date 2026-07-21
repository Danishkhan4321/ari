import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = join(__dirname, "..", "..");
const dashboardRoot = join(repoRoot, "dashboard");

test("meeting platform is added through an idempotent migration", () => {
  const migration = readFileSync(
    join(repoRoot, "migrations", "15_meeting_platform.js"),
    "utf8"
  );

  assert.match(
    migration,
    /ALTER TABLE meeting_recordings\s+ADD COLUMN IF NOT EXISTS meeting_platform TEXT/i
  );
});

test("manual meeting migration preserves historical recordings", () => {
  const migration = readFileSync(
    join(repoRoot, "migrations", "25_manual_meeting_recording.js"),
    "utf8"
  );
  assert.match(migration, /source_type = COALESCE\(source_type, 'legacy_recording'\)/);
  assert.match(migration, /processing_stage[\s\S]+ELSE 'completed'/);
  assert.match(migration, /ALTER COLUMN processing_stage SET DEFAULT 'captured'/);
});

test("meetings list does not expose database errors", () => {
  const route = readFileSync(
    join(dashboardRoot, "app", "api", "meetings", "list", "route.ts"),
    "utf8"
  );

  assert.equal(route.includes("e.message"), false);
  assert.match(route, /Unable to load meetings right now/);
});

test("meeting details expose the complete record and render the approved Overview contract", () => {
  const route = readFileSync(
    join(dashboardRoot, "app", "api", "meetings", "list", "route.ts"),
    "utf8"
  );
  const content = readFileSync(
    join(dashboardRoot, "app", "meetings", "meetings-content.tsx"),
    "utf8"
  ) + readFileSync(
    join(dashboardRoot, "app", "meetings", "meeting-detail.tsx"),
    "utf8"
  ) + readFileSync(
    join(dashboardRoot, "app", "meetings", "meeting-tasks.tsx"),
    "utf8"
  );

  for (const field of ["transcript", "action_items", "decisions", "mom", "topics"]) {
    assert.equal(route.includes(field), true, `API should select ${field}`);
  }
  for (const field of ["transcript", "decisions"]) {
    assert.equal(content.includes(field), true, `UI should render ${field}`);
  }
  assert.match(content, /Transcript/);
  assert.match(content, /title="Summary"/);
  assert.match(content, /title="Decisions"/);
  assert.match(content, /MeetingTasks/);
  assert.match(content, /Confirm task creation/);
});
