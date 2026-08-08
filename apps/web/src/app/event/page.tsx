import { permanentRedirect } from "next/navigation";

/** Preserve old bookmarks while making `/events` the sole chooser URL. */
export default function LegacyEventLandingPage() {
  permanentRedirect("/events");
}
