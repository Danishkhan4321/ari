"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const footerLinks = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "/features" },
      { label: "Meeting Recorder", href: "/meet" },
      { label: "FAQ", href: "/faq" },
    ],
  },
  {
    title: "Platform",
    links: [
      { label: "WhatsApp", href: "/features#whatsapp" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Terms & Conditions", href: "/terms" },
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
];

export default function Footer() {
  const pathname = usePathname();
  // New design has its own footer (FooterStrip via PageShell). Hide global.
  return null;
  // eslint-disable-next-line no-unreachable
  if (pathname?.startsWith("/preview-nudge")) return null;
  return (
    <footer className="bg-black text-white border-t-2 border-black">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 pt-16 pb-8">
        {/* Top: Logo + tagline */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 mb-12 pb-8 border-b border-white/20">
          <div>
            <div className="flex items-center gap-2.5 mb-3">
              <img src="/logo-wolf.png" alt="Ari logo" width={40} height={40} className="rounded-md" />
              <span className="text-2xl font-bold tracking-tight">Ari</span>
            </div>
            <p className="text-white/60 max-w-md">
              You just work. Ari remembers, organizes, and executes for you.
            </p>
          </div>
          <a href="http://127.0.0.1:43101" className="btn-brutal-sm !border-white !shadow-[4px_4px_0_#fff]">
            Open Ari Desktop
          </a>
        </div>

        {/* Link grid */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8 mb-12">
          {footerLinks.map((col) => (
            <div key={col.title}>
              <h4 className="text-sm font-bold uppercase tracking-wider text-white mb-4">
                {col.title}
              </h4>
              <ul className="space-y-3">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-white/60 hover:text-card-lemon transition-colors duration-150"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Copyright */}
        <div className="border-t border-white/20 pt-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-white/40">
            &copy; {new Date().getFullYear()} Ari. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
