import type { PosterColor } from "./types";

// Tailwind can't construct class names from interpolated strings, so
// each event's poster color needs a literal, statically-scannable
// entry here rather than `bg-${posterColor}`.
export const posterColorClasses: Record<
  PosterColor,
  { bg: string; text: string; border: string; ring: string }
> = {
  flame: {
    bg: "bg-flame",
    text: "text-flame",
    border: "border-flame",
    ring: "ring-flame",
  },
  acid: {
    bg: "bg-acid",
    text: "text-acid",
    border: "border-acid",
    ring: "ring-acid",
  },
  violet: {
    bg: "bg-violet",
    text: "text-violet",
    border: "border-violet",
    ring: "ring-violet",
  },
};
