import type { TodoistTask, TodoistProject } from '../todoist/types.js'
import { resolveTopLevelProjectId } from '../todoist/normalize.js'

export type RouteTarget =
  | { kind: 'none' }
  | { kind: 'reminders' }
  | { kind: 'tasks' }
  | { kind: 'project'; topLevelProjectId: string; projectName: string }

/** Route targets that map to an actual Google calendar (excludes `none`). */
export type RoutedCalendarTarget = Exclude<RouteTarget, { kind: 'none' }>

export type RoutingContext = {
  projectsById: Map<string, TodoistProject>
  inboxProjectId: string | null
  reminderLabel: string
  noCalendarLabel: string
}

/**
 * Routing order:
 * 1. `noCalendarLabel` present -> do not sync (remove any existing event).
 * 2. `reminderLabel` present -> Reminders calendar.
 * 3. Inbox or no resolvable project -> Tasks calendar.
 * 4. Else -> top-level project calendar.
 */
export function route(task: TodoistTask, ctx: RoutingContext): RouteTarget {
  if (task.labels.includes(ctx.noCalendarLabel)) {
    return { kind: 'none' }
  }
  if (task.labels.includes(ctx.reminderLabel)) {
    return { kind: 'reminders' }
  }

  const topId = resolveTopLevelProjectId(task.projectId, ctx.projectsById)
  if (!topId || topId === ctx.inboxProjectId) {
    return { kind: 'tasks' }
  }

  const topProject = ctx.projectsById.get(topId)
  return {
    kind: 'project',
    topLevelProjectId: topId,
    projectName: topProject?.name ?? 'Unknown',
  }
}
