import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Logo } from "@/components/logo";

export const LEGAL = {
  product: "Agentic RAG",
  // TODO: replace with your real contact address before going live.
  contactEmail: "support@example.com",
  lastUpdated: "November 7, 2026",
};

export type LegalSection = { id: string; title: string; body: React.ReactNode };

/** Shared layout for the Terms and Privacy pages: header, table of contents and prose sections. */
export function LegalPage({ title, intro, sections }: { title: string; intro: React.ReactNode; sections: LegalSection[] }) {
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-5">
          <Link href="/" aria-label="Agentic RAG home"><Logo /></Link>
          <nav className="flex items-center gap-4 text-[13.5px] text-muted">
            <Link href="/terms" className="hover:text-ink">Terms</Link>
            <Link href="/privacy" className="hover:text-ink">Privacy</Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-5 pb-20 pt-10 md:grid md:grid-cols-[200px_1fr] md:gap-12">
        <aside className="hidden md:block">
          <div className="sticky top-24">
            <p className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted">On this page</p>
            <ul className="space-y-1.5 text-[13px]">
              {sections.map((s) => (
                <li key={s.id}><a href={`#${s.id}`} className="text-ink/70 hover:text-ink">{s.title}</a></li>
              ))}
            </ul>
          </div>
        </aside>

        <article className="min-w-0">
          <Link href="/" className="mb-6 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
            <ArrowLeft className="size-3.5" /> Back to app
          </Link>
          <h1 className="font-serif text-[36px] font-medium leading-tight">{title}</h1>
          <p className="mt-2 text-[13px] text-muted">Last updated {LEGAL.lastUpdated}</p>
          <div className="mt-6 text-[15px] leading-relaxed text-ink/85">{intro}</div>

          <div className="mt-10 space-y-10">
            {sections.map((s, i) => (
              <section key={s.id} id={s.id} className="scroll-mt-24">
                <h2 className="font-serif text-[22px] font-medium">{i + 1}. {s.title}</h2>
                <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-ink/85 [&_a]:text-accent [&_a:hover]:underline [&_li]:pl-1 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
                  {s.body}
                </div>
              </section>
            ))}
          </div>

          <p className="mt-14 border-t border-line pt-6 text-[13px] text-muted">
            Questions? Contact us at <a href={`mailto:${LEGAL.contactEmail}`} className="text-accent hover:underline">{LEGAL.contactEmail}</a>.
          </p>
        </article>
      </div>
    </div>
  );
}
