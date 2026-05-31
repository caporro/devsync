/* eslint-disable react-refresh/only-export-components */
import * as React from "react"

import { NavMain } from "@/components/nav-main"
import { NavProjects } from "@/components/nav-projects"
import { NavSecondary } from "@/components/nav-secondary"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiBrain04Icon,
  BookOpen02Icon,
  ChartGanttIcon,
  ChartRingIcon,
  CropIcon,
  GitBranchIcon,
  Mail01Icon,
  NewsIcon,
} from "@hugeicons/core-free-icons"
import type { DocsSummary, ProjectSummary } from "@/domain/devsync"

export const appUser = {
  name: "Team",
  email: "team@devsync.local",
  avatar: "/avatars/shadcn.jpg",
}

const data = {
  user: {
    name: appUser.name,
    email: appUser.email,
    avatar: appUser.avatar,
  },
}

export function AppSidebar({
  projects,
  docs,
  isLoading = false,
  isDocsLoading = false,
  isCreateDisabled = false,
  activeView = "activity",
  onCreateThread,
  onDocSelect,
  onOpenGit,
  onOpenInbox,
  onOpenMyItems,
  onOpenNews,
  onOpenPlanning,
  onOpenReadme,
  onOpenSystemLog,
  onOpenMcpTokens,
  onLogout,
  onThreadSelect,
  selectedDocId,
  selectedThreadId,
  user = data.user,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  projects: ProjectSummary[]
  docs: DocsSummary[]
  isLoading?: boolean
  isDocsLoading?: boolean
  isCreateDisabled?: boolean
  activeView?: "activity" | "artifacts" | "generated" | "plan" | "my-items" | "inbox" | "news" | "docs" | "git" | "readme" | string
  onCreateThread?: () => void
  onDocSelect?: (docId: string) => void
  onOpenGit?: () => void
  onOpenInbox?: () => void
  onOpenMyItems?: () => void
  onOpenNews?: () => void
  onOpenPlanning?: () => void
  onOpenReadme?: () => void
  onOpenSystemLog?: () => void
  onOpenMcpTokens?: () => void
  onLogout?: () => void
  onThreadSelect?: (threadId: string) => void
  selectedDocId?: string | null
  selectedThreadId?: string | null
  user?: {
    name: string
    email: string
    avatar: string
  }
}) {
  const sidebarProjects = projects.map((project) => ({
    id: project.id,
    name: project.name,
    icon: <HugeiconsIcon icon={CropIcon} strokeWidth={2} />,
  }))
  const navMain = [
    {
      title: "Planning",
      url: "#",
      icon: <HugeiconsIcon icon={ChartGanttIcon} strokeWidth={2} />,
      isActive: activeView === "planning",
      onSelect: onOpenPlanning,
    },
    {
      title: "News",
      url: "#",
      icon: <HugeiconsIcon icon={NewsIcon} strokeWidth={2} />,
      isActive: activeView === "news",
      onSelect: onOpenNews,
    },
    {
      title: "Inbox",
      url: "#",
      icon: <HugeiconsIcon icon={Mail01Icon} strokeWidth={2} />,
      isActive: activeView === "inbox",
      onSelect: onOpenInbox,
    },
    {
      title: "My items",
      url: "#",
      icon: <HugeiconsIcon icon={ChartRingIcon} strokeWidth={2} />,
      isActive: activeView === "my-items",
      onSelect: onOpenMyItems,
    },
    {
      title: "System Log",
      url: "#",
      icon: <HugeiconsIcon icon={ChartRingIcon} strokeWidth={2} />,
      isActive: activeView === "system-log",
      onSelect: onOpenSystemLog,
    },
    {
      title: "Git",
      url: "#",
      icon: <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} />,
      isActive: activeView === "git",
      onSelect: onOpenGit,
    },
    {
      title: "Team Docs",
      url: "#",
      icon: <HugeiconsIcon icon={BookOpen02Icon} strokeWidth={2} />,
      isActive: Boolean(selectedDocId),
      items: isDocsLoading
        ? [{ title: "Loading...", url: "#" }]
        : docs.length
          ? docs.map((doc) => ({
              title: doc.name,
              url: "#",
              isActive: doc.id === selectedDocId,
              onSelect: () => onDocSelect?.(doc.id),
            }))
          : [{ title: "No docs folders", url: "#" }],
    },
  ]

  return (
    <Sidebar variant="inset" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <a href="#">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-orange-500 text-white">
                  <HugeiconsIcon icon={AiBrain04Icon} strokeWidth={2} className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">Devsync</span>
                  <span className="truncate text-[10px]">Project memory for AI-heavy teams</span>
                </div>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain} />
        <NavProjects
          projects={sidebarProjects}
          isLoading={isLoading}
          isCreateDisabled={isCreateDisabled}
          isDeleteDisabled
          onCreateProject={onCreateThread}
          onProjectSelect={onThreadSelect}
          selectedProjectId={selectedThreadId}
        />
        <NavSecondary
          items={[
            {
              title: "Readme",
              url: "#",
              icon: <HugeiconsIcon icon={ChartRingIcon} strokeWidth={2} />,
              onSelect: onOpenReadme,
            },
          ]}
          className="mt-auto"
        />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} onOpenMcpTokens={onOpenMcpTokens} onLogout={onLogout} />
      </SidebarFooter>
    </Sidebar>
  )
}
