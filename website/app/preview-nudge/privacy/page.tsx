"use client";

import {
  PageShell,
  Reveal,
  Sticker,
  HandLabel,
  BlackPill,
  OutlinePill,
} from "../_shared";
import { motion } from "framer-motion";

const sections = [
  {
    title: "1. Who We Are",
    content: `Ari ("we", "our", "us") operates an AI-powered work management platform accessible via WhatsApp and the Ari desktop app. Support is available from Ari Desktop. By using Ari, you agree to this Privacy Policy.`,
  },
  {
    title: "2. Data We Collect",
    content: `We collect only what is necessary to provide the service:

• WhatsApp phone number and profile name (to identify your account)
• Messages and commands you send to Ari (reminders, notes, tasks, calendar entries)
• OAuth tokens from Google or Microsoft (when you connect your calendar or email)
• Meeting recordings and transcriptions (only when you explicitly start a recording)
• Usage metadata (message timestamps, feature usage counts for rate limiting and billing)
• Google Workspace data (emails, calendar events, documents, contacts, tasks) — ONLY when you explicitly connect your Google account and ONLY the specific data you ask Ari to access. We never passively read or store your entire mailbox or calendar.
• Microsoft 365 data (Outlook emails, calendar) — ONLY when you explicitly connect your Microsoft account and on the same conditions as above.

We do NOT collect passwords. We do NOT passively read your inbox. We do NOT sell your data.`,
  },
  {
    title: "3. How We Use Your Data",
    content: `Your data is used solely to:

• Respond to your commands and provide the features you request
• Send you reminders, summaries, and briefings you have set up
• Sync with Google Calendar, Gmail, Outlook, or Zoom on your behalf (only when you ask)
• Improve service reliability and debug errors (using anonymised logs)

We do not use your data to train AI models without your explicit consent.`,
  },
  {
    title: "4. Data Storage & Security",
    content: `• All OAuth tokens are encrypted at rest using AES-256-GCM encryption (authenticated encryption that also verifies data integrity)
• All data is transmitted over HTTPS / TLS
• Rate limiting is enforced (30 messages/minute per user) to prevent abuse
• SSRF protection is enforced on all external API calls
• Access to production data is restricted to authorised personnel only
• We use Supabase (hosted on AWS) as our primary database, which maintains SOC 2 compliance`,
  },
  {
    title: "5. Third-Party Integrations",
    content: `When you connect third-party accounts, you grant Ari OAuth access scopes you explicitly approve:

• Google (Calendar, Gmail, Meet): governed by Google's Privacy Policy
• Microsoft (Outlook): governed by Microsoft's Privacy Policy
• WhatsApp: governed by Meta's Privacy Policy
• Zoom: governed by Zoom's Privacy Policy

We only request the minimum permissions required. You can revoke any integration at any time.`,
  },
  {
    title: "6. Google API Services — Limited Use Disclosure",
    content: `Ari's use and transfer of information received from Google APIs to any other app will adhere to the Google API Services User Data Policy, including the Limited Use requirements.

Specifically, we affirm that:

• We only use your Google user data to provide or improve user-facing features that are prominent in Ari's WhatsApp and web dashboard interfaces (reminders, email management, calendar events, document access, contact resolution, etc.).

• We do NOT transfer your Google user data to third parties except as necessary to provide or improve these user-facing features, to comply with applicable law, or as part of a merger, acquisition, or sale of assets (with prior user notification).

• We do NOT use your Google user data to serve advertisements of any kind.

• We do NOT allow humans to read your Google user data unless:
  - We have your affirmative consent for specific messages
  - It is necessary for security purposes (e.g., investigating abuse)
  - It is necessary to comply with applicable law
  - The data is aggregated and anonymized, used only for internal operations

• We do NOT use your Google user data to train AI models, develop generalized AI/ML models, or for any purpose other than providing you the Ari service.

You can revoke Ari's access to your Google account at any time by visiting https://myaccount.google.com/permissions or by messaging Ari "disconnect google".

For more details on Google's requirements, see the Google API Services User Data Policy: https://developers.google.com/terms/api-services-user-data-policy`,
  },
  {
    title: "7. Data Retention & Deletion",
    content: `• Active account data is retained for as long as your account is active
• If you cancel your account or request deletion, all your data — reminders, memories, notes, contacts, conversation history, and connected account tokens — is permanently deleted within 30 days
• Billing records may be retained for up to 7 years as required by Indian tax law
• You can request deletion from Settings > Support in Ari Desktop`,
  },
  {
    title: "8. Your Rights",
    content: `You have the right to:

• Access a copy of the personal data we hold about you
• Correct inaccurate data
• Request deletion of your data ("right to be forgotten")
• Withdraw consent for any integration at any time
• Object to processing of your data for certain purposes

To exercise any of these rights, use Settings > Support in Ari Desktop. We will respond within 30 days.`,
  },
  {
    title: "9. Cookies",
    content: `The Ari marketing preview and desktop app use minimal, essential cookies only — no third-party tracking cookies and no advertising cookies. The WhatsApp control surface does not use cookies.`,
  },
  {
    title: "10. Children's Privacy",
    content: `Ari is not intended for users under 13 years of age. We do not knowingly collect personal data from children. If you believe a child has provided us with personal data, use Settings > Support in Ari Desktop and we will delete it immediately.`,
  },
  {
    title: "11. Changes to This Policy",
    content: `We may update this Privacy Policy from time to time. When we do, we will notify you via WhatsApp or email and update the "Last updated" date below. Continued use of Ari after changes constitutes acceptance of the updated policy.`,
  },
  {
    title: "12. Contact Us",
    content: `For any privacy-related questions, requests, or concerns, use Settings > Support in Ari Desktop.\n\nWe aim to respond to all privacy inquiries within 3 business days.`,
  },
];

