import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wb-accent-soft disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-wb-primary text-wb-primary-fg shadow-xs hover:bg-wb-primary-hover active:opacity-95",
        secondary:
          "border border-wb-border bg-wb-elev text-wb-fg hover:bg-wb-hover active:bg-wb-active",
        ghost:
          "text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
        outline:
          "border border-wb-border-strong bg-transparent text-wb-fg hover:bg-wb-hover",
        destructive:
          "bg-wb-danger text-white shadow-xs hover:opacity-90",
      },
      size: {
        default: "h-9 px-3.5 py-2",
        sm: "h-7 rounded-md px-2.5 text-xs",
        xs: "h-6 rounded-md px-1.5 text-xs",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

interface ButtonProps
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

export { Button };
