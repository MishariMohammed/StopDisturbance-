"use client";
import { useEffect } from "react";

/**
 * Sets <html data-hydrated> once React has hydrated the page. Until then client-only behaviour (the app
 * router's back/forward handling, onClick/onChange handlers) is not attached; e2e tests wait for this.
 */
export function HydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);
  return null;
}