export default function PrivacyNudge() {
  return (
    <PageShell>
      {/* HERO */}
      <section className="relative pt-8 pb-14 overflow-hidden">
        <Reveal className="text-center">
          <HandLabel text="legal stuff →" width={140} />
        </Reveal>

        <motion.h1
          initial={{ opacity: 0, scale: 0.92, y: 40 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.3 }}
          className="font-display text-center leading-[0.85] text-[clamp(30px,5vw,56px)] mt-10 px-4"
        >
          PRIVACY
          <br />
          <span className="inline-block bg-[#9BE7BF] border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
            POLICY.
          </span>
        </motion.h1>

        <Reveal delay={0.4}>
          <p className="mt-12 text-center text-[15px] lg:text-[16px] leading-relaxed text-black/70 max-w-2xl mx-auto px-6">
            Privacy is a right, not a feature. Here&apos;s exactly what we
            collect, why, and how we protect it — in plain English.
          </p>
        </Reveal>

        <Reveal delay={0.5}>
          <div className="mt-8 text-center label-caps text-black/55">
            Last updated · April 2026
          </div>
        </Reveal>

        <div className="absolute hidden md:block top-[140px] left-[5%]">
          <Sticker bg="#FFE38C" rotate={-9} delay={0.6}>
            AES-256 ENCRYPTED
          </Sticker>
        </div>
        <div className="absolute hidden md:block top-[160px] right-[6%]">
          <Sticker bg="#FFB1D8" rotate={9} delay={0.7} shape="tape">
            ZERO TRACKING
          </Sticker>
        </div>
      </section>

      {/* SECTIONS */}
      <section className="py-14 lg:py-18 max-w-3xl mx-auto px-6 lg:px-10">
        <div className="space-y-5 lg:space-y-6">
          {sections.map((s, i) => (
            <Reveal key={s.title} delay={i * 0.04}>
              <motion.div
                whileHover={{ x: 4 }}
                transition={{ type: "spring", stiffness: 220, damping: 15 }}
                className="bg-white border-[2.5px] border-black p-5 lg:p-9"
                style={{ borderRadius: 12, boxShadow: "5px 5px 0 #000" }}
              >
                <h2 className="font-body-big text-[15px] lg:text-[18px] mb-4">
                  {s.title}
                </h2>
                <p className="text-[15px] leading-[1.7] text-black/75 whitespace-pre-line">
                  {s.content}
                </p>
              </motion.div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* CONTACT CTA */}
      <section className="py-10 lg:py-14 overflow-hidden bg-[#FFFBED] border-y-[2.5px] border-black">
        <div className="max-w-3xl mx-auto px-6 lg:px-10 text-center">
          <Reveal>
            <HandLabel text="questions?" width={120} className="mb-4" />
          </Reveal>
          <Reveal delay={0.1}>
            <h2 className="font-display text-[clamp(24px,4vw,40px)] leading-[0.88]">
              ASK A
              <br />
              <span className="inline-block bg-[#7BD3F7] border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
                HUMAN.
              </span>
            </h2>
          </Reveal>
          <Reveal delay={0.2}>
            <p className="mt-10 text-[15px] lg:text-[16px] text-black/70">
              Open Ari Desktop and use Settings &gt; Support. A real person will
              read it and reply within 3 business days.
            </p>
          </Reveal>
          <Reveal delay={0.3}>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <BlackPill href="http://127.0.0.1:43101" iconBg="#FFE38C" iconChar="✉">
                OPEN ARI SUPPORT
              </BlackPill>
              <OutlinePill href="/preview-nudge/terms">READ TERMS →</OutlinePill>
            </div>
          </Reveal>
        </div>
      </section>
    </PageShell>
  );
}
