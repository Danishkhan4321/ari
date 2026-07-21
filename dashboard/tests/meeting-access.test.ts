import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { canViewerAccessMeeting, meetingIdentityCandidates, parseMeetingAccessId } from "../lib/meeting-access";

const dashboardRoot = path.resolve(__dirname, "..");

test("meeting identity candidates bridge canonical and legacy numeric phones", () => {
  assert.deepEqual(meetingIdentityCandidates("919876543210"), ["919876543210", "+919876543210"]);
  assert.deepEqual(meetingIdentityCandidates("+919876543210"), ["919876543210", "+919876543210"]);
  assert.deepEqual(meetingIdentityCandidates("wa_12345"), ["wa_12345"]);
  assert.deepEqual(meetingIdentityCandidates(""), []);
});

test("meeting access validates PostgreSQL IDs and recognizes owner or team admin variants", () => {
  assert.equal(parseMeetingAccessId("2147483647"), 2_147_483_647);
  for (const invalid of ["0", "-1", "01", "2147483648", "1 OR 1=1"]) {
    assert.equal(parseMeetingAccessId(invalid), null);
  }
  const row = { user_phone: "+919876543210", team_admin_phone: "+919876543211" };
  assert.equal(canViewerAccessMeeting("919876543210", row), true);
  assert.equal(canViewerAccessMeeting("919876543211", row), true);
  assert.equal(canViewerAccessMeeting("919876543299", row), false);
});

test("meeting list and tasks use parameterized candidate ownership and team-admin queries", () => {
  const list = fs.readFileSync(path.join(dashboardRoot, "app", "api", "meetings", "list", "route.ts"), "utf8");
  const tasks = fs.readFileSync(path.join(dashboardRoot, "app", "api", "meetings", "[id]", "tasks", "route.ts"), "utf8");
  assert.match(list, /meetingIdentityCandidates/);
  assert.match(list, /user_phone\s*=\s*ANY\(\$1::text\[\]\)/);
  assert.match(list, /team_admin_phone\s*=\s*ANY\(\$1::text\[\]\)/);
  assert.match(tasks, /user_phone\s*=\s*ANY\(\$2::text\[\]\)/);
  assert.match(tasks, /team_admin_phone\s*=\s*ANY\(\$2::text\[\]\)/);
  assert.match(tasks, /admin_phone\s*=\s*ANY\(\$1::text\[\]\)/);
});

test("meeting proxy routes resolve dashboard access and proxy with the retained owner", () => {
  for (const routeName of ["recording", "retry", "speakers", "status"]) {
    const route = fs.readFileSync(
      path.join(dashboardRoot, "app", "api", "meetings", "[id]", routeName, "route.ts"),
      "utf8",
    );
    assert.match(route, /resolveMeetingAccess/);
    assert.match(route, /access\.ownerPhone/);
    assert.doesNotMatch(route, /desktopMeetingFetch\([^\n]+,\s*phone\b/);
  }
});
