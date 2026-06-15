"use client";

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { cn } from "@/src/lib/utils";

/**
 * Lightweight hover tooltip. Self-contained — bundles its own `Provider` so a
 * single `<Tooltip>` works without a root-level provider. Wrap any element via
 * the `render` prop on the trigger; pass the hint text as `content`.
 *
 *   <Tooltip content="What this is">
 *     <span>hover me</span>
 *   </Tooltip>
 */
export function Tooltip({
  content,
  children,
  side = "top",
  sideOffset = 6,
  delay = 300,
}: {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
  delay?: number;
}) {
  if (!content) return children;
  return (
    <TooltipPrimitive.Provider delay={delay}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger render={children} />
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset}>
            <TooltipPrimitive.Popup
              className={cn(
                "z-50 max-w-xs rounded-md border border-border bg-popover px-2 py-1",
                "text-xs text-popover-foreground shadow-md",
                "origin-[var(--transform-origin)]",
              )}
            >
              {content}
            </TooltipPrimitive.Popup>
          </TooltipPrimitive.Positioner>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
