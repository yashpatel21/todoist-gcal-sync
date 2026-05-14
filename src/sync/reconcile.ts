import type { GCalClient } from '../gcal/client.js'
import {
  buildEventPayload,
  deleteEvent,
  findManagedEventByTodoistId,
  getTodoistIdFromEvent,
  insertEvent,
  listManagedEvents,
  updateEvent,
} from '../gcal/events.js'
import type { TaskMappingsRepo } from '../db/tasks.js'
import type { TodoistSnapshot, TodoistTask } from '../todoist/types.js'
import type { CalendarManager } from './calendarManager.js'
import { route, type RoutedCalendarTarget } from './routing.js'
import { computeContentHash } from './hash.js'
import { log } from '../logger.js'

export type ReconcileDeps = {
  gcal: GCalClient
  tasks: TaskMappingsRepo
  calendarManager: CalendarManager
  reminderLabel: string
  noCalendarLabel: string
}

export type ReconcileStats = {
  created: number
  updated: number
  rerouted: number
  skipped: number
  deleted: number
  noCalendar: number
  errors: number
}

export class Reconciler {
  constructor(private readonly deps: ReconcileDeps) {}

  /**
   * Startup reconciliation: walks every managed calendar, looks at every event
   * carrying our todoist_task_id extended property, and rebuilds any mapping
   * the local DB is missing. Recovers from "wrote event but DB write failed"
   * crash scenarios per architecture.mdc.
   */
  async rebuildLostMappings(): Promise<number> {
    const calendarIds = this.deps.calendarManager.listActiveCalendarIds()
    let rebuilt = 0
    for (const calendarId of calendarIds) {
      const events = await listManagedEvents(this.deps.gcal, calendarId)
      for (const ev of events) {
        const todoistId = getTodoistIdFromEvent(ev)
        if (!todoistId || !ev.id) continue
        const existing = this.deps.tasks.findById(todoistId)
        if (existing && existing.status === 'active' && existing.googleEventId === ev.id) {
          continue
        }
        this.deps.tasks.upsertActive({
          todoistTaskId: todoistId,
          googleEventId: ev.id,
          googleCalendarId: calendarId,
          todoistUpdatedAt: ev.updated ?? new Date(0).toISOString(),
          contentHash: 'recovered',
        })
        rebuilt += 1
      }
    }
    if (rebuilt > 0) log.info('Recovered lost task mappings', { count: rebuilt })
    return rebuilt
  }

  async reconcileSnapshot(snapshot: TodoistSnapshot): Promise<ReconcileStats> {
    const stats: ReconcileStats = {
      created: 0,
      updated: 0,
      rerouted: 0,
      skipped: 0,
      deleted: 0,
      noCalendar: 0,
      errors: 0,
    }

    const seenTaskIds = new Set<string>()

    for (const task of snapshot.tasks) {
      seenTaskIds.add(task.id)
      try {
        await this.reconcileTask(task, snapshot, stats)
      } catch (e) {
        stats.errors += 1
        log.error('Failed to reconcile task', { taskId: task.id, error: e })
      }
    }

    await this.handleDisappearedTasks(seenTaskIds, stats)

    return stats
  }

