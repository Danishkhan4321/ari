"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  PageShell,
  Reveal,
  Sticker,
  HandLabel,
  BlackPill,
  OutlinePill,
} from "../_shared";
import Link from "next/link";

const BOT_URL = process.env.NEXT_PUBLIC_BOT_URL || "http://127.0.0.1:43101";

function StepDot({ active, done }: { active: boolean; done: boolean }) {
  return (
    <motion.div
      animate={{ scale: active ? 1.3 : 1 }}
      transition={{ type: "spring", stiffness: 220, damping: 12 }}
      className={`w-3.5 h-3.5 rounded-full border-2 border-black transition-colors duration-300 ${
        done ? "bg-[#9BE7BF]" : active ? "bg-[#7BD3F7]" : "bg-white"
      }`}
    />
  );
}

function ChunkyInput({
  label,
  type = "text",
  placeholder,
  value,
  onChange,
  prefix,
}: {
  label: string;
  type?: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="label-caps text-black/65">{label}</label>
      <div
        className="flex border-[2.5px] border-black bg-white overflow-hidden"
        style={{ borderRadius: 10, boxShadow: "4px 4px 0 #000" }}
      >
        {prefix && (
          <span className="flex items-center px-4 bg-[#7BD3F7] border-r-[2.5px] border-black font-bold text-[15px]">
            {prefix}
          </span>
        )}
        <input
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 px-4 py-3.5 text-[15px] font-medium outline-none bg-transparent placeholder:text-black/30"
        />
      </div>
    </div>
  );
}

