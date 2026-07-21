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

const meetFeatures = [
  {
    n: "01",
    title: "Manual Meeting Recorder",
    desc: "Click Record Meeting in Ari Desktop when you are ready. Ari captures system and microphone audio together, and you can pause, resume, or stop at any time.",
    detail: "Capture is user-controlled and stays recoverable locally until it is finalized and uploaded for processing.",
    bg: "#7BD3F7",
  },
  {
    n: "02",
    title: "AssemblyAI Transcription",
    desc: "The completed recording is transcribed with speaker labels such as Speaker A and Speaker B.",
    detail: "Rename a speaker once and Ari updates the transcript, summary, decisions, action items, task suggestions, and full report.",
    bg: "#FFE38C",
  },
  {
    n: "03",
    title: "Meeting Summary",
    desc: "After processing, Ari creates a structured summary with key decisions, topics discussed, deadlines, open questions, and follow-ups in the Meetings page.",
    detail: "Sections: Overview, Key Decisions, Discussion Points, Next Steps. Ask follow-ups: \"What did Raj say about the Q3 timeline?\" Ari answers from the transcript.",
    bg: "#FFB1D8",
  },
  {
    n: "04",
    title: "Minutes of Meeting",
    desc: "A complete report is generated with resolutions, action items, suggested owners, deadlines, and open questions.",
    detail: "Task suggestions remain proposals until you explicitly confirm them through Ari's task workflow.",
    bg: "#B7A8FF",
    textColor: "white",
  },
];

const comparison = [
  { feature: "System + microphone capture", ari: true, standalone: false },
  { feature: "Transcription with speaker labels", ari: true, standalone: true },
  { feature: "Meeting summary", ari: true, standalone: true },
  { feature: "Reviewed task suggestions", ari: true, standalone: false },
  { feature: "Desktop recording controls", ari: true, standalone: false },
  { feature: "Rename speakers everywhere", ari: true, standalone: false },
  { feature: "Auto follow-up reminders", ari: true, standalone: false },
  { feature: "Email summary to team", ari: true, standalone: false },
  { feature: "Ask questions about past meetings", ari: true, standalone: false },
  { feature: "Part of your agentic work OS", ari: true, standalone: false },
];

