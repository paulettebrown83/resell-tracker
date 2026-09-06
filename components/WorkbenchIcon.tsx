import type { CSSProperties } from "react";

export type IconName =
  | "grid"
  | "box"
  | "plus"
  | "photo"
  | "store"
  | "sale"
  | "receipt"
  | "attention"
  | "search"
  | "arrow"
  | "close"
  | "download"
  | "refresh"
  | "check"
  | "chevron"
  | "tag";
const paths: Record<IconName, string> = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  box: "m3 7 9-4 9 4v10l-9 4-9-4V7Zm0 0 9 4 9-4M12 11v10M7.5 5 17 9",
  plus: "M12 5v14M5 12h14",
  photo: "M4 4h16v16H4z M4 16l5-5 4 4 3-3 4 4 M15 8h.01",
  store:
    "M3 10h18l-2-7H5l-2 7Zm1 0v11h16V10M9 21v-7h6v7M3 10c0 4 5 4 5 0 0 4 8 4 8 0 0 4 5 4 5 0",
  sale: "m4 16 5-5 4 3 7-9M14 5h6v6M3 21h18",
  receipt: "M5 3h14v18l-3-2-4 2-4-2-3 2V3Zm4 5h6M9 12h6",
  attention: "M12 3 2 21h20L12 3Zm0 6v5M12 18h.01",
  search: "M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Zm5.5-2 5 5",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  close: "m6 6 12 12M6 18 18 6",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  refresh:
    "M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5",
  check: "m5 12 4 4L19 6",
  chevron: "m9 5 7 7-7 7",
  tag: "M3 3h8l10 10-8 8L3 11V3Zm5 5h.01",
};
export default function WorkbenchIcon({
  name,
  size = 20,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
