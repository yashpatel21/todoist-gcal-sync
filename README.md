# todoist-gcal-sync

Headless **Todoist → Google Calendar** sync service. Todoist is the only source of truth; Google Calendar is a read-only mirror for viewing tasks in Apple Calendar or any Google Calendar client.

## What it does

- Polls Todoist every 60 seconds and syncs tasks with a due date (timed or all-day). Tasks without a due date are ignored.
- Creates and maintains Google Calendars prefixed with `Todoist:` so they stand out:
  - Tasks with the **no-calendar** label (name configurable, default `no-calendar`) are never synced. Any existing Google Calendar event for that task is removed.
  - Else tasks with the **reminder** label (name configurable, default `reminder`) → **Reminders**
  - Else tasks in the Inbox or with no project → **Tasks**
  - Else → calendar named after the **top-level** Todoist project (subprojects roll up)
- **Lazy project calendars**: created the first time a scheduled task routes there to prevent calendar clutter.
- **Project deletion**: deleting/archiving a Todoist project removes its Google calendar. Emptying a project does not.
- Each Google event links back to Todoist (`https://app.todoist.com/app/task/<id>`).
- Crash-safe mapping in SQLite

## Getting started

### 1. Todoist API token

[Todoist](https://todoist.com/) → **Settings → Integrations → Developer** → copy the API token.

### 2. Google Cloud

1. [Google Cloud Console](https://console.cloud.google.com/) → new project → enable **Google Calendar API**.
2. **OAuth consent screen** → **External** → add your Gmail under **Test users**.
3. **Credentials → OAuth client ID** → **Web application**.
4. Under **Authorized redirect URIs**, add exactly: `http://localhost:8765/oauth/callback` (Google does not allow private IPs like `192.168.x.x` here.)
5. Copy **Client ID** and **Client Secret**.

That redirect URI must match `GOOGLE_OAUTH_REDIRECT_URI` in [`docker-compose.yml`](docker-compose.yml) (default is already `http://localhost:8765/oauth/callback`).

### 3. Run with Docker

**Same machine as Docker (local):** use [`docker-compose.yml`](docker-compose.yml) as-is. Set `TODOIST_API_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; leave `GOOGLE_REFRESH_TOKEN` empty. Start the stack (`docker compose up -d` or Portainer). Open the container logs, follow the printed Google URL, approve access, copy the printed refresh token into env, redeploy. Then you can comment out the `ports:` block (8765 is only for that first OAuth step).

**Homelab or remote server:** clone this repo on a machine where you can run Node and use a browser. `npm install`, copy [`.env.example`](.env.example) to `.env`, set the three Google/Todoist secrets, leave `GOOGLE_REFRESH_TOKEN` empty, run `npm run oauth`, complete OAuth in the browser, copy the printed refresh token. On the server, deploy the same compose file with all four secrets set (including `GOOGLE_REFRESH_TOKEN`). Comment out the `ports:` block in the compose file. No OAuth step runs on the server.

Without Portainer: fill `.env` from `.env.example` and run `docker compose up -d`.

## Running locally (no Docker)

```bash
npm install
cp .env.example .env
# TODOIST_API_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET; empty GOOGLE_REFRESH_TOKEN first run
npm run oauth   # OAuth only, then exits
```

Put `GOOGLE_REFRESH_TOKEN` in `.env`, then `npm start` for the sync loop.

## Configuration

Secrets (set in Portainer / `.env` for compose):

| Variable               | Description                                             |
| ---------------------- | ------------------------------------------------------- |
| `TODOIST_API_TOKEN`    | Todoist personal API token.                             |
| `GOOGLE_CLIENT_ID`     | OAuth client ID.                                        |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret.                                    |
| `GOOGLE_REFRESH_TOKEN` | Long-lived refresh token (after OAuth).               |

Non-secrets are in [`docker-compose.yml`](docker-compose.yml):

| Variable                     | Default                                | Description                                    |
| ---------------------------- | -------------------------------------- | ---------------------------------------------- |
| `GOOGLE_OAUTH_REDIRECT_URI`  | `http://localhost:8765/oauth/callback` | Must match Google Cloud exactly.               |
| `POLL_INTERVAL_SECONDS`      | `60`                                   | Todoist polling interval.                      |
| `DATABASE_PATH`              | `/app/data/sync.db`                    | SQLite file.                                   |
| `MANAGED_CALENDAR_PREFIX`    | `Todoist:`                             | Prefix for managed calendars; empty disables.  |
| `SPECIAL_CALENDAR_REMINDERS` | `Reminders`                            | Reminder calendar name (before prefix).        |
| `SPECIAL_CALENDAR_TASKS`     | `Tasks`                                | Inbox/catch-all calendar name (before prefix). |
| `TODOIST_REMINDER_LABEL`     | `reminder`                             | Todoist label that routes to Reminders (exact match). |
| `TODOIST_NO_CALENDAR_LABEL`  | `no-calendar`                          | Todoist label that excludes the task from all calendars (exact match; wins over reminder). |
| `LOG_LEVEL`                  | `info`                                 | `debug` / `info` / `warn` / `error`.           |

## Data persistence

The Compose file bind-mounts `/data/todoist-gcal-sync/` on the host to `/app/data` in the container. Change the host path in compose if you want a different location. On the Docker host, create the directory and make it writable by uid 1000 (`node` in the image):

```bash
sudo mkdir -p /data/todoist-gcal-sync
sudo chown -R 1000:1000 /data/todoist-gcal-sync
```
