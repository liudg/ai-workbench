import { useEffect, useState } from "react";

import type { ReviewTargets } from "@/types";
import { fetchReviewTargets } from "./composer-backend";

export function useReviewTargets(sessionId: string) {
  const [targets, setTargets] = useState<ReviewTargets | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTargets(null);
    setError(null);
    void fetchReviewTargets(sessionId)
      .then((next) => {
        if (!cancelled) setTargets(next);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return { targets, error };
}
