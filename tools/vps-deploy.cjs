#!/usr/bin/env node
// vps-deploy.cjs — Docker deployment helper for Mission Control on Hostinger VPS.
//
// Starts AFTER the owner/account/password wall. It does not create a Hostinger account,
// enter payment details, accept terms, or store credentials. Use it only after the owner has
// provisioned the VPS and SSH is available.
//
// Examples:
//   node tools/vps-deploy.cjs plan --host 2.57.90.95 --repo https://github.com/OWNER/REPO.git --domain mission.example.com
//   node tools/vps-deploy.cjs remote-check --host 2.57.90.95
//   node tools/vps-deploy.cjs deploy --host 2.57.90.95 --repo https://github.com/OWNER/REPO.git --domain mission.example.com --execute
//   node tools/vps-deploy.cjs rollback --host 2.57.90.95 --tag deploy-20260825-150000 --execute
//
// Scope shape:
//   - this helper deploys the Mission Control dashboard container only
//   - corrected VPS scope says the server is for the wider AI Agents / desktop-OS system;
//     Hermes profiles, kanban runtime, desktop/browser host needs, gateways, and Ollama are
//     separate services/plans and are not silently covered by this dashboard container
//   - recommended build path is on the VPS from the committed remote repo, not a local
//     Docker Desktop build/push from a shared dirty Windows checkout
//
// Safety shape:
//   - default is dry-run; pass --execute before any remote mutation happens
//   - deploy targets only /opt/mission-control and Docker objects named mission-control*
//   - SQLite lives in Docker volume mission-control-data mounted at /app/data
//   - rollback switches the container back to a previous image tag; it does not touch the volume
'use strict';

const { spawnSync } = require('node:child_process');

const USAGE = `usage:
  node tools/vps-deploy.cjs plan --host <ip-or-host> --repo <git-url> [--domain <name>] [--user root]
  node tools/vps-deploy.cjs remote-check --host <ip-or-host> [--user root]
  node tools/vps-deploy.cjs deploy --host <ip-or-host> --repo <git-url> [--domain <name>] [--user root] [--tag <image-tag>] [--execute]
  node tools/vps-deploy.cjs rollback --host <ip-or-host> --tag <previous-image-tag> [--user root] [--execute]

Commands:
  plan          Print exact remote Docker deployment commands, no network required.
  remote-check  Read-only SSH probe: host, disk, memory, Docker/Compose availability.
  deploy        Install Docker if missing, clone/update code, build image, run Compose.
  rollback      Recreate the container from an existing previous mission-control:<tag> image.

Notes:
  Hostinger provisioning/payment/terms/password handling are owner-only. This script starts after SSH works.
  The default is dry-run. Only --execute runs remote mutations.
  Build on the VPS from the committed remote repo; do not deploy from this shared dirty checkout.
  SQLite persistence is the Docker volume mission-control-data mounted at /app/data.
  Scope correction: this deploys the Mission Control dashboard container only. The wider
  AI Agents / desktop-OS stack (Hermes profiles, kanban workers, gateways, desktop host,
  Ollama/local-model custody) needs its own deployment plan before the VPS can be called complete.
`;

function parse(argv) {
  const opts = { user: 'root', execute: false, domain: '', tag: '' };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--execute') { opts.execute = true; continue; }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${a}`);
      opts[key] = value;
      i += 1;
      continue;
    }
    positional.push(a);
  }
  opts.command = positional[0];
  return opts;
}

function requireOpt(opts, key) {
  if (!opts[key]) throw new Error(`missing --${key}`);
}

