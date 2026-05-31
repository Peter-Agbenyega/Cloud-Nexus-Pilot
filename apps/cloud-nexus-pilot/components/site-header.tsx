import Link from "next/link";
import { siteConfig } from "@/lib/site";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/50 bg-background/75 backdrop-blur-lg">
      <div className="section-shell flex h-16 items-center justify-between">
        <Link href="/" className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-sm font-semibold text-primary">
            {siteConfig.brandMark}
          </span>
          <div>
            <p className="font-semibold text-foreground">{siteConfig.name}</p>
            <p className="text-xs text-text-secondary">{siteConfig.tagline}</p>
          </div>
        </Link>
        <nav className="hidden items-center gap-6 text-sm font-medium text-text-secondary md:flex">
          {siteConfig.mainNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="transition hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <Link
          href={siteConfig.cta.href}
          className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-hover"
        >
          {siteConfig.cta.label}
        </Link>
      </div>
    </header>
  );
}
