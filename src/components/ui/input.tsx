import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        "flex h-9 w-full min-w-0 max-w-full rounded-lg border border-wb-border-strong bg-wb-input px-3 py-1 text-sm text-wb-fg transition-colors placeholder:text-wb-dim focus-visible:border-wb-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wb-accent-soft disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = "Input";

export { Input };
