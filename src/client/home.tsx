import { Brand, Footer } from "./brand";
import { Button } from "./components/ui/button";

export function HomePage() {
  return (
    <div className="safe-pad min-h-dvh">
      <Brand subtitle="Hear the tour in your language" />
      <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-5">
        <section className="rounded-3xl bg-white p-5 shadow-card">
          <p className="text-lg font-extrabold leading-snug text-brand-navy">
            Your guide speaks English. You hear the same tour in your own language, on this phone, through your earphones.
          </p>
          <p className="mt-3 text-base font-semibold leading-relaxed text-brand-navy/80">
            Guests do not install anything. Ask your guide for the QR code, choose a language, and tap to listen.
          </p>
        </section>
        <section className="rounded-3xl border-2 border-brand-yellow bg-brand-yellow/20 p-5">
          <p className="text-sm font-extrabold uppercase tracking-wide text-brand-navy">Translated by AI</p>
          <p className="mt-2 text-sm font-semibold leading-relaxed text-brand-navy/80">
            The voice is synthetic. It is not a recording of your guide. Audio from the live tour is not kept after the tour ends.
          </p>
        </section>
        <Button variant="navy" size="lg" onClick={() => (window.location.href = "/guide")}>
          Guide desk
        </Button>
      </main>
      <Footer />
    </div>
  );
}
