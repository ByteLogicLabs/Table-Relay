import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, toast, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon, XIcon } from "lucide-react"

// Distance from the viewport edge to the toast stack. We push it in a bit so
// the "Clear all" pill can sit at the edge above (top) / below (bottom) the
// stack without colliding with the first toast.
const TOAST_STACK_OFFSET = 44

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <>
      <Sonner
        theme={theme as ToasterProps["theme"]}
        className="toaster group"
        // Per-toast close button (an × in the corner of every toast).
        closeButton
        icons={{
          success: (
            <CircleCheckIcon className="size-4" />
          ),
          info: (
            <InfoIcon className="size-4" />
          ),
          warning: (
            <TriangleAlertIcon className="size-4" />
          ),
          error: (
            <OctagonXIcon className="size-4" />
          ),
          loading: (
            <Loader2Icon className="size-4 animate-spin" />
          ),
        }}
        style={
          {
            "--normal-bg": "var(--popover)",
            "--normal-text": "var(--popover-foreground)",
            "--normal-border": "var(--border)",
            "--border-radius": "var(--radius)",
          } as React.CSSProperties
        }
        toastOptions={{
          classNames: {
            toast: "cn-toast",
          },
        }}
        // Nudge the stack inward so the "Clear all" pill has room at the edge
        // without overlapping the first toast.
        offset={TOAST_STACK_OFFSET}
        {...props}
      />
      <ClearAllToasts position={props.position} />
    </>
  )
}

/**
 * A floating "Clear all" pill that appears whenever more than one toast is on
 * screen, so the user can dismiss the whole stack at once (sonner has no
 * built-in dismiss-all UI). We can't read sonner's toast count from a hook, so
 * we observe its container in the DOM and count `[data-sonner-toast]` nodes.
 */
function ClearAllToasts({ position }: { position?: ToasterProps["position"] }) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    const read = () =>
      document.querySelectorAll("[data-sonner-toast]").length

    // Poll on a MutationObserver against the body — sonner mounts/unmounts
    // toast nodes anywhere under it as they enter/leave.
    const observer = new MutationObserver(() => setCount(read()))
    observer.observe(document.body, { childList: true, subtree: true })
    setCount(read())
    return () => observer.disconnect()
  }, [])

  if (count < 2) return null

  // Anchor the pill to the same edge the toasts use. Default sonner position
  // is top-right; the app mounts it as top-right too.
  const pos = position ?? "top-right"
  const isTop = pos.startsWith("top")
  const isRight = pos.endsWith("right")
  const isCenter = pos.endsWith("center")

  return (
    <div
      className="fixed z-9999 pointer-events-none"
      style={{
        // Sits in the gap created by the toast stack's offset: at the top edge
        // for top positions, the bottom edge for bottom positions.
        top: isTop ? 10 : undefined,
        bottom: isTop ? undefined : 10,
        right: isRight ? 16 : undefined,
        left: isCenter ? "50%" : isRight ? undefined : 16,
        transform: isCenter ? "translateX(-50%)" : undefined,
      }}
    >
      <button
        type="button"
        onClick={() => toast.dismiss()}
        className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-border bg-popover/95 px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur hover:text-foreground hover:bg-popover transition-colors"
      >
        <XIcon className="size-3" />
        Clear all ({count})
      </button>
    </div>
  )
}

export { Toaster }
