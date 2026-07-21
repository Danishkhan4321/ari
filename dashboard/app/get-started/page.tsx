import Link from "next/link";
import { AriMark } from "@/components/icons";
import { ariWhatsAppDigits, formatWhatsAppDisplay, whatsappDeepLink } from "@/lib/whatsapp";
import { GetStartedContent } from "./get-started-content";

export const dynamic = "force-dynamic";

export default function GetStartedPage() {
  const digits = ariWhatsAppDigits();
  const phoneDisplay = formatWhatsAppDisplay(digits);
  const startUrl = whatsappDeepLink("hi");

  return (
    <main className="min-h-screen flex items-start justify-center p-6 pt-12 pb-16">
      <div className="card-brutal rounded-[4px] p-8 max-w-lg w-full">
        <div className="w-16 h-16 rounded-[16px] bg-ari-midnight grid place-items-center mb-5 shadow-[0_12px_30px_rgba(90,55,214,0.2)]">
          <AriMark className="w-12 h-12" />
        </div>
        <h1 className="text-3xl font-bold mb-2">Get started with Ari</h1>
        <p className="text-txt-muted mb-8">
          Ari is WhatsApp-first. Your phone number becomes your account on the first message.
        </p>

        <GetStartedContent
          phoneDisplay={phoneDisplay}
          phoneDigits={digits}
          startUrl={startUrl}
          dashboardUrl="/login"
        />

        <p className="text-txt-muted text-sm mt-8 pt-6 border-t-2 border-black/10">
          Already chatting with Ari?{" "}
          <Link href="/login" className="font-semibold underline">
            Sign in to the dashboard →
          </Link>
        </p>
      </div>
    </main>
  );
}
