/**
 * Multi-Agent Dev — 深色开发者主题设计令牌（terminal-inspired）。
 *
 * 主题方向：开发者工具 / Agent 编排终端。深海军蓝黑底 + 电光青主色，
 * 状态语义色（成功/失败/运行中）统一令牌，等宽字体用于 ID 与状态数据。
 * 遵循 ui-ux-pro-max 语义色 token / 8px 间距节奏 / 对比度 ≥4.5:1，
 * 以及 frontend-design 的克制原则（签名元素：Agent 节点 Logo + 状态脉冲）。
 */
import type React from "react";

export const theme = {
  // 表面
  bg: "#0B1220", // 页面背景（深海军蓝黑，非纯黑）
  surface: "#111A2E", // 卡片表面
  surfaceAlt: "#172238", // 次级表面（表头/输入）
  surfaceHover: "#1B2942", // hover
  border: "#24334F", // 边框
  borderStrong: "#31456B",

  // 文字
  text: "#E6EDF7", // 主文字
  textDim: "#93A5C3", // 次要文字
  textFaint: "#5E7191", // 弱化文字

  // 品牌色
  primary: "#22D3EE", // 电光青（主操作/连接/Agent）
  primaryText: "#0B1220", // 主按钮上的文字
  indigo: "#6366F1", // 辅助（集成/审查）
  violet: "#A78BFA",

  // 语义色
  success: "#34D399",
  warning: "#FBBF24",
  danger: "#F87171",

  // 状态 → 徽章/节点色
  status: {
    created: "#64748B",
    planning: "#38BDF8",
    ready: "#38BDF8",
    running: "#38BDF8",
    succeeded: "#34D399",
    failed: "#F87171",
    cancelled: "#64748B",
    pending: "#64748B",
    testing: "#FBBF24",
  } as Record<string, string>,

  // 字体
  font: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
  mono: "Consolas, 'JetBrains Mono', 'Courier New', monospace",

  // 尺寸
  radius: 10,
  radiusSm: 6,
  space: 4, // 4px 基础节奏
  shadow: "0 6px 20px rgba(0, 0, 0, .35)",
  shadowSm: "0 2px 8px rgba(0, 0, 0, .3)",
};

/** 状态徽章（带脉冲点，running 时动画）。 */
export const statusBadge = (status: string): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  color: theme.status[status] ?? theme.textDim,
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: ".04em",
  background: "rgba(255,255,255,.04)",
  border: `1px solid ${theme.border}`,
  borderRadius: 999,
  padding: "3px 10px",
});

/** 状态脉冲点（running/planning 时呼吸动画）。 */
export const statusDot = (status: string): React.CSSProperties => {
  const color = theme.status[status] ?? theme.textDim;
  const pulse = status === "running" || status === "planning" || status === "testing";
  return {
    width: 7,
    height: 7,
    borderRadius: 999,
    background: color,
    boxShadow: `0 0 0 0 ${color}`,
    animation: pulse ? "mad-pulse 1.6s infinite" : undefined,
  };
};
