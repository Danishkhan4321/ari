"use client";

import Link from "next/link";
import { motion, useInView } from "framer-motion";
import { useRef } from "react";
import { Sparkle, Circle, Diamond, Cross, Triangle, Pill } from "@/components/DecorativeShapes";
import type { Feature } from "@/lib/features-data";

function Reveal({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 24 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

interface FeaturePageClientProps {
  feature: Feature;
  related: Feature[];
}

export default function FeaturePageClient({ feature, related }: FeaturePageClientProps) {
  const isDark = feature.color.includes("text-white");

  return (
    <>
      {/* Breadcrumb */}
      <section className="bg-page border-b-2 border-black">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 py-4">
          <div className="font-sans text-sm flex items-center gap-2">
            <Link href="/features" className="text-txt-muted hover:text-black transition-colors">
              ← All Features
            </Link>
            <span className="text-txt-muted">/</span>
            <span className="text-black font-bold">{feature.category}</span>
          </div>
        </div>
      </section>

      {/* Hero */}
      <section className={`${feature.color} border-b-2 border-black relative overflow-hidden`}>
        <Sparkle className="absolute top-10 right-[8%] w-5 h-5 lg:w-7 lg:h-7 opacity-30 rotate-12" color={isDark ? "#DAF464" : "#7C3AED"} />
        <Diamond className="absolute bottom-16 left-[6%] w-4 h-4 lg:w-6 lg:h-6 opacity-25 -rotate-12" color={isDark ? "#7DFFB3" : "#FF6B9D"} />
        <Cross className="absolute top-[40%] right-[15%] w-3 h-3 opacity-30 rotate-45" color={isDark ? "#F2A3D8" : "#000000"} />
        <div className="max-w-5xl mx-auto px-6 lg:px-10 py-24 lg:py-32">
          <Reveal>
            <p className={`font-sans text-sm font-bold uppercase tracking-wider mb-4 ${isDark ? "text-card-lemon" : "text-card-purple"}`}>
              {feature.category}
            </p>
            <h1 className={`font-serif text-[44px] sm:text-[58px] lg:text-[72px] font-normal leading-[1.1] tracking-tight mb-6 ${isDark ? "text-white" : "text-black"}`}>
              {feature.title}
            </h1>
            <p className={`font-serif text-2xl sm:text-3xl italic leading-snug max-w-3xl mb-8 ${isDark ? "text-white/90" : "text-black"}`}>
              {feature.tagline}
            </p>
            <p className={`font-sans text-lg leading-relaxed max-w-2xl ${isDark ? "text-white/70" : "text-txt-muted"}`}>
              {feature.overview}
            </p>
          </Reveal>
        </div>
      </section>

      {/* Who it's for */}
      <section className="bg-page border-b-2 border-black">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 py-16">
          <Reveal>
            <p className="font-sans text-sm font-bold uppercase tracking-wider text-card-purple mb-4">Built For</p>
            <div className="flex flex-wrap gap-3">
              {feature.whoFor.map((who) => (
                <div key={who} className="bg-white border-2 border-black shadow-brutal px-5 py-2">
                  <span className="font-sans text-sm font-bold">{who}</span>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* Use Cases */}
      <section className="bg-card-dark text-white border-b-2 border-black relative overflow-hidden">
        <Pill className="absolute top-10 right-[8%] opacity-25 rotate-12" color="#DAF464" />
        <Triangle className="absolute bottom-12 left-[6%] w-5 h-5 opacity-20 rotate-45" color="#F2A3D8" />
        <div className="max-w-7xl mx-auto px-6 lg:px-10 py-24">
          <Reveal>
            <p className="font-sans text-sm font-bold uppercase tracking-wider text-card-lemon mb-4">Use Cases</p>
            <h2 className="font-serif text-[38px] sm:text-[50px] font-normal leading-[1.2] tracking-tight mb-12">
              How people use it.
            </h2>
          </Reveal>
          <div className="grid sm:grid-cols-2 gap-6">
            {feature.useCases.map((uc, i) => (
              <Reveal key={uc.title} delay={i * 0.05}>
                <div className="bg-white text-black border-2 border-black shadow-brutal p-7 h-full hover:-translate-y-1 hover:shadow-brutal-lg transition-all duration-150">
                  <div className="text-4xl mb-3">{uc.emoji}</div>
                  <h3 className="text-xl font-serif font-normal mb-2">{uc.title}</h3>
                  <p className="font-sans text-sm text-txt-muted leading-relaxed mb-4">{uc.desc}</p>
                  <div className="bg-card-lemon border-2 border-black px-3 py-2">
                    <p className="font-sans text-sm italic">{uc.example}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Live Chat Demo */}
      <section className="bg-card-lemon border-b-2 border-black relative overflow-hidden">
        <Circle className="absolute top-12 left-[5%] w-5 h-5 opacity-30" color="#7C3AED" />
        <Sparkle className="absolute bottom-16 right-[8%] w-4 h-4 opacity-30" color="#FF6B9D" />
        <div className="max-w-5xl mx-auto px-6 lg:px-10 py-24">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <Reveal>
              <p className="font-sans text-sm font-bold uppercase tracking-wider text-card-purple mb-4">Try It</p>
              <h2 className="font-serif text-[38px] sm:text-[50px] font-normal leading-[1.1] tracking-tight mb-6">
                Just{" "}
                <span className="bg-white px-3 border-2 border-black inline-block -rotate-1">say it.</span>
              </h2>
              <p className="font-sans text-lg text-txt-muted leading-relaxed mb-6">
                Here&apos;s what it looks like on WhatsApp. No menus. No forms. Just text.
              </p>
            </Reveal>
            <Reveal delay={0.2}>
              <div className="bg-white border-2 border-black shadow-brutal-lg p-6 rotate-1">
                <div className="flex items-center gap-3 mb-5 pb-4 border-b-2 border-black/10">
                  <div className="w-10 h-10 rounded-full bg-card-purple border-2 border-black flex items-center justify-center text-white font-bold">S</div>
                  <div>
                    <div className="font-sans font-bold text-sm">Ari</div>
                    <div className="font-sans text-xs text-txt-muted">online</div>
                  </div>
                </div>
                <div className="flex justify-end mb-3">
                  <div className="bg-card-teal border-2 border-black px-4 py-2 max-w-[85%]">
                    <p className="font-sans text-sm whitespace-pre-line">{feature.chat.user}</p>
                  </div>
                </div>
                <div className="flex justify-start">
                  <div className="bg-card-pink border-2 border-black px-4 py-2 max-w-[90%]">
                    <p className="font-sans text-sm whitespace-pre-line">{feature.chat.ari}</p>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* Benefits */}
      <section className="bg-page border-b-2 border-black">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 py-24">
          <Reveal>
            <p className="font-sans text-sm font-bold uppercase tracking-wider text-card-purple mb-4">Why It Matters</p>
            <h2 className="font-serif text-[38px] sm:text-[50px] font-normal leading-[1.2] tracking-tight mb-12">
              The benefits.
            </h2>
          </Reveal>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {feature.benefits.map((b, i) => {
              const colors = ["bg-card-teal", "bg-card-lemon", "bg-card-pink", "bg-card-orange"];
              return (
                <Reveal key={b} delay={i * 0.05}>
                  <div className={`${colors[i % 4]} border-2 border-black shadow-brutal p-6 h-full`}>
                    <div className="bg-black text-white border-2 border-black w-10 h-10 flex items-center justify-center font-bold mb-4">
                      {String(i + 1).padStart(2, "0")}
                    </div>
                    <p className="font-sans font-bold leading-snug">{b}</p>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* Related Features */}
      {related.length > 0 && (
        <section className="bg-card border-b-2 border-black">
          <div className="max-w-7xl mx-auto px-6 lg:px-10 py-24">
            <Reveal>
              <p className="font-sans text-sm font-bold uppercase tracking-wider text-card-purple mb-4">More From {feature.category}</p>
              <h2 className="font-serif text-[38px] sm:text-[44px] font-normal leading-[1.2] tracking-tight mb-12">
                You might also like.
              </h2>
            </Reveal>
            <div className="grid md:grid-cols-3 gap-6">
              {related.map((r, i) => (
                <Reveal key={r.slug} delay={i * 0.05}>
                  <Link href={`/features/${r.slug}`} className="block">
                    <div className={`${r.color} border-2 border-black shadow-brutal p-7 h-full hover:-translate-y-1 hover:shadow-brutal-lg transition-all duration-150`}>
                      <h3 className="text-xl font-serif font-normal mb-2">{r.title}</h3>
                      <p className={`font-sans text-sm leading-relaxed mb-4 ${r.color.includes("text-white") ? "text-white/70" : "text-txt-muted"}`}>
                        {r.tagline}
                      </p>
                      <span className={`font-sans text-sm font-bold ${r.color.includes("text-white") ? "text-card-lemon" : "text-card-purple"}`}>
                        Learn more →
                      </span>
                    </div>
                  </Link>
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* CTA */}
      <section className="bg-card-purple text-white border-b-2 border-black relative overflow-hidden">
        <Sparkle className="absolute top-10 right-[10%] w-6 h-6 opacity-30 rotate-12" color="#DAF464" />
        <Diamond className="absolute bottom-10 left-[8%] w-4 h-4 opacity-25 rotate-45" color="#7DFFB3" />
        <div className="max-w-4xl mx-auto px-6 lg:px-10 py-24 text-center">
          <h2 className="font-serif text-[38px] sm:text-[50px] font-normal leading-[1.2] tracking-tight mb-4">
            Ready to try it?
          </h2>
          <p className="font-sans text-lg text-white/70 max-w-xl mx-auto mb-8">
            {feature.title} works inside WhatsApp. Free for everyone, with full access.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <a href="http://127.0.0.1:43101" className="font-sans bg-card-lemon text-black border-2 border-black shadow-brutal px-6 py-3 font-bold hover:-translate-y-0.5 hover:shadow-brutal-lg transition-all duration-150">
              Open Ari Desktop
            </a>
            <Link href="/features" className="font-sans bg-white text-black border-2 border-black shadow-brutal px-6 py-3 font-bold hover:-translate-y-0.5 hover:shadow-brutal-lg transition-all duration-150">
              See All Features →
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