function q(s) {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

function sshTarget(opts) {
  requireOpt(opts, 'host');
  return `${opts.user || 'root'}@${opts.host}`;
}

function composeCommand() {
  return `if docker compose version >/dev/null 2>&1; then echo "docker compose"; elif command -v docker-compose >/dev/null 2>&1; then echo "docker-compose"; else echo "missing"; fi`;
}

function dockerInstallScript() {
  return `if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg git
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  apt-get update
  apt-get install -y git ca-certificates curl
fi
systemctl enable --now docker
COMPOSE=$(${composeCommand()})
if [ "$COMPOSE" = missing ]; then
  apt-get install -y docker-compose-plugin
  COMPOSE=$(${composeCommand()})
fi
if [ "$COMPOSE" = missing ]; then
  echo "Docker Compose is missing after install attempt" >&2
  exit 1
fi`;
}

function deployScript(opts) {
  requireOpt(opts, 'repo');
  const domain = opts.domain || '<domain-not-set-yet>';
  const tag = opts.tag ? q(opts.tag) : 'deploy-$(date -u +%Y%m%d-%H%M%S)';
  return `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APP=/opt/mission-control
REPO=${q(opts.repo)}
DOMAIN=${q(domain)}
PORT=3000
IMAGE_TAG=${tag}

echo "== Docker availability =="
${dockerInstallScript()}

echo "== code =="
mkdir -p /opt
if [ ! -d "$APP/.git" ]; then
  git clone "$REPO" "$APP"
else
  git -C "$APP" fetch --all --prune
  git -C "$APP" pull --ff-only
fi

if [ -f "$APP/mission-control/package.json" ]; then
  APP_ROOT="$APP/mission-control"
elif [ -f "$APP/package.json" ]; then
  APP_ROOT="$APP"
else
  echo "Could not find package.json at $APP or $APP/mission-control" >&2
  exit 1
fi
cd "$APP_ROOT"
if [ ! -f Dockerfile ] || [ ! -f docker-compose.yml ]; then
  echo "Dockerfile or docker-compose.yml missing in $APP_ROOT" >&2
  exit 1
fi

COMPOSE=$(${composeCommand()})
docker volume create mission-control-data >/dev/null

echo "== persistent data volume =="
docker volume inspect mission-control-data --format 'volume={{.Name}} mountpoint={{.Mountpoint}}'
echo "SQLite path inside container: /app/data/dashboard.db"
echo "Restore encrypted backup into mission-control-data BEFORE cutover if this is not a fresh test deploy."

echo "== image build and container restart =="
MC_IMAGE_TAG="$IMAGE_TAG" $COMPOSE up -d --build

echo "== health =="
docker ps --filter name=mission-control --format 'container={{.Names}} image={{.Image}} status={{.Status}} ports={{.Ports}}'
docker inspect mission-control --format 'health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restart={{.HostConfig.RestartPolicy.Name}}'
for i in 1 2 3 4 5; do
  if curl -fsS "http://127.0.0.1:$PORT/api/status"; then break; fi
  sleep 3
  if [ "$i" = 5 ]; then
    echo "Mission Control did not answer /api/status on localhost:$PORT" >&2
    docker logs --tail=80 mission-control >&2 || true
    exit 1
  fi
done

echo "== deployment result =="
echo "Provider: Hostinger VPS with Docker Manager enabled"
echo "Domain: $DOMAIN"
echo "Image tag: mission-control:$IMAGE_TAG"
echo "Container: mission-control"
echo "Persistent volume: mission-control-data -> /app/data"
echo "Port mapping: host 3000 -> container 3000"
echo "Rollback: node tools/vps-deploy.cjs rollback --host ${opts.host} --tag $IMAGE_TAG --execute"
`;
}

function rollbackScript(opts) {
  requireOpt(opts, 'tag');
  return `set -euo pipefail
APP=/opt/mission-control
TAG=${q(opts.tag)}
PORT=3000
if [ -f "$APP/mission-control/docker-compose.yml" ]; then
  APP_ROOT="$APP/mission-control"
elif [ -f "$APP/docker-compose.yml" ]; then
  APP_ROOT="$APP"
else
  echo "Could not find docker-compose.yml at $APP or $APP/mission-control" >&2
  exit 1
fi
cd "$APP_ROOT"
COMPOSE=$(${composeCommand()})
if [ "$COMPOSE" = missing ]; then
  echo "Docker Compose is missing" >&2
  exit 1
fi
if ! docker image inspect "mission-control:$TAG" >/dev/null 2>&1; then
  echo "Previous image mission-control:$TAG is not present on this VPS" >&2
  docker images 'mission-control' --format 'available={{.Repository}}:{{.Tag}} created={{.CreatedSince}}'
  exit 1
fi
# Only the image changes. The mission-control-data volume is deliberately preserved.
MC_IMAGE_TAG="$TAG" $COMPOSE up -d --no-build --force-recreate
for i in 1 2 3 4 5; do
  if curl -fsS "http://127.0.0.1:$PORT/api/status"; then break; fi
  sleep 3
  if [ "$i" = 5 ]; then
    echo "Rolled-back container did not answer /api/status" >&2
    docker logs --tail=80 mission-control >&2 || true
    exit 1
  fi
done
docker ps --filter name=mission-control --format 'container={{.Names}} image={{.Image}} status={{.Status}} ports={{.Ports}}'
echo "Rolled back to mission-control:$TAG; mission-control-data volume preserved."
`;
}

function remoteCheckScript() {
  return `set -euo pipefail
echo "host: $(hostname)"
echo "kernel: $(uname -a)"
echo "disk:"; df -h / | tail -n +1
echo "memory:"; free -h || true
echo "docker: $(docker --version 2>/dev/null || echo missing)"
echo "compose: $(${composeCommand()})"
echo "mission-control volume: $(docker volume inspect mission-control-data --format '{{.Name}} {{.Mountpoint}}' 2>/dev/null || echo absent)"
echo "mission-control container: $(docker ps -a --filter name=mission-control --format '{{.Names}} {{.Image}} {{.Status}}' 2>/dev/null || echo absent)"
`;
}

function runSsh(opts, script, mutate) {
  const target = sshTarget(opts);
  if (mutate && !opts.execute) {
    console.log('DRY RUN — pass --execute to run these commands on ' + target + '\n');
    console.log(script);
    return 0;
  }
  const child = spawnSync('ssh', [target, 'bash -s'], { input: script, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
  return child.status == null ? 1 : child.status;
}

function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help || !opts.command) { console.log(USAGE); return 0; }
  if (!['plan', 'remote-check', 'deploy', 'rollback'].includes(opts.command)) throw new Error(`unknown command: ${opts.command}`);
  requireOpt(opts, 'host');
  if (opts.command === 'plan') {
    requireOpt(opts, 'repo');
    console.log('Target: ' + sshTarget(opts));
    console.log('Provider: Hostinger VPS with Docker Manager enabled (owner-provisioned before this script runs)');
    console.log('Build path: directly on the VPS from the committed remote repo, not local Docker Desktop');
    console.log('Scope: Mission Control dashboard container only; wider AI Agents / desktop-OS stack is not covered by this script');
    console.log('Remote Docker deployment commands:\n');
    console.log(deployScript(opts));
    return 0;
  }
  if (opts.command === 'remote-check') return runSsh(opts, remoteCheckScript(), false);
  if (opts.command === 'deploy') return runSsh(opts, deployScript(opts), true);
  if (opts.command === 'rollback') return runSsh(opts, rollbackScript(opts), true);
  return 2;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error('FAILED: ' + e.message + '\n');
  console.error(USAGE.trimEnd());
  process.exitCode = 2;
}
