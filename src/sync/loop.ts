import type { AppConfig } from '../config.js'
import { TodoistClient } from '../todoist/client.js'
import { createGCalClient } from '../gcal/client.js'
import { openDatabase } from '../db/db.js'
import { TaskMappingsRepo } from '../db/tasks.js'
import { CalendarMappingsRepo } from '../db/calendars.js'
import { CalendarManager } from './calendarManager.js'
import { Reconciler } from './reconcile.js'
import { log } from '../logger.js'

const ERROR_BACKOFF_MAX_MS = 5 * 60 * 1000

export type DaemonHandle = {
  stop: () => Promise<void>
}

export async function runDaemon(config: AppConfig): Promise<DaemonHandle> {
  if (!config.google.refreshToken) {
    throw new Error('runDaemon called without a refresh token; run the OAuth bootstrap first')
  }

  const db = openDatabase(config.daemon.databasePath)
  const tasksRepo = new TaskMappingsRepo(db)
  const calendarsRepo = new CalendarMappingsRepo(db)

  const todoist = new TodoistClient(config.todoist.apiToken)
  const gcal = createGCalClient({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    refreshToken: config.google.refreshToken,
    redirectUri: config.google.redirectUri,
  })

  const calendarManager = new CalendarManager({
    gcal,
    calendars: calendarsRepo,
    tasks: tasksRepo,
    reminderCalendarName: config.calendars.reminders,
    tasksCalendarName: config.calendars.tasks,
    managedPrefix: config.calendars.managedPrefix,
  })

  const reconciler = new Reconciler({
    gcal,
    tasks: tasksRepo,
    calendarManager,
    reminderLabel: config.todoist.reminderLabel,
    noCalendarLabel: config.todoist.noCalendarLabel,
  })

  log.info('Daemon starting', {
    pollIntervalMs: config.daemon.pollIntervalMs,
    databasePath: config.daemon.databasePath,
  })

  log.info('Ensuring special calendars (Reminders, Tasks)')
  await calendarManager.ensureSpecialCalendars()

  log.info('Running startup reconciliation pass')
  await reconciler.rebuildLostMappings()

  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let inFlight: Promise<void> | null = null
  let consecutiveErrors = 0

  const tick = async (): Promise<void> => {
    if (stopped) return
    const started = Date.now()
    try {
      log.debug('Tick start')
      const snapshot = await todoist.fetchSnapshot()
      await calendarManager.handleDeletedProjects(snapshot)
      const stats = await reconciler.reconcileSnapshot(snapshot)
      consecutiveErrors = 0
      log.info('Tick complete', {
        durationMs: Date.now() - started,
        tasks: snapshot.tasks.length,
        projects: snapshot.projects.length,
        ...stats,
      })
    } catch (e) {
      consecutiveErrors += 1
      log.error('Tick failed', { error: e, consecutiveErrors })
    } finally {
      scheduleNext()
    }
  }

  const scheduleNext = (): void => {
    if (stopped) return
    const base = config.daemon.pollIntervalMs
    const backoff = consecutiveErrors > 0
      ? Math.min(ERROR_BACKOFF_MAX_MS, base * Math.pow(2, Math.min(consecutiveErrors - 1, 6)))
      : 0
    const delay = base + backoff
    if (backoff > 0) log.warn('Backing off after errors', { delayMs: delay, consecutiveErrors })
    timer = setTimeout(() => {
      inFlight = tick()
    }, delay)
  }

  inFlight = tick()

  return {
    stop: async () => {
      stopped = true
      if (timer) clearTimeout(timer)
      if (inFlight) {
        try {
          await inFlight
        } catch {
          /* errors already logged inside tick */
        }
      }
      db.close()
      log.info('Daemon stopped')
    },
  }
}
