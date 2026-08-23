import { defaultTextMapSetter, type Context } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { BrowserContext } from "playwright";

/**
 * Exact host, or a subdomain of an allowlisted host.
 *
 * Deliberately not a substring match. The harness has a third-party host list
 * that gates on `host.includes(pattern)`, which would let
 * `evil-sentry.iomalicious.com` match `sentry.io`. That is fine for labelling
 * agent evidence and unusable as a gate on where trace context is sent.
 *
 * An empty allowlist propagates to nothing: this is a default-deny gate, and
 * there is no wildcard, so a third-party domain cannot be matched by accident.
 */
export function shouldPropagateTo(hostname: string, allowlist: string[]): boolean {
  if (!hostname || allowlist.length === 0) return false;

  const host = hostname.toLowerCase();
  return allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export type TraceparentPropagationOptions = {
  /** Context the header should reference, or undefined to send nothing. */
  getContext: () => Context | undefined;
  allowlist: string[];
};

/**
 * Inject W3C `traceparent` into requests the browser makes, so an
 * OTel-instrumented app under test parents its own spans under our step span.
 *
 * Registered on the BrowserContext rather than the Page, so popups are covered
 * without re-installing. The URL predicate means non-allowlisted requests are
 * never intercepted at all, which keeps the interception cost off the hot path
 * and avoids perturbing the network-idle and stall heuristics.
 */
export async function installTraceparentPropagation(
  browserContext: BrowserContext,
  options: TraceparentPropagationOptions,
): Promise<void> {
  const { getContext, allowlist } = options;
  if (allowlist.length === 0) return;

  const propagator = new W3CTraceContextPropagator();

  await browserContext.route(
    (url) => shouldPropagateTo(url.hostname, allowlist),
    async (route) => {
      try {
        const active = getContext();
        if (!active) {
          await route.fallback();
          return;
        }

        // fallback rather than continue, so this composes with any handler
        // registered later.
        const headers = { ...route.request().headers() };
        propagator.inject(active, headers, defaultTextMapSetter);
        await route.fallback({ headers });
      } catch {
        // A route can already be handled, or the context can close mid-flight.
        // Propagation is best-effort and must never break a run.
      }
    },
  );
}
