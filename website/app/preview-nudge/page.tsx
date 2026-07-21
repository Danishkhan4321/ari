"use client";

import { motion, useMotionValue, useSpring, animate, useInView } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { HeyLoader, PreviewNav as SharedPreviewNav } from "./_shared";

/* ═══════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════ */

function LiveClock({
  className = "",
  showTz = true,
}: {
  className?: string;
  showTz?: boolean;
}) {
  const [time, setTime] = useState("");
  const [tz, setTz] = useState("");

  useEffect(() => {
    // Always renders in the viewer's local timezone. Append the short
    // timezone abbreviation (IST / EST / PST / GMT+5:30) so it's clear
    // this is the viewer's own time, not server time.
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZoneName: "short",
      }).formatToParts(new Date());
      const zone = parts.find((p) => p.type === "timeZoneName")?.value;
      if (zone) setTz(zone);
    } catch {
      const offset = -new Date().getTimezoneOffset();
      const sign = offset >= 0 ? "+" : "-";
      const abs = Math.abs(offset);
      setTz(
        `GMT${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(
          abs % 60
        ).padStart(2, "0")}`
      );
    }

    const tick = () => {
      const d = new Date();
      const h12 = d.getHours() % 12 || 12;
      const h = String(h12).padStart(2, "0");
      const m = String(d.getMinutes()).padStart(2, "0");
      const s = String(d.getSeconds()).padStart(2, "0");
      const ampm = d.getHours() >= 12 ? "PM" : "AM";
      setTime(`${h}:${m}:${s} ${ampm}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <span className={`font-mono tabular-nums ${className}`}>
      {time || "--:--:-- --"}
      {showTz && tz && (
        <span className="ml-2 text-black/55">{tz}</span>
      )}
    </span>
  );
}

function YouCursor() {
  // useSpring for snappy follow — direct x.set on every move, spring
  // trails. No animate() queue → no lag under fast movement.
  const x = useMotionValue(-100);
  const y = useMotionValue(-100);
  const springX = useSpring(x, { stiffness: 380, damping: 28, mass: 0.35 });
  const springY = useSpring(y, { stiffness: 380, damping: 28, mass: 0.35 });
  const [shown, setShown] = useState(false);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const isTouch =
      window.matchMedia?.("(hover: none), (pointer: coarse)")?.matches ?? false;
    const tooNarrow = window.innerWidth < 900;
    if (isTouch || tooNarrow) {
      setEnabled(false);
      return;
    }
    const move = (e: MouseEvent) => {
      if (!shown) setShown(true);
      x.set(e.clientX);
      y.set(e.clientY);
    };
    window.addEventListener("mousemove", move, { passive: true });
    return () => window.removeEventListener("mousemove", move);
  }, [x, y, shown]);

  if (!enabled) return null;

  return (
    <motion.div
      className="fixed z-[60] pointer-events-none mix-blend-difference"
      style={{
        left: springX,
        top: springY,
        opacity: shown ? 1 : 0,
        willChange: "transform",
      }}
    >
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
        <circle cx="11" cy="11" r="8" fill="white" />
      </svg>
      <div className="absolute top-3 left-5 bg-white text-black text-[10px] font-bold px-2 py-[2px] rounded-full tracking-wider">
        YOU
      </div>
    </motion.div>
  );
}

function Reveal({
  children,
  delay = 0,
  y = 28,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function Sticker({
  children,
  bg = "#9BE7BF",
  rotate = -6,
  className = "",
  delay = 0.4,
  shape = "pill",
  textColor = "black",
  floatRange = 7,
  floatDuration = 3.4,
  floatDelay,
}: {
  children: React.ReactNode;
  bg?: string;
  rotate?: number;
  className?: string;
  delay?: number;
  shape?: "pill" | "tape" | "speech";
  textColor?: string;
  floatRange?: number;
  floatDuration?: number;
  floatDelay?: number;
}) {
  const radius = shape === "pill" ? 999 : shape === "tape" ? 6 : 18;
  // Two-layer motion: outer wrapper does the entry-spring (scale + rotate +
  // opacity), inner does the continuous floating loop. Splitting them avoids
  // transform-conflicts that would happen if a single element tried to do
  // both at once.
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.55, rotate: 0 }}
      whileInView={{ opacity: 1, scale: 1, rotate }}
      viewport={{ once: true }}
      whileHover={{ scale: 1.08, rotate: rotate * 0.2 }}
      transition={{ type: "spring", stiffness: 80, damping: 11, delay }}
      className={`inline-block ${className}`}
      style={{ willChange: "transform" }}
    >
      <motion.div
        animate={{ y: [0, -floatRange, 0, floatRange * 0.6, 0] }}
        transition={{
          duration: floatDuration,
          repeat: Infinity,
          ease: "easeInOut",
          delay: floatDelay ?? delay + 0.6,
        }}
        className="inline-flex items-center px-5 py-2.5 font-semibold text-[14px] border-[2px] border-black select-none"
        style={{
          background: bg,
          color: textColor,
          borderRadius: radius,
          boxShadow: "3px 3px 0 #000",
        }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

function Squiggle({ width = 130, className = "" }: { width?: number; className?: string }) {
  return (
    <svg className={className} width={width} height="14" viewBox="0 0 130 14" fill="none">
      <motion.path
        d="M3 7 Q 22 1, 42 7 T 82 7 T 127 7"
        stroke="black"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 1.1, delay: 0.3 }}
      />
      <motion.path
        d="M5 11 Q 27 6, 50 11 T 90 11 T 125 11"
        stroke="black"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
        opacity="0.55"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 1.1, delay: 0.6 }}
      />
    </svg>
  );
}

function HandArrow({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="80" height="64" viewBox="0 0 80 64" fill="none">
      <motion.path
        d="M3 8 Q 30 4, 50 24 T 70 54"
        stroke="black"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 1.1 }}
      />
      <motion.path
        d="M62 46 L72 54 L60 56"
        stroke="black"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6, delay: 1 }}
      />
    </svg>
  );
}

function ArcLine({ opacity = 0.4 }: { opacity?: number }) {
  return (
    <svg className="w-full" viewBox="0 0 1400 80" fill="none" preserveAspectRatio="none">
      <motion.path
        d="M0 60 Q 700 -10, 1400 60"
        stroke="#1A1A18"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
        opacity={opacity}
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 1.6 }}
      />
    </svg>
  );
}

function Polaroid({
  src,
  caption,
  rotate = -6,
  className = "",
}: {
  src: string;
  caption: string;
  rotate?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30, rotate: 0 }}
      whileInView={{ opacity: 1, y: 0, rotate }}
      viewport={{ once: true }}
      whileHover={{ rotate: rotate * 0.3, scale: 1.04 }}
      transition={{ duration: 0.8, type: "spring", stiffness: 70, damping: 12 }}
      className={`relative bg-white p-3 pb-12 shadow-[6px_6px_0_rgba(0,0,0,0.12)] border border-black/10 ${className}`}
      style={{ width: 200 }}
    >
      <div className="aspect-[4/5] bg-[#EAEAEA] overflow-hidden">
        <img src={src} alt="" className="w-full h-full object-cover" />
      </div>
      <div className="absolute bottom-2 left-0 right-0 text-center font-handwritten text-[20px] text-[#1A1A18]">
        {caption}
      </div>
    </motion.div>
  );
}

function AvatarBubble({
  src,
  className = "",
  delay = 0.6,
}: {
  src: string;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.5 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true }}
      transition={{ type: "spring", stiffness: 100, damping: 12, delay }}
      className={`absolute rounded-full overflow-hidden bg-[#CFE7FF] border-2 border-white shadow-[0_8px_24px_rgba(0,0,0,0.15)] ${className}`}
    >
      <img src={src} alt="" className="w-full h-full object-cover" />
    </motion.div>
  );
}

function HandLabel({
  text,
  width = 140,
  className = "",
}: {
  text: string;
  width?: number;
  className?: string;
}) {
  return (
    <div className={`inline-block ${className}`}>
      <div className="font-handwritten text-[26px] leading-none text-[#1A1A18]">
        {text}
      </div>
      <Squiggle width={width} className="mt-1" />
    </div>
  );
}

function BlackPill({
  children,
  iconBg = "#7BD3F7",
  iconChar = "▶▶",
  className = "",
  href = "#",
}: {
  children: React.ReactNode;
  iconBg?: string;
  iconChar?: string;
  className?: string;
  href?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-3 bg-black text-white pl-3 pr-7 py-3 rounded-full font-bold text-[13px] tracking-[0.18em] hover:scale-105 transition-transform ${className}`}
    >
      <span
        className="w-9 h-9 rounded-full flex items-center justify-center text-black text-[15px]"
        style={{ background: iconBg }}
      >
        {iconChar}
      </span>
      {children}
    </Link>
  );
}

/* ═══════════════════════════════════════════════════════════════
   DATA — pulled from original site
   ═══════════════════════════════════════════════════════════════ */

const stats = [
  { value: "80+", label: "AI Tools", bg: "#FFC34D" },
  { value: "1", label: "Platform", bg: "#818CF8", textColor: "white" },
  { value: "15+", label: "Integrations", bg: "#7BD3F7" },
  { value: "24/7", label: "Always On", bg: "#DAF464" },
];

const steps = [
  {
    n: "01",
    title: "Just tell it",
    desc: "Say what you need in plain language — build a lead list, assign a task, join a meeting, send a reminder. No commands. No syntax.",
    example: '"Create a lead list of legal-tech startups and start outreach"',
    color: "#7BD3F7",
  },
  {
    n: "02",
    title: "Ari takes action",
    desc: "It understands the context of your work, does the job — creates the records, schedules it, drafts it — and follows up so nothing slips.",
    example: "Done. 40 leads added, outreach drafts ready for review.",
    color: "#FFE38C",
  },
  {
    n: "03",
    title: "Wherever you work",
    desc: "Message Ari on WhatsApp or open the dashboard — one workspace, one shared context. No new tool for your team to learn.",
    example: "One agent. WhatsApp or web. Zero friction.",
    color: "#FFB1D8",
  },
  {
    n: "04",
    title: "Run your whole team",
    desc: "Assign tasks, set deadlines, track progress, and run AI stand-ups. Teammates get notified; you get updates when work is done.",
    example: '"Assign the website review to Rahul, due Friday 5 PM"',
    color: "#FF9D6E",
  },
  {
    n: "05",
    title: "Record when you choose",
    desc: "Start from Ari Desktop to capture system and microphone audio, then generate the complete report.",
    example: "Meeting ended. Summary + action items sent to your chat.",
    color: "#B7A8FF",
  },
  {
    n: "06",
    title: "Daily briefing every morning",
    desc: "Wake up to a personalized summary — today's meetings, pending tasks, emails that need your attention.",
    example: "Good morning! 3 meetings, 5 tasks, 2 urgent emails.",
    color: "#9BE7BF",
  },
];

const features = [
  { title: "Voice Messages", desc: "Send a voice note. Ari understands 100+ languages.", bg: "#FFE38C", emoji: "🎙️", slug: "voice-messages" },
  { title: "Daily News", desc: "Curated headlines every morning — tech, business, world.", bg: "#FF9D6E", emoji: "📰", slug: "daily-news" },
  { title: "Reminders", desc: "One-time, recurring, location-based. Never miss anything.", bg: "#7BD3F7", emoji: "⏰", slug: "unlimited-reminders" },
  { title: "Smart Calendar", desc: "Google + Outlook + Apple in one view. Chat to create events.", bg: "#FCFDFF", emoji: "📅", slug: "unified-calendar" },
  { title: "Email HQ", desc: "Send, schedule, search, auto-organize your inbox from chat.", bg: "#DAF464", emoji: "✉️", slug: "email-command-center" },
  { title: "Meeting Recorder", desc: "Captures system + mic audio, transcribes, and generates reports.", bg: "#818CF8", emoji: "🎥", textColor: "white", slug: "meeting-recorder" },
  { title: "Tasks & Sprints", desc: "Kanban boards, sprint planning, velocity tracking — in chat.", bg: "#FCFDFF", emoji: "✓", slug: "task-board" },
  { title: "Daily Briefing", desc: "Every morning: meetings, tasks, reminders in one message.", bg: "#FFB1D8", emoji: "🌅", slug: "daily-briefing" },
];

const integrations = [
  { name: "WhatsApp", icon: "/logos/whatsapp.svg", bg: "#9BE7BF" },
  { name: "Gmail", icon: "/logos/gmail.svg", bg: "#FFB1D8" },
  { name: "Google Calendar", icon: "/logos/google-calendar.svg", bg: "#7BD3F7" },
  { name: "Google Meet", icon: "/logos/google-meet.svg", bg: "#FFE38C" },
  { name: "Outlook", icon: "/logos/outlook.svg", bg: "#B7A8FF" },
  { name: "Zoom", icon: "/logos/zoom.svg", bg: "#DAF464" },
  { name: "Drive", icon: "/logos/google-drive.svg", bg: "#FCFDFF" },
];

const testimonials = [
  { quote: "I used to forget half my meetings and deadlines. Now Ari handles everything — reminders, emails, calendar — all from one chat.", name: "Somnath Mishra", role: "Software Developer", bg: "#9BE7BF", rotate: -3 },
  { quote: "Running a law firm means juggling a hundred things. Ari replaced our task apps, calendar tools, and notes — our team hasn't missed a deadline since.", name: "Mahaprasad", role: "Founder & CEO", bg: "#FFE38C", rotate: 2 },
  { quote: "The meeting recorder lets me stay present, then gives me a transcript, decisions, and task suggestions to review.", name: "Alexander Lee", role: "Marketing Manager", bg: "#FFB1D8", rotate: -2 },
  { quote: "Ari tracks our pipeline, sends follow-up reminders, runs our daily standups. Like having an extra teammate who never sleeps.", name: "James Carter", role: "Sales Head", bg: "#7BD3F7", rotate: 3 },
  { quote: "Setup took 3 minutes. Tried 6 productivity tools this year — Ari is the only one I actually stuck with.", name: "Sophie Williams", role: "Freelance Designer", bg: "#B7A8FF", rotate: -2 },
  { quote: "Before I open my laptop, Ari has already told me my meetings, tasks, and emails I need to reply to. I feel in control.", name: "Ananya Singh", role: "Product Manager", bg: "#FF9D6E", rotate: 2 },
];


/* ═══════════════════════════════════════════════════════════════
   PAGE
   ═══════════════════════════════════════════════════════════════ */

export default function PreviewNudge() {
  return (
    <div className="bg-white text-[#0E0E0C] min-h-screen overflow-x-hidden font-sans">
      <FontStyle />
      <HeyLoader />
      <YouCursor />

      <PreviewNav />
      <HeroSection />
      <StatsBar />
      <ProblemSection />
      <HowItWorks />
      <FeatureGrid />
      <DashboardCrmSection />
      <VoiceSection />
      <IntegrationsSection />
      <TestimonialsSection />
      <ManifestoSection />
      <PricingSection />
      <FinalCTA />
      <FooterStrip />
    </div>
  );
}

function FontStyle() {
  return (
    <style jsx global>{`
      .font-display {
        font-family: "Bagel Fat One", "Bowlby One", system-ui, sans-serif;
        letter-spacing: -0.045em;
        font-weight: 400;
      }
      .font-handwritten {
        font-family: "Caveat", cursive;
        font-weight: 600;
      }
      .font-body-big {
        font-family: "Inter", "Plus Jakarta Sans", system-ui, sans-serif;
        font-weight: 500;
        letter-spacing: -0.045em;
        line-height: 1.05;
        font-optical-sizing: auto;
        font-variation-settings: "opsz" 32, "wght" 500;
      }
      .font-sans, body {
        font-family: "Inter", "Plus Jakarta Sans", system-ui, sans-serif;
      }
      .label-caps {
        font-family: "Inter", "Plus Jakarta Sans", system-ui, sans-serif;
        font-weight: 700;
        font-size: 11px;
        letter-spacing: 0.22em;
        text-transform: uppercase;
      }
      @keyframes float-y {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-10px); }
      }
      .float-y { animation: float-y 5s ease-in-out infinite; }
      .float-y-slow { animation: float-y 7s ease-in-out infinite; }
      @keyframes spin-slow {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      .spin-slow { animation: spin-slow 18s linear infinite; }
      @keyframes wobble {
        0%, 100% { transform: rotate(-3deg); }
        50% { transform: rotate(3deg); }
      }
      .wobble { animation: wobble 6s ease-in-out infinite; }
      .marquee {
        animation: marquee-scroll 40s linear infinite;
      }
      @keyframes marquee-scroll {
        from { transform: translateX(0); }
        to { transform: translateX(-50%); }
      }
    `}</style>
  );
}

/* ═══════════════════ TOP NAV ═══════════════════ */

/* Homepage uses the shared upgraded nav (with FEATURES dropdown +
   DASHBOARD button). Aliased so the rest of the file's references to
   <PreviewNav /> still work. */
const PreviewNav = SharedPreviewNav;

function NavItem({
  label,
  icon,
  href,
  active = false,
}: {
  label: string;
  icon: React.ReactNode;
  href: string;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-2 px-3.5 py-2 rounded-full text-[12px] font-bold tracking-[0.16em] transition-all ${
        active ? "bg-[#7BD3F7] text-black" : "text-black hover:bg-black/5"
      }`}
    >
      {icon}
      {label}
    </Link>
  );
}

const HomeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M2 7l6-5 6 5v7H2V7z" />
  </svg>
);
const AboutIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 1l1.6 5h5.4l-4.4 3.2 1.6 5L8 11l-4.2 3.2 1.6-5L1 6h5.4z" />
  </svg>
);
const CaseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
    <rect x="2" y="4" width="12" height="9" rx="1" />
    <path d="M5 4V2h6v2" />
  </svg>
);
const PlayIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <rect x="2" y="11" width="3" height="3" />
    <rect x="6" y="8" width="3" height="6" />
    <rect x="10" y="5" width="3" height="9" />
  </svg>
);

/* ═══════════════════ HERO ═══════════════════ */

function HeroSection() {
  return (
    <section className="relative pt-5 pb-10 lg:pb-14 overflow-hidden">
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7 }}
        className="text-center text-[13px] tracking-[0.06em] text-[#1A1A18]"
      >
        <LiveClock />
      </motion.div>

      <div className="relative max-w-[1300px] mx-auto px-6 lg:px-10 mt-6 lg:mt-8">
        {/* "i am" handwritten */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.7 }}
          className="text-center mb-1"
        >
          <div className="font-handwritten text-[26px] leading-none">i am</div>
          <Squiggle width={86} className="mx-auto mt-0.5" />
        </motion.div>

        {/* sticker - currently */}
        <Sticker bg="#9BE7BF" rotate={-8} delay={0.55} className="absolute top-[18px] left-[6%] hidden md:inline-flex">
          Run work from WhatsApp + web
        </Sticker>

        {/* sticker - previously */}
        <Sticker bg="#FFE38C" rotate={7} delay={0.65} className="absolute top-[40px] right-[5%] hidden md:inline-flex">
          Previously: a dozen open tabs
        </Sticker>

        {/* avatar bubbles */}
        <AvatarBubble src="/logo-wolf.png" className="w-[60px] h-[60px] top-[150px] left-[3%] hidden lg:block float-y" delay={0.7} />
        <AvatarBubble src="/logo-wolf.png" className="w-[60px] h-[60px] top-[170px] right-[4%] hidden lg:block float-y-slow" delay={0.85} />

        {/* BIG ARI — uses the custom Flux variable font */}
        <motion.h1
          initial={{ opacity: 0, scale: 0.92, y: 40 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.35 }}
          className="text-center leading-[0.85] text-[clamp(58px,11vw,160px)] text-[#0E0E0C] relative z-10 select-none"
          style={{
            fontFamily: '"Flux", "Bagel Fat One", system-ui, sans-serif',
            fontVariationSettings: '"wght" 700',
            letterSpacing: "-0.02em",
          }}
        >
          ARI
        </motion.h1>

        {/* available */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.9 }}
          className="text-center mt-3 flex items-center justify-center gap-2 label-caps"
        >
          <span className="inline-block w-2 h-2 rounded-full bg-[#3FAA6E] animate-pulse" />
          Built for founders, freelancers &amp; teams
        </motion.div>

        {/* AGENTIC WORK OS tape + hand-drawn arrow — both share the same
            float loop so they move together as one little sticker scene. */}
        <motion.div
          animate={{ y: [0, -7, 0, 4.2, 0] }}
          transition={{
            duration: 3.4,
            repeat: Infinity,
            ease: "easeInOut",
            delay: 1.6,
          }}
          className="absolute hidden md:block top-[280px] left-[8%]"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.55, rotate: 0 }}
            whileInView={{ opacity: 1, scale: 1, rotate: -10 }}
            viewport={{ once: true }}
            whileHover={{ scale: 1.08, rotate: -2 }}
            transition={{ type: "spring", stiffness: 80, damping: 11, delay: 1.0 }}
            className="inline-flex items-center px-4 py-2 font-semibold text-[12px] border-[2px] border-black select-none"
            style={{
              background: "#FFC34D",
              color: "black",
              borderRadius: 6,
              boxShadow: "3px 3px 0 #000",
            }}
          >
            AGENTIC WORK OS
          </motion.div>
          <HandArrow className="absolute -bottom-10 left-12 w-[60px] h-[48px]" />
        </motion.div>

        {/* tagline */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 1.0 }}
          className="text-center mt-10 lg:mt-12 px-4"
        >
          <h2 className="font-body-big text-[clamp(20px,3vw,38px)] max-w-3xl mx-auto">
            One AI agent{" "}
            <span className="inline-flex items-center justify-center w-9 h-9 lg:w-12 lg:h-12 rounded-full bg-[#7BD3F7] border-[2.5px] border-black align-middle">
              <span className="text-[18px] lg:text-[24px]">🎯</span>
            </span>{" "}
            that runs your{" "}
            <br className="hidden md:block" />
            work{" "}
            <span className="inline-flex items-center justify-center w-9 h-9 lg:w-12 lg:h-12 rounded-full bg-[#FFB1D8] border-[2.5px] border-black align-middle">
              <span className="text-[18px] lg:text-[24px]">⚡</span>
            </span>
            , not a dozen tabs.
          </h2>
          <p className="mt-4 text-[14px] lg:text-[15px] leading-relaxed text-black/65 max-w-xl mx-auto">
            Leads, outreach, team, tasks, meetings, and reminders — one
            intelligent workspace with a shared context. Ari understands your
            work and takes action, whether you message it on WhatsApp or open
            the dashboard.
          </p>
        </motion.div>

        {/* CTAs */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 1.2 }}
          className="flex flex-wrap items-center justify-center gap-3 mt-6"
        >
          <BlackPill href="#pricing">TRY ARI FREE</BlackPill>
          <Link
            href="#features"
            className="inline-flex items-center gap-2 border-2 border-black px-6 py-3 rounded-full font-bold text-[13px] tracking-[0.18em] hover:bg-black hover:text-white transition-colors"
          >
            EXPLORE FEATURES →
          </Link>
        </motion.div>
      </div>
    </section>
  );
}

