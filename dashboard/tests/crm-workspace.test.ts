import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("CRM navigation follows the approved contact-to-campaign flow", () => {
  const nav = read("components/crm-subnav.tsx");
  for (const [href, label] of [
    ["/contacts", "Contacts"],
    ["/contacts/groups", "Groups"],
    ["/contacts/campaigns", "Campaigns"],
    ["/contacts/activity", "Email activity"],
    ["/contacts/analytics", "Analytics"],
  ]) {
    assert.match(nav, new RegExp(`href:.*"${href}"`), label);
    assert.match(nav, new RegExp(`label:.*"${label}"`), label);
  }
  assert.doesNotMatch(nav, /label:\s*"All contacts"/);
});

test("email activity is batch-first with email, metrics, and recipient detail", () => {
  const page = read("app/contacts/activity/page.tsx");
  const activity = read("app/contacts/activity/email-activity.tsx");
  const detailApi = read("app/api/campaigns/[id]/route.ts");

  assert.match(page, /title="Email activity"/);
  assert.match(activity, /Campaign performance/);
  assert.match(activity, /Email sent/);
  assert.match(activity, /Recipients/);
  assert.match(activity, /Delivery rate/);
  assert.match(activity, /Open rate/);
  assert.match(activity, /Click rate/);
  assert.match(activity, /recipient_email/);
  assert.match(activity, /send_status/);
  assert.match(detailApi, /body_template/);
  assert.match(detailApi, /recipient_email/);
  assert.match(detailApi, /campaign_id/);
});

test("CRM analytics exposes the core email performance metrics", () => {
  const page = read("app/contacts/analytics/page.tsx");
  const analytics = read("app/contacts/analytics/crm-analytics.tsx");

  assert.match(page, /title="Analytics"/);
  for (const metric of [
    "Emails sent",
    "Delivery rate",
    "Open rate",
    "Click rate",
    "Reply rate",
    "Bounce rate",
  ]) {
    assert.match(analytics, new RegExp(metric), metric);
  }
});

test("demo mode includes realistic campaign and recipient activity", () => {
  const db = read("lib/db.ts");
  assert.match(db, /CREATE TABLE bulk_email_campaigns/);
  assert.match(db, /CREATE TABLE email_sends/);
  assert.match(db, /Product launch follow-up/);
  assert.match(db, /recipient_email/);
  assert.match(db, /opened_at/);
  assert.match(db, /clicked_at/);
});

test("contacts expose complete functional management controls", () => {
  const contacts = read("app/contacts/contacts-content.tsx");
  const contactApi = read("app/api/contacts/[id]/route.ts");
  for (const control of ["Add contact", "Import CSV", "Filter by stage", "Sort contacts", "Archive", "Restore", "Delete permanently", "Save changes"]) {
    assert.match(contacts, new RegExp(control), control);
  }
  assert.match(contactApi, /export async function PATCH/);
  assert.match(contactApi, /export async function DELETE/);
});

test("groups support create edit membership archive and delete workflows", () => {
  const groups = read("app/contacts/groups/groups-list.tsx");
  const detail = read("app/contacts/groups/[id]/group-detail.tsx");
  const groupApi = read("app/api/groups/[id]/route.ts");
  for (const control of ["Create group", "Edit group", "Archive group", "Delete group"]) assert.match(groups, new RegExp(control), control);
  assert.match(detail, /Add people/);
  assert.match(detail, /Remove members/);
  assert.match(groupApi, /export async function PATCH/);
  assert.match(groupApi, /export async function DELETE/);
});

test("campaign workflow includes audience pacing scheduling and lifecycle actions", () => {
  const campaigns = read("app/contacts/campaigns/campaigns-list.tsx");
  const composer = read("app/contacts/groups/[id]/email/composer.tsx");
  const campaignApi = read("app/api/campaigns/[id]/route.ts");
  assert.match(campaigns, /Daily sending limit/);
  assert.match(campaigns, /Continue to email/);
  assert.match(campaigns, /archive/);
  assert.match(campaigns, /delete/);
  assert.match(composer, /scheduledFor/);
  assert.match(composer, /dailyLimit/);
  assert.match(campaignApi, /export async function PATCH/);
  assert.match(campaignApi, /export async function DELETE/);
});
