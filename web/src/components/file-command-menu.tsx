import type { CSSProperties } from "react"
import { HugeiconsIcon } from "@hugeicons/react"

import type { CommandMenuGroup, CommandMenuItem } from "@/components/file-command-menu-utils"
import { cn } from "@/lib/utils"

export function CommandMenuList({
  activeIndex,
  className,
  groups,
  onActiveIndexChange,
  onRun,
  style,
}: {
  activeIndex: number
  className?: string
  groups: CommandMenuGroup[]
  onActiveIndexChange: (index: number) => void
  onRun: (item: CommandMenuItem) => void
  style?: CSSProperties
}) {
  return (
    <div
      className={cn(
        "max-h-80 w-72 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
        className
      )}
      onMouseDown={(event) => event.preventDefault()}
      style={style}
    >
      {groups.length > 0 ? (
        groups.map((group) => (
          <div key={group.id}>
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              {group.label}
            </div>
            {group.items.map((item) => (
              <button
                className={cn(
                  "flex min-h-8 w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm outline-none transition-colors",
                  item.index === activeIndex && "bg-accent text-accent-foreground"
                )}
                key={item.id}
                onClick={() => onRun(item)}
                onMouseEnter={() => onActiveIndexChange(item.index)}
                type="button"
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                  <HugeiconsIcon className="size-4" icon={item.icon} strokeWidth={2} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate">{item.label}</span>
                  {item.subtitle ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.subtitle}
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        ))
      ) : (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">
          No commands
        </div>
      )}
    </div>
  )
}

export function CommandMenu({
  x,
  y,
  ...props
}: Omit<Parameters<typeof CommandMenuList>[0], "className" | "style"> & {
  x: number
  y: number
}) {
  return (
    <CommandMenuList
      {...props}
      className="absolute z-60"
      style={{ left: x, top: y }}
    />
  )
}