export default function MeetNudge() {
  return (
    <PageShell>
      {/* HERO */}
      <section className="relative pt-12 pb-32 lg:pb-40 overflow-hidden">
        <Reveal className="text-center">
          <HandLabel text="meeting recorder →" width={180} />
        </Reveal>

        <motion.h1
          initial={{ opacity: 0, scale: 0.92, y: 40 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.3 }}
          className="font-display text-center leading-[0.85] text-[clamp(32px,5.2vw,60px)] mt-10 px-4"
        >
          MEETINGS,
          <br />
          <span className="inline-block bg-[#B7A8FF] text-white border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
            AUTOPILOT.
          </span>
        </motion.h1>

        <Reveal delay={0.4}>
          <p className="mt-12 text-center text-[15px] lg:text-[17px] leading-relaxed text-black/70 max-w-2xl mx-auto px-6">
            The intelligent meeting recorder inside your work OS. You start
            capture from the Meetings page, then Ari transcribes the audio and
            prepares summaries, decisions, action items, task suggestions, and
            a complete report.
          </p>
        </Reveal>

        <div className="absolute hidden md:block top-[140px] left-[5%]">
          <Sticker bg="#9BE7BF" rotate={-10} delay={0.6}>
            ALPHA EXCLUSIVE
          </Sticker>
        </div>
        <div className="absolute hidden md:block top-[160px] right-[6%]">
          <Sticker bg="#FFE38C" rotate={9} delay={0.7} shape="tape">
            USER CONTROLLED
          </Sticker>
        </div>

        <Reveal delay={0.5}>
          <div className="mt-12 flex flex-wrap justify-center gap-3">
            {["Google Meet", "Zoom", "Teams", "Webex"].map((p) => (
              <span
                key={p}
                className="label-caps bg-white border-2 border-black px-4 py-2 rounded-full"
                style={{ boxShadow: "3px 3px 0 #000" }}
              >
                {p}
              </span>
            ))}
          </div>
        </Reveal>

        <Reveal delay={0.6}>
          <div className="mt-12 flex flex-wrap justify-center gap-4">
            <BlackPill href="http://127.0.0.1:43101" iconBg="#FFE38C" iconChar="▶">
              OPEN ARI DESKTOP
            </BlackPill>
            <OutlinePill href="/preview-nudge/features">SEE ALL FEATURES →</OutlinePill>
          </div>
        </Reveal>
      </section>

      {/* MOCKUP */}
      <section className="py-20 overflow-hidden bg-[#FFFBED] border-y-[2.5px] border-black">
        <div className="max-w-3xl mx-auto px-6 lg:px-10">
          <Reveal>
            <motion.div
              animate={{ rotate: [-1, 1, -1] }}
              transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
              className="bg-[#0E0E0C] text-white border-[2.5px] border-black p-6 lg:p-8"
              style={{ borderRadius: 14, boxShadow: "8px 8px 0 #000" }}
            >
              <div className="flex items-center justify-between mb-5 pb-4 border-b border-white/15">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-[#B7A8FF] flex items-center justify-center font-bold">S</div>
                  <div>
                    <div className="font-bold text-[14px]">Ari Desktop Recorder</div>
                    <div className="text-[11px] text-white/55 flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#FF4D6E] animate-pulse" />
                      Recording · 0:23:14
                    </div>
                  </div>
                </div>
                <div className="label-caps text-white/55">Q3 Planning</div>
              </div>

              <div className="space-y-3">
                <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                  <div className="label-caps text-white/55 mb-1">Raj · Product Lead</div>
                  <div className="text-[14px] leading-relaxed">
                    &ldquo;We need to finalize the roadmap by Friday. Priya, can you own the GTM doc?&rdquo;
                  </div>
                </div>
                <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                  <div className="label-caps text-white/55 mb-1">Priya · Marketing</div>
                  <div className="text-[14px] leading-relaxed">
                    &ldquo;Yes — I&apos;ll have it ready by Thursday EOD.&rdquo;
                  </div>
                </div>
                <div className="bg-[#FFE38C] text-black border-2 border-black rounded-xl p-4">
                  <div className="label-caps mb-2">Suggested task</div>
                  <div className="text-[14px] font-bold mb-1">
                    Priya to finalize GTM doc
                  </div>
                  <div className="text-[12px] text-black/65">
                    Due Thursday EOD · Review before creating
                  </div>
                </div>
              </div>
            </motion.div>
          </Reveal>
        </div>
      </section>

      {/* FEATURES */}
      <section className="py-10 lg:py-14 overflow-hidden">
        <div className="max-w-[1300px] mx-auto px-6 lg:px-10">
          <Reveal className="text-center mb-4">
            <HandLabel text="how it works!" width={150} />
          </Reveal>

          <Reveal delay={0.1}>
            <h2 className="font-display text-center text-[clamp(22px,3.6vw,34px)] leading-[0.88] mb-10">
              FOUR STEPS.
            </h2>
          </Reveal>

          <div className="space-y-6 lg:space-y-8">
            {meetFeatures.map((f, i) => (
              <Reveal key={f.n} delay={i * 0.08}>
                <motion.div
                  whileHover={{ y: -4, rotate: i % 2 === 0 ? -0.8 : 0.8 }}
                  transition={{ type: "spring", stiffness: 220, damping: 15 }}
                  className="border-[2.5px] border-black p-6 lg:p-9 grid lg:grid-cols-[140px,1fr] gap-6 lg:gap-12 items-start"
                  style={{
                    background: f.bg,
                    color: f.textColor || "black",
                    borderRadius: 14,
                    boxShadow: "6px 6px 0 #000",
                  }}
                >
                  <div className="font-display text-[42px] lg:text-[56px] leading-none">
                    {f.n}
                  </div>
                  <div>
                    <h3 className="font-body-big text-[22px] lg:text-[30px] mb-4">
                      {f.title}
                    </h3>
                    <p
                      className={`text-[14px] lg:text-[15px] leading-relaxed mb-4 ${
                        f.textColor === "white" ? "text-white/85" : "text-black/75"
                      }`}
                    >
                      {f.desc}
                    </p>
                    <p
                      className={`text-[14px] leading-relaxed pl-4 border-l-2 ${
                        f.textColor === "white"
                          ? "text-white/65 border-white/30"
                          : "text-black/60 border-black/20"
                      }`}
                    >
                      {f.detail}
                    </p>
                  </div>
                </motion.div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* COMPARISON */}
      <section className="py-10 lg:py-14 overflow-hidden bg-[#FFFBED] border-y-[2.5px] border-black">
        <div className="max-w-3xl mx-auto px-6 lg:px-10">
          <Reveal className="text-center mb-4">
            <HandLabel text="vs. standalone tools" width={210} />
          </Reveal>
          <Reveal delay={0.1}>
            <h2 className="font-display text-center text-[clamp(26px,4.4vw,46px)] leading-[0.88] mb-10">
              ARI WINS.
            </h2>
          </Reveal>

          <Reveal delay={0.2}>
            <div
              className="bg-white border-[2.5px] border-black overflow-hidden"
              style={{ borderRadius: 14, boxShadow: "8px 8px 0 #000" }}
            >
              <div className="grid grid-cols-[1fr,80px,80px] bg-black text-white">
                <div className="p-4 label-caps">Feature</div>
                <div className="p-4 label-caps text-center bg-[#9BE7BF] text-black">
                  Ari
                </div>
                <div className="p-4 label-caps text-center">Others</div>
              </div>
              {comparison.map((row, i) => (
                <div
                  key={row.feature}
                  className={`grid grid-cols-[1fr,80px,80px] items-center ${
                    i !== comparison.length - 1 ? "border-b border-black/10" : ""
                  }`}
                >
                  <div className="p-4 text-[14px] lg:text-[15px]">
                    {row.feature}
                  </div>
                  <div className="p-4 text-center">
                    <span className="inline-flex w-7 h-7 rounded-full bg-[#9BE7BF] border-2 border-black items-center justify-center text-[12px] font-bold">
                      ✓
                    </span>
                  </div>
                  <div className="p-4 text-center">
                    {row.standalone ? (
                      <span className="inline-flex w-7 h-7 rounded-full bg-white border-2 border-black/30 items-center justify-center text-[12px] font-bold text-black/40">
                        ✓
                      </span>
                    ) : (
                      <span className="text-black/30 text-lg">—</span>
                    )}
                  </div>
                </div>
              ))}
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
              UNLOCK
              <br />
              <span className="inline-block bg-[#FFE38C] border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
                MEETINGS.
              </span>
            </h2>
          </Reveal>
          <Reveal delay={0.2}>
            <p className="mt-10 text-[15px] lg:text-[16px] text-black/70 max-w-xl mx-auto">
              Free for everyone. Includes unlimited recordings, transcripts, and
              MoM generation.
            </p>
          </Reveal>
          <Reveal delay={0.3}>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <BlackPill href="http://127.0.0.1:43101">OPEN ARI DESKTOP</BlackPill>
              <OutlinePill href="/preview-nudge/features">SEE ALL TOOLS →</OutlinePill>
            </div>
          </Reveal>
        </div>
      </section>
    </PageShell>
  );
}
