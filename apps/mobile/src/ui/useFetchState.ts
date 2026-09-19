// The loading/error/ready fetch pattern every screen in this app repeats
// against the X-Stub: 1 layer. Lives under src/ui/ rather than src/lib/,
// because src/lib/api.ts and src/lib/sse.ts are the only two src/lib files
// Panel B owns (CLAUDE.md file ownership) — this is screen-support code,
// not a new lib surface.
import { useCallback, useEffect, useState } from "react";

export type FetchState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

export function useFetchState<T>(fetcher: () => Promise<T>, deps: unknown[]): [FetchState<T>, () => void] {
  const [state, setState] = useState<FetchState<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetcher()
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
    // deps is caller-controlled, same contract as useEffect's own array;
    // `attempt` is appended so retry() re-runs the same fetcher.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return [state, retry];
}
