# Running the server

The web app can run two ways. On its own it reads the case artifacts the pipeline wrote into
`public/data`, and keeps everyone's changes in the browser. With the server running it signs people
in against real accounts, keeps the workflow state, drafts, detections and audit trail in
PostgreSQL, and signs the documents it exports.

Nothing on screen changes between the two modes — the server hands the pages the same JSON.

## What runs

| Piece | What it does |
| --- | --- |
| `oceanspill-api serve` | The HTTP API: sign-in, case data, actions, accounts, documents, notifications |
| `oceanspill-api worker` | Background jobs: watch areas for new SAR scenes, process them, refresh AIS and forecasts |
| PostgreSQL + PostGIS | Accounts, workflow state, detections, AIS positions, audit trail, signed documents |
| nginx | Serves the built site and puts the API on the same origin |

## On this machine

```bash
cd pipeline && uv sync --extra api --extra sar
```

Create the database once (it is separate from any other database on the machine):

```bash
createdb oceanspill
```

Put the connection string in `pipeline/.env` next to the provider credentials:

```
DATABASE_URL=postgresql+psycopg:///oceanspill
```

Create the schema, load the built-in planning areas, and add the first account:

```bash
cd pipeline && uv run oceanspill-api migrate && uv run oceanspill-api seed
```

```bash
cd pipeline && uv run oceanspill-api create-user --name "Your Name" --email you@example.gov.in --role "NTRO Admin" --agency NTRO --clearance Secret
```

The password is asked for, never passed on the command line and never written to a log. It needs at
least 12 characters and three of: lower case, upper case, digits, symbols.

Then run the API and, in another terminal, the worker:

```bash
cd pipeline && uv run oceanspill-api serve --reload
```

```bash
cd pipeline && uv run oceanspill-api worker
```

Point the web app at it by adding to `.env.local` in the repository root:

```
VITE_API_URL=http://127.0.0.1:8000
```

## Secrets

`JWT_SECRET` signs session tokens; changing it signs everyone out. `SIGNING_SECRET` signs exported
evidence documents; changing it means documents issued earlier no longer verify, so it is the one to
keep safest. If neither is set, the server generates them once into `pipeline/.secrets/` (not in
version control) so a local run needs no setup.

## Deployment

`deploy/docker-compose.yml` runs the database, API, worker, site and a nightly backup:

```bash
cp deploy/.env.example deploy/.env
```

Fill in the passwords and secrets, then:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

The site is on `WEB_PORT` (8080 by default). Put TLS in front of it — either a certificate mounted
into the nginx container or a load balancer that terminates HTTPS — and uncomment the
`Strict-Transport-Security` header in `deploy/nginx.conf`. The database is not published outside the
compose network.

Backups are a nightly `pg_dump` into the `backups` volume, kept for `BACKUP_KEEP_DAYS` days. Restore
with the `pg_restore` line printed in the backup log. Test a restore before it matters.

Monitoring: `GET /api/health` reports the database and the case artifacts, and is wired to the
container health check. The worker writes a row in `jobs` for everything it runs, with the error
when something fails, and raises a notification that reaches signed-in users.

## How access is decided

`shared/access.json` holds the role matrix and `shared/workflow.json` the verification sequence.
Both the web app and the API read those files, so the rules cannot drift apart: the API refuses what
the screens grey out. A viewer with Restricted clearance also gets vessel identifiers withheld —
MMSI and IMO numbers are replaced by a stable pseudonym, so the case still hangs together, and SAR
imagery is not served at all.

The audit trail is append-only in the database itself: a trigger rejects `UPDATE` and `DELETE` on
`audit_log`, so a record cannot be quietly rewritten later.

## Evidence documents

`POST /api/cases/{id}/chain-of-custody` builds the case record from the server's own artifacts and
audit trail, renders it as a PDF, hashes what the document says, signs that hash with the server key
and keeps a copy. `POST /api/documents/verify` takes a PDF back and says whether it is one the server
issued and whether it has been altered since.
