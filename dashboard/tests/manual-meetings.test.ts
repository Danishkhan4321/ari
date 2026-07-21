import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  filterMeetings,
  isMeetingTerminal,
  meetingStageLabel,
  type ManualMeeting,
  parseJsonValue,
} from "../lib/manual-meetings";
import {
  advancePendingSubmission,
  createPendingSubmission,
  isLatestMeetingRequest,
  resolveMeetingSelection,
  shouldScheduleMeetingPoll,
} from "../app/meetings/meetings-content";
import { createSubmissionGate, progressMatchesActiveSession } from "../app/meetings/meeting-recorder";
import {
  createMeetingRequestGuard,
  getSpeakerName,
  mergeSpeakerNames,
  normalizeRetryProcessingStage,
  parseDecisionItems,
  parseSpeakerNames,
  setupMeetingRequestGuard,
} from "../app/meetings/meeting-detail";

const root = path.resolve(__dirname, "..");

test("manual meeting helpers parse retained canonical artifacts", () => {
  assert.deepEqual(parseJsonValue('[{"speakerId":"A","text":"Hello"}]', []), [{ speakerId: "A", text: "Hello" }]);
  assert.deepEqual(parseJsonValue("invalid", []), []);
  assert.equal(meetingStageLabel("generating_report"), "Generating report");
});

test("filterMeetings searches meeting metadata case-insensitively", () => {
  const meetings: ManualMeeting[] = [
    {
      id: 1,
      title: "Quarterly Planning",
      status: "PROCESSING",
      processing_stage: "generating_REPORT",
      duration_seconds: null,
      meeting_platform: "Google Meet",
      capture_platform: "Desktop Recorder",
      summary: null,
      transcript: null,
      action_items: null,
      decisions: null,
      mom: null,
      topics: null,
      attendees: "Alice, Bob",
      recording_url: null,
    },
  ];

  for (const query of ["quarterly", "GOOGLE", "desktop", "ALICE", "report", "processing"]) {
    assert.deepEqual(filterMeetings(meetings, query), meetings);
  }
  assert.deepEqual(filterMeetings(meetings, "no such meeting"), []);
});

test("filterMeetings returns the original list for a trimmed empty query", () => {
  const meetings: ManualMeeting[] = [];
  assert.equal(filterMeetings(meetings, "   "), meetings);
});

test("isMeetingTerminal recognizes terminal and processing stages", () => {
  for (const stage of ["completed", "failed", "cancelled"]) {
    assert.equal(isMeetingTerminal(stage), true);
  }
  for (const stage of ["processing", "captured", "uploading", "transcribing", "generating_report"]) {
    assert.equal(isMeetingTerminal(stage), false);
  }
});

test("completed meetings are labeled Ready", () => {
  assert.equal(meetingStageLabel("completed"), "Ready");
});

test("meeting decisions parse JSON arrays and retain useful object text", () => {
  assert.deepEqual(parseDecisionItems('["Ship the beta",{"text":"Keep the Friday review"}]'), [
    "Ship the beta",
    "Keep the Friday review",
  ]);
  assert.deepEqual(parseDecisionItems("Use the existing rollout plan"), ["Use the existing rollout plan"]);
  assert.deepEqual(parseDecisionItems("invalid { json"), ["invalid { json"]);
  assert.deepEqual(parseDecisionItems(null), []);
});

test("retry stage normalization always resumes a nonterminal processing stage", () => {
  assert.equal(normalizeRetryProcessingStage("generating_report"), "generating_report");
  assert.equal(normalizeRetryProcessingStage("FAILED"), "transcribing");
  assert.equal(normalizeRetryProcessingStage("completed"), "transcribing");
  assert.equal(normalizeRetryProcessingStage("cancelled"), "transcribing");
  assert.equal(normalizeRetryProcessingStage(null), "transcribing");
});

test("speaker name refresh preserves dirty local fields and adopts clean server fields", () => {
  assert.deepEqual(
    mergeSpeakerNames(
      { A: "Locally edited", B: "Old server value" },
      { A: "Server overwrite", B: "Fresh server value", C: "New speaker" },
      new Set(["A"]),
    ),
    { A: "Locally edited", B: "Fresh server value", C: "New speaker" },
  );
});

