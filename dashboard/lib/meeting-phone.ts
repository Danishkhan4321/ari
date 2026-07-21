export function meetingIdentityCandidates(identity: string): string[] {
  const value = String(identity || "").trim();
  const numeric = value.match(/^\+?(\d{5,20})$/);
  if (numeric) return [numeric[1], `+${numeric[1]}`];
  return value ? [value] : [];
}
