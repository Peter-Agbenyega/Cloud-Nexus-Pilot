import Link from "next/link";
import { siteConfig } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="border-t border-slate-200/80 bg-white/80">
      <div className="section-shell flex flex-col gap-6 py-10 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="font-semibold text-slate-950">{siteConfig.name}</p>
          <p className="mt-2 max-w-xl text-sm text-slate-600">{siteConfig.footer}</p>
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-slate-600">
          {siteConfig.mainNav.map((item) => (
            <Link key={item.href} href={item.href} className="transition hover:text-slate-950">
              {item.label}
            </Link>
          ))}
        </div>
      </div>
    </footer>
  );
}
