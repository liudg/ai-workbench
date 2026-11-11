import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--wb-send-bg)] text-[var(--wb-send-fg)] shadow-sm hover:opacity-90 active:opacity-95",
        secondary:
          "bg-[var(--wb-chip)] text-[var(--wb-text)] hover:bg-[var(--wb-chip-hover)] active:bg-[var(--wb-chip)]",
        ghost:
          "text-[var(--wb-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]",
        outline:
          "border border-[var(--wb-border-strong)] bg-transparent text-[var(--wb-text)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]",
        destructive:
          "bg-[var(--wb-danger-solid)] text-white shadow-sm hover:bg-[var(--wb-danger-solid-hover)] active:opacity-95",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-7 rounded-md px-2.5 text-xs",
        xs: "h-6 rounded px-1.5 text-xs",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
