"use client";

import { motion, useMotionValue, useSpring, animate, useInView, AnimatePresence } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/* ═══════════════════════════════════════════════════════════════
   FONTS + GLOBAL ANIMATIONS
   ═══════════════════════════════════════════════════════════════ */
export function FontStyle() {
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
      @keyframes marquee-scroll {
        from { transform: translateX(0); }
        to { transform: translateX(-50%); }
      }
      .marquee { animation: marquee-scroll 40s linear infinite; }
    `}</style>
  );
}

/* ═══════════════════ Live ticking clock ═══════════════════
   Always renders in the viewer's LOCAL timezone (Date#getHours/etc.
   are already local). The timezone abbreviation (IST / EST / PST /
   GMT+5:30) is appended via Intl.DateTimeFormat so the viewer sees
   exactly which zone is being displayed. */
export function LiveClock({
  className = "",
  showTz = true,
}: {
  className?: string;
  showTz?: boolean;
}) {
  const [time, setTime] = useState("");
  const [tz, setTz] = useState("");

  useEffect(() => {
    // Compute the timezone abbreviation once on mount
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZoneName: "short",
      }).formatToParts(new Date());
      const zone = parts.find((p) => p.type === "timeZoneName")?.value;
      if (zone) setTz(zone);
    } catch {
      // older runtimes — fall back to UTC offset
      const offset = -new Date().getTimezoneOffset();
      const sign = offset >= 0 ? "+" : "-";
      const abs = Math.abs(offset);
      setTz(`GMT${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`);
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

/* ═══════════════════ Floating "YOU" cursor ═══════════════════
   Performance: previously used animate(x, target, { duration: 0.45 })
   on every mousemove which queued overlapping tweens (laggy under fast
   movement). Now uses useSpring for proper physics — direct x.set on
   each event (instant capture), spring trails behind smoothly. Disabled
   on touch / coarse pointers and narrow viewports where it adds nothing. */
export function YouCursor() {
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

/* ═══════════════════ Reveal on scroll ═══════════════════ */
export function Reveal({
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

/* ═══════════════════ Sticker badge ═══════════════════ */
export function Sticker({
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

/* ═══════════════════ Squiggle underline ═══════════════════ */
export function Squiggle({
  width = 130,
  className = "",
}: {
  width?: number;
  className?: string;
}) {
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

/* ═══════════════════ Hand-drawn arrow ═══════════════════ */
export function HandArrow({ className = "" }: { className?: string }) {
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

/* ═══════════════════ Hand-drawn arc divider ═══════════════════ */
export function ArcLine({ opacity = 0.4 }: { opacity?: number }) {
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

/* ═══════════════════ Handwritten label + squiggle ═══════════════════ */
export function HandLabel({
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

/* ═══════════════════ Black pill CTA ═══════════════════ */
export function BlackPill({
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

/* ═══════════════════ Outline pill CTA ═══════════════════ */
export function OutlinePill({
  children,
  href = "#",
  className = "",
}: {
  children: React.ReactNode;
  href?: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-2 border-2 border-black px-6 py-3 rounded-full font-bold text-[13px] tracking-[0.18em] hover:bg-black hover:text-white transition-colors ${className}`}
    >
      {children}
    </Link>
  );
}

