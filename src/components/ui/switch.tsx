import * as React from "react";

import { cn } from "@/lib/utils";

export function SwitchTrack({
  checked,
  size = "default",
  className,
}: {
  checked: boolean;
  size?: "default" | "sm";
  className?: string;
}) {
  const small = size === "sm";
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full border transition-colors",
        small ? "h-4 w-7" : "h-5 w-9",
        checked ? "border-transparent bg-wb-accent" : "border-wb-border-strong bg-wb-active",
        className,
      )}
    >
      <span
        className={cn(
          "pointer-events-none block rounded-full bg-white shadow-xs ring-1 ring-black/5 transition-transform",
          small ? "h-2.5 w-2.5" : "h-3.5 w-3.5",
          checked ? (small ? "translate-x-3.5" : "translate-x-4") : "translate-x-0.5",
        )}
      />
    </span>
  );
}

interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  size?: "default" | "sm";
  onCheckedChange?: (checked: boolean) => void;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, size = "default", onCheckedChange, onClick, className, disabled, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cn(
        "inline-flex shrink-0 cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wb-accent-soft disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && !disabled) {
          onCheckedChange?.(!checked);
        }
      }}
      {...props}
    >
      <SwitchTrack checked={checked} size={size} />
    </button>
  ),
);
Switch.displayName = "Switch";
