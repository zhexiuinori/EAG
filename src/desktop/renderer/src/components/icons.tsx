import type { ReactNode } from "react";

/**
 * 图标集。
 *
 * 统一规格：20×20 视框、1.5 描边、随文字色。
 * 自己维护而不是引入图标库，是为了避免为一个纯展示需求新增运行时依赖
 * （项目此前用 "▸" "·" "✓" 之类的文字符号代替图标，视觉上很杂乱）。
 */

export interface IconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// -- 导航 ------------------------------------------------------------------

export const IconWorkspace = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="6" height="6" rx="1.5" />
    <rect x="11.5" y="2.5" width="6" height="6" rx="1.5" />
    <rect x="2.5" y="11.5" width="6" height="6" rx="1.5" />
    <rect x="11.5" y="11.5" width="6" height="6" rx="1.5" />
  </Svg>
);

export const IconChat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M17 9.5c0 3.6-3.13 6.5-7 6.5a7.7 7.7 0 0 1-2.2-.31L4 17l1.1-3.2A6.2 6.2 0 0 1 3 9.5C3 5.9 6.13 3 10 3s7 2.9 7 6.5Z" />
  </Svg>
);

export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="3.5" width="16" height="13" rx="2" />
    <path d="M5.5 8l2.5 2.25-2.5 2.25M10.5 12.5h4" />
  </Svg>
);

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 6a2 2 0 0 1 2-2h2.8a1.5 1.5 0 0 1 1.2.6l.7.9h6.3a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2V6Z" />
  </Svg>
);

export const IconDiff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3v9M6 15.5v1.5M14 17V8M14 5.5V4" />
    <circle cx="6" cy="13" r="1.8" />
    <circle cx="14" cy="6.5" r="1.8" />
    <path d="M6 3.5h3.5M10.5 17H14" />
  </Svg>
);

export const IconGauge = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 14.5a8 8 0 1 1 14 0" />
    <path d="M10 14.5 13 9.5" />
    <circle cx="10" cy="14.5" r="1.3" />
  </Svg>
);

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="7.2" />
    <path d="M10 9v4.5M10 6.6v.1" />
  </Svg>
);

export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 2.5 3.5 5.2v4.6c0 3.9 2.8 6.9 6.5 7.7 3.7-.8 6.5-3.8 6.5-7.7V5.2L10 2.5Z" />
    <path d="M7.6 10.1l1.7 1.7 3.1-3.4" />
  </Svg>
);

export const IconList = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="2.5" width="13" height="15" rx="2" />
    <path d="M7 6.5h6M7 10h6M7 13.5h3.5" />
  </Svg>
);

export const IconNetwork = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="4" r="1.8" />
    <circle cx="4" cy="15" r="1.8" />
    <circle cx="16" cy="15" r="1.8" />
    <path d="M10 5.8v3.7M8.5 10.5 5.2 13.6M11.5 10.5l3.3 3.1" />
  </Svg>
);

export const IconSliders = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3v5M6 12v5M14 3v3M14 10v7" />
    <circle cx="6" cy="10" r="1.8" />
    <circle cx="14" cy="8" r="1.8" />
  </Svg>
);

export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7.5" cy="7" r="2.6" />
    <path d="M2.8 16.5c0-2.6 2.1-4.2 4.7-4.2s4.7 1.6 4.7 4.2" />
    <path d="M13.5 5.2a2.4 2.4 0 0 1 0 4.6M14 12.6c1.9.4 3.2 1.8 3.2 3.9" />
  </Svg>
);

// -- 通用 ------------------------------------------------------------------

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7.5 4.5 13 10l-5.5 5.5" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 7.5 10 13l5.5-5.5" />
  </Svg>
);

export const IconArrowLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15.5 10h-11M9 4.5 3.5 10 9 15.5" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 10.5 8 14l7.5-8" />
  </Svg>
);

export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 4.5v11M4.5 10h11" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="9" r="5.5" />
    <path d="M13.2 13.2 17 17" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16.5 10a6.5 6.5 0 1 1-2-4.7" />
    <path d="M16.5 3v3.2h-3.2" />
  </Svg>
);

export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4.2v11.6l9-5.8-9-5.8Z" />
  </Svg>
);

export const IconStop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="9" height="9" rx="2" />
  </Svg>
);

