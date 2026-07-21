export function conversationPhoneCandidates(phone: string): string[] {
  const normalized = phone.replace(/\D/g, "");
  return normalized && normalized !== phone ? [phone, normalized] : [phone];
}
