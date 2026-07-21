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
    title: "1. Acceptance of Terms",
    content: `By accessing or using Ari (the "Service"), you agree to be bound by these Terms & Conditions ("Terms"). If you do not agree to these Terms, do not use the Service.

These Terms apply to all users of the Service. Ari is operated and owned by the Ari team. Support is available from Ari Desktop.`,
  },
  {
    title: "2. Description of Service",
    content: `Ari is an AI-powered work management platform accessible via WhatsApp and a web dashboard. The Service includes features such as reminders, task management, calendar integration, email management, meeting transcription, team standups, sales pipeline tracking, and more.

Ari is provided free of charge. All features are available to every user at no cost.`,
  },
  {
    title: "3. Eligibility",
    content: `You must be at least 13 years of age to use Ari. By using the Service, you represent that you meet this requirement. If you are using Ari on behalf of a company or organisation, you represent that you have authority to bind that entity to these Terms.`,
  },
  {
    title: "4. Account & Access",
    content: `• Your Ari account is tied to your WhatsApp phone number
• You are responsible for maintaining the security of your WhatsApp account
• You must not share your account access with others or use automation to send messages to Ari beyond normal usage
• We reserve the right to suspend or terminate accounts that violate these Terms
• You are responsible for all activity that occurs under your account`,
  },
  {
    title: "5. Acceptable Use",
    content: `You agree NOT to use Ari to:

• Violate any applicable law or regulation in India or your jurisdiction
• Send spam, unsolicited messages, or bulk automated requests
• Attempt to reverse-engineer, scrape, or extract data from the Service
• Transmit viruses, malware, or any harmful code
• Harass, abuse, or harm other users or third parties
• Circumvent rate limits or usage caps
• Use the Service for any illegal activity including fraud, money laundering, or financing of terrorism

Violation of this section may result in immediate account termination without refund.`,
  },
  {
    title: "6. Cost of Service",
    content: `• Ari is free to use — there are no subscription plans, tiers, or fees
• All features are available to every user at no cost
• We do not collect payment information and there is no billing
• If we ever introduce optional paid features in the future, we will update these Terms and notify you in advance`,
  },
  {
    title: "7. Feature Availability",
    content: `• Every feature of the Service is unlocked for all users
• We may add, change, or remove features over time to improve the Service
• We will make reasonable efforts to notify you of material changes to core features`,
  },
  {
    title: "8. Third-Party Integrations",
    content: `Ari integrates with third-party services including Google Workspace, Microsoft 365, WhatsApp (Meta), and Zoom. Your use of these integrations is also governed by the respective third party's terms of service and privacy policies.

When you connect your Google account to Ari, you agree to comply with:
• Google's Terms of Service: https://policies.google.com/terms
• Google API Services User Data Policy: https://developers.google.com/terms/api-services-user-data-policy

Ari complies with the Google API Services User Data Policy, including the Limited Use requirements. Details on how Ari handles your Google user data are described in the Privacy Policy included with Ari.

We are not responsible for the availability, accuracy, or conduct of any third-party service. If a third-party service becomes unavailable, the corresponding Ari feature may also become unavailable.

You can revoke any third-party integration at any time by:
• Messaging Ari "disconnect [service name]" (e.g., "disconnect google")
• Visiting the third party's security settings directly
• Using Settings > Support in Ari Desktop to request manual revocation`,
  },
  {
    title: "9. Intellectual Property",
    content: `• All intellectual property in the Service — including the software, AI models, branding, UI design, and documentation — belongs to Ari
• We grant you a limited, non-exclusive, non-transferable licence to use the Service for your own personal or business use
• You retain ownership of all content you create using Ari (reminders, notes, documents, etc.)
• You grant Ari a limited licence to process your content solely to provide the Service to you`,
  },
  {
    title: "10. Data & Privacy",
    content: `Your use of the Service is also governed by the Privacy Policy included with Ari. The Privacy Policy is incorporated into these Terms by reference.`,
  },
  {
    title: "11. Disclaimer of Warranties",
    content: `The Service is provided "as is" and "as available" without warranties of any kind, either express or implied. We do not warrant that:

• The Service will be uninterrupted or error-free
• AI-generated outputs (reminders, summaries, emails) will be perfectly accurate
• The Service will meet all your requirements

You use AI-generated content at your own discretion. Always verify critical information (meeting details, financial figures, medical advice) independently.`,
  },
  {
    title: "12. Limitation of Liability",
    content: `To the maximum extent permitted by applicable law, Ari shall not be liable for any indirect, incidental, special, consequential, or punitive damages including loss of profits, data, or business arising from your use of the Service.

Because the Service is provided free of charge, our total liability to you for any claim shall not exceed INR 1,000 (or the maximum amount permitted by applicable law, whichever is lower).`,
  },
  {
    title: "13. Termination",
    content: `• You may terminate your account at any time by messaging Ari or using Settings > Support in Ari Desktop
• We may suspend or terminate your account immediately if you breach these Terms
• Upon termination, your access to the Service ends and your data is deleted within 30 days per our Privacy Policy
• Sections on intellectual property, limitation of liability, and governing law survive termination`,
  },
  {
    title: "14. Changes to Terms",
    content: `We may update these Terms from time to time. We will notify you of material changes via WhatsApp or email at least 14 days before they take effect. Continued use of the Service after changes constitutes acceptance of the new Terms.`,
  },
  {
    title: "15. Governing Law & Disputes",
    content: `These Terms are governed by the laws of India. Any disputes arising from these Terms or your use of the Service shall be subject to the exclusive jurisdiction of the courts of India.

For informal dispute resolution, please use Settings > Support in Ari Desktop first. We will make every effort to resolve disputes within 14 business days.`,
  },
  {
    title: "16. Contact",
    content: `For any questions about these Terms, use Settings > Support in Ari Desktop.\n\nWe aim to respond to all legal queries within 3 business days.`,
  },
];

