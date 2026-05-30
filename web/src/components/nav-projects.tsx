"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/components/ui/sidebar"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AddCircleIcon,
  Delete02Icon,
  FolderIcon,
  MoreHorizontalCircle01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons"

type NavProject = {
  id: string
  name: string
  icon: React.ReactNode
}

function normalizeSearchValue(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
}

function fuzzyScore(value: string, query: string) {
  const text = normalizeSearchValue(value)
  const search = normalizeSearchValue(query)
  if (!search) return 0
  if (text === search) return 10000 - text.length
  if (text.startsWith(search)) return 9000 - text.length

  const directIndex = text.indexOf(search)
  if (directIndex !== -1) return 8000 - directIndex * 10 - text.length

  let score = 0
  let lastIndex = -1
  let streak = 0

  for (const char of search) {
    const nextIndex = text.indexOf(char, lastIndex + 1)
    if (nextIndex === -1) return null

    if (nextIndex === lastIndex + 1) {
      streak += 1
      score += 20 + streak * 5
    } else {
      streak = 0
      score += 5 - Math.min(nextIndex - lastIndex, 5)
    }

    lastIndex = nextIndex
  }

  return score - text.length
}

export function NavProjects({
  projects,
  isLoading = false,
  isCreateDisabled = false,
  isDeleteDisabled = false,
  label = "Projects",
  emptyLabel = "No projects yet",
  showActions = true,
  onCreateProject,
  onProjectDelete,
  onProjectSelect,
  selectedProjectId,
}: {
  projects: NavProject[]
  isLoading?: boolean
  isCreateDisabled?: boolean
  isDeleteDisabled?: boolean
  label?: string
  emptyLabel?: string
  showActions?: boolean
  onCreateProject?: () => void
  onProjectDelete?: (projectId: string) => void
  onProjectSelect?: (projectId: string) => void
  selectedProjectId?: string | null
}) {
  const { isMobile } = useSidebar()
  const [isSearchOpen, setIsSearchOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState("")
  const searchInputRef = React.useRef<HTMLInputElement | null>(null)
  const visibleProjects = React.useMemo(() => {
    const query = searchQuery.trim()
    if (!query) return projects

    return projects
      .map((project) => ({
        project,
        score: fuzzyScore(project.name, query),
      }))
      .filter((item): item is { project: NavProject; score: number } => item.score !== null)
      .sort((a, b) => b.score - a.score || a.project.name.localeCompare(b.project.name))
      .map((item) => item.project)
  }, [projects, searchQuery])

  function handleSearchOpenChange(open: boolean) {
    setIsSearchOpen(open)
    if (!open) setSearchQuery("")
  }

  function selectProject(projectId: string) {
    onProjectSelect?.(projectId)
    handleSearchOpenChange(false)
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault()
      handleSearchOpenChange(false)
      return
    }

    if (event.key === "Enter" && visibleProjects[0]) {
      event.preventDefault()
      selectProject(visibleProjects[0].id)
    }
  }

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      {showActions ? (
        <>
          <PopoverPrimitive.Root open={isSearchOpen} onOpenChange={handleSearchOpenChange}>
            <PopoverPrimitive.Trigger asChild>
              <SidebarGroupAction
                aria-label="Search projects"
                className="right-9"
                disabled={isLoading || projects.length === 0}
                title="Search projects"
              >
                <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
                <span className="sr-only">Search projects</span>
              </SidebarGroupAction>
            </PopoverPrimitive.Trigger>
            <PopoverPrimitive.Portal>
              <PopoverPrimitive.Content
                align={isMobile ? "end" : "start"}
                className="z-50 w-64 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden"
                onOpenAutoFocus={(event) => {
                  event.preventDefault()
                  searchInputRef.current?.focus()
                }}
                side={isMobile ? "bottom" : "right"}
                sideOffset={6}
              >
                <div className="p-1">
                  <Input
                    ref={searchInputRef}
                    aria-label="Search projects"
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder="Search projects..."
                    value={searchQuery}
                  />
                </div>
              </PopoverPrimitive.Content>
            </PopoverPrimitive.Portal>
          </PopoverPrimitive.Root>
          <SidebarGroupAction
            aria-label="New project"
            disabled={isCreateDisabled}
            onClick={onCreateProject}
            title="New project"
          >
            <HugeiconsIcon icon={AddCircleIcon} strokeWidth={2} />
            <span className="sr-only">New project</span>
          </SidebarGroupAction>
        </>
      ) : null}
      <SidebarMenu>
        {isLoading
          ? Array.from({ length: 3 }).map((_, index) => (
              <SidebarMenuItem key={`project-skeleton-${index}`}>
                <SidebarMenuSkeleton showIcon />
              </SidebarMenuItem>
            ))
          : null}

        {!isLoading && visibleProjects.length === 0 ? (
          <SidebarMenuItem>
            <SidebarMenuButton disabled>
              <span>{searchQuery.trim() ? "No projects found" : emptyLabel}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}

        {!isLoading && visibleProjects.map((item) => (
          <SidebarMenuItem key={item.id}>
            <SidebarMenuButton
              isActive={item.id === selectedProjectId}
              onClick={() => selectProject(item.id)}
            >
                {item.icon}
                <span>{item.name}</span>
            </SidebarMenuButton>
            {showActions ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuAction
                    showOnHover
                    className="aria-expanded:bg-muted"
                  >
                    <HugeiconsIcon icon={MoreHorizontalCircle01Icon} strokeWidth={2} />
                    <span className="sr-only">More</span>
                  </SidebarMenuAction>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="w-48"
                  side={isMobile ? "bottom" : "right"}
                  align={isMobile ? "end" : "start"}
                >
                  <DropdownMenuItem onClick={() => onProjectSelect?.(item.id)}>
                    <HugeiconsIcon icon={FolderIcon} strokeWidth={2} className="text-muted-foreground" />
                    <span>Open project</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={isDeleteDisabled}
                    onClick={() => onProjectDelete?.(item.id)}
                  >
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} className="text-muted-foreground" />
                    <span>Delete project</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