function ConnectButton({
  label,
  icon,
  href,
  connected,
  disabled,
  bg,
}: {
  label: string;
  icon: React.ReactNode;
  href: string;
  connected: boolean;
  disabled: boolean;
  bg: string;
}) {
  if (connected) {
    return (
      <div
        className="flex items-center gap-3 px-5 py-4 border-[2.5px] border-black bg-[#9BE7BF]"
        style={{ borderRadius: 10, boxShadow: "4px 4px 0 #000" }}
      >
        <span className="w-7 h-7 rounded-full bg-black text-white flex items-center justify-center font-bold text-[14px]">
          ✓
        </span>
        <span className="font-bold text-[15px]">{label} connected</span>
      </div>
    );
  }
  if (disabled) {
    return (
      <div
        className="flex items-center gap-3 px-5 py-4 border-[2.5px] border-black/20 bg-white opacity-50 cursor-not-allowed"
        style={{ borderRadius: 10 }}
      >
        {icon}
        <span className="font-bold text-[15px] text-black/55">
          Connect {label}
        </span>
        <span className="ml-auto text-[11px] label-caps text-black/40">
          Enter phone first
        </span>
      </div>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 px-5 py-4 border-[2.5px] border-black hover:translate-x-[2px] hover:translate-y-[2px] transition-all duration-150"
      style={{
        background: bg,
        borderRadius: 10,
        boxShadow: "4px 4px 0 #000",
      }}
    >
      {icon}
      <span className="font-bold text-[15px]">Connect {label}</span>
      <span className="ml-auto text-[11px] label-caps text-black/55">
        Opens new tab →
      </span>
    </a>
  );
}

export default function OnboardingNudge() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [googleConnected, setGoogleConnected] = useState(false);
  const [msConnected, setMsConnected] = useState(false);

  const formattedPhone = phone.startsWith("+") ? phone : `+${phone}`;
  const googleAuthUrl = `${BOT_URL}/auth/google?phone=${encodeURIComponent(
    formattedPhone
  )}`;
  const msAuthUrl = `${BOT_URL}/auth/microsoft?phone=${encodeURIComponent(
    formattedPhone
  )}`;
  const phoneValid = phone.replace(/\D/g, "").length >= 10;

  async function handleSave() {
    if (!name.trim()) {
      setError("Please enter your name.");
      return;
    }
    if (!phoneValid) {
      setError("Please enter a valid WhatsApp number (with country code).");
      return;
    }
    setError("");
    setSaving(true);
    try {
      await fetch(`${BOT_URL}/api/onboarding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), phone: formattedPhone }),
      });
    } catch {
      // non-blocking
    } finally {
      setSaving(false);
      setStep(2);
    }
  }

  return (
    <PageShell>
      <section className="relative pt-8 pb-32 overflow-hidden">
        {/* welcome banner */}
        <Reveal className="text-center mb-6">
          <Sticker bg="#FFE38C" rotate={-3} delay={0.2}>
            🎉 YOU&apos;RE IN — IT&apos;S FREE
          </Sticker>
        </Reveal>

        <Reveal delay={0.1}>
          <h1 className="font-display text-center leading-[0.88] text-[clamp(32px,5.2vw,64px)] px-4">
            WELCOME TO
            <br />
            <span className="inline-block bg-[#7BD3F7] border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
              ARI!
            </span>
          </h1>
        </Reveal>

        <Reveal delay={0.3}>
          <p className="mt-8 text-center text-[14px] lg:text-[15px] text-black/70 max-w-md mx-auto px-6">
            Let&apos;s get you set up in 2 quick steps.
          </p>
        </Reveal>

        {/* progress dots */}
        <Reveal delay={0.4}>
          <div className="flex items-center justify-center gap-3 mt-12 mb-12">
            <StepDot active={step === 1} done={step > 1} />
            <div className="w-12 h-[2px] bg-black/20" />
            <StepDot active={step === 2} done={step > 2} />
            <div className="w-12 h-[2px] bg-black/20" />
            <StepDot active={step === 3} done={false} />
          </div>
        </Reveal>

        <div className="max-w-lg mx-auto px-6">
          <AnimatePresence mode="wait">
            {/* STEP 1 */}
            {step === 1 && (
              <motion.div
                key="step1"
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -40 }}
                transition={{ duration: 0.35 }}
                className="bg-white border-[2.5px] border-black p-8 flex flex-col gap-6"
                style={{ borderRadius: 14, boxShadow: "6px 6px 0 #000" }}
              >
                <div>
                  <div className="label-caps text-[#7BD3F7] mb-2">
                    Step 1 of 2
                  </div>
                  <h2 className="font-body-big text-[28px] mb-2">
                    Tell Ari who you are
                  </h2>
                  <p className="text-[14px] text-black/65 leading-relaxed">
                    Ari uses this to greet you and send messages on WhatsApp.
                  </p>
                </div>

                <ChunkyInput
                  label="Your Name"
                  placeholder="e.g. Raj, Sarah, James..."
                  value={name}
                  onChange={setName}
                />

                <div>
                  <ChunkyInput
                    label="WhatsApp Number"
                    type="tel"
                    placeholder="919876543210"
                    value={phone}
                    onChange={setPhone}
                    prefix="+"
                  />
                  <p className="text-[12px] text-black/55 mt-2">
                    Country code without the + (e.g. 919876543210 for India)
                  </p>
                </div>

                {error && (
                  <div
                    className="bg-[#FF9D6E] border-2 border-black px-4 py-3 text-[14px] font-bold"
                    style={{ borderRadius: 8 }}
                  >
                    {error}
                  </div>
                )}

                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="bg-black text-white px-7 py-4 rounded-full font-bold text-[14px] tracking-[0.16em] flex items-center justify-center gap-3 hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100 transition-transform"
                >
                  {saving ? "SAVING…" : "SAVE & CONTINUE →"}
                </button>
              </motion.div>
            )}

            {/* STEP 2 */}
            {step === 2 && (
              <motion.div
                key="step2"
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -40 }}
                transition={{ duration: 0.35 }}
                className="bg-white border-[2.5px] border-black p-8 flex flex-col gap-6"
                style={{ borderRadius: 14, boxShadow: "6px 6px 0 #000" }}
              >
                <div>
                  <div className="label-caps text-[#7BD3F7] mb-2">
                    Step 2 of 2
                  </div>
                  <h2 className="font-body-big text-[28px] mb-2">
                    Connect your accounts
                  </h2>
                  <p className="text-[14px] text-black/65 leading-relaxed">
                    Connect Google or Microsoft to unlock calendar, email, and
                    drive features.{" "}
                    <span className="font-bold text-black">
                      You can skip and connect later via WhatsApp.
                    </span>
                  </p>
                </div>

                <div className="flex flex-col gap-3">
                  <ConnectButton
                    label="Google"
                    icon={
                      <img
                        src="/logos/gmail.svg"
                        alt="Google"
                        className="w-5 h-5 object-contain"
                      />
                    }
                    href={googleAuthUrl}
                    connected={googleConnected}
                    disabled={!phoneValid}
                    bg="#FFFFFF"
                  />
                  <p className="text-[12px] text-black/55 pl-1">
                    Connects Gmail, Calendar, Drive, Docs, Sheets
                  </p>

                  <ConnectButton
                    label="Microsoft"
                    icon={
                      <svg
                        viewBox="0 0 21 21"
                        width="20"
                        height="20"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                        <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                        <rect
                          x="1"
                          y="11"
                          width="9"
                          height="9"
                          fill="#00a4ef"
                        />
                        <rect
                          x="11"
                          y="11"
                          width="9"
                          height="9"
                          fill="#ffb900"
                        />
                      </svg>
                    }
                    href={msAuthUrl}
                    connected={msConnected}
                    disabled={!phoneValid}
                    bg="#FFFFFF"
                  />
                  <p className="text-[12px] text-black/55 pl-1">
                    Connects Outlook, OneDrive
                  </p>
                </div>

                {!googleConnected && (
                  <button
                    onClick={() => setGoogleConnected(true)}
                    className="text-[12px] text-black/55 underline underline-offset-2 text-left"
                  >
                    I already connected Google ✓
                  </button>
                )}
                {!msConnected && (
                  <button
                    onClick={() => setMsConnected(true)}
                    className="text-[12px] text-black/55 underline underline-offset-2 text-left -mt-3"
                  >
                    I already connected Microsoft ✓
                  </button>
                )}

                <button
                  onClick={() => setStep(3)}
                  className="bg-black text-white px-7 py-4 rounded-full font-bold text-[14px] tracking-[0.16em] hover:scale-[1.02] transition-transform mt-2"
                >
                  I&apos;M ALL SET →
                </button>

                <button
                  onClick={() => setStep(3)}
                  className="text-[13px] text-black/55 underline underline-offset-2 text-center"
                >
                  Skip — connect via WhatsApp later
                </button>
              </motion.div>
            )}

            {/* STEP 3 */}
            {step === 3 && (
              <motion.div
                key="step3"
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.4 }}
                className="bg-[#FFE38C] border-[2.5px] border-black p-10 flex flex-col items-center gap-6 text-center"
                style={{ borderRadius: 14, boxShadow: "8px 8px 0 #000" }}
              >
                <motion.div
                  animate={{ rotate: [-5, 5, -5] }}
                  transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
                  className="text-[88px] select-none leading-none"
                >
                  🐺
                </motion.div>
                <div>
                  <h2 className="font-body-big text-[34px] mb-2 leading-tight">
                    You&apos;re all set
                    {name ? `, ${name.split(" ")[0]}` : ""}!
                  </h2>
                  <p className="text-[15px] text-black/75 leading-relaxed">
                    Ari is waiting for you on WhatsApp. Say hi — Ari
                    responds within seconds.
                  </p>
                </div>

                <div
                  className="bg-white border-[2.5px] border-black px-5 py-4 w-full text-left"
                  style={{ borderRadius: 10, boxShadow: "4px 4px 0 #000" }}
                >
                  <p className="label-caps text-black/55 mb-2">
                    Try saying this on WhatsApp
                  </p>
                  <p className="font-mono font-bold text-[15px]">
                    &ldquo;Remind me to review my goals every Sunday at 7
                    PM&rdquo;
                  </p>
                </div>

                <BlackPill
                  href="https://wa.me/+918000000000"
                  iconBg="#9BE7BF"
                  iconChar="▶"
                >
                  OPEN WHATSAPP CHAT
                </BlackPill>

                <Link
                  href="/preview-nudge"
                  className="text-[13px] text-black/65 underline underline-offset-2"
                >
                  Back to homepage
                </Link>
              </motion.div>
            )}
          </AnimatePresence>

          {step !== 3 && (
            <Reveal delay={0.5}>
              <p className="text-center text-[12px] text-black/55 mt-8 leading-relaxed">
                You can always connect accounts later by messaging Ari on
                WhatsApp.
                <br />
                Need help?{" "}
                <a
                  href="http://127.0.0.1:43101"
                  className="underline underline-offset-2 font-bold"
                >
                  Open Ari Desktop support
                </a>
              </p>
            </Reveal>
          )}
        </div>
      </section>
    </PageShell>
  );
}
