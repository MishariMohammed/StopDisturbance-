"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = { href: string; label: string; disabled?: boolean; note?: string };

export function NavLinks({ items, label }: { items: NavItem[]; label: string }) {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap items-center gap-1">
        {items.map((item) => {
          const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
          if (item.disabled) {
            return (
              <li key={item.href}>
                <span aria-disabled="true" className="inline-flex min-h-tap items-center gap-1 rounded-md px-3 text-sm text-muted">
                  {item.label}
                  {item.note && <span className="text-xs">({item.note})</span>}
                </span>
              </li>
            );
          }
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={`inline-flex min-h-tap items-center rounded-md px-3 text-sm font-medium ${current ? "bg-primary text-primary-fg" : "hover:bg-surface-2"}`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
