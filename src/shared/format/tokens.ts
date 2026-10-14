/** TUI `format_tokens_compact`：12500 → 12.5K，50000 → 50K，63876 → 63.9K。 */
export function formatTokens(value: number): string {
  const abs = Math.max(0, Math.floor(Math.abs(value)));
  if (abs === 0) return "0";
  if (abs < 1_000) return String(abs);
  const units = [
    { scale: 1_000_000_000_000, suffix: "T" },
    { scale: 1_000_000_000, suffix: "B" },
    { scale: 1_000_000, suffix: "M" },
    { scale: 1_000, suffix: "K" },
  ];
  const unit = units.find((item) => abs >= item.scale) ?? units[units.length - 1]!;
  const scaled = abs / unit.scale;
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  let formatted = scaled.toFixed(decimals);
  if (formatted.includes(".")) formatted = formatted.replace(/0+$/, "").replace(/\.$/, "");
  return `${formatted}${unit.suffix}`;
}
