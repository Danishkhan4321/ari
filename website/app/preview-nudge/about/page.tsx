"use client";

import {
  PageShell,
  Reveal,
  Sticker,
  HandLabel,
  ArcLine,
  BlackPill,
  OutlinePill,
  HandArrow,
} from "../_shared";
import { motion } from "framer-motion";

const beliefs = [
  {
    n: "01",
    title: "Chaos is the enemy.",
    body: "We don't compete with other apps. We compete with the chaos in your head — the 3 AM anxiety about the email you forgot, the meeting you double-booked, the task that fell through the cracks. Our enemy isn't Todoist. It's the feeling of drowning.",
    bg: "#FF9D6E",
  },
  {
    n: "02",
    title: "We don't organize — we decompress.",
    body: "Organization is putting things in boxes. Decompression is removing the weight entirely. Ari doesn't give you a prettier to-do list. It takes the to-do list out of your head and handles it.",
    bg: "#7BD3F7",
  },
  {
    n: "03",
    title: "Meet people where they are.",
    body: "The world doesn't need another app to learn or another password to remember. People already check chat 100 times a day — so Ari meets you there, and opens up as a full dashboard the moment you want the wider view.",
    bg: "#FFE38C",
  },
  {
    n: "04",
    title: "We don't sell features. We sell clarity.",
    body: "You'll never see us brag about how many integrations we have. The only metric that matters: did you wake up less stressed today? Did you forget fewer things? Did your team spend less time in meetings about meetings?",
    bg: "#FFB1D8",
  },
  {
    n: "05",
    title: "We're building a new category.",
    body: "Not a better reminder app or a better CRM. An agentic operating system for work. An AI layer that sits between you and every tool you use — understanding your context, taking action, and coordinating your workflows, whether you run it from WhatsApp or the dashboard.",
    bg: "#B7A8FF",
    textColor: "white",
  },
];

const timeline = [
  { date: "DAY 1", event: "The idea: what if your entire work life fit inside one chat?" },
  { date: "MONTH 1", event: "First prototype: reminders and notes via WhatsApp." },
  { date: "MONTH 3", event: "Calendar, email, tasks. Users started replacing 3-4 tools." },
  { date: "MONTH 6", event: "Polish on WhatsApp. Users managing entire workflows from chat." },
  { date: "MONTH 9", event: "Manual meeting recording, transcription, reports. Sales pipeline. Team features." },
  { date: "TODAY", event: "80+ AI tools, 15+ integrations, on WhatsApp and the web dashboard — one agentic OS for work. Just the beginning." },
];

const numbers = [
  { val: "80+", label: "AI Tools", bg: "#FFC34D" },
  { val: "15+", label: "Integrations", bg: "#7BD3F7" },
  { val: "1", label: "Platform", bg: "#B7A8FF", textColor: "white" },
  { val: "100+", label: "Languages", bg: "#9BE7BF" },
];

