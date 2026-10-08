# Running qm on Agent37

[Agent37](https://agent37.com) rents isolated Linux machines over a small REST API. qm can use
it two ways, independently:

- `SANDBOX_BACKEND=agent37` — every agent computer is an Agent37 instance with a persistent
  disk. See `adrs/agent37-sandbox-backend.md`.
- `DEPLOY_PROVIDER=agent37` — apps the agent publishes run on the same account.

Both need one API key, minted in the Agent37 dashboard under
[Cloud -> API keys](https://agent37.com/dashboard/cloud/api-keys). A complete deploy-side
environment:

```bash
DEPLOY_PROVIDER=agent37
AGENT37_API_KEY=sk_live_...
# AGENT37_DEPLOY_API_KEY=       # only when apps live in a different Agent37 workspace
# AGENT37_DEPLOY_API_BASE_URL=  # only when the API host is not https://api.agent37.com
# AGENT37_DEPLOY_TEMPLATE=      # default: qm-app-runner, created on first publish
# AGENT37_DEPLOY_RUNNER_IMAGE=  # default: node:24-bookworm-slim
# AGENT37_DEPLOY_CPUS=          # default 2; 2, 4, 8 or 16, paired with memory below
# AGENT37_DEPLOY_MEMORY_GB=     # default 4; 4, 8, 16 or 32
# AGENT37_DEPLOY_DISK_GB=       # default 4
# AGENT37_DEPLOY_APP_PORT=      # default 8080
# AGENT37_DEPLOY_ALWAYS_ON=1    # keep every app awake instead of sleeping when idle
```

Nothing else is set up by hand. The first publish creates the runner template, and each app
gets its own instance with a permanent HTTPS URL.

## What an app runs

Agent37 boots a template, not a command, so the per-app command cannot ride on the create
call the way it does on Fly. The provider splits it in two:

- The **template** carries a fixed entrypoint that waits for `/app/.qm-start.sh` and execs it.
  Set once, on the template, by the provider's first publish.
- The **app's own start script** is that file: it exports the version's env and execs the
  version's entrypoint. The provider writes it on every deploy.

The split is what makes a published app survive. Agent37 instances checkpoint when idle, and
a process started by reaching into a running box does not come back from a checkpoint. A
command the image itself runs does. The same property covers a restart, a resize and host
maintenance, none of which an exec-started app survives either.

`qm-app-runner` points at `node:24-bookworm-slim` by default. Point
`AGENT37_DEPLOY_RUNNER_IMAGE` at any public image your apps need, or create the template
yourself with whatever entrypoint you like and name it in `AGENT37_DEPLOY_TEMPLATE`. The only
contract is that the entrypoint eventually runs `/app/.qm-start.sh`.

## Sleeping apps

Agent37 wakes a sleeping instance on the routed request, so published apps scale to zero by
default: an idle app pays for its disk and nothing else, and the first visit after idle costs
roughly a second.

The provider tells qm it manages idleness itself (`managedScaleToZero`), so **qm's own idle
reaper never runs against these apps**. That matters: the reaper deletes an idle app outright
and rebuilds it on the next visit, which here would throw away the app's data directory and
pay a full create where a wake would do.

Turning on "always on" for a deployment turns sleeping off for that one app.
`AGENT37_DEPLOY_ALWAYS_ON=1` turns it off for all of them.

## Shapes and limits

Agent37 sells fixed shapes: 2 vCPU / 4 GB, 4 / 8, 8 / 16 and 16 / 32, each with its own disk
range. An unlisted pair is refused at create, so `AGENT37_DEPLOY_CPUS` and
`AGENT37_DEPLOY_MEMORY_GB` move together.

Every published app is one instance and counts against the workspace's instance limit, which
starts at one on an unfunded account and rises with the account tier. A deploy that trips it
fails with `instance_limit_reached`; add funds in the dashboard.

## Data

`/data` persists on the instance's own disk across sleeps, restarts and redeploys. It is the
`dataDir` qm hands the app. Deleting the deployment deletes the instance and its disk.

## URLs

Each app gets a permanent unauthenticated URL on one port of its instance, which is what qm
proxies to. The hostname carries a server-minted random slug, so it is not guessable; rotate
it by redeploying. Sign-in, the request-access flow and live editing all run in qm core, as
on every other provider.