test("speaker parsing and lookup accept only canonical safe speaker IDs", () => {
  const parsed = parseSpeakerNames('{"A":"Alice","AA":"Alex","a":"Lower","constructor":"Unsafe","B":42}');
  assert.deepEqual(parsed, { A: "Alice", AA: "Alex" });
  assert.equal(getSpeakerName(parsed, "A"), "Alice");
  assert.equal(getSpeakerName(parsed, "constructor"), "");
  assert.equal(getSpeakerName({ A: 42 } as unknown as Record<string, string>, "A"), "");
});

test("meeting request guard supersedes stale requests within one operation", () => {
  const guard = createMeetingRequestGuard();
  const firstRename = guard.begin("rename");
  const playback = guard.begin("playback");
  const secondRename = guard.begin("rename");

  assert.equal(firstRename.signal.aborted, true);
  assert.equal(firstRename.accepts(), false);
  assert.equal(secondRename.accepts(), true);
  assert.equal(playback.accepts(), true);
});

test("meeting request guard rejects and aborts every request after disposal", () => {
  const guard = createMeetingRequestGuard();
  const rename = guard.begin("rename");
  const retry = guard.begin("retry");
  const playback = guard.begin("playback");

  guard.dispose();

  for (const request of [rename, retry, playback]) {
    assert.equal(request.signal.aborted, true);
    assert.equal(request.accepts(), false);
  }
});

test("meeting request lifecycle accepts operations from a fresh Strict Mode setup", () => {
  const guardRef: { current: ReturnType<typeof createMeetingRequestGuard> | null } = { current: null };
  const cleanupFirst = setupMeetingRequestGuard(guardRef);
  const firstGuard = guardRef.current!;
  const firstRequest = firstGuard.begin("playback");

  cleanupFirst();
  const cleanupSecond = setupMeetingRequestGuard(guardRef);
  const secondGuard = guardRef.current!;
  const secondRequest = secondGuard.begin("playback");

  assert.notEqual(secondGuard, firstGuard);
  assert.equal(firstRequest.accepts(), false);
  assert.equal(secondRequest.accepts(), true);
  cleanupSecond();
});

test("Meetings uses the approved compact page header", () => {
  const page = fs.readFileSync(path.join(root, "app", "meetings", "page.tsx"), "utf8");
  assert.match(page, /Record the conversation\. Ari handles everything after\./);
  assert.doesNotMatch(page, /Recordings, transcripts & reports/);
  assert.doesNotMatch(page, /Recordings & transcripts/);
});

test("a submission without an id selects the newest loaded meeting", () => {
  const newest = meetingFixture(3, "Newest");
  const previouslySelected = meetingFixture(2, "Previous");
  assert.deepEqual(resolveMeetingSelection([newest, previouslySelected], previouslySelected.id, createPendingSubmission(undefined)), {
    selectedId: newest.id,
    pendingSubmission: null,
  });
});

test("a submitted meeting target stays pending until it appears", () => {
  const existing = meetingFixture(2, "Existing");
  const pending = createPendingSubmission(7);
  assert.deepEqual(resolveMeetingSelection([existing], existing.id, pending), {
    selectedId: existing.id,
    pendingSubmission: pending,
  });
  assert.deepEqual(resolveMeetingSelection([meetingFixture(7, "Submitted"), existing], existing.id, pending), {
    selectedId: 7,
    pendingSubmission: null,
  });
});

test("pending submission polling is bounded and retains a recoverable target", () => {
  let pending = createPendingSubmission(7);
  let timedOut = false;
  for (let attempt = 0; attempt < 20 && pending.polling; attempt += 1) {
    const advanced = advancePendingSubmission(pending);
    pending = advanced.pendingSubmission!;
    timedOut = advanced.timedOut;
  }
  assert.equal(timedOut, true);
  assert.equal(pending.meetingId, 7);
  assert.equal(pending.polling, false);
});

