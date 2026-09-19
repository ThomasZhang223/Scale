// Design tokens for the plain-React-Native surfaces this app still needs —
// the capture overlays and the AR fallback box. Most library and detail
// screens are built on @expo/ui SwiftUI primitives instead, which pick up
// the system appearance on their own and never read these.

export const colors = {
  accent: "#3a86ff",
  // matches iOS systemFill in both appearances, so it reads correctly
  // whether or not Liquid Glass is available.
  surfaceFallback: "rgba(120,120,128,0.16)",
  danger: "#ff3b30",
  warning: "#ff9f0a",
  textMuted: "rgba(60,60,67,0.6)",
} as const;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;

export const radius = { sm: 8, md: 12, lg: 20 } as const;
