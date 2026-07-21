import type { Metadata } from "next";
import "./globals.css";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "http://127.0.0.1:43101",
  ),
  title: "Ari | Your Agentic Operating System for Work",
  description:
    "Ari is an AI-powered work platform for founders, freelancers, and small teams. Manage leads, outreach, team, tasks, meetings, and daily operations from one intelligent workspace — powered by an agentic AI that understands your context and takes action. Control it from WhatsApp or the dashboard.",
  keywords: [
    "agentic AI",
    "AI work management",
    "AI assistant for founders",
    "lead generation",
    "team management",
    "AI meeting assistant",
    "task management",
    "WhatsApp AI agent",
  ],
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/logo-wolf.png", type: "image/png" },
    ],
    apple: "/logo-wolf.png",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Ari",
    title: "Ari | Your Agentic Operating System for Work",
    description:
      "One intelligent workspace for leads, team, meetings, tasks, and outreach — an agentic AI that understands your context and takes action. Control it from WhatsApp or the dashboard.",
    images: [{ url: "/logo-wolf.png" }],
  },
  twitter: {
    card: "summary",
    title: "Ari | Your Agentic Operating System for Work",
    description:
      "Manage leads, team, meetings, tasks, and outreach from one intelligent workspace. An agentic AI that takes action — controllable from WhatsApp or the dashboard.",
    images: ["/logo-wolf.png"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="scroll-smooth">
      <body className="bg-page text-black antialiased">
        <Navbar />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