test("slow meeting polls are serialized instead of aborted by background ticks", () => {
  assert.equal(shouldScheduleMeetingPoll({ hasProcessingMeeting: true, pendingSubmission: null, requestInFlight: true }), false);
  assert.equal(shouldScheduleMeetingPoll({ hasProcessingMeeting: true, pendingSubmission: null, requestInFlight: false }), true);
  assert.equal(shouldScheduleMeetingPoll({ hasProcessingMeeting: false, pendingSubmission: createPendingSubmission(7), requestInFlight: false }), true);
  assert.equal(shouldScheduleMeetingPoll({ hasProcessingMeeting: false, pendingSubmission: { ...createPendingSubmission(7), polling: false }, requestInFlight: false }), false);
});

test("only the newest meeting list request may commit", () => {
  assert.equal(isLatestMeetingRequest(4, 5), false);
  assert.equal(isLatestMeetingRequest(5, 5), true);
});

test("recording completion is emitted once per session or meeting", () => {
  const gate = createSubmissionGate();
  assert.equal(gate.claim({ sessionId: "capture-1", meetingId: 11 }), true);
  assert.equal(gate.claim({ sessionId: "capture-1", meetingId: 11 }), false);
  assert.equal(gate.claim({ sessionId: "capture-1", meetingId: 12 }), false);
  assert.equal(gate.claim({ sessionId: "capture-2", meetingId: 11 }), false);
  assert.equal(gate.claim({ sessionId: "capture-new", meetingId: 99 }), true);

  const progressiveGate = createSubmissionGate();
  assert.equal(progressiveGate.claim({ sessionId: "capture-3" }), true);
  assert.equal(progressiveGate.claim({ sessionId: "capture-3", meetingId: 13 }), false);
  assert.equal(progressiveGate.claim({ meetingId: 13 }), false);
});

test("recorder progress belongs only to the active capture session", () => {
  assert.equal(progressMatchesActiveSession("capture-1", "capture-1", 1), true);
  assert.equal(progressMatchesActiveSession("capture-old", "capture-1", 1), false);
  assert.equal(progressMatchesActiveSession(undefined, "capture-1", 1), true);
  assert.equal(progressMatchesActiveSession(undefined, "capture-1", 2), false);
  assert.equal(progressMatchesActiveSession(undefined, null, 0), false);
});