export default function TermsNudge() {
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
          TERMS &amp;
          <br />
          <span className="inline-block bg-[#FFB1D8] border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
            CONDITIONS.
          </span>
        </motion.h1>

        <Reveal delay={0.4}>
          <p className="mt-12 text-center text-[15px] lg:text-[16px] leading-relaxed text-black/70 max-w-2xl mx-auto px-6">
            Please read these terms carefully before using Ari. They govern
            your use of the service and our relationship with you.
          </p>
        </Reveal>

        <Reveal delay={0.5}>
          <div className="mt-8 text-center label-caps text-black/55">
            Last updated · April 2026
          </div>
        </Reveal>

        <div className="absolute hidden md:block top-[140px] left-[5%]">
          <Sticker bg="#7BD3F7" rotate={-10} delay={0.6}>
            14-DAY REFUND
          </Sticker>
        </div>
        <div className="absolute hidden md:block top-[160px] right-[6%]">
          <Sticker bg="#FFE38C" rotate={9} delay={0.7} shape="tape">
            CANCEL ANYTIME
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
            <HandLabel text="legal questions?" width={170} className="mb-4" />
          </Reveal>
          <Reveal delay={0.1}>
            <h2 className="font-display text-[clamp(24px,4vw,40px)] leading-[0.88]">
              EMAIL
              <br />
              <span className="inline-block bg-[#9BE7BF] border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
                A HUMAN.
              </span>
            </h2>
          </Reveal>
          <Reveal delay={0.3}>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <BlackPill href="http://127.0.0.1:43101" iconBg="#FFE38C" iconChar="✉">
                OPEN ARI SUPPORT
              </BlackPill>
              <OutlinePill href="/preview-nudge/privacy">READ PRIVACY →</OutlinePill>
            </div>
          </Reveal>
        </div>
      </section>
    </PageShell>
  );
}
