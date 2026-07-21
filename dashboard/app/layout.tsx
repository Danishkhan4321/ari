import type { Metadata } from "next";
import { DesktopWindowMode } from "@/components/desktop-window-mode";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ari Dashboard",
  description: "Your private Ari workspace for tasks, contacts, messages, meetings, and more.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/ari-icon.svg", type: "image/svg+xml" },
    ],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="scroll-smooth">
      <body className="bg-page text-ari-text antialiased min-h-screen">
        <DesktopWindowMode />
        {children}
      </body>
    </html>
  );
}