export default function AboutNudge() {
  return (
    <PageShell>
      {/* HERO */}
      <section className="relative pt-12 pb-32 lg:pb-40 overflow-hidden">
        <Reveal className="text-center">
          <HandLabel text="our story →" width={130} />
        </Reveal>

        <motion.h1
          initial={{ opacity: 0, scale: 0.92, y: 40 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.3 }}
          className="font-display text-center leading-[0.85] text-[clamp(32px,5.4vw,64px)] mt-10 px-4"
        >
          CHAOS WON&apos;T
          <br />
          <span className="inline-block bg-[#FFE38C] border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
            WIN TWICE.
          </span>
        </motion.h1>

        <Reveal delay={0.4}>
          <p className="mt-12 text-center text-[15px] lg:text-[17px] leading-relaxed text-black/70 max-w-2xl mx-auto px-6">
            We&apos;re not building another productivity app. We&apos;re building
            the thing that makes productivity apps unnecessary.
          </p>
        </Reveal>

        <div className="absolute hidden md:block top-[140px] left-[5%]">
          <Sticker bg="#9BE7BF" rotate={-10} delay={0.6}>
            FOUNDER&apos;S NOTE
          </Sticker>
          <HandArrow className="absolute -bottom-12 left-12" />
        </div>
        <div className="absolute hidden md:block top-[160px] right-[6%]">
          <Sticker bg="#FF9D6E" rotate={9} delay={0.7} shape="tape">
            EST. 2026
          </Sticker>
        </div>
      </section>

      {/* ORIGIN QUOTE */}
      <section className="relative py-10 lg:py-14 overflow-hidden bg-[#FFFBED] border-y-[2.5px] border-black">
        <div className="-mt-12 mb-12 opacity-40">
          <ArcLine />
        </div>
        <div className="max-w-4xl mx-auto px-6 lg:px-10">
          <Reveal>
            <motion.div
              animate={{ rotate: [-1, 1, -1] }}
              transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
              className="bg-[#FFE38C] border-[2.5px] border-black p-10 lg:p-14"
              style={{ borderRadius: 12, boxShadow: "8px 8px 0 #000" }}
            >
              <div className="font-display text-[42px] leading-none text-black/30 mb-4">
                &ldquo;
              </div>
              <p className="font-body-big text-[20px] lg:text-[26px] leading-[1.25]">
                I had four apps for tasks, three calendars, two email clients,
                and a notes app I forgot to check. I was more organized than
                ever — and more overwhelmed than ever. That&apos;s when I
                realized: the tools were the problem.
              </p>
              <div className="mt-8 label-caps">
                Ari founder
              </div>
            </motion.div>
          </Reveal>

          <div className="mt-10 space-y-6 text-[15px] lg:text-[16px] leading-relaxed text-black/75 max-w-2xl">
            <Reveal>
              <p>
                Ari started with a simple observation: the most productive
                people don&apos;t use the most tools. They use the fewest. They
                have systems that capture, organize, and execute without asking
                for attention.
              </p>
            </Reveal>
            <Reveal delay={0.1}>
              <p>
                We asked: what if that system understood your work and acted on
                it? What if you could run your entire operation — leads,
                outreach, tasks, team, meetings, and daily ops — from one
                connected workspace, whether you message it on WhatsApp or open
                the dashboard?
              </p>
            </Reveal>
            <Reveal delay={0.2}>
              <p>
                Not a chatbot with five preset commands. A genuine agentic AI
                that understands the context of your work, remembers everything,
                connects to all your tools, coordinates your workflows, and
                takes action on your behalf.
              </p>
            </Reveal>
            <Reveal delay={0.3}>
              <p className="font-body-big text-[22px] lg:text-[28px] leading-[1.1] text-black">
                That&apos;s Ari. And it works.
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      {/* BELIEFS */}
      <section className="py-10 lg:py-14 overflow-hidden">
        <div className="max-w-[1300px] mx-auto px-6 lg:px-10">
          <Reveal className="text-center mb-4">
            <HandLabel text="what we believe!" width={170} />
          </Reveal>

          <Reveal delay={0.1}>
            <h2 className="font-display text-center text-[clamp(22px,3.6vw,34px)] leading-[0.88] mb-6">
              FIVE TRUTHS.
            </h2>
          </Reveal>
          <Reveal delay={0.2}>
            <p className="text-center text-[14px] lg:text-[15px] text-black/65 max-w-2xl mx-auto mb-10">
              These aren&apos;t marketing slogans. They&apos;re engineering
              decisions.
            </p>
          </Reveal>

          <div className="space-y-6 lg:space-y-8">
            {beliefs.map((b, i) => (
              <Reveal key={b.n} delay={i * 0.06}>
                <motion.div
                  whileHover={{ y: -4, rotate: i % 2 === 0 ? -0.8 : 0.8 }}
                  transition={{ type: "spring", stiffness: 220, damping: 15 }}
                  className="border-[2.5px] border-black p-6 lg:p-9 grid lg:grid-cols-[140px,1fr] gap-6 lg:gap-12 items-start"
                  style={{
                    background: b.bg,
                    color: b.textColor || "black",
                    borderRadius: 14,
                    boxShadow: "6px 6px 0 #000",
                  }}
                >
                  <div className="font-display text-[42px] lg:text-[56px] leading-none">
                    {b.n}
                  </div>
                  <div>
                    <h3 className="font-body-big text-[22px] lg:text-[30px] mb-4">
                      {b.title}
                    </h3>
                    <p
                      className={`text-[14px] lg:text-[15px] leading-relaxed ${
                        b.textColor === "white" ? "text-white/85" : "text-black/75"
                      }`}
                    >
                      {b.body}
                    </p>
                  </div>
                </motion.div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* TIMELINE */}
      <section className="py-10 lg:py-14 overflow-hidden bg-[#FFFBED] border-y-[2.5px] border-black">
        <div className="max-w-4xl mx-auto px-6 lg:px-10">
          <Reveal className="text-center mb-4">
            <HandLabel text="the journey →" width={140} />
          </Reveal>
          <Reveal delay={0.1}>
            <h2 className="font-display text-center text-[clamp(30px,5vw,60px)] leading-[0.88] mb-10">
              SO FAR.
            </h2>
          </Reveal>

          <div className="space-y-3">
            {timeline.map((t, i) => (
              <Reveal key={t.date} delay={i * 0.06}>
                <motion.div
                  whileHover={{ x: 6 }}
                  transition={{ type: "spring", stiffness: 220, damping: 15 }}
                  className="grid grid-cols-[120px,1fr] border-[2.5px] border-black overflow-hidden bg-white"
                  style={{ borderRadius: 10, boxShadow: "5px 5px 0 #000" }}
                >
                  <div className="bg-black text-white p-5 label-caps flex items-center justify-center">
                    {t.date}
                  </div>
                  <div className="p-5 text-[15px] lg:text-[16px] text-black/75 flex items-center">
                    {t.event}
                  </div>
                </motion.div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* NUMBERS */}
      <section className="py-14 lg:py-20 max-w-[1300px] mx-auto px-6 lg:px-10">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-5">
          {numbers.map((s, i) => (
            <Reveal key={s.label} delay={i * 0.08}>
              <motion.div
                whileHover={{ y: -4, rotate: i % 2 === 0 ? -1.5 : 1.5 }}
                transition={{ type: "spring", stiffness: 200, damping: 15 }}
                className="border-[2.5px] border-black p-6 lg:p-8 text-center"
                style={{
                  background: s.bg,
                  color: s.textColor || "black",
                  borderRadius: 8,
                  boxShadow: "5px 5px 0 #000",
                }}
              >
                <div className="font-display text-[32px] lg:text-[40px] leading-none">
                  {s.val}
                </div>
                <div className="label-caps mt-3">{s.label}</div>
              </motion.div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="py-10 lg:py-14 overflow-hidden">
        <div className="max-w-4xl mx-auto px-6 lg:px-10 text-center">
          <Reveal>
            <HandLabel text="join us!" width={100} className="mb-4" />
          </Reveal>
          <Reveal delay={0.1}>
            <h2 className="font-display text-[clamp(26px,4.4vw,46px)] leading-[0.88]">
              JOIN THE
              <br />
              <span className="inline-block bg-[#9BE7BF] border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
                CLARITY MOVEMENT.
              </span>
            </h2>
          </Reveal>
          <Reveal delay={0.2}>
            <p className="mt-10 text-[15px] lg:text-[16px] text-black/70">
              1,500+ people already stopped drowning in productivity tools.
            </p>
          </Reveal>
          <Reveal delay={0.3}>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <BlackPill href="http://127.0.0.1:43101">OPEN ARI DESKTOP</BlackPill>
              <OutlinePill href="/preview-nudge/features">EXPLORE FEATURES →</OutlinePill>
            </div>
          </Reveal>
        </div>
      </section>
    </PageShell>
  );
}
