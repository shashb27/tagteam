# TagTeam — one-command deploy

TagTeam ships as a single Docker container (HTTP + WebSocket + SQLite +
in-process opencode). Company-wide deploy is `cp .env.example .env && docker
compose up -d`.

## 1. Prerequisites

- Docker 24+ (with the Compose v2 plugin: `docker compose` works)
- ~256 MB RAM, ~200 MB disk for the image
- A host port free on 3000 (or remap in `docker-compose.yml`)

Optional, only for real (non-mock) Claude runs:
- `opencode` CLI installed and authenticated on the host (`opencode auth`)
  — credentials are read by the in-process opencode server. For a pure demo
  with zero credentials, set `MOCK_CLAUDE=1` and skip this.

## 2. Configure

```bash
cp .env.example .env
$EDITOR .env
```

Minimum edits:
- **Local demo:** set `MOCK_CLAUDE=1` (or leave it unset if you've run
  `opencode auth` and want real Claude). Everything else has working defaults.
- **Public / behind a proxy:** set `BASE_URL=https://your.public.host` (used to
  build invite URLs and to mark the session cookie `Secure`). If you run on a
  hostname other than localhost, also add it to `ALLOWED_ORIGINS`.

No admin account or secret key is required — the first user registers via the
UI and gets a normal local account.

## 3. Launch

```bash
docker compose up -d
```

Open <http://localhost:3000>. Register a user, create a session, share the
invite link. The SQLite DB lives in `./data/tagteam.db`; logs in `./logs/`.

## 4. First user

There is no bootstrap admin. Register via the UI ("Register") with any email +
password. The first registered user is a normal user (no special role needed
for the POC).

## 5. Update

```bash
git pull
docker compose up -d --build
```

`--build` rebuilds the image when `package.json`, `server/`, or `web/` change.
State persists in `./data` and `./logs` across rebuilds.

## 6. Backup

```bash
# Stop, copy, restart — avoids writing to a live SQLite file.
docker compose stop
cp -r data/tagteam.db data/tagteam.db.bak.$(date +%F)
cp -r logs logs.bak.$(date +%F)
docker compose start
```

For automated backups, snapshot `./data/tagteam.db` on a cron schedule.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `port is already allocated` on `up` | Another process owns host port 3000. Change `ports: ["3001:3000"]` in `docker-compose.yml` (host side) or stop the other process. |
| 401 / "opencode not authenticated" errors in sessions | The in-process opencode server can't find credentials. Either run `opencode auth` on the host and restart the container, or set `MOCK_CLAUDE=1` for a zero-cred demo. |
| `better-sqlite3` native build fails during `docker build` | The image uses `node:20-bookworm` + `python3 make g++` so the prebuilt binary or a from-source build should succeed. If your network blocks the prebuild CDN, ensure outbound HTTPS to npm is allowed. |
| WS connections rejected from a browser on another host | Add that origin to `ALLOWED_ORIGINS` and ensure `BASE_URL` matches the public URL. |
| Cookie not sent over HTTPS reverse proxy | Set `BASE_URL=https://...`; the server marks the cookie `Secure` when `BASE_URL` starts with `https`. Terminate TLS at the proxy or pass it through. |
| Logs directory empty despite `./logs` mounted | The M2 logger writes to `<cwd>/logs` (= `/app/logs` in the container), not the `LOG_DIR` env var. `LOG_DIR` is reserved for a future code change. To capture logs today, either rely on `docker logs tagteam` (stdout) or add `- ./logs:/app/logs` to the compose volume list. |

## 8. One-liner (fresh box)

```bash
git clone <repo> tagteam && cd tagteam \
  && cp .env.example .env \
  && docker compose up -d \
  && open http://localhost:3000
```
