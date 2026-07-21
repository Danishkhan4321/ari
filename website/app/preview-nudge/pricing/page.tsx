"use client";

import {
  PageShell,
  Reveal,
  HandLabel,
  Sticker,
  BlackPill,
  OutlinePill,
} from "../_shared";
import { motion } from "framer-motion";

const included = [
  "Unlimited reminders & long-term memory",
  "AI chat with live web search",
  "Notes, lists & knowledge base",
  "Email management & unified calendar",
  "Tasks, projects & team standups",
  "Contacts, CRM & campaigns",
  "Manual meeting recording, transcripts & reports",
  "Expense tracking & daily briefing",
  "Voice messages in 100+ languages",
];

const faqs = [
  {
    q: "How much does Ari cost?",
    a: "Nothing. Ari is completely free — every feature, full access, no paid plans.",
  },
  {
    q: "Is there a paid tier I'll be pushed into?",
    a: "No. There are no tiers, no upgrades, and no billing. Everyone gets everything.",
  },
  {
    q: "Do I need a credit card to start?",
    a: "Never. Just message Ari on WhatsApp and start using it right away.",
  },
  {
    q: "Are any features locked?",
    a: "No. All 80+ tools — from memory to the meeting recorder — are unlocked for everyone.",
  },
];

export default function PricingNudge() {
  return (
    <PageShell>
      {/* HERO */}
      <section className="relative pt-12 pb-14 lg:pb-20 overflow-hidden">
        <Reveal className="text-center">
          <HandLabel text="great news!" width={150} />
        </Reveal>

        <motion.h1
          initial={{ opacity: 0, scale: 0.92, y: 40 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.3 }}
          className="font-display text-center leading-[0.85] text-[clamp(32px,5vw,60px)] mt-10 px-4"
        >
          ARI IS
          <br />
          <span className="inline-block bg-[#9BE7BF] border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
            FREE.
          </span>
        </motion.h1>

        <Reveal delay={0.4}>
          <p className="mt-12 text-center text-[15px] lg:text-[17px] leading-relaxed text-black/70 max-w-2xl mx-auto px-6">
            No plans. No prices. No upgrades. Every tool, every feature — full
            access for everyone, from your very first message.
          </p>
        </Reveal>

        <div className="absolute hidden md:block top-[140px] left-[5%]">
          <Sticker bg="#9BE7BF" rotate={-9} delay={0.6}>
            FREE FOREVER
          </Sticker>
        </div>
        <div className="absolute hidden md:block top-[160px] right-[6%]">
          <Sticker bg="#FF9D6E" rotate={9} delay={0.7} shape="tape">
            NO CREDIT CARD
          </Sticker>
        </div>
      </section>

      {/* WHAT YOU GET */}
      <section className="py-12 lg:py-20 overflow-hidden">
        <div className="max-w-2xl mx-auto px-6 lg:px-10">
          <Reveal>
            <motion.div
              whileHover={{ y: -8 }}
              transition={{ type: "spring", stiffness: 220, damping: 15 }}
              className="relative bg-white border-[2.5px] border-black p-8 lg:p-10"
              style={{ borderRadius: 14, boxShadow: "8px 8px 0 #000" }}
            >
              <div className="flex items-center gap-3 mb-4">
                <h3 className="font-body-big text-[32px]">Everything</h3>
                <span
                  className="border-2 border-black px-3 py-0.5 text-[10px] font-bold tracking-[0.16em]"
                  style={{ background: "#9BE7BF", borderRadius: 999 }}
                >
                  FREE FOREVER
                </span>
              </div>
              <p className="text-[14px] text-black/65 leading-relaxed mb-6">
                All 80+ AI tools, unlocked for everyone. Your entire productivity
                stack replaced by one chat — at no cost.
              </p>

              <a
                href="http://127.0.0.1:43101"
                className="block w-full text-center py-3.5 font-bold text-[13px] tracking-[0.14em] border-2 border-black mb-6 bg-[#FFE38C] transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none"
                style={{ borderRadius: 999, boxShadow: "4px 4px 0 #000" }}
              >
                OPEN ARI DESKTOP
              </a>

              <ul className="space-y-3">
                {included.map((it) => (
                  <li key={it} className="flex items-start gap-3 text-[14px]">
                    <span className="w-5 h-5 rounded-full bg-[#9BE7BF] border-2 border-black flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">
                      ✓
                    </span>
                    <span className="text-black/80 leading-snug">{it}</span>
                  </li>
                ))}
              </ul>
            </motion.div>
          </Reveal>

          <Reveal delay={0.4}>
            <p className="text-center text-[13px] text-black/55 mt-12">
              Full access · no credit card · no paid plans, ever.
            </p>
          </Reveal>
        </div>
      </section>

      {/* FAQ STRIP */}
      <section className="py-10 lg:py-14 overflow-hidden bg-[#FFFBED] border-y-[2.5px] border-black">
        <div className="max-w-3xl mx-auto px-6 lg:px-10">
          <Reveal className="text-center mb-4">
            <HandLabel text="quick questions →" width={170} />
          </Reveal>

          <Reveal delay={0.1}>
            <h2 className="font-display text-center text-[clamp(26px,4.4vw,46px)] leading-[0.88] mb-10">
              ANSWERED.
            </h2>
          </Reveal>

          <div className="space-y-4">
            {faqs.map((f, i) => (
              <Reveal key={f.q} delay={i * 0.08}>
                <motion.div
                  whileHover={{ x: 4 }}
                  className="bg-white border-[2.5px] border-black p-6"
                  style={{ borderRadius: 12, boxShadow: "5px 5px 0 #000" }}
                >
                  <div className="font-body-big text-[15px] lg:text-[16px] mb-2">
                    {f.q}
                  </div>
                  <div className="text-[15px] text-black/70 leading-relaxed">
                    {f.a}
                  </div>
                </motion.div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={0.4}>
            <div className="mt-12 text-center">
              <OutlinePill href="/preview-nudge/faq">SEE FULL FAQ →</OutlinePill>
            </div>
          </Reveal>
        </div>
      </section>

      {/* CTA */}
      <section className="py-10 lg:py-14 overflow-hidden">
        <div className="max-w-4xl mx-auto px-6 lg:px-10 text-center">
          <Reveal>
            <HandLabel text="ready?" width={80} className="mb-4" />
          </Reveal>
          <Reveal delay={0.1}>
            <h2 className="font-display text-[clamp(26px,4.4vw,46px)] leading-[0.88]">
              STOP
              <br />
              <span className="inline-block bg-[#9BE7BF] border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
                JUGGLING.
              </span>
            </h2>
          </Reveal>
          <Reveal delay={0.2}>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <BlackPill href="http://127.0.0.1:43101" iconBg="#9BE7BF" iconChar="▶">
                OPEN ARI DESKTOP
              </BlackPill>
              <OutlinePill href="/preview-nudge/features">EXPLORE FEATURES →</OutlinePill>
            </div>
          </Reveal>
        </div>
      </section>
    </PageShell>
  );
}
