import { Callout } from "@/components/ui/callout";
import { Code } from "@/components/ui/code";

/**
 * Shown wherever a screen would otherwise call Convex.
 *
 * No provider credentials exist yet (TODO.md → "Notes for Corey"), so the app
 * has to be fully browsable with an empty `.env.local`. Rather than crash or
 * show a spinner forever, anything that needs the backend renders this and
 * names the exact variable that is missing.
 */
export function BackendNotConfigured({ className }: { readonly className?: string }) {
  return (
    <Callout tone="warning" title="Backend not configured" className={className}>
      <p>
        <Code>NEXT_PUBLIC_CONVEX_URL</Code> is not set, so sign-in and live data are unavailable.
        Everything else renders normally.
      </p>
      <p className="mt-2 text-muted">
        Copy <Code>.env.example</Code> to <Code>.env.local</Code>, then run{" "}
        <Code>bun run env:doctor</Code> to see what is still missing.
      </p>
    </Callout>
  );
}

/**
 * The thinner banner used inside authenticated shells, where the page has
 * already decided to render in preview mode.
 */
export function PreviewModeBanner() {
  return (
    <div
      role="status"
      className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-center text-xs text-warning"
    >
      Preview mode — no Convex deployment configured, so nothing here is signed in or live.
    </div>
  );
}