/* ═══════════════════ STATS BAR ═══════════════════ */

function StatsBar() {
  return (
    <section className="py-10 max-w-[1300px] mx-auto px-6 lg:px-10">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-5">
        {stats.map((s, i) => (
          <Reveal key={s.label} delay={i * 0.08} y={20}>
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
                {s.value}
              </div>
              <div className="label-caps mt-3">{s.label}</div>
            </motion.div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* ═══════════════════ PROBLEM ═══════════════════ */

function ProblemSection() {
  return (
    <section className="relative py-10 lg:py-14 overflow-hidden">
      <div className="-mt-12 mb-12 opacity-50">
        <ArcLine />
      </div>
      <div className="max-w-[1300px] mx-auto px-6 lg:px-10">
        <Reveal>
          <HandLabel text="here's the truth" width={170} className="mb-8" />
        </Reveal>

        <Reveal delay={0.1}>
          <h2 className="font-body-big text-[clamp(24px,3.8vw,44px)] max-w-5xl">
            You don&apos;t have a{" "}
            <span className="inline-block bg-[#FF9D6E] border-[2.5px] border-black px-4 py-1 -rotate-2 rounded-md mx-1 align-baseline shadow-[4px_4px_0_#000]">
              productivity
            </span>{" "}
            problem.
            <br />
            You have a{" "}
            <span className="inline-block bg-[#7BD3F7] border-[2.5px] border-black px-4 py-1 rotate-2 rounded-md mx-1 align-baseline shadow-[4px_4px_0_#000]">
              tool
            </span>{" "}
            problem.
          </h2>
        </Reveal>

        <Reveal delay={0.2}>
          <p className="mt-10 text-[15px] lg:text-[16px] leading-relaxed text-black/70 max-w-2xl">
            Calendar in one app. Tasks in another. Reminders on your phone.
            Emails in a tab you forgot. Meeting notes in a doc you can&apos;t
            find. Ari puts everything in the one place you already check 100
            times a day — your chat.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/* ═══════════════════ HOW IT WORKS ═══════════════════ */

function HowItWorks() {
  return (
    <section className="py-10 lg:py-14 overflow-hidden">
      <div className="max-w-[1300px] mx-auto px-6 lg:px-10">
        <Reveal className="text-center mb-4">
          <HandLabel text="how it works!" width={150} className="" />
        </Reveal>

        <Reveal delay={0.1}>
          <h2 className="font-display text-center text-[clamp(22px,3.6vw,34px)] leading-[0.88] mb-6">
            ONE AGENT.
          </h2>
        </Reveal>
        <Reveal delay={0.2}>
          <p className="text-center text-[15px] lg:text-[16px] text-black/65 max-w-2xl mx-auto mb-12">
            From lead lists to meetings — one agent understands your context and
            moves the work forward, on WhatsApp or the dashboard.
          </p>
        </Reveal>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5 lg:gap-6">
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={i * 0.08}>
              <motion.div
                whileHover={{ y: -6 }}
                transition={{ type: "spring", stiffness: 200, damping: 15 }}
                className="border-[2.5px] border-black p-5 h-full flex flex-col"
                style={{
                  background: s.color,
                  borderRadius: 10,
                  boxShadow: "5px 5px 0 #000",
                }}
              >
                <div className="font-display text-[40px] leading-none mb-4">
                  {s.n}
                </div>
                <h3 className="font-body-big text-[24px] mb-3">{s.title}</h3>
                <p className="text-[15px] leading-relaxed text-black/75 mb-5 flex-1">
                  {s.desc}
                </p>
                <div className="bg-white/60 border-2 border-black/15 p-3 text-[13px] italic text-black/70 rounded">
                  {s.example}
                </div>
              </motion.div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════ FEATURE GRID ═══════════════════ */

function FeatureGrid() {
  return (
    <section id="features" className="py-10 lg:py-14 overflow-hidden">
      <div className="max-w-[1300px] mx-auto px-6 lg:px-10">
        <Reveal className="text-center mb-4">
          <HandLabel text="explore the magic!" width={170} className="" />
        </Reveal>

        <Reveal delay={0.1}>
          <h2 className="font-display text-center text-[clamp(22px,3.6vw,34px)] leading-[0.88] mb-6">
            80+ TOOLS
          </h2>
        </Reveal>
        <Reveal delay={0.2}>
          <p className="text-center text-[15px] lg:text-[16px] text-black/65 max-w-2xl mx-auto mb-10">
            Every feature works through natural conversation. No dashboards.
            No buttons. Just type what you need.
          </p>
        </Reveal>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-5">
          {features.map((f, i) => (
            <Reveal key={f.title} delay={i * 0.05}>
              <Link href={`/preview-nudge/features/${f.slug}`} className="block h-full">
                <motion.div
                  whileHover={{ y: -6, rotate: i % 2 === 0 ? -1.5 : 1.5 }}
                  transition={{ type: "spring", stiffness: 200, damping: 15 }}
                  className="border-[2.5px] border-black p-6 h-full flex flex-col group cursor-pointer"
                  style={{
                    background: f.bg,
                    color: f.textColor || "black",
                    borderRadius: 10,
                    boxShadow: "4px 4px 0 #000",
                  }}
                >
                  <div className="text-[40px] mb-3">{f.emoji}</div>
                  <h3 className="font-body-big text-[20px] mb-2">{f.title}</h3>
                  <p
                    className={`text-[13px] leading-relaxed flex-1 mb-3 ${
                      f.textColor === "white" ? "text-white/80" : "text-black/70"
                    }`}
                  >
                    {f.desc}
                  </p>
                  <span
                    className={`label-caps inline-flex items-center gap-1 group-hover:gap-2 transition-all ${
                      f.textColor === "white" ? "text-white/85" : "text-black"
                    }`}
                  >
                    Learn more →
                  </span>
                </motion.div>
              </Link>
            </Reveal>
          ))}
        </div>

        <Reveal delay={0.4}>
          <div className="mt-12 text-center">
            <Link
              href="/preview-nudge/features"
              className="inline-flex items-center gap-2 border-2 border-black px-6 py-3 rounded-full font-bold text-[13px] tracking-[0.18em] hover:bg-black hover:text-white transition-colors"
            >
              SEE ALL 80+ TOOLS →
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ═══════════════════ DASHBOARD / CRM ═══════════════════ */

function DashboardCrmSection() {
  const stages = [
    { label: "New", value: "$45K", count: 2, accent: "#a3a3a3" },
    { label: "Qualified", value: "$92K", count: 3, accent: "#7BD3F7" },
    { label: "Demo done", value: "$138K", count: 3, accent: "#FFE38C" },
    { label: "Negotiation", value: "$200K", count: 2, accent: "#FFB1D8" },
    { label: "Won", value: "$320K", count: 2, accent: "#9BE7BF" },
  ];
  const sampleContacts = [
    { name: "Priya Sharma", company: "Meridian Health", stage: "Customer", color: "#9BE7BF" },
    { name: "Roelof Botha", company: "Sequoia Capital", stage: "Negotiation", color: "#FFE38C" },
    { name: "Sarah Chen", company: "Acme Corp", stage: "Demo done", color: "#7BD3F7" },
    { name: "Raj Mehta", company: "Stitch.ai", stage: "New", color: "#FFB1D8" },
  ];

  return (
    <section className="py-12 lg:py-20 overflow-hidden bg-[#FFFBED] border-y-[2.5px] border-black relative">
      <div className="absolute top-12 right-[6%] hidden md:block">
        <Sticker bg="#FFE38C" rotate={9} delay={0.2} shape="tape">
          NEW · DASHBOARD
        </Sticker>
      </div>

      <div className="max-w-[1300px] mx-auto px-6 lg:px-10">
        <Reveal className="text-center mb-3">
          <HandLabel text="and there's a dashboard too →" width={240} />
        </Reveal>

        <Reveal delay={0.1}>
          <h2 className="font-display text-center text-[clamp(28px,4.6vw,52px)] leading-[0.9] mt-6">
            RUN EVERYTHING.
            <br />
            <span className="inline-block bg-[#7BD3F7] border-[3px] border-black px-5 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
              ONE DASHBOARD.
            </span>
          </h2>
        </Reveal>

        <Reveal delay={0.2}>
          <p className="mt-8 text-center text-[15px] lg:text-[17px] leading-relaxed text-black/70 max-w-2xl mx-auto">
            Chat is the front door — the dashboard is the war room.
            A full Folk-style CRM, sales pipeline, tasks, kanban, meetings,
            inbox, notes, knowledge base, team, and productivity views —
            all wired to the same brain. Same data. Two surfaces.
          </p>
        </Reveal>

        {/* Mock dashboard preview */}
        <Reveal delay={0.3}>
          <div
            className="mt-14 bg-white border-[2.5px] border-black overflow-hidden"
            style={{ borderRadius: 16, boxShadow: "8px 8px 0 #000" }}
          >
            {/* mock topbar */}
            <div className="flex items-center justify-between px-5 py-3 border-b-2 border-black/10 bg-[#fbfaf3]">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-[#FF9D6E] border border-black/20" />
                <span className="w-3 h-3 rounded-full bg-[#FFE38C] border border-black/20" />
                <span className="w-3 h-3 rounded-full bg-[#9BE7BF] border border-black/20" />
                <span className="ml-3 text-[12px] tracking-[0.18em] uppercase font-bold text-black/55">
                  Ari Desktop / contacts
                </span>
              </div>
              <span className="text-[11px] tracking-[0.18em] uppercase font-bold text-black/45 hidden sm:block">
                184 contacts · 12 active deals
              </span>
            </div>

            <div className="grid lg:grid-cols-[1fr,1fr] gap-0">
              {/* Pipeline column */}
              <div className="p-5 lg:p-7 border-b-2 lg:border-b-0 lg:border-r-2 border-black/10">
                <div className="flex items-baseline justify-between mb-5">
                  <h3 className="font-body-big text-[18px] lg:text-[20px]">
                    Sales pipeline
                  </h3>
                  <span className="text-[11px] tracking-[0.18em] uppercase font-bold text-black/45">
                    $320K · MTD
                  </span>
                </div>
                <div className="space-y-2.5">
                  {stages.map((s, i) => (
                    <motion.div
                      key={s.label}
                      initial={{ opacity: 0, x: -12 }}
                      whileInView={{ opacity: 1, x: 0 }}
                      viewport={{ once: true, margin: "-50px" }}
                      transition={{ delay: i * 0.06 }}
                      className="flex items-center gap-3 border border-black/15 rounded-md px-3.5 py-2.5 bg-[#fbfaf3]"
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ background: s.accent }}
                      />
                      <span className="text-[13px] font-semibold flex-1">
                        {s.label}
                      </span>
                      <span className="text-[11px] text-black/55">
                        {s.count} deals
                      </span>
                      <span className="text-[13px] font-bold tabular-nums">
                        {s.value}
                      </span>
                    </motion.div>
                  ))}
                </div>
              </div>

              {/* Contacts column */}
              <div className="p-5 lg:p-7">
                <div className="flex items-baseline justify-between mb-5">
                  <h3 className="font-body-big text-[18px] lg:text-[20px]">
                    Recent contacts
                  </h3>
                  <span className="text-[11px] tracking-[0.18em] uppercase font-bold text-black/45">
                    +12 this month
                  </span>
                </div>
                <ul className="space-y-2.5">
                  {sampleContacts.map((c, i) => (
                    <motion.li
                      key={c.name}
                      initial={{ opacity: 0, y: 8 }}
                      whileInView={{ opacity: 1, y: 0 }}
                      viewport={{ once: true, margin: "-50px" }}
                      transition={{ delay: 0.2 + i * 0.06 }}
                      className="flex items-center gap-3 border border-black/15 rounded-md px-3.5 py-2.5 bg-[#fbfaf3]"
                    >
                      <span
                        className="w-8 h-8 rounded-full border border-black/20 flex items-center justify-center text-[12px] font-bold flex-shrink-0"
                        style={{ background: c.color }}
                      >
                        {c.name.split(" ").map((n) => n[0]).join("")}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-semibold leading-tight truncate">
                          {c.name}
                        </div>
                        <div className="text-[11px] text-black/55 truncate">
                          {c.company}
                        </div>
                      </div>
                      <span
                        className="text-[10px] tracking-[0.14em] uppercase font-bold border border-black/20 rounded-full px-2.5 py-1 flex-shrink-0"
                        style={{ background: c.color }}
                      >
                        {c.stage}
                      </span>
                    </motion.li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </Reveal>

        {/* Everything in the dashboard */}
        <Reveal delay={0.4}>
          <div className="mt-14 mb-3 text-center">
            <span className="label-caps text-black/55">What lives inside →</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 lg:gap-4">
            {[
              { label: "Home", desc: "Daily briefing & today's agenda.", emoji: "🏠", bg: "#FCFDFF" },
              { label: "Chat", desc: "Full WhatsApp history, searchable.", emoji: "💬", bg: "#9BE7BF" },
              { label: "Reminders", desc: "One-time, recurring, location-based.", emoji: "⏰", bg: "#7BD3F7" },
              { label: "Tasks & Sprints", desc: "Kanban boards, sprint planning.", emoji: "✓", bg: "#FFE38C" },
              { label: "Contacts & CRM", desc: "184-contact directory, Folk-style.", emoji: "👥", bg: "#FFB1D8" },
              { label: "Sales pipeline", desc: "Drag deals New → Won. Forecast.", emoji: "📈", bg: "#FF9D6E" },
              { label: "Inbox", desc: "Gmail + Outlook. One unified view.", emoji: "✉️", bg: "#DAF464" },
              { label: "Meetings", desc: "Auto-bot, transcripts, MoMs.", emoji: "🎥", bg: "#B7A8FF" },
              { label: "Notes & KB", desc: "412 notes — wiki for your team.", emoji: "📓", bg: "#FFFBED" },
              { label: "Team", desc: "Standups, leave, polls, dashboard.", emoji: "🧑‍🤝‍🧑", bg: "#9BE7BF" },
              { label: "Productivity", desc: "Focus mode, habits, expenses.", emoji: "⚡", bg: "#FFE38C" },
              { label: "Campaigns", desc: "Track open, click, reply rates.", emoji: "📨", bg: "#7BD3F7" },
              { label: "Smart groups", desc: "Segments, bulk email any list.", emoji: "🎯", bg: "#FFB1D8" },
              { label: "Calendar", desc: "Google + Outlook + Apple, one view.", emoji: "📅", bg: "#B7A8FF" },
              { label: "Settings", desc: "Integrations, preferences, team access.", emoji: "⚙️", bg: "#FCFDFF" },
            ].map((b, i) => (
              <motion.div
                key={b.label}
                whileHover={{ y: -4, rotate: i % 2 === 0 ? -1 : 1 }}
                transition={{ type: "spring", stiffness: 220, damping: 15 }}
                className="border-[2px] border-black p-4"
                style={{ background: b.bg, borderRadius: 10, boxShadow: "4px 4px 0 #000" }}
              >
                <div className="text-[22px] mb-2 leading-none">{b.emoji}</div>
                <div className="font-bold text-[13px] mb-1.5 leading-tight">{b.label}</div>
                <p className="text-[11.5px] leading-relaxed text-black/70">{b.desc}</p>
              </motion.div>
            ))}
          </div>
        </Reveal>

        <Reveal delay={0.5}>
          <div className="mt-12 text-center">
            <Link
              href="/preview-nudge/dashboard"
              className="inline-flex items-center gap-2 bg-black text-white px-7 py-3.5 rounded-full font-bold text-[13px] tracking-[0.18em] hover:-translate-y-0.5 transition-transform shadow-[5px_5px_0_#000]"
            >
              EXPLORE THE DASHBOARD →
            </Link>
            <p className="mt-4 text-[12px] text-black/50">
              Available in <span className="font-semibold">Ari Desktop</span>
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ═══════════════════ VOICE ═══════════════════ */

function VoiceSection() {
  return (
    <section className="py-10 lg:py-14 overflow-hidden bg-[#FFFBED] border-y-[2.5px] border-black relative">
      <div className="absolute top-10 left-[5%] hidden md:block">
        <Sticker bg="#9BE7BF" rotate={-12} delay={0.4}>VOICE-FIRST</Sticker>
      </div>
      <div className="absolute top-12 right-[5%] hidden md:block">
        <Sticker bg="#FFB1D8" rotate={9} delay={0.5}>HANDS-FREE</Sticker>
      </div>

      <div className="max-w-[1300px] mx-auto px-6 lg:px-10 pt-12">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <Reveal>
            <HandLabel text="too busy to type?" width={180} className="mb-6" />
            <h2 className="font-body-big text-[clamp(22px,3.4vw,36px)] mb-6">
              Just{" "}
              <span className="inline-block bg-white border-[2.5px] border-black px-4 py-1 -rotate-1 rounded-md mx-1 align-baseline shadow-[4px_4px_0_#000]">
                speak.
              </span>
            </h2>
            <p className="text-[15px] lg:text-[16px] leading-relaxed text-black/75 mb-10">
              Send Ari a voice message and it handles everything — reminders,
              emails, meetings, tasks. No typing. No commands. Just talk
              naturally, like you would to a friend.
            </p>

            <ul className="space-y-4">
              {[
                { bg: "#9BE7BF", title: "Any language, any accent", desc: "Speak in English, Hindi, Spanish, Arabic — Ari understands 100+ languages." },
                { bg: "#FFB1D8", title: "Hands-free productivity", desc: "Driving, walking, cooking — tell Ari what you need, it handles the rest." },
                { bg: "#B7A8FF", title: "Faster than typing", desc: "3× faster than thumb-typing. Perfect for long instructions." },
              ].map((b) => (
                <li key={b.title} className="flex items-start gap-4">
                  <div
                    className="w-9 h-9 rounded-full border-2 border-black flex items-center justify-center font-bold text-[15px] flex-shrink-0"
                    style={{ background: b.bg }}
                  >
                    ✓
                  </div>
                  <div>
                    <div className="font-bold text-[16px]">{b.title}</div>
                    <div className="text-[14px] text-black/65 leading-relaxed">{b.desc}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal delay={0.2}>
            <div className="relative">
              <motion.div
                animate={{ rotate: [1, -1, 1] }}
                transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
                className="bg-white border-[2.5px] border-black p-6 rounded-2xl shadow-[8px_8px_0_#000]"
              >
                <div className="flex items-center gap-3 mb-5 pb-4 border-b border-black/10">
                  <div className="w-10 h-10 rounded-full bg-[#818CF8] border-2 border-black flex items-center justify-center text-white font-bold">S</div>
                  <div>
                    <div className="font-bold text-[14px]">Ari</div>
                    <div className="text-[11px] text-black/55">online</div>
                  </div>
                </div>

                {/* outgoing voice */}
                <div className="flex justify-end mb-3">
                  <div className="bg-[#7BD3F7] border-2 border-black px-4 py-3 rounded-2xl max-w-[85%]">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center flex-shrink-0">
                        <svg className="w-3.5 h-3.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M6 4l10 6-10 6V4z" />
                        </svg>
                      </div>
                      <div className="flex items-end gap-0.5 h-5">
                        {[3, 5, 8, 12, 6, 10, 14, 8, 4, 9, 11, 7, 5, 3, 6, 10, 8, 4, 7, 9].map((h, i) => (
                          <div key={i} className="w-0.5 bg-black" style={{ height: `${h * 1.6}px` }} />
                        ))}
                      </div>
                      <span className="text-[11px] text-black/60 flex-shrink-0">0:08</span>
                    </div>
                  </div>
                </div>

                <p className="text-[12px] italic text-black/55 max-w-[85%] ml-auto text-right mb-3 leading-snug">
                  &ldquo;Hey Ari, remind me to call mom at 6 pm and schedule a
                  meeting with Rahul tomorrow at 10 am about the marketing
                  proposal.&rdquo;
                </p>

                <div className="flex justify-start">
                  <div className="bg-[#FFE38C] border-2 border-black px-4 py-3 rounded-2xl max-w-[90%]">
                    <p className="text-[14px] leading-relaxed">
                      Done! 🎯
                      <br />
                      ✓ Reminder set 6:00 PM — Call mom
                      <br />
                      ✓ Meeting scheduled with Rahul
                      <br />
                      <span className="text-black/55 text-[12px]">Tomorrow, 10:00 AM · Marketing</span>
                    </p>
                  </div>
                </div>
              </motion.div>

              <Sticker
                bg="#B7A8FF"
                rotate={6}
                delay={0.8}
                className="absolute -top-4 -right-4"
                textColor="white"
              >
                VOICE ENABLED
              </Sticker>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════ INTEGRATIONS ═══════════════════ */

function IntegrationsSection() {
  return (
    <section className="py-10 lg:py-14 overflow-hidden">
      <div className="max-w-[1300px] mx-auto px-6 lg:px-10">
        <Reveal className="text-center mb-4">
          <HandLabel text="plays nice with everyone" width={210} />
        </Reveal>

        <Reveal delay={0.1}>
          <h2 className="font-body-big text-center text-[clamp(22px,3.4vw,36px)] mb-6 max-w-3xl mx-auto">
            Connects to the tools you already use.
          </h2>
        </Reveal>
        <Reveal delay={0.2}>
          <p className="text-center text-[14px] lg:text-[15px] text-black/65 max-w-xl mx-auto mb-10">
            No migration. No new logins. Ari works with your existing stack.
          </p>
        </Reveal>

        <div className="flex flex-wrap justify-center gap-4 lg:gap-5">
          {integrations.map((it, i) => (
            <Reveal key={it.name} delay={i * 0.05}>
              <motion.div
                whileHover={{ y: -6, rotate: i % 2 === 0 ? -3 : 3 }}
                transition={{ type: "spring", stiffness: 220, damping: 14 }}
                className="border-[2.5px] border-black flex flex-col items-center justify-center gap-3"
                style={{
                  background: it.bg,
                  width: 140,
                  height: 140,
                  borderRadius: 10,
                  boxShadow: "4px 4px 0 #000",
                }}
              >
                <img src={it.icon} alt={it.name} width={44} height={44} className="object-contain" />
                <span className="font-bold text-[12px] tracking-wide text-center px-2 leading-tight">
                  {it.name}
                </span>
              </motion.div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════ TESTIMONIALS ═══════════════════ */

function TestimonialsSection() {
  return (
    <section className="py-10 lg:py-14 overflow-hidden bg-[#FFFBED] border-y-[2.5px] border-black">
      <div className="max-w-[1300px] mx-auto px-6 lg:px-10 mb-12">
        <Reveal className="text-center mb-4">
          <HandLabel text="real humans, real days" width={200} className="" />
        </Reveal>

        <Reveal delay={0.1}>
          <h2 className="font-body-big text-center text-[clamp(22px,3.4vw,38px)]">
            Real people.{" "}
            <span className="inline-block bg-[#FFE38C] border-[2.5px] border-black px-4 py-1 -rotate-2 rounded-md mx-1 align-baseline shadow-[4px_4px_0_#000]">
              Real results.
            </span>
          </h2>
        </Reveal>
      </div>

      <div
        className="relative overflow-hidden"
        style={{
          // soft fade-out at both edges so partial cards don't abruptly clip
          maskImage:
            "linear-gradient(to right, transparent 0, #000 80px, #000 calc(100% - 80px), transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to right, transparent 0, #000 80px, #000 calc(100% - 80px), transparent 100%)",
        }}
      >
        <div className="flex gap-8 marquee w-max px-6 py-6">
          {[...testimonials, ...testimonials].map((t, i) => (
            <motion.figure
              key={i}
              whileHover={{ rotate: t.rotate, y: -6, scale: 1.02 }}
              transition={{ type: "spring", stiffness: 180, damping: 15 }}
              className="bg-white border-[2.5px] border-black p-5 flex flex-col flex-shrink-0"
              style={{
                width: 360,
                minHeight: 280,
                background: t.bg,
                borderRadius: 14,
                boxShadow: "5px 5px 0 #000",
              }}
            >
              <div className="font-display text-[40px] leading-none mb-3">&ldquo;</div>
              <blockquote className="text-[15px] leading-[1.55] text-black flex-1 -mt-2">
                {t.quote}
              </blockquote>
              <figcaption className="mt-5 pt-4 border-t-2 border-black/15">
                <div className="font-bold text-[15px]">{t.name}</div>
                <div className="text-[12px] text-black/60">{t.role}</div>
              </figcaption>
            </motion.figure>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════ MANIFESTO ═══════════════════ */

function ManifestoSection() {
  return (
    <section className="py-10 lg:py-14 overflow-hidden bg-[#0E0E0C] text-white">
      <div className="max-w-[1300px] mx-auto px-6 lg:px-10 text-center">
        <Reveal>
          <div className="inline-block">
            <div className="font-handwritten text-[24px] text-[#FFE38C]">our philosophy →</div>
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <h2 className="font-display text-[clamp(28px,5vw,60px)] leading-[0.86] mt-8">
            WE DON&apos;T
            <br />
            ORGANIZE WORK.
          </h2>
        </Reveal>

        <Reveal delay={0.25}>
          <h2 className="font-display text-[clamp(28px,5vw,60px)] leading-[0.86] mt-2">
            WE{" "}
            <span className="inline-block bg-[#FFE38C] text-black px-6 py-2 rotate-2 rounded-lg mx-2 align-middle border-[3px] border-white shadow-[6px_6px_0_white]">
              DECOMPRESS
            </span>{" "}
            IT.
          </h2>
        </Reveal>

        <Reveal delay={0.4}>
          <div className="mt-10 max-w-2xl mx-auto space-y-6 text-[15px] lg:text-[16px] text-white/70 leading-relaxed">
            <p>
              The world doesn&apos;t need another dashboard. It needs fewer
              things to remember.
            </p>
            <p>
              Ari doesn&apos;t ask you to switch apps. It meets you where you
              already are — in chat.
            </p>
            <p className="text-white text-[20px] lg:text-[24px] font-bold">
              We don&apos;t sell features. We sell clarity.
            </p>
          </div>

          <div className="mt-12">
            <Link
              href="/preview-nudge/about"
              className="inline-flex items-center gap-3 bg-[#FFE38C] text-black pl-3 pr-7 py-3 rounded-full font-bold text-[13px] tracking-[0.18em] hover:scale-105 transition-transform"
            >
              <span className="w-9 h-9 rounded-full bg-black text-white flex items-center justify-center">
                →
              </span>
              READ OUR STORY
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ═══════════════════ PRICING (FREE) ═══════════════════ */

function PricingSection() {
  const included = [
    "Unlimited reminders & long-term memory",
    "AI chat with live web search",
    "Email management & unified calendar",
    "Tasks, projects & team standups",
    "Manual meeting recording, transcripts & reports",
    "Notes, knowledge base & expenses",
    "Contacts, CRM & campaigns",
    "100+ languages, voice & daily briefing",
  ];
  return (
    <section id="pricing" className="py-10 lg:py-14 overflow-hidden">
      <div className="max-w-[1300px] mx-auto px-6 lg:px-10">
        <Reveal className="text-center mb-4">
          <HandLabel text="the best part →" width={160} className="" />
        </Reveal>

        <Reveal delay={0.1}>
          <h2 className="font-body-big text-center text-[clamp(22px,3.4vw,40px)] max-w-3xl mx-auto">
            Ari is{" "}
            <span className="inline-block bg-[#FFE38C] border-[2.5px] border-black px-4 py-1 -rotate-2 rounded-md mx-1 align-baseline shadow-[4px_4px_0_#000]">
              free.
            </span>
          </h2>
        </Reveal>

        <Reveal delay={0.2}>
          <p className="text-center text-[14px] lg:text-[15px] text-black/65 max-w-xl mx-auto mt-6 mb-10">
            Every tool, every feature, full access — no paid plans, no upgrades,
            no credit card. Just start chatting on WhatsApp.
          </p>
        </Reveal>

        <Reveal delay={0.25}>
          <div
            className="max-w-2xl mx-auto bg-white border-[2.5px] border-black p-8 lg:p-10"
            style={{ borderRadius: 14, boxShadow: "8px 8px 0 #000" }}
          >
            <div className="flex items-center gap-3 mb-4">
              <h3 className="font-body-big text-[30px]">Everything</h3>
              <span
                className="border-2 border-black px-3 py-0.5 text-[11px] font-bold tracking-[0.16em]"
                style={{ background: "#9BE7BF", borderRadius: 999 }}
              >
                FREE FOREVER
              </span>
            </div>
            <p className="text-[14px] text-black/65 leading-relaxed mb-6">
              All 80+ AI tools — memory, reminders, email, calendar, tasks,
              teams and meetings — unlocked from your very first message.
            </p>

            <ul className="grid sm:grid-cols-2 gap-3 mb-8">
              {included.map((item) => (
                <li key={item} className="flex items-start gap-3 text-[14px]">
                  <span className="w-5 h-5 rounded-full bg-[#9BE7BF] border-2 border-black flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5">
                    ✓
                  </span>
                  <span className="text-black/80 leading-snug">{item}</span>
                </li>
              ))}
            </ul>

            <a
              href="http://127.0.0.1:43101"
              className="block w-full text-center py-3.5 font-bold text-[14px] tracking-[0.14em] border-2 border-black bg-[#FFE38C] transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none"
              style={{ borderRadius: 999, boxShadow: "4px 4px 0 #000" }}
            >
              OPEN ARI DESKTOP
            </a>
          </div>
        </Reveal>

        <Reveal delay={0.3}>
          <p className="text-center text-[12px] text-black/55 mt-8">
            Full access · no credit card · no paid plans, ever
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/* ═══════════════════ FINAL CTA ═══════════════════ */

function FinalCTA() {
  return (
    <section className="py-10 lg:py-14 overflow-hidden">
      <div className="max-w-[1300px] mx-auto px-6 lg:px-10">
        <div className="grid lg:grid-cols-[1fr,1.4fr] gap-10 lg:gap-16 items-center">
          <Reveal>
            <div className="relative w-full aspect-square max-w-[380px] mx-auto">
              {/* soft cyan glow disc behind logo */}
              <div className="absolute inset-6 rounded-full bg-[#9BE7BF] opacity-70 blur-2xl" />
              <motion.div
                animate={{ rotate: [-3, 3, -3], y: [0, -8, 0] }}
                transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
                className="relative w-full h-full flex items-center justify-center"
              >
                <img
                  src="/logo-wolf.png"
                  alt="Ari wolf mascot"
                  className="w-[78%] h-[78%] object-contain drop-shadow-[6px_8px_0_rgba(0,0,0,0.15)]"
                  draggable={false}
                />
              </motion.div>
              {/* sticker tag */}
              <div className="absolute -bottom-2 left-1/2 -translate-x-1/2">
                <div
                  className="bg-[#FFE38C] border-[2.5px] border-black px-4 py-1.5 label-caps -rotate-3"
                  style={{ borderRadius: 999, boxShadow: "3px 3px 0 #000" }}
                >
                  Hi, I&apos;m Ari
                </div>
              </div>
            </div>
          </Reveal>

          <Reveal delay={0.15}>
            <HandLabel text="now then →" width={120} className="mb-4" />
            <h2 className="font-display text-[clamp(22px,3.6vw,34px)] leading-[0.85] mb-6">
              STOP
              <br />
              DROWNING.
            </h2>
            <p className="text-[15px] lg:text-[16px] leading-relaxed max-w-md text-black/75 mb-10">
              Replace your scattered work tools with one intelligent workspace —
              and an agent that actually does the work. Start free. No credit
              card required.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <BlackPill href="http://127.0.0.1:43101" iconBg="#9BE7BF" iconChar="▶">
                OPEN ARI DESKTOP
              </BlackPill>
              <Link
                href="/preview-nudge/features"
                className="inline-flex items-center gap-2 border-2 border-black px-6 py-3 rounded-full font-bold text-[13px] tracking-[0.18em] hover:bg-black hover:text-white transition-colors"
              >
                SEE FEATURES
              </Link>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════ FOOTER ═══════════════════ */

function FooterStrip() {
  return (
    <footer className="border-t border-black/10 pt-12 pb-10 max-w-[1400px] mx-auto px-6 lg:px-10">
      <div className="grid md:grid-cols-[2fr,1fr,1fr,1fr] gap-10 mb-10">
        <div>
          <div className="font-display text-[32px] leading-none mb-3">ARI</div>
          <p className="text-[14px] text-black/65 leading-relaxed max-w-xs">
            Your agentic operating system for work. Leads, team, meetings,
            tasks, and outreach — one workspace, controllable from WhatsApp or
            the dashboard.
          </p>
        </div>
        {[
          {
            title: "Product",
            links: [
              { label: "Features", href: "/preview-nudge/features" },
              { label: "Meeting Recorder", href: "/preview-nudge/meet" },
              { label: "FAQ", href: "/preview-nudge/faq" },
            ],
          },
          {
            title: "Company",
            links: [
              { label: "About", href: "/preview-nudge/about" },
              { label: "Privacy", href: "/privacy" },
              { label: "Terms", href: "/terms" },
            ],
          },
          {
            title: "Connect",
            links: [
              { label: "WhatsApp", href: "#" },
              { label: "LinkedIn", href: "#" },
              { label: "Instagram", href: "#" },
              { label: "Ari desktop support", href: "http://127.0.0.1:43101" },
            ],
          },
        ].map((col) => (
          <div key={col.title}>
            <div className="label-caps mb-4">{col.title}</div>
            <ul className="space-y-2">
              {col.links.map((l) => (
                <li key={l.label}>
                  <Link href={l.href} className="text-[14px] text-black/70 hover:text-black transition-colors">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-black/10 pt-6 flex flex-wrap items-center justify-between gap-4 label-caps text-black/55">
        <div>© Ari 2026</div>
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-[#3FAA6E] animate-pulse" />
          Available
        </div>
        <LiveClock className="text-[12px]" />
      </div>
    </footer>
  );
}
