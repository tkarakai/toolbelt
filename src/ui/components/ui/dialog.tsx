import * as React from "react"
import { cn } from "@/lib/utils"
import { Dialog as DialogPrimitive } from "radix-ui"

import { Button } from "@/components/ui/button"
import { InfoIcon, XIcon } from "lucide-react"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-200 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

/** Remembers what had focus when the dialog opened (its layout effect runs before Radix moves
 *  focus into the dialog). A menu item that opened it is about to disappear with its menu: the
 *  menu's button (through any submenus) stands in for it, and a table or list for a control of
 *  one of its rows. */
function RememberFocus({ into }: { into: React.RefObject<HTMLElement | null> }) {
  React.useLayoutEffect(() => {
    let active: Element | null = document.activeElement
    for (let menu = active?.closest("[role=menu]"); menu; menu = active?.closest("[role=menu]")) {
      const by = menu.getAttribute("aria-labelledby")
      active = by ? document.getElementById(by) : null
    }
    // A control outside the Tab order inside a table or list (a row's ⋯) hands back to the list.
    if (active instanceof HTMLElement && active.tabIndex < 0) active = active.closest("[data-navigation-collection]") ?? active
    into.current = active instanceof HTMLElement && active !== document.body ? active : null
  }, [into])
  return null
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  overlay = true,
  container,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  /** Dim and blur what's behind (default). */
  overlay?: boolean
  /** Where the dialog mounts (default: the document body). */
  container?: HTMLElement | null
}) {
  // Radix gives focus back to a `DialogTrigger`; dialogs opened by a key, a plugin or an action
  // have none, and focus would fall to the page. They return it to where it was instead.
  const opener = React.useRef<HTMLElement | null>(null)
  return (
    <DialogPortal container={container}>
      {overlay && <DialogOverlay />}
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-200 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event)
          if (event.defaultPrevented) return
          const target = opener.current
          if (target?.isConnected && target.getClientRects().length && !target.closest("[inert]")) {
            event.preventDefault()
            target.focus({ preventScroll: true })
          }
        }}
        {...props}
      >
        <RememberFocus into={opener} />
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-2 right-2"
              size="icon-sm"
            >
              <XIcon
              />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  children,
  icon = <InfoIcon className="size-5" />,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title> & { icon?: React.ReactNode }) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "flex min-w-0 items-center gap-3 pr-6 text-base leading-normal font-semibold text-primary",
        className
      )}
      {...props}
    >
      {icon && <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-muted/40 text-primary">{icon}</span>}
      <span className="min-w-0 break-words">{children}</span>
    </DialogPrimitive.Title>
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
