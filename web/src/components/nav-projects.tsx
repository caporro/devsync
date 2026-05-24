"use client"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
} from "@hugeicons/core-free-icons"

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
  projects: {
    id: string
    name: string
    icon: React.ReactNode
  }[]
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

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      {showActions ? (
        <SidebarGroupAction
          aria-label="New project"
          disabled={isCreateDisabled}
          onClick={onCreateProject}
          title="New project"
        >
          <HugeiconsIcon icon={AddCircleIcon} strokeWidth={2} />
          <span className="sr-only">New project</span>
        </SidebarGroupAction>
      ) : null}
      <SidebarMenu>
        {isLoading
          ? Array.from({ length: 3 }).map((_, index) => (
              <SidebarMenuItem key={`project-skeleton-${index}`}>
                <SidebarMenuSkeleton showIcon />
              </SidebarMenuItem>
            ))
          : null}

        {!isLoading && projects.length === 0 ? (
          <SidebarMenuItem>
            <SidebarMenuButton disabled>
              <span>{emptyLabel}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}

        {!isLoading && projects.map((item) => (
          <SidebarMenuItem key={item.id}>
            <SidebarMenuButton
              isActive={item.id === selectedProjectId}
              onClick={() => onProjectSelect?.(item.id)}
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