/* ═══════════════════ Avatar bubble ═══════════════════ */
export function AvatarBubble({
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

/* ═══════════════════ Top nav ═══════════════════ */
/* Main feature categories surfaced in the FEATURES hover dropdown.
   Mirrors the categories the /preview-nudge/features index uses, but kept
   compact for menu use. */
const featureMenu = [
  { label: "Memory & Reminders", desc: "Remember everything, forget nothing", emoji: "🧠", slug: "unlimited-reminders", bg: "#7BD3F7" },
  { label: "Calendar & Scheduling", desc: "Google + Outlook + Apple, one view", emoji: "📅", slug: "unified-calendar", bg: "#FFE38C" },
  { label: "Email Command Center", desc: "Send, search, schedule from chat", emoji: "✉️", slug: "email-command-center", bg: "#FFB1D8" },
  { label: "Tasks & Sprints", desc: "Kanban without the dashboard", emoji: "✓", slug: "task-board", bg: "#9BE7BF" },
  { label: "Meeting Recorder", desc: "Captures system + mic audio and generates reports", emoji: "🎥", slug: "meeting-recorder", bg: "#B7A8FF" },
  { label: "Voice Messages", desc: "100+ languages, hands-free", emoji: "🎙️", slug: "voice-messages", bg: "#FF9D6E" },
];

function FeaturesDropdown({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: -6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.98 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="absolute top-full left-1/2 -translate-x-1/2 pt-3 z-50 w-[600px]"
        >
          <div
            className="relative bg-white border-[2.5px] border-black overflow-hidden"
            style={{ borderRadius: 14, boxShadow: "6px 6px 0 #000" }}
          >
            {/* Tip arrow */}
            <div
              aria-hidden
              className="absolute -top-[7px] left-1/2 -translate-x-1/2 w-3 h-3 bg-white border-l-[2.5px] border-t-[2.5px] border-black"
              style={{ transform: "translateX(-50%) rotate(45deg)" }}
            />
            <div className="grid grid-cols-2 gap-2 p-3">
              {featureMenu.map((f) => (
                <Link
                  key={f.slug}
                  href={`/preview-nudge/features/${f.slug}`}
                  onClick={onClose}
                  className="group flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-[#FFFBED] transition-colors"
                >
                  <span
                    className="flex-shrink-0 w-9 h-9 border-[1.5px] border-black flex items-center justify-center text-[18px]"
                    style={{ background: f.bg, borderRadius: 8 }}
                  >
                    {f.emoji}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-bold leading-tight">
                      {f.label}
                    </span>
                    <span className="block text-[11px] text-black/55 leading-snug mt-0.5">
                      {f.desc}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
            {/* Footer CTA */}
            <Link
              href="/features"
              onClick={onClose}
              className="border-t-[2.5px] border-black bg-[#FFE38C] px-5 py-3 flex items-center justify-between hover:bg-[#FFD659] transition-colors"
            >
              <span className="text-[12px] font-bold tracking-[0.16em] uppercase">
                See all 80+ tools
              </span>
              <span className="text-[14px] group-hover:translate-x-1 transition-transform">
                →
              </span>
            </Link>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function PreviewNav() {
  const pathname = usePathname();
  const [featOpen, setFeatOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enterFeat = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setFeatOpen(true);
  };
  const leaveFeat = () => {
    closeTimer.current = setTimeout(() => setFeatOpen(false), 200);
  };

  const items: {
    label: string;
    href: string;
    icon: React.ReactNode;
    dropdown?: boolean;
  }[] = [
    { label: "HOME", href: "/", icon: <HomeIcon /> },
    { label: "ABOUT", href: "/about", icon: <AboutIcon /> },
    {
      label: "FEATURES",
      href: "/features",
      icon: <CaseIcon />,
      dropdown: true,
    },
    { label: "MEET", href: "/meet", icon: <MeetIcon /> },
    { label: "FAQ", href: "/faq", icon: <FaqIcon /> },
  ];

  return (
    <header className="sticky top-0 z-40 bg-white/85 backdrop-blur-md border-b border-black/5">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-10 h-16 flex items-center justify-between">
        <div className="flex items-center gap-5">
          {/* Ari wolf logo */}
          <Link
            href="/"
            className="flex items-center group"
            aria-label="Ari home"
          >
            <span className="relative w-10 h-10 flex items-center justify-center">
              <span className="absolute inset-0 rounded-full bg-[#9BE7BF] opacity-60 blur-md group-hover:opacity-90 transition-opacity" />
              <img
                src="/logo-wolf.png"
                alt="Ari"
                className="relative w-10 h-10 object-contain select-none"
                draggable={false}
              />
            </span>
          </Link>
          <nav className="hidden md:flex items-center gap-1">
            {items.map((it) => {
              const active =
                pathname === it.href ||
                (it.label === "FEATURES" &&
                  pathname?.startsWith("/preview-nudge/features"));
              if (it.dropdown) {
                return (
                  <div
                    key={it.label}
                    className="relative"
                    onMouseEnter={enterFeat}
                    onMouseLeave={leaveFeat}
                  >
                    <Link
                      href={it.href}
                      className={`flex items-center gap-2 px-3.5 py-2 rounded-full text-[12px] font-bold tracking-[0.16em] transition-all ${
                        active
                          ? "bg-[#7BD3F7] text-black"
                          : "text-black hover:bg-black/5"
                      }`}
                    >
                      {it.icon}
                      {it.label}
                      <svg
                        width="9"
                        height="6"
                        viewBox="0 0 9 6"
                        fill="none"
                        className={`transition-transform duration-200 ${
                          featOpen ? "rotate-180" : ""
                        }`}
                      >
                        <path
                          d="M1 1l3.5 4L8 1"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </Link>
                    <FeaturesDropdown
                      open={featOpen}
                      onClose={() => setFeatOpen(false)}
                    />
                  </div>
                );
              }
              return (
                <Link
                  key={it.label}
                  href={it.href}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-full text-[12px] font-bold tracking-[0.16em] transition-all ${
                    active
                      ? "bg-[#7BD3F7] text-black"
                      : "text-black hover:bg-black/5"
                  }`}
                >
                  {it.icon}
                  {it.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="https://wa.me/19177958667?text=Hi%20Ari"
            target="_blank"
            rel="noopener noreferrer"
            title="+1 (917) 795-8667"
            className="bg-[#25D366] text-black px-5 py-2 rounded-full text-[12px] font-bold tracking-[0.14em] flex items-center gap-2 border-2 border-black hover:scale-105 transition-transform"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M17.5 14.4c-.3-.2-1.7-.9-2-1-.3-.1-.5-.2-.6.2-.2.3-.7.9-.9 1.1-.2.2-.3.2-.6.1-.3-.2-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6.1-.1.3-.3.4-.5.2-.2.2-.3.3-.5.1-.2.1-.4 0-.5-.1-.2-.6-1.5-.9-2-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.3.3-.9.9-.9 2.2s.9 2.5 1.1 2.7c.1.2 1.8 2.8 4.4 3.9.6.3 1.1.4 1.5.5.6.2 1.2.2 1.6.1.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.2-.3-.2-.6-.4zM12 2a10 10 0 0 0-8.6 15l-1.3 4.8 4.9-1.3A10 10 0 1 0 12 2z" />
            </svg>
            TRY ON WHATSAPP
          </a>
          <a
            href="http://127.0.0.1:43101"
            className="bg-black text-white px-5 py-2 rounded-full text-[12px] font-bold tracking-[0.18em] flex items-center gap-2 hover:scale-105 transition-transform"
          >
            <span
              className="w-5 h-5 rounded-[3px] bg-[#7BD3F7] flex items-center justify-center"
              aria-hidden
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="black">
                <rect x="0" y="0" width="4" height="4" rx="0.6" />
                <rect x="6" y="0" width="4" height="4" rx="0.6" />
                <rect x="0" y="6" width="4" height="4" rx="0.6" />
                <rect x="6" y="6" width="4" height="4" rx="0.6" />
              </svg>
            </span>
            OPEN ARI DESKTOP
          </a>
        </div>
      </div>
    </header>
  );
}

/* Bold, filled-shape nav icons — matches the heavy iconography of the
   reference. Roughly 16px square at 100% weight. */
const HomeIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 1.5l-7 5.5v7.5h4.5v-5h5v5H15V7L8 1.5z" />
  </svg>
);
const AboutIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
    {/* Asterisk / spark — 8-point */}
    <path d="M8 0v6.6L13.6 1l1.4 1.4L9.4 8H16v2H9.4l5.6 5.6-1.4 1.4L8 9.4V16H6V9.4L.4 15 -1 13.6 4.6 8H-2V6h6.6L-1 .4 .4-1 6 4.6V0h2z" transform="translate(1 1) scale(0.94)" />
  </svg>
);
const CaseIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
    {/* Filled film-reel / ticket */}
    <path d="M2 5h12v8H2V5zm1 1v6h2V6H3zm10 0v6h-2V6h2z" />
    <path d="M5 3h6v2H5V3z" />
  </svg>
);
const MeetIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
    {/* Solid camera */}
    <path d="M2 4h9v8H2V4zm10 1.5l4-2v9l-4-2v-5z" />
  </svg>
);
const FaqIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
    {/* Solid speech-bubble with ? */}
    <path d="M8 1C4.13 1 1 3.69 1 7c0 1.71.84 3.27 2.18 4.4L2.5 14.5l3-1.6A8.4 8.4 0 008 13c3.87 0 7-2.69 7-6s-3.13-6-7-6zm.6 8.4H7.4v-1.2h1.2v1.2zM9.7 6.7c-.4.4-.7.7-.7 1.3H7c0-1 .4-1.6.9-2.1.4-.4.7-.7.7-1.1 0-.5-.4-.8-.9-.8s-.9.3-.9.8H5.3c0-1.4 1.1-2.4 2.4-2.4s2.4 1 2.4 2.4c0 .7-.4 1.2-.4 1.9z" />
  </svg>
);

/* ═══════════════════ Footer ═══════════════════ */
export function FooterStrip() {
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
              { label: "Onboarding", href: "/preview-nudge/onboarding" },
              { label: "Privacy", href: "/preview-nudge/privacy" },
              { label: "Terms", href: "/preview-nudge/terms" },
            ],
          },
          {
            title: "Connect",
            links: [
              { label: "WhatsApp", href: "https://wa.me/19177958667" },
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
                  <Link
                    href={l.href}
                    className="text-[14px] text-black/70 hover:text-black transition-colors"
                  >
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

/* ═══════════════════ Hey-there typing loader ═══════════════════
   Plays on every fresh page load (hard reload, new tab, first visit).
   Skipped on Next.js <Link> navigation so it doesn't replay between
   /preview-nudge/* routes inside the same tab.
   Strict-mode-safe: the module flag is keyed by performance.timeOrigin
   so that a fresh JS runtime (= real reload) gets a different value,
   while the synthetic strict-mode double-mount sees the same key.
*/
let __heyLoaderPlayedForOrigin: number | null = null;

export function HeyLoader() {
  const text = "Hey there";

  // Decide synchronously in useState initializer so Link-nav remounts
  // can return null without a flash. We defer the "true" decision to a
  // useEffect+setTimeout so that React Strict Mode's synthetic
  // mount/unmount/remount in dev doesn't claim the slot prematurely.
  const [shouldRun, setShouldRun] = useState<boolean | null>(() => {
    if (typeof window === "undefined") return null;
    const myOrigin = Math.floor(performance.timeOrigin);
    if (__heyLoaderPlayedForOrigin === myOrigin) return false;
    return null;
  });

  const [chars, setChars] = useState(0);
  const [phase, setPhase] = useState<"typing" | "hold" | "fading" | "done">(
    "typing"
  );

  // Settle the decision after strict-mode double-fire. Cleanup cancels
  // the synthetic first mount's timer, so only the real mount records.
  useEffect(() => {
    if (shouldRun !== null) return;
    let cancelled = false;
    const t = setTimeout(() => {
      if (cancelled) return;
      const myOrigin = Math.floor(performance.timeOrigin);
      if (__heyLoaderPlayedForOrigin === myOrigin) {
        setShouldRun(false);
      } else {
        __heyLoaderPlayedForOrigin = myOrigin;
        setShouldRun(true);
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [shouldRun]);

  // Drive the typing / hold / fade state machine
  useEffect(() => {
    if (shouldRun !== true || phase === "done") return;

    if (phase === "typing") {
      if (chars < text.length) {
        const t = setTimeout(() => setChars((c) => c + 1), 110);
        return () => clearTimeout(t);
      }
      const t = setTimeout(() => setPhase("hold"), 0);
      return () => clearTimeout(t);
    }
    if (phase === "hold") {
      const t = setTimeout(() => setPhase("fading"), 650);
      return () => clearTimeout(t);
    }
    if (phase === "fading") {
      const t = setTimeout(() => setPhase("done"), 650);
      return () => clearTimeout(t);
    }
  }, [chars, phase, shouldRun]);

  // SSR + brief pre-decide window: render an invisible placeholder so
  // the page beneath isn't visible during the storage check.
  if (shouldRun === null) {
    return (
      <div className="fixed inset-0 z-[100] bg-white flex items-center justify-center">
        <div
          className="bg-[#7BD3F7] text-black border-[2.5px] border-black px-7 py-4 lg:px-9 lg:py-5 flex items-center"
          style={{ borderRadius: 14, boxShadow: "6px 6px 0 #000" }}
        >
          <span className="font-body-big text-[36px] lg:text-[56px] leading-none opacity-0">
            Hey there
          </span>
        </div>
      </div>
    );
  }

  // Already shown this session — don't show again on subpage nav
  if (shouldRun === false) return null;
  if (phase === "done") return null;

  return (
    <motion.div
      initial={{ opacity: 1 }}
      animate={{ opacity: phase === "fading" ? 0 : 1 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className="fixed inset-0 z-[100] bg-white flex items-center justify-center"
      style={{ pointerEvents: phase === "fading" ? "none" : "auto" }}
    >
      <div
        className="bg-[#7BD3F7] text-black border-[2.5px] border-black px-7 py-4 lg:px-9 lg:py-5 flex items-center"
        style={{ borderRadius: 14, boxShadow: "6px 6px 0 #000" }}
      >
        <span className="font-body-big text-[36px] lg:text-[56px] leading-none">
          {text.slice(0, chars)}
        </span>
        <motion.span
          animate={{ opacity: [1, 0, 1] }}
          transition={{ duration: 0.85, repeat: Infinity, ease: "easeInOut" }}
          className="ml-1 inline-block w-[3px] h-[34px] lg:h-[52px] bg-black"
        />
      </div>
    </motion.div>
  );
}

/* ═══════════════════ Page wrapper (chrome) ═══════════════════ */
export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white text-[#0E0E0C] min-h-screen overflow-x-hidden font-sans">
      <FontStyle />
      <HeyLoader />
      <YouCursor />
      <PreviewNav />
      {children}
      <FooterStrip />
    </div>
  );
}
