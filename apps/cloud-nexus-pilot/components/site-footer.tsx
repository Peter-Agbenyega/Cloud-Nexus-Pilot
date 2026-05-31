import Link from "next/link";
import { siteConfig } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="border-t border-border/50 bg-surface/80">
      <div className="section-shell flex flex-col gap-6 py-10 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="font-semibold text-foreground">{siteConfig.name}</p>
          <p className="mt-2 max-w-xl text-sm text-text-secondary">{siteConfig.footer}</p>
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-text-secondary">
          {siteConfig.mainNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="transition hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </div>
      </div>
    </footer>
  );
}