test("a retained recording error hides controls that could start a new recording", () => {
  const recorder = fs.readFileSync(path.join(root, "app", "meetings", "meeting-recorder.tsx"), "utf8");
  assert.match(recorder, /retainedError/);
  assert.match(recorder, /!active\s*&&\s*!retainedError/);
  assert.doesNotMatch(recorder, /\{stateLabel\}\{active \? `, \$\{elapsed\}`/);
});

test("Meetings uses a searchable master-detail history workspace", () => {
  const page = fs.readFileSync(path.join(root, "app", "meetings", "page.tsx"), "utf8");
  const content = fs.readFileSync(path.join(root, "app", "meetings", "meetings-content.tsx"), "utf8");
  const history = fs.readFileSync(path.join(root, "app", "meetings", "meeting-history.tsx"), "utf8");
  const recorder = fs.readFileSync(path.join(root, "app", "meetings", "meeting-recorder.tsx"), "utf8");
  const detail = fs.readFileSync(path.join(root, "app", "meetings", "meeting-detail.tsx"), "utf8");
  const meetingTasks = fs.readFileSync(path.join(root, "app", "meetings", "meeting-tasks.tsx"), "utf8");
  assert.match(content, /MeetingHistory/);
  assert.match(history, /Search meetings/);
  assert.match(recorder, />Record</);
  assert.match(content, /MeetingDetail/);
  assert.match(history, /onRetry/);
  assert.match(history, />Retry</);
  assert.match(detail, />Overview</);
  assert.match(detail, />Transcript</);
  assert.match(detail, /title="Decisions"/);
  assert.match(detail, /role="tablist"/);
  assert.match(detail, /role="tab"/);
  assert.match(detail, /aria-selected/);
  assert.match(meetingTasks, /require confirmation/i);
  assert.doesNotMatch(detail, /Complete meeting report/);
  assert.doesNotMatch(detail, />Topics</);
  assert.doesNotMatch(`${page}\n${content}`, /meeting bot|Send Ari a meeting link/i);
});

test("meeting detail resets result-pane state when the selected meeting changes", () => {
  const detail = fs.readFileSync(path.join(root, "app", "meetings", "meeting-detail.tsx"), "utf8");
  assert.match(detail, /useState<"overview" \| "transcript">\("overview"\)/);
  assert.match(detail, /<MeetingResult key=\{meeting\.id\}/);
  assert.match(detail, /useState<string \| null>\(null\)/);
});

test("meeting detail aborts and rejects stale async callbacks on disposal", () => {
  const detail = fs.readFileSync(path.join(root, "app", "meetings", "meeting-detail.tsx"), "utf8");
  for (const operation of ["rename", "retry", "playback"]) {
    assert.match(detail, new RegExp(`requestGuard\\.begin\\("${operation}"\\)`));
  }
  assert.match(detail, /signal: request\.signal/);
  assert.match(detail, /setupGuard\.dispose\(\)/);
  assert.match(detail, /request\.accepts\(\)/);
});

test("meeting request lifecycle creates a fresh live guard after Strict Mode effect replay", () => {
  const detail = fs.readFileSync(path.join(root, "app", "meetings", "meeting-detail.tsx"), "utf8");
  assert.match(detail, /requestGuardRef = useRef<ReturnType<typeof createMeetingRequestGuard> \| null>\(null\)/);
  assert.match(detail, /useEffect\(\(\) => setupMeetingRequestGuard\(requestGuardRef\), \[\]\)/);
  assert.match(detail, /const setupGuard = createMeetingRequestGuard\(\)/);
  assert.match(detail, /ref\.current = setupGuard/);
  assert.match(detail, /setupGuard\.dispose\(\)/);
  assert.match(detail, /ref\.current === setupGuard/);
  assert.match(detail, /ref\.current = null/);
  assert.doesNotMatch(detail, /useMemo\(\(\) => createMeetingRequestGuard\(\), \[\]\)/);
});

test("meeting detail exposes accessible terminal status and persistent tab panels", () => {
  const detail = fs.readFileSync(path.join(root, "app", "meetings", "meeting-detail.tsx"), "utf8");
  assert.match(detail, /role="status"/);
  assert.match(detail, /aria-live="polite"/);
  assert.match(detail, /Meeting processing was cancelled/);
  assert.match(detail, /hidden=\{activeTab !== "overview"\}/);
  assert.match(detail, /hidden=\{activeTab !== "transcript"\}/);
  assert.doesNotMatch(detail, /#7c7771|#85807a|#918c86/i);
});

test("speaker input is disabled and visibly busy while its save is in flight", () => {
  const detail = fs.readFileSync(path.join(root, "app", "meetings", "meeting-detail.tsx"), "utf8");
  assert.match(detail, /disabled=\{busySpeaker === speakerId\}/);
  assert.match(detail, /aria-busy=\{busySpeaker === speakerId\}/);
  assert.match(detail, /disabled:cursor-wait/);
});

test("desktop meeting proxy keeps the launch token server-side", () => {
  const helper = fs.readFileSync(path.join(root, "lib", "manual-meetings.ts"), "utf8");
  const recorder = fs.readFileSync(path.join(root, "app", "meetings", "meeting-recorder.tsx"), "utf8");
  assert.match(helper, /process\.env\.ARI_DESKTOP_INTERNAL_TOKEN/);
  assert.doesNotMatch(recorder, /ARI_DESKTOP_INTERNAL_TOKEN/);
});

function meetingFixture(id: number, title: string): ManualMeeting {
  return {
    id,
    title,
    status: "completed",
    duration_seconds: null,
    meeting_platform: null,
    summary: null,
    transcript: null,
    action_items: null,
    decisions: null,
    mom: null,
    topics: null,
    attendees: null,
    recording_url: null,
  };
}
