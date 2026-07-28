import type { SVGProps } from "react";

/**
 * Hand-rolled 24×24 stroke icons.
 *
 * An icon package would be the single biggest dependency in this app for the
 * six glyphs the skeleton needs, so these are inline. They inherit `color` via
 * `currentColor` and size via the `size` prop (default 20, the nav size).
 */

type IconProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & {
  readonly size?: number;
};

function Icon({ size = 20, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 10.5 12 3.5l8.5 7" />
      <path d="M5.5 9.5V20h13V9.5" />
      <path d="M9.5 20v-5.5h5V20" />
    </Icon>
  );
}

export function SlideshowIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="4.5" width="19" height="13" rx="2" />
      <path d="M10 9.2v4.1l3.6-2.05z" fill="currentColor" stroke="none" />
      <path d="M8.5 21h7" />
    </Icon>
  );
}

export function MediaIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="5.5" width="14" height="13" rx="2" />
      <path d="M6.5 15.5 10 12l3.5 3.5" />
      <circle cx="12.5" cy="9.5" r="1.1" />
      <path d="M20.5 8.5v9a3 3 0 0 1-3 3h-9" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h10" />
      <path d="M18 7h2" />
      <circle cx="16" cy="7" r="2" />
      <path d="M4 17h6" />
      <path d="M14 17h6" />
      <circle cx="12" cy="17" r="2" />
    </Icon>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.2 5 6v5.4c0 4.2 2.8 7.7 7 9.4 4.2-1.7 7-5.2 7-9.4V6z" />
      <path d="m9.3 12 1.9 1.9 3.5-3.6" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6.5 9.5 5.5 5 5.5-5" />
    </Icon>
  );
}

export function QrIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="3.5" width="6" height="6" rx="1" />
      <rect x="14.5" y="3.5" width="6" height="6" rx="1" />
      <rect x="3.5" y="14.5" width="6" height="6" rx="1" />
      <path d="M14.5 14.5h2.5V17m3.5 0v3.5H17" />
    </Icon>
  );
}

export function CalendarIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 9.5h17M8 3.5V6.5M16 3.5V6.5" />
    </Icon>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
      <path d="M15.5 5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 12h15M13.5 6l6 6-6 6" />
    </Icon>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9.5" cy="8" r="3.5" />
      <path d="M3 20c0-3.3 2.9-5.5 6.5-5.5S16 16.7 16 20" />
      <path d="M16.5 5.2a3.5 3.5 0 0 1 0 6.6M18 14.9c2 .8 3 2.6 3 5.1" />
    </Icon>
  );
}

/** The PartyBooth mark: a camera aperture with a confetti burst. */
export function LogoMark({ size = 24, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <circle cx="12" cy="13" r="7.2" stroke="currentColor" strokeWidth={1.6} />
      <circle cx="12" cy="13" r="2.8" fill="currentColor" />
      <path
        d="M12 3.4V1.2M17.6 5.1l1.5-1.6M6.4 5.1 4.9 3.5"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
      />
    </svg>
  );
}
