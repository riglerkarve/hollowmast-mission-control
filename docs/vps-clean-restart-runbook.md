# VPS clean restart runbook — 25 Aug 2026

## Fixed context

- Provider: Hostinger KVM 2.
- Server IP: `2.57.90.95`.
- Docker Manager: enabled.
- SSH user: `root`.
- Password: owner types it interactively. Do not paste it into chat, files, shell history, or kanban comments.
- Repo: `https://github.com/riglerkarve/hollowmast-mission-control.git`.
- Mission Control deployment commit prepared locally: `ea3489d37cb9d233a3b762a436eb3d84bb9997c1`.

## Stop condition before copy-paste deploy

Run this from `C:\Users\jcwhi\Claude Outputs` before telling the VPS to check out the commit:

```bash
git -C mission-control ls-remote origin ea3489d37cb9d233a3b762a436eb3d84bb9997c1
```

Expected:

- It prints a matching remote ref.

If it prints nothing:

- Do not run the VPS deploy yet.
- The Docker deploy commit is local-only and the VPS cannot check it out from GitHub.
- Push or otherwise publish the deployment commit through the normal repo route first.

## Scope correction

This VPS is for the wider AI Agents / desktop-OS system, not just the Mission Control web dashboard.

That means Mission Control Docker is only the first service:

- Mission Control dashboard: Docker container, port `3000`, SQLite in Docker volume `mission-control-data`.
- Hermes Agent CLI/profiles/kanban workers: separate host-level or service plan required.
- Gateway delivery: separate service/secret plan required.
- Desktop/browser automation: separate decision required; a basic Hostinger Linux VPS is headless and is not automatically a desktop OS.
- Ollama/local-model custody: separate resource decision required; KVM 2 has 1 vCPU and 4 GB RAM, so it is not a substitute for the local RTX laptop model setup.

Do not call the whole VPS migration complete when only the Mission Control container answers.

## Files this runbook assumes exist

- `C:\Users\jcwhi\Claude Outputs\mission-control\Dockerfile`
- `C:\Users\jcwhi\Claude Outputs\mission-control\docker-compose.yml`
- `C:\Users\jcwhi\Claude Outputs\mission-control\.dockerignore`
- `C:\Users\jcwhi\Claude Outputs\mission-control\tools\vps-deploy.cjs`
- `C:\Users\jcwhi\Claude Outputs\mission-control\docs\pre-flight.txt`
- `C:\Users\jcwhi\Claude Outputs\reports\rollback-guidance.md`

## Owner copy-paste sequence: read-only remote check

From `C:\Users\jcwhi\Claude Outputs`:

```bash
node mission-control/tools/vps-deploy.cjs remote-check --host 2.57.90.95
```

This opens SSH and asks the owner for the root password in the terminal. It should print:

- host and kernel;
- disk and memory;
- Docker version or `missing`;
- Docker Compose command or `missing`;
- current `mission-control-data` volume state;
- current `mission-control` container state.

## Owner copy-paste sequence: print the exact deploy script

From `C:\Users\jcwhi\Claude Outputs`:

```bash
node mission-control/tools/vps-deploy.cjs plan --host 2.57.90.95 --repo https://github.com/riglerkarve/hollowmast-mission-control.git --ref ea3489d37cb9d233a3b762a436eb3d84bb9997c1 --domain 2.57.90.95
```

Read the output before executing. It must show:

- clone/update path: `/opt/mission-control`;
- checkout ref: `ea3489d37cb9d233a3b762a436eb3d84bb9997c1`;
- Docker image: `mission-control:<timestamp>`;
- container: `mission-control`;
- port mapping: `3000:3000`;
- persistent volume: `mission-control-data` mounted at `/app/data`;
- database path: `/app/data/dashboard.db`.

## Owner copy-paste sequence: deploy Mission Control container

Only run this after the remote commit visibility check passes:

```bash
node mission-control/tools/vps-deploy.cjs deploy --host 2.57.90.95 --repo https://github.com/riglerkarve/hollowmast-mission-control.git --ref ea3489d37cb9d233a3b762a436eb3d84bb9997c1 --domain 2.57.90.95 --execute
```

The helper will:

- install Docker/Git support if missing;
- clone or update `https://github.com/riglerkarve/hollowmast-mission-control.git` into `/opt/mission-control`;
- check out `ea3489d37cb9d233a3b762a436eb3d84bb9997c1`;
- find `mission-control/package.json` if the repo root is the full workspace;
- build the image directly on the VPS;
- create or reuse Docker volume `mission-control-data`;
- run `docker compose up -d --build` with `MC_DB_PATH=/app/data/dashboard.db`;
- verify `http://127.0.0.1:3000/api/status` from inside the VPS.

## Manual VPS commands, if not using the helper

SSH in:

```bash
ssh root@2.57.90.95
```

Then run on the VPS:

```bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APP=/opt/mission-control
REPO=https://github.com/riglerkarve/hollowmast-mission-control.git
REF=ea3489d37cb9d233a3b762a436eb3d84bb9997c1
IMAGE_TAG=deploy-$(date -u +%Y%m%d-%H%M%S)

apt-get update
apt-get install -y git ca-certificates curl
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

mkdir -p /opt
if [ ! -d "$APP/.git" ]; then
  git clone "$REPO" "$APP"
else
  git -C "$APP" fetch --all --prune
fi
git -C "$APP" checkout "$REF"
git -C "$APP" rev-parse --verify HEAD

if [ -f "$APP/mission-control/package.json" ]; then
  APP_ROOT="$APP/mission-control"
else
  APP_ROOT="$APP"
fi
cd "$APP_ROOT"

docker volume create mission-control-data >/dev/null
MC_IMAGE_TAG="$IMAGE_TAG" docker compose up -d --build
docker ps --filter name=mission-control --format 'container={{.Names}} image={{.Image}} status={{.Status}} ports={{.Ports}}'
docker inspect mission-control --format 'health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restart={{.HostConfig.RestartPolicy.Name}}'
docker volume inspect mission-control-data --format 'volume={{.Name}} mountpoint={{.Mountpoint}}'
curl -fsS http://127.0.0.1:3000/api/status
echo "IMAGE_TAG=$IMAGE_TAG"
```

## External verification

Only after port `3000` is intentionally exposed by Hostinger/firewall:

```bash
curl -fsS http://2.57.90.95:3000/api/status
```

If the firewall is not open, report `could not look externally yet`, not `failed` and not `working`.

## Rollback mechanism

Rollback is image-tag reversion. It must not delete `mission-control-data`.

List available image tags on the VPS:

```bash
ssh root@2.57.90.95 "docker images 'mission-control' --format '{{.Repository}}:{{.Tag}} {{.CreatedSince}}'"
```

Rollback to a previous known-good tag:

```bash
node mission-control/tools/vps-deploy.cjs rollback --host 2.57.90.95 --tag <previous-image-tag> --execute
```

Then verify:

```bash
ssh root@2.57.90.95 "docker ps --filter name=mission-control --format 'container={{.Names}} image={{.Image}} status={{.Status}} ports={{.Ports}}'"
ssh root@2.57.90.95 "docker volume inspect mission-control-data --format 'volume={{.Name}} mountpoint={{.Mountpoint}}'"
ssh root@2.57.90.95 "curl -fsS http://127.0.0.1:3000/api/status"
```

## Real blockers to record separately

- Root password prompt: owner-only interactive input.
- Hostinger account, payment, identity, billing, server deletion: owner-only.
- Missing remote commit: deployment commit must be published before the VPS can check it out.
- Full AI Agents / desktop-OS stack: not completed by the Mission Control Docker container.
