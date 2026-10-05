"use client";
import { authClient } from "@/lib/auth/client";

export function LoginButtons({ locale, labels }: { locale: string; labels: { google: string; microsoft: string } }) {
  const go = (provider: "google" | "microsoft") =>
    authClient.signIn.social({ provider, callbackURL: `/${locale}/connect`, errorCallbackURL: `/${locale}/login?error=1` });
  return (
    <div className="mt-8 flex flex-col gap-3">
      <button type="button" onClick={() => go("google")} className="rounded-md bg-brand px-4 py-3 text-brand-ink focus-visible:outline-2 focus-visible:outline-offset-2">
        {labels.google}
      </button>
      <button type="button" onClick={() => go("microsoft")} className="rounded-md border border-border-strong px-4 py-3 focus-visible:outline-2 focus-visible:outline-offset-2">
        {labels.microsoft}
      </button>
    </div>
  );
}
