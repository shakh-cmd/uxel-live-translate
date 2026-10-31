export function Brand({ subtitle }: { subtitle: string }) {
  return (
    <header className="bg-brand-navy px-4 pb-5 pt-[max(1rem,env(safe-area-inset-top))] text-white">
      <div className="mx-auto flex max-w-md items-center justify-between gap-3">
        <div>
          <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-brand-yellow">Tourmania</p>
          <h1 className="text-2xl font-extrabold leading-tight">Live Translate</h1>
        </div>
        <p className="max-w-[9.5rem] text-right text-xs font-bold leading-snug text-white/80">{subtitle}</p>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="mx-auto max-w-md px-4 py-8 text-center text-sm font-bold text-brand-navy/70">
      <p>Tourmania Live Translate</p>
      <a className="mt-1 inline-block text-brand-blue" href="mailto:info@tourmania.com">
        info@tourmania.com
      </a>
    </footer>
  );
}
