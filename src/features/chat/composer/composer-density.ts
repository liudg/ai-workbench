/** 作曲栏控件随可用宽度收拢，避免权限、计划和模型叠在一起。 */
export type ComposerDensity = "full" | "compact" | "icons";

const FULL_MIN = 520;
const COMPACT_MIN = 360;

export function composerDensity(barWidth: number): ComposerDensity {
  if (barWidth >= FULL_MIN) return "full";
  if (barWidth <= 0 || barWidth >= COMPACT_MIN) return "compact";
  return "icons";
}
