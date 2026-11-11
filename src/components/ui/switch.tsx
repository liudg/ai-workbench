import * as React from "react";

import { cn } from "@/lib/utils";

export interface SwitchIndicatorProps {
  checked: boolean;
  size?: "sm" | "md";
  className?: string;
}

/** 纯视觉开关滑轨（供外层整行已经是 `<button role="switch">` 的菜单项复用，避免按钮嵌套）。 */
export function SwitchIndicator({
  checked,
  size = "md",
  className,
}: SwitchIndicatorProps) {
  const sm = size === "sm";
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-colors",
        sm ? "h-4 w-7" : "h-5 w-9",
        checked ? "bg-[var(--wb-accent)]" : "bg-[var(--wb-border-strong)]",
        className,
      )}
    >
      <span
        className={cn(
          "pointer-events-none block rounded-full bg-white shadow-sm transition-transform",
          sm ? "h-3 w-3" : "h-3.5 w-3.5",
          checked
            ? sm
              ? "translate-x-3.5"
              : "translate-x-4"
            : "translate-x-0.5",
        )}
      />
    </span>
  );
}

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  size?: "sm" | "md";
}

/** 独立可聚焦开关控件。双主题统一使用 `--wb-accent` 启用态与纯白高对比滑块。 */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, size = "md", className, onClick, disabled, ...props }, ref) => {
    const sm = size === "sm";
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented && !disabled) {
            onCheckedChange?.(!checked);
          }
        }}
        className={cn(
          "relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35 disabled:cursor-not-allowed disabled:opacity-50",
          sm ? "h-4 w-7" : "h-5 w-9",
          checked ? "bg-[var(--wb-accent)]" : "bg-[var(--wb-border-strong)]",
          className,
        )}
        {...props}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none block rounded-full bg-white shadow-sm transition-transform",
            sm ? "h-3 w-3" : "h-3.5 w-3.5",
            checked
              ? sm
                ? "translate-x-3.5"
                : "translate-x-4"
              : "translate-x-0.5",
          )}
        />
      </button>
    );
  },
);
Switch.displayName = "Switch";
