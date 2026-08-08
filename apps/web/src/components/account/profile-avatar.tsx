import { cn } from "@/lib/cn";

export function profileInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] ?? "?"}${parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : ""}`.toUpperCase();
}

/** Private signed avatar when available, with deterministic initials as fallback. */
export function ProfileAvatar({
  displayName,
  avatarUrl,
  className,
}: {
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-full border border-accent/35 bg-accent-soft text-sm font-semibold text-accent",
        className,
      )}
      aria-hidden="true"
    >
      {avatarUrl === undefined ? (
        profileInitials(displayName)
      ) : (
        // Signed private-media URLs are more reliable as an image source than
        // when interpolated into CSS background-image syntax.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt="" className="size-full object-cover" />
      )}
    </span>
  );
}
