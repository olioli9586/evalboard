"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Re-renders the server page every few seconds while a run is in progress.
// The page stops rendering this once the run finishes, which stops the timer.
export function AutoRefresh({ seconds = 3 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);
  return null;
}