  private async reconcileTask(
    task: TodoistTask,
    snapshot: TodoistSnapshot,
    stats: ReconcileStats,
  ): Promise<void> {
    const target = route(task, {
      projectsById: snapshot.projectsById,
      inboxProjectId: snapshot.inboxProjectId,
      reminderLabel: this.deps.reminderLabel,
      noCalendarLabel: this.deps.noCalendarLabel,
    })

    if (target.kind === 'none') {
      await this.removeTaskFromGoogleCalendar(task.id, stats)
      return
    }

    const calendarTarget: RoutedCalendarTarget = target
    const targetCalendarId = await this.deps.calendarManager.resolveCalendarId(calendarTarget)
    const payload = buildEventPayload(task)
    const hash = computeContentHash(task, target)
    const existing = this.deps.tasks.findById(task.id)

    // CASE A: brand new task (no mapping or soft-deleted). Create event.
    // Before blindly creating, do the duplicate-prevention safety net check
    // for an existing event with our extended property across all calendars.
    if (!existing || existing.status === 'deleted') {
      const found = await findManagedEventByTodoistId(
        this.deps.gcal,
        this.deps.calendarManager.listActiveCalendarIds(),
        task.id,
      )
      if (found && found.event.id) {
        if (found.calendarId === targetCalendarId) {
          await updateEvent(this.deps.gcal, targetCalendarId, found.event.id, payload)
          this.deps.tasks.upsertActive({
            todoistTaskId: task.id,
            googleEventId: found.event.id,
            googleCalendarId: targetCalendarId,
            todoistUpdatedAt: task.updatedAt,
            contentHash: hash,
          })
          stats.updated += 1
          return
        }
        const newEventId = await insertEvent(this.deps.gcal, targetCalendarId, payload)
        await deleteEvent(this.deps.gcal, found.calendarId, found.event.id)
        this.deps.tasks.upsertActive({
          todoistTaskId: task.id,
          googleEventId: newEventId,
          googleCalendarId: targetCalendarId,
          todoistUpdatedAt: task.updatedAt,
          contentHash: hash,
        })
        stats.rerouted += 1
        return
      }

      const eventId = await insertEvent(this.deps.gcal, targetCalendarId, payload)
      this.deps.tasks.upsertActive({
        todoistTaskId: task.id,
        googleEventId: eventId,
        googleCalendarId: targetCalendarId,
        todoistUpdatedAt: task.updatedAt,
        contentHash: hash,
      })
      stats.created += 1
      return
    }

    // CASE B: mapping exists, hash unchanged AND target calendar unchanged. No-op.
    if (existing.contentHash === hash && existing.googleCalendarId === targetCalendarId) {
      stats.skipped += 1
      return
    }

    // CASE C: hash changed but on the same calendar. Update in place.
    if (existing.googleCalendarId === targetCalendarId) {
      await updateEvent(this.deps.gcal, targetCalendarId, existing.googleEventId, payload)
      this.deps.tasks.upsertActive({
        todoistTaskId: task.id,
        googleEventId: existing.googleEventId,
        googleCalendarId: targetCalendarId,
        todoistUpdatedAt: task.updatedAt,
        contentHash: hash,
      })
      stats.updated += 1
      return
    }

    // CASE D: re-route. Create on new calendar, delete from old.
    const newEventId = await insertEvent(this.deps.gcal, targetCalendarId, payload)
    this.deps.tasks.upsertActive({
      todoistTaskId: task.id,
      googleEventId: newEventId,
      googleCalendarId: targetCalendarId,
      todoistUpdatedAt: task.updatedAt,
      contentHash: hash,
    })
    await deleteEvent(this.deps.gcal, existing.googleCalendarId, existing.googleEventId)
    stats.rerouted += 1
  }

  /**
   * Strips a task from Google Calendar: active DB mapping, then any remaining
   * managed events (duplicates/orphans) found by extended property scan.
   */
  private async removeTaskFromGoogleCalendar(
    todoistTaskId: string,
    stats: ReconcileStats,
  ): Promise<void> {
    const existing = this.deps.tasks.findById(todoistTaskId)
    if (existing?.status === 'active') {
      await deleteEvent(this.deps.gcal, existing.googleCalendarId, existing.googleEventId)
      this.deps.tasks.softDelete(todoistTaskId)
      stats.noCalendar += 1
    }
    const calendarIds = this.deps.calendarManager.listActiveCalendarIds()
    for (let i = 0; i < 10; i++) {
      const found = await findManagedEventByTodoistId(this.deps.gcal, calendarIds, todoistTaskId)
      if (!found?.event?.id) break
      await deleteEvent(this.deps.gcal, found.calendarId, found.event.id)
      stats.noCalendar += 1
    }
  }

  /**
   * Any active mapping whose Todoist task is no longer in the current snapshot
   * (completed, deleted, or otherwise removed from active) gets its event
   * deleted and the mapping soft-deleted.
   */
  private async handleDisappearedTasks(
    seenTaskIds: Set<string>,
    stats: ReconcileStats,
  ): Promise<void> {
    const active = this.deps.tasks.listActive()
    for (const m of active) {
      if (seenTaskIds.has(m.todoistTaskId)) continue
      try {
        await deleteEvent(this.deps.gcal, m.googleCalendarId, m.googleEventId)
        this.deps.tasks.softDelete(m.todoistTaskId)
        stats.deleted += 1
      } catch (e) {
        stats.errors += 1
        log.error('Failed to delete disappeared task event', {
          taskId: m.todoistTaskId,
          error: e,
        })
      }
    }
  }
}
