"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
  PageShell,
  Reveal,
  Sticker,
  HandLabel,
  BlackPill,
  OutlinePill,
} from "../../_shared";
import type { Feature } from "@/lib/features-data";

/* Map original brutal classes → nudge palette */
const CATEGORY_BG: Record<string, string> = {
  "bg-card-teal": "#7BD3F7",
  "bg-card-lemon": "#FFE38C",
  "bg-card-pink": "#FFB1D8",
  "bg-card-orange": "#FF9D6E",
  "bg-card-lime": "#DAF464",
  "bg-card-purple text-white": "#B7A8FF",
  "bg-card": "#FCFDFF",
};

function colorFor(c: string) {
  return CATEGORY_BG[c] || "#FFE38C";
}
function isDark(c: string) {
  return c.includes("text-white");
}

interface Props {
  feature: Feature;
  related: Feature[];
}

export default function FeatureSlugClient({ feature, related }: Props) {
  const heroBg = colorFor(feature.color);
  const dark = isDark(feature.color);

  return (
    <PageShell>
      {/* BREADCRUMB */}
      <section className="border-b border-black/10">
        <div className="max-w-[1300px] mx-auto px-6 lg:px-10 py-4 flex items-center gap-2 text-[13px]">
          <Link
            href="/preview-nudge/features"
            className="text-black/60 hover:text-black transition-colors"
          >
            ← All Features
          </Link>
          <span className="text-black/30">/</span>
          <span className="font-bold">{feature.category}</span>
        </div>
      </section>

      {/* HERO */}
      <section className="relative pt-12 pb-32 lg:pb-40 overflow-hidden">
        <Reveal className="text-center">
          <HandLabel text="zoom in →" width={120} />
        </Reveal>

        <Reveal delay={0.15}>
          <div className="text-center mt-8 label-caps text-black/55">
            {feature.category}
          </div>
        </Reveal>

        <motion.h1
          initial={{ opacity: 0, scale: 0.92, y: 40 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.3 }}
          className="font-display text-center leading-[0.85] text-[clamp(22px,3.6vw,34px)] mt-4 px-4"
        >
          <span
            className="inline-block border-[3px] border-black px-6 -rotate-1 rounded-lg shadow-[6px_6px_0_#000]"
            style={{
              background: heroBg,
              color: dark ? "white" : "black",
            }}
          >
            {feature.title}
          </span>
        </motion.h1>

        <Reveal delay={0.4}>
          <p className="font-handwritten text-[26px] text-center mt-12 max-w-3xl mx-auto leading-tight px-6">
            {feature.tagline}
          </p>
        </Reveal>

        <Reveal delay={0.5}>
          <p className="mt-8 text-center text-[15px] lg:text-[16px] leading-relaxed text-black/70 max-w-2xl mx-auto px-6">
            {feature.overview}
          </p>
        </Reveal>

        <div className="absolute hidden md:block top-[100px] left-[5%]">
          <Sticker bg="#9BE7BF" rotate={-10} delay={0.6}>
            FEATURE DEEP DIVE
          </Sticker>
        </div>
        <div className="absolute hidden md:block top-[120px] right-[6%]">
          <Sticker bg="#FFE38C" rotate={9} delay={0.7} shape="tape">
            WHATSAPP OR DASHBOARD
          </Sticker>
        </div>
      </section>

      {/* WHO IT'S FOR */}
      <section className="py-14 lg:py-18 max-w-[1300px] mx-auto px-6 lg:px-10">
        <Reveal>
          <div className="label-caps text-black/55 mb-5">Built for</div>
        </Reveal>
        <div className="flex flex-wrap gap-3">
          {feature.whoFor.map((who, i) => (
            <Reveal key={who} delay={i * 0.06}>
              <motion.div
                whileHover={{ rotate: -2, scale: 1.04 }}
                className="bg-white border-[2.5px] border-black px-5 py-2.5 font-bold text-[14px]"
                style={{ borderRadius: 999, boxShadow: "3px 3px 0 #000" }}
              >
                {who}
              </motion.div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* USE CASES */}
      <section className="py-10 lg:py-14 overflow-hidden bg-[#0E0E0C] text-white">
        <div className="max-w-[1300px] mx-auto px-6 lg:px-10">
          <Reveal className="mb-4">
            <div className="font-handwritten text-[26px] text-[#FFE38C]">
              how people use it →
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <h2 className="font-display text-[clamp(26px,4.4vw,48px)] leading-[0.88] mb-10">
              USE CASES.
            </h2>
          </Reveal>

          <div className="grid sm:grid-cols-2 gap-5 lg:gap-6">
            {feature.useCases.map((uc, i) => (
              <Reveal key={uc.title} delay={i * 0.07}>
                <motion.div
                  whileHover={{ y: -5, rotate: i % 2 === 0 ? -1 : 1 }}
                  transition={{ type: "spring", stiffness: 220, damping: 15 }}
                  className="bg-white text-black border-[2.5px] border-black p-5 h-full"
                  style={{ borderRadius: 12, boxShadow: "5px 5px 0 #FFFFFF" }}
                >
                  <div className="text-[42px] mb-3">{uc.emoji}</div>
                  <h3 className="font-body-big text-[22px] mb-2">{uc.title}</h3>
                  <p className="text-[14px] leading-relaxed text-black/70 mb-5">
                    {uc.desc}
                  </p>
                  <div
                    className="bg-[#FFE38C] border-2 border-black px-3 py-2.5 text-[13px] italic"
                    style={{ borderRadius: 6 }}
                  >
                    {uc.example}
                  </div>
                </motion.div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* CHAT DEMO */}
      <section className="py-10 lg:py-14 overflow-hidden bg-[#FFFBED] border-y-[2.5px] border-black">
        <div className="max-w-[1100px] mx-auto px-6 lg:px-10 grid lg:grid-cols-2 gap-12 items-center">
          <Reveal>
            <HandLabel text="try it →" width={100} className="mb-4" />
            <h2 className="font-body-big text-[clamp(20px,3.2vw,34px)] mb-6">
              Just{" "}
              <span className="inline-block bg-white border-[2.5px] border-black px-4 py-1 -rotate-1 rounded-md shadow-[4px_4px_0_#000]">
                say it.
              </span>
            </h2>
            <p className="text-[14px] lg:text-[15px] leading-relaxed text-black/70">
              Here&apos;s what it looks like on WhatsApp. No menus. No forms.
              Just text.
            </p>
          </Reveal>

          <Reveal delay={0.2}>
            <motion.div
              animate={{ rotate: [1, -1, 1] }}
              transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
              className="bg-white border-[2.5px] border-black p-6 rounded-2xl"
              style={{ boxShadow: "8px 8px 0 #000" }}
            >
              <div className="flex items-center gap-3 mb-5 pb-4 border-b border-black/10">
                <div className="w-10 h-10 rounded-full bg-[#B7A8FF] border-2 border-black flex items-center justify-center text-white font-bold">
                  S
                </div>
                <div>
                  <div className="font-bold text-[14px]">Ari</div>
                  <div className="text-[11px] text-black/55">online</div>
                </div>
              </div>
              <div className="flex justify-end mb-3">
                <div className="bg-[#7BD3F7] border-2 border-black px-4 py-2.5 rounded-2xl max-w-[85%]">
                  <p className="text-[14px] whitespace-pre-line">
                    {feature.chat.user}
                  </p>
                </div>
              </div>
              <div className="flex justify-start">
                <div className="bg-[#FFB1D8] border-2 border-black px-4 py-2.5 rounded-2xl max-w-[90%]">
                  <p className="text-[14px] whitespace-pre-line leading-snug">
                    {feature.chat.ari}
                  </p>
                </div>
              </div>
            </motion.div>
          </Reveal>
        </div>
      </section>

      {/* BENEFITS */}
      <section className="py-10 lg:py-14 max-w-[1300px] mx-auto px-6 lg:px-10">
        <Reveal>
          <HandLabel text="why it matters →" width={180} className="mb-4" />
        </Reveal>
        <Reveal delay={0.1}>
          <h2 className="font-display text-[clamp(26px,4.4vw,48px)] leading-[0.88] mb-10">
            BENEFITS.
          </h2>
        </Reveal>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {feature.benefits.map((b, i) => {
            const colors = ["#7BD3F7", "#FFE38C", "#FFB1D8", "#FF9D6E"];
            return (
              <Reveal key={b} delay={i * 0.06}>
                <motion.div
                  whileHover={{ y: -5, rotate: i % 2 === 0 ? -2 : 2 }}
                  transition={{ type: "spring", stiffness: 220, damping: 15 }}
                  className="border-[2.5px] border-black p-6 h-full"
                  style={{
                    background: colors[i % 4],
                    borderRadius: 12,
                    boxShadow: "5px 5px 0 #000",
                  }}
                >
                  <div className="bg-black text-white border-2 border-black w-11 h-11 flex items-center justify-center font-display text-[18px] mb-4 rounded-md">
                    {String(i + 1).padStart(2, "0")}
                  </div>
                  <p className="font-body-big text-[18px] leading-snug">{b}</p>
                </motion.div>
              </Reveal>
            );
          })}
        </div>
      </section>

      {/* RELATED */}
      {related.length > 0 && (
        <section className="py-10 lg:py-14 overflow-hidden bg-[#FFFBED] border-y-[2.5px] border-black">
          <div className="max-w-[1300px] mx-auto px-6 lg:px-10">
            <Reveal>
              <HandLabel
                text="more from this category →"
                width={250}
                className="mb-4"
              />
            </Reveal>
            <Reveal delay={0.1}>
              <h2 className="font-body-big text-[clamp(20px,3.2vw,32px)] mb-12">
                You might also like.
              </h2>
            </Reveal>
            <div className="grid md:grid-cols-3 gap-5 lg:gap-6">
              {related.map((r, i) => {
                const bg = colorFor(r.color);
                const dk = isDark(r.color);
                return (
                  <Reveal key={r.slug} delay={i * 0.08}>
                    <Link
                      href={`/preview-nudge/features/${r.slug}`}
                      className="block h-full"
                    >
                      <motion.div
                        whileHover={{ y: -5, rotate: i % 2 === 0 ? -1 : 1 }}
                        className="border-[2.5px] border-black p-5 h-full flex flex-col"
                        style={{
                          background: bg,
                          color: dk ? "white" : "black",
                          borderRadius: 12,
                          boxShadow: "5px 5px 0 #000",
                        }}
                      >
                        <h3 className="font-body-big text-[22px] mb-2 leading-tight">
                          {r.title}
                        </h3>
                        <p
                          className={`text-[14px] leading-relaxed flex-1 mb-4 ${
                            dk ? "text-white/80" : "text-black/70"
                          }`}
                        >
                          {r.tagline}
                        </p>
                        <span
                          className={`label-caps ${
                            dk ? "text-[#FFE38C]" : "text-black"
                          }`}
                        >
                          Learn more →
                        </span>
                      </motion.div>
                    </Link>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* CTA */}
      <section className="py-10 lg:py-14 overflow-hidden">
        <div className="max-w-3xl mx-auto px-6 lg:px-10 text-center">
          <Reveal>
            <HandLabel text="ready?" width={80} className="mb-4" />
          </Reveal>
          <Reveal delay={0.1}>
            <h2 className="font-display text-[clamp(24px,4vw,40px)] leading-[0.88]">
              TRY IT
              <br />
              <span
                className="inline-block border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]"
                style={{
                  background: heroBg,
                  color: dark ? "white" : "black",
                }}
              >
                RIGHT NOW.
              </span>
            </h2>
          </Reveal>
          <Reveal delay={0.2}>
            <p className="mt-10 text-[14px] lg:text-[15px] text-black/70 max-w-xl mx-auto">
              {feature.title} works from WhatsApp or the dashboard. Free for
              everyone, with full access.
            </p>
          </Reveal>
          <Reveal delay={0.3}>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <BlackPill href="http://127.0.0.1:43101">OPEN ARI DESKTOP</BlackPill>
              <OutlinePill href="/preview-nudge/features">
                SEE ALL FEATURES →
              </OutlinePill>
            </div>
          </Reveal>
        </div>
      </section>
    </PageShell>
  );
}
