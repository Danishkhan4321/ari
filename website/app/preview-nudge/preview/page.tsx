"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { PageShell, Reveal, HandLabel } from "../_shared";
import Link from "next/link";

export default function PreviewRedirect() {
  const router = useRouter();
  useEffect(() => {
    const t = setTimeout(() => router.replace("/preview-nudge"), 1500);
    return () => clearTimeout(t);
  }, [router]);

  return (
    <PageShell>
      <section className="min-h-[60vh] flex flex-col items-center justify-center text-center px-6">
        <Reveal>
          <HandLabel text="redirecting →" width={140} className="mb-4" />
        </Reveal>
        <h1 className="font-display text-[clamp(26px,4.4vw,46px)] leading-[0.88]">
          THE PREVIEW
          <br />
          <span className="inline-block bg-[#7BD3F7] border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
            IS NOW HOME.
          </span>
        </h1>
        <p className="mt-8 text-[15px] text-black/60">
          Taking you to{" "}
          <Link
            href="/preview-nudge"
            className="underline underline-offset-2 font-bold"
          >
            /preview-nudge
          </Link>
          …
        </p>
      </section>
    </PageShell>
  );
}
