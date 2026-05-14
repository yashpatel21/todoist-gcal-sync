import type { GCalClient } from '../gcal/client.js'
import {
  createCalendar,
  deleteCalendar,
  formatManagedCalendarSummary,
  getCalendar,
  patchCalendarSummary,
} from '../gcal/calendars.js'
import {
  type CalendarMapping,
  type CalendarMappingsRepo,
  projectCalendarId,
  specialCalendarId,
} from '../db/calendars.js'
import type { TaskMappingsRepo } from '../db/tasks.js'
import type { TodoistSnapshot } from '../todoist/types.js'
import type { RoutedCalendarTarget } from './routing.js'
import { log } from '../logger.js'

export type CalendarManagerDeps = {
  gcal: GCalClient
  calendars: CalendarMappingsRepo
  tasks: TaskMappingsRepo
  reminderCalendarName: string
  tasksCalendarName: string
  managedPrefix: string
}

export class CalendarManager {
  constructor(private readonly deps: CalendarManagerDeps) {}

  private summary(displayName: string): string {
    return formatManagedCalendarSummary(this.deps.managedPrefix, displayName)
  }

  /**
   * Ensures the two special calendars exist. Called on startup before any
   * task reconciliation. Handles the case where the user manually deleted
   * one of our managed calendars (404 -> recreate).
   */
  async ensureSpecialCalendars(): Promise<void> {
    await this.ensureSpecial('reminders', this.deps.reminderCalendarName)
    await this.ensureSpecial('tasks', this.deps.tasksCalendarName)
  }

  private async ensureSpecial(kind: 'reminders' | 'tasks', displayName: string): Promise<void> {
    const id = specialCalendarId(kind)
    const desiredSummary = this.summary(displayName)
    const existing = this.deps.calendars.findById(id)
    if (existing && existing.status === 'active') {
      const live = await getCalendar(this.deps.gcal, existing.googleCalendarId)
      if (live) {
        if (live.summary !== desiredSummary) {
          await patchCalendarSummary(
            this.deps.gcal,
            existing.googleCalendarId,
            desiredSummary,
          )
        }
        if (existing.displayName !== displayName) {
          this.deps.calendars.updateDisplayName(id, displayName)
        }
        return
      }
      log.warn('Special calendar missing in GCal; recreating', { kind, calendarId: existing.googleCalendarId })
      this.deps.tasks.softDeleteByCalendar(existing.googleCalendarId)
    }

    log.info('Creating special calendar', { kind, displayName, summary: desiredSummary })
    const newId = await createCalendar(this.deps.gcal, { summary: desiredSummary })
    this.deps.calendars.upsertActive({
      id,
      kind,
      todoistProjectId: null,
      displayName,
      googleCalendarId: newId,
    })
  }

  /**
   * Resolves the route target to a Google Calendar id, creating the calendar
   * lazily for `project` targets that do not yet have one. The mapping is
   * persisted immediately after a successful create.
   */
  async resolveCalendarId(target: RoutedCalendarTarget): Promise<string> {
    if (target.kind === 'reminders' || target.kind === 'tasks') {
      const mapping = this.deps.calendars.findSpecial(target.kind)
      if (!mapping) {
        throw new Error(`Special calendar mapping missing for ${target.kind}; bootstrap not run?`)
      }
      const live = await getCalendar(this.deps.gcal, mapping.googleCalendarId)
      if (!live) {
        log.warn('Special calendar disappeared; recreating', { kind: target.kind })
        this.deps.tasks.softDeleteByCalendar(mapping.googleCalendarId)
        const displayName =
          target.kind === 'reminders' ? this.deps.reminderCalendarName : this.deps.tasksCalendarName
        const newId = await createCalendar(this.deps.gcal, {
          summary: this.summary(displayName),
        })
        this.deps.calendars.upsertActive({
          id: mapping.id,
          kind: target.kind,
          todoistProjectId: null,
          displayName,
          googleCalendarId: newId,
        })
        return newId
      }
      return mapping.googleCalendarId
    }

    const id = projectCalendarId(target.topLevelProjectId)
    const desiredSummary = this.summary(target.projectName)
    const existing = this.deps.calendars.findById(id)
    if (existing && existing.status === 'active') {
      const live = await getCalendar(this.deps.gcal, existing.googleCalendarId)
      if (live) {
        if (live.summary !== desiredSummary) {
          log.info('Renaming GCal calendar to match Todoist project', {
            calendarId: existing.googleCalendarId,
            from: live.summary ?? existing.displayName,
            to: desiredSummary,
          })
          await patchCalendarSummary(this.deps.gcal, existing.googleCalendarId, desiredSummary)
        }
        if (existing.displayName !== target.projectName) {
          this.deps.calendars.updateDisplayName(id, target.projectName)
        }
        return existing.googleCalendarId
      }
      log.warn('Project calendar missing in GCal; recreating', {
        projectId: target.topLevelProjectId,
        calendarId: existing.googleCalendarId,
      })
      this.deps.tasks.softDeleteByCalendar(existing.googleCalendarId)
    }

    log.info('Creating project calendar', {
      projectId: target.topLevelProjectId,
      name: target.projectName,
      summary: desiredSummary,
    })
    const newId = await createCalendar(this.deps.gcal, { summary: desiredSummary })
    this.deps.calendars.upsertActive({
      id,
      kind: 'project',
      todoistProjectId: target.topLevelProjectId,
      displayName: target.projectName,
      googleCalendarId: newId,
    })
    return newId
  }

  /**
   * Detects Todoist projects that have been deleted (present in the local
   * mapping table but absent from the current Todoist snapshot, and not the
   * inbox) and cascade-deletes their Google Calendars + associated task
   * mappings.
   *
   * Per the user's invariant: a project calendar is only deleted when the
   * Todoist project itself is deleted, NOT when the project is merely empty
   * or has no scheduled tasks.
   */
  async handleDeletedProjects(snapshot: TodoistSnapshot): Promise<void> {
    const existingProjectIds = new Set(snapshot.projects.map((p) => p.id))
    const projectMappings = this.deps.calendars.listActiveProjects()

    for (const m of projectMappings) {
      if (!m.todoistProjectId) continue
      if (existingProjectIds.has(m.todoistProjectId)) continue

      log.info('Detected deleted Todoist project; deleting GCal calendar', {
        projectId: m.todoistProjectId,
        displayName: m.displayName,
        calendarId: m.googleCalendarId,
      })
      try {
        await deleteCalendar(this.deps.gcal, m.googleCalendarId)
      } catch (e) {
        const code = (e as { code?: number }).code
        if (code !== 404 && code !== 410) {
          log.error('Failed to delete GCal calendar', { calendarId: m.googleCalendarId, error: e })
          throw e
        }
      }
      this.deps.tasks.softDeleteByCalendar(m.googleCalendarId)
      this.deps.calendars.softDelete(m.id)
    }
  }

  /**
   * Returns the google calendar ids for every active managed calendar.
   * Used by the startup reconciliation pass for cross-calendar event scans.
   */
  listActiveCalendarIds(): string[] {
    return this.deps.calendars.listActive().map((m: CalendarMapping) => m.googleCalendarId)
  }
}
