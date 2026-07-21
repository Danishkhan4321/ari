// Shared WhatsApp helpers for onboarding surfaces (/get-started, /login).

const DEFAULT_ARI_WHATSAPP_NUMBER = "918448089096";

export function ariWhatsAppDigits(): string {
  const raw =
    process.env.DASHBOARD_WHATSAPP_NUMBER
    || process.env.PUBLIC_WHATSAPP_NUMBER
    || process.env.ARI_WHATSAPP_NUMBER
    || DEFAULT_ARI_WHATSAPP_NUMBER;
  return raw.replace(/\D/g, "");
}

export function formatWhatsAppDisplay(digits: string): string {
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 12 && digits.startsWith("91")) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return `+${digits}`;
}
export function whatsappDeepLink(prefill: string): string {
  const digits = ariWhatsAppDigits();
  if (!digits) return "";
  return `https://wa.me/${digits}?text=${encodeURIComponent(prefill)}`;
}
