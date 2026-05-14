import { createHash } from 'node:crypto'
import type { TodoistTask } from '../todoist/types.js'
import type { RouteTarget } from './routing.js'

/**
 * Deterministic content hash for change detection. Per architecture.mdc, includes:
 * title, due datetime/date, timezone, labels, project id, plus duration and the
 * resolved target calendar (so re-routing triggers a hash change too).
 */
export function computeContentHash(task: TodoistTask, target: RouteTarget): string {
  const labels = [...task.labels].sort()
  const due =
    task.due.kind === 'date'
      ? { kind: 'date', value: task.due.date, tz: task.due.timezone }
      : { kind: 'datetime', value: task.due.datetime, tz: task.due.timezone }

  const canonical = JSON.stringify({
    v: 3,
    title: task.content,
    description: task.description,
    due,
    labels,
    projectId: task.projectId,
    duration: task.duration,
    target: targetKey(target),
  })

  return createHash('sha256').update(canonical).digest('hex')
}

function targetKey(t: RouteTarget): string {
  switch (t.kind) {
    case 'none':
      return 'none'
    case 'reminders':
      return 'reminders'
    case 'tasks':
      return 'tasks'
    case 'project':
      return `project:${t.topLevelProjectId}`
  }
}
