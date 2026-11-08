// The app's one icon set: authored 24px line icons in a single stroke weight,
// drawn in currentColor so they take the text colour they sit next to.
// Decorative by default (aria-hidden); give the control itself its label.

import type { SVGProps } from "react";

const PATHS = {
  "arrow-left": "M19 12H5m6-6-6 6 6 6",
  "arrow-right": "M5 12h14m-6-6 6 6-6 6",
  minus: "M5 12h14",
  plus: "M12 5v14M5 12h14",
  copy: "M9 9h10v10H9zM5 15V5h10",
  check: "m5 12.5 4.5 4.5L19 7",
  ticket:
    "M4 8a2 2 0 0 0 2-2h12a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H6a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4zM14 6v12",
  calendar: "M5 6h14v14H5zM5 10h14M9 3v4m6-4v4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-13v4l3 2",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-10v6m0-9.5v.5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 18,
  ...rest
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