export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 3.5h5.5V9" />
    <path d="M16.5 3.5 9.5 10.5" />
    <path d="M14 12.5v3a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3" />
  </Svg>
);

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 3.2 17.5 16H2.5L10 3.2Z" />
    <path d="M10 8v3.4M10 13.6v.1" />
  </Svg>
);

export const IconSparkle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 2.8l1.7 4.6 4.6 1.7-4.6 1.7L10 15.4l-1.7-4.6L3.7 9.1l4.6-1.7L10 2.8Z" />
    <path d="M15.5 14.2l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6.6-1.7Z" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="7.2" />
    <path d="M10 5.8V10l2.8 1.8" />
  </Svg>
);

export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11.5 2.5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7l-4.5-4.5Z" />
    <path d="M11.5 2.5V7H16" />
  </Svg>
);

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="7" width="9.5" height="10" rx="2" />
    <path d="M13 4.5V4a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 4v8A1.5 1.5 0 0 0 5 13.5h.5" />
  </Svg>
);

export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M17 3 9.5 10.5" />
    <path d="M17 3l-5 14-2.5-6.5L3 8l14-5Z" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 5.5h13" />
    <path d="M8 5.5V4a1.5 1.5 0 0 1 1.5-1.5h1A1.5 1.5 0 0 1 12 4v1.5" />
    <path d="M5 5.5l.8 10a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4l.8-10" />
    <path d="M8.5 9v4.5M11.5 9v4.5" />
  </Svg>
);

export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12.5 3.5 16.5 7.5 7 17H3v-4l9.5-9.5Z" />
    <path d="M11 5l4 4" />
  </Svg>
);

export const IconUser = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="6.5" r="3" />
    <path d="M4 17c0-3 2.7-5 6-5s6 2 6 5" />
  </Svg>
);

export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="7.2" />
    <path d="M3 10h14" />
    <path d="M10 2.8c2 1.9 3 4.4 3 7.2s-1 5.3-3 7.2c-2-1.9-3-4.4-3-7.2s1-5.3 3-7.2Z" />
  </Svg>
);

export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="4.5" cy="10" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="10" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconBell = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 3a4.2 4.2 0 0 0-4.2 4.2c0 3.6-1.3 4.8-1.3 4.8h11s-1.3-1.2-1.3-4.8A4.2 4.2 0 0 0 10 3Z" />
    <path d="M8.4 14.6a1.6 1.6 0 0 0 3.2 0" />
  </Svg>
);

export const IconPaperclip = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 6.5 8 12a2 2 0 1 0 2.8 2.8l6-6a3.5 3.5 0 0 0-5-5l-6 6a5 5 0 0 0 7 7l4.5-4.5" />
  </Svg>
);

export const IconBook = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H16v14H5.5A1.5 1.5 0 0 1 4 15.5v-11Z" />
    <path d="M4 15.5A1.5 1.5 0 0 1 5.5 14H16" />
  </Svg>
);

export const IconLogout = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 6V4.5A1.5 1.5 0 0 0 11.5 3h-6A1.5 1.5 0 0 0 4 4.5v11A1.5 1.5 0 0 0 5.5 17h6a1.5 1.5 0 0 0 1.5-1.5V14" />
    <path d="M9 10h8" />
    <path d="m14.5 7.5 2.5 2.5-2.5 2.5" />
  </Svg>
);

export const IconPin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5 16.5 8l-1.3.9-3.4.5.5 3.4 1 1-1.2 1.2L8 12.8 4.5 15.5l1.5-4.5 2.7-3.3 1.2-1.2 1 1 3.4.5.5-3.4L12 3.5Z" />
  </Svg>
);

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="3.2" />
    <path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M15.3 4.7 14 6M6 14l-1.3 1.3" />
  </Svg>
);

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16.5 11.5A6.5 6.5 0 1 1 8.5 3.5a5.5 5.5 0 0 0 8 8Z" />
  </Svg>
);

export const IconMonitor = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" />
    <path d="M7 17h6M10 13.5V17" />
  </Svg>
);

export const IconInbox = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 10.5 5 4.5h10l2.5 6v4a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 2.5 14.5v-4Z" />
    <path d="M2.5 11h4l1 2h5l1-2h4" />
  </Svg>
);
