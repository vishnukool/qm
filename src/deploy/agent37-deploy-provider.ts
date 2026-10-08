import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { LRUCache } from "lru-cache";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider, DeployReconcileInput } from "./deploy-provider.ts";
import { waitAppReady } from "./shared-deploy-provider.ts";
import { normalizeRelPath, posixJoin, readTree } from "./deploy-fs.ts";
import { makeTar } from "../sandbox/tar.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createKeyedQueue, fetchWithRetry, sleep } from "../util/async.ts";
import { shq } from "../util/shell.ts";
import { errMessage, swallow, withRequestId } from "../util/errors.ts";

const APP_DIR = "/app";
const HOME_DIR = "/root";
const DATA_DIR = "/data";
const START_PATH = "/app/.qm-start.sh";
const PID_PATH = "/tmp/qm-app.pid";
const LOG_PATH = "/tmp/qm-app.log";
const APP_PORT_DEFAULT = 8080;
const ENDPOINT_PORT = 443;
const APP_READY_WINDOW_SEC_DEFAULT = 60;
const APP_START_EXEC_TIMEOUT_SEC = 60;
const EXTRACT_TIMEOUT_SEC = 300;
const RESOLVE_CACHE_MS_DEFAULT = 15_000;
const RESOLVE_CACHE_MAX = 500;
const WRITE_CHUNK_B64 = 64 * 1024;
const CREATE_TIMEOUT_MS = 330_000;
const READY_TIMEOUT_MS = 300_000;
const READY_POLL_MS = 2_000;
const EXEC_TIMEOUT_MS = 300_000;
const DEFAULT_BASE_URL = "https://api.agent37.com";
const DEFAULT_RUNNER_IMAGE = "docker.io/library/node:24-bookworm-slim";
const DEFAULT_RUNNER_TEMPLATE = "qm-app-runner";
const DEFAULT_CPUS = 2;
const DEFAULT_MEMORY_GB = 4;
const DEFAULT_DISK_GB = 4;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GONE_STATES = new Set(["deleting", "deleted"]);
const DEAD_STATES = new Set(["failed", ...GONE_STATES]);
const STARTABLE_STATES = new Set(["stopped", "sleeping"]);

interface Agent37Instance {
  id: string;
  name?: string | null;
  status: string;
  url?: string | null;
  public_ports?: Array<{ port: number; url: string }> | null;
}

interface Agent37ExecResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface StoredAgent37DeployBody {
  deploymentId: string;
  instanceId: string;
  name: string;
  host: string;
  createdAtMs: number;
}

export interface Agent37DeployProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Workspace template the app instances boot. Created on first use when absent. */
  template?: string;
  /** Image that template points at. Only used when this provider has to create the template. */
  runnerImage?: string;
  namePrefix?: string;
  cpus?: number;
  memoryGb?: number;
  diskGb?: number;
  /** Apps sleep when idle unless the owner turns always-on on, matching qm's own default. */
  autoSleep?: boolean;
  appPort?: number;
  readyWindowSec?: number;
  resolveCacheMs?: number;
  fetchImpl?: typeof fetch;
  store?: DurableMap<StoredAgent37DeployBody>;
  advisoryLock?: AdvisoryLock;
}

export function createAgent37DeployProvider(opts: Agent37DeployProviderOptions): DeployProvider {
  if (!opts.apiKey && !opts.fetchImpl) throw new Error("DEPLOY_PROVIDER=agent37 requires AGENT37_DEPLOY_API_KEY");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const template = opts.template ?? DEFAULT_RUNNER_TEMPLATE;
  const runnerImage = opts.runnerImage ?? DEFAULT_RUNNER_IMAGE;
  const prefix = opts.namePrefix ?? "qm";
  const appPort = opts.appPort ?? APP_PORT_DEFAULT;
  const autoSleep = opts.autoSleep ?? true;
  const readyWindowSec = opts.readyWindowSec ?? APP_READY_WINDOW_SEC_DEFAULT;
  const resolveCacheMs = opts.resolveCacheMs ?? RESOLVE_CACHE_MS_DEFAULT;
  const resources = {
    cpu: opts.cpus ?? DEFAULT_CPUS,
    memory: opts.memoryGb ?? DEFAULT_MEMORY_GB,
    disk: opts.diskGb ?? DEFAULT_DISK_GB,
  };
  const store = opts.store ?? createMemoryMap<StoredAgent37DeployBody>();
  const advisoryLock = opts.advisoryLock ?? createNoopAdvisoryLock();
  const queue = createKeyedQueue<string>();
  const resolveCache = new LRUCache<string, DeployEndpoint>({
    max: RESOLVE_CACHE_MAX,
    ttl: Math.max(1, resolveCacheMs),
  });
  let templateReady = false;

  function send(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 60_000,
    signal?: AbortSignal,
  ): Promise<Response> {
    return fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.apiKey ?? ""}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
  }

  function api(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<Response> {
    const operation = (signal?: AbortSignal) => send(method, path, body, timeoutMs, signal);
    return method === "GET" || method === "DELETE"
      ? fetchWithRetry(operation, "idempotent", { timeoutMs })
      : operation();
  }

  async function fail(action: string, res: Response): Promise<Error> {
    const body = await res.text().catch(() => "");
    return new Error(
      `agent37 deploy ${action}: ${withRequestId(`http ${res.status} ${body.slice(0, 200)}`, res.headers)}`,
    );
  }

  async function apiJson<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    const res = await api(method, path, body, timeoutMs);
    if (!res.ok) throw await fail(`${method} ${path}`, res);
    return (await res.json()) as T;
  }

  const baseName = (d: Deployment): string => `${prefix}-app-${d.id.slice(0, 12).toLowerCase()}`;

  // The runner template is this provider's one piece of setup, so it does it itself: an
  // operator should need nothing but an API key. The entrypoint is fixed and the per-app
  // command lives in a file the app instance owns, which is what makes an app survive a
  // sleep, a restart, or host maintenance — a command we only exec in would not.
  async function ensureTemplate(): Promise<void> {
    if (templateReady) return;
    const existing = await api("GET", `/v1/templates/${encodeURIComponent(template)}`);
    if (existing.ok) {
      templateReady = true;
      return;
    }
    if (existing.status !== 404) throw await fail(`get template ${template}`, existing);
    const created = await send(
      "POST",
      "/v1/templates",
      {
        name: template,
        image_ref: runnerImage,
        description: "qm published apps",
        default_port: appPort,
        entrypoint: ["/bin/sh", "-c", `while [ ! -x ${START_PATH} ]; do sleep 1; done; exec ${START_PATH}`],
      },
      CREATE_TIMEOUT_MS,
    );
    // A concurrent deploy may have created it between the GET and here.
    if (!created.ok && created.status !== 409) throw await fail(`create template ${template}`, created);
    templateReady = true;
  }

  async function ensureRunning(id: string): Promise<Agent37Instance> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const info = await apiJson<Agent37Instance>("GET", `/v1/instances/${encodeURIComponent(id)}`);
      if (info.status === "running") return info;
      if (DEAD_STATES.has(info.status)) throw new Error(`agent37 deploy instance ${id}: ${info.status}`);
      if (Date.now() > deadline) throw new Error(`agent37 deploy instance ${id}: not running (status=${info.status})`);
      if (STARTABLE_STATES.has(info.status)) {
        const res = await api("POST", `/v1/instances/${encodeURIComponent(id)}/start`, undefined, CREATE_TIMEOUT_MS);
        if (res.ok) continue;
        if (res.status !== 400 && res.status !== 409) throw await fail(`start ${id}`, res);
      }
      await sleep(READY_POLL_MS);
    }
  }

  async function exec(instanceId: string, script: string, timeoutSec: number): Promise<Agent37ExecResponse> {
    const res = await send(
      "POST",
      `/v1/instances/${encodeURIComponent(instanceId)}/exec`,
      { command: script },
      Math.min(EXEC_TIMEOUT_MS, timeoutSec * 1000 + 60_000),
    );
    if (!res.ok) throw await fail(`exec ${instanceId}`, res);
    return (await res.json()) as Agent37ExecResponse;
  }

  // Our exec endpoint takes a command, not a file, so a tree rides in as base64 chunks and is
  // unpacked on the far side. Same shape the agent37 sandbox backend uses.
  async function writeFile(instanceId: string, absPath: string, data: Uint8Array): Promise<void> {
    const part = `${absPath}.${randomUUID().slice(0, 8)}.part`;
    const b64 = Buffer.from(data).toString("base64");
    const mk = await exec(instanceId, `mkdir -p "$(dirname ${shq(absPath)})" && : > ${shq(part)}`, 60);
    if (mk.exit_code !== 0) throw new Error(`agent37 deploy write ${absPath}: mkdir failed (${mk.exit_code})`);
    try {
      for (let i = 0; i < b64.length; i += WRITE_CHUNK_B64) {
        const chunk = b64.slice(i, i + WRITE_CHUNK_B64);
        const r = await exec(instanceId, `printf %s ${shq(chunk)} | base64 -d >> ${shq(part)}`, 120);
        if (r.exit_code !== 0) throw new Error(`agent37 deploy write ${absPath}: chunk failed (${r.exit_code})`);
      }
      const fin = await exec(
        instanceId,
        `sz=$(wc -c < ${shq(part)}) && mv -f ${shq(part)} ${shq(absPath)} && printf %s "$sz"`,
        60,
      );
      const written = Number.parseInt(fin.stdout.trim(), 10);
      if (fin.exit_code !== 0 || written !== data.length) {
        throw new Error(
          `agent37 deploy write ${absPath} failed (rc=${fin.exit_code}, ${written}/${data.length} bytes)`,
        );
      }
    } catch (e) {
      await exec(instanceId, `rm -f ${shq(part)}`, 60).catch((err) =>
        swallow("agent37-deploy: write part cleanup", err),
      );
      throw e;
    }
  }

  async function unpackTree(instanceId: string, guestDir: string, dir: string, only?: string[]): Promise<void> {
    const files = await readTree(dir, { tolerateMissing: true });
    const wanted = only ? new Set(only.map(normalizeRelPath)) : null;
    const entries = files
      .map((f) => ({ path: normalizeRelPath(f.path), data: f.data }))
      .filter((f) => !wanted || wanted.has(f.path));
    if (!entries.length) return;
    const bundle = `/tmp/qm-bundle-${randomUUID().slice(0, 8)}.tgz`;
    await writeFile(instanceId, bundle, gzipSync(await makeTar(entries)));
    const r = await exec(
      instanceId,
      `mkdir -p ${shq(guestDir)} && tar -xzmf ${shq(bundle)} -C ${shq(guestDir)}; rc=$?; rm -f ${shq(bundle)}; exit $rc`,
      EXTRACT_TIMEOUT_SEC,
    );
    if (r.exit_code !== 0) {
      throw new Error(`agent37 deploy: unpacking into ${guestDir} failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
    }
  }

  async function removePaths(instanceId: string, guestDir: string, paths: string[]): Promise<void> {
    if (!paths.length) return;
    const quoted = paths.map((p) => shq(posixJoin(guestDir, normalizeRelPath(p)))).join(" ");
    await exec(instanceId, `rm -rf -- ${quoted}`, 120);
  }

  function appEnv(version: DeploymentVersion): Record<string, string> {
    const declared = Object.fromEntries(Object.entries(version.env ?? {}).filter(([k]) => ENV_NAME.test(k)));
    return { ...declared, HOME: HOME_DIR, PORT: String(appPort), DATA_DIR };
  }

  // The start script is the whole reason this provider works across a sleep: it is a file the
  // instance owns, and the template's entrypoint runs it on every boot, wake and restart.
  function startScript(version: DeploymentVersion): string {
    const exports = Object.entries(appEnv(version))
      .map(([k, v]) => `export ${k}=${shq(v)}`)
      .join("\n");
    // cd to the script's own directory rather than a constant: the script ships inside the app
    // tree, so this stays right even if the tree moves.
    return `#!/bin/sh\nset -e\n${exports}\ncd "$(dirname "$0")"\nexec sh -lc ${shq(version.entrypoint)}\n`;
  }

  async function installStartScript(instanceId: string, version: DeploymentVersion): Promise<void> {
    await writeFile(instanceId, START_PATH, Buffer.from(startScript(version), "utf8"));
    await exec(instanceId, `chmod 0755 ${shq(START_PATH)}`, 60);
  }

  // Restarting the app in place (redeploy, reconcile) rather than the instance: the template
  // entrypoint waits on the same script, so this is the same command either way.
  async function restartApp(instanceId: string): Promise<void> {
    const launch = `${shq(START_PATH)} < /dev/null > ${shq(LOG_PATH)} 2>&1 & echo $! > ${shq(PID_PATH)}`;
    const script = [
      `kill "$(cat ${shq(PID_PATH)} 2>/dev/null)" 2>/dev/null || true`,
      `if command -v setsid >/dev/null 2>&1; then setsid ${launch}; else ${launch}; fi`,
    ].join("; ");
    const r = await exec(instanceId, script, APP_START_EXEC_TIMEOUT_SEC);
    if (r.exit_code !== 0) throw new Error(`agent37 deploy app start failed: ${r.stderr.slice(0, 300)}`);
    await waitAppReady(
      async (probe, timeoutSec) => {
        const out = await exec(instanceId, probe, timeoutSec);
        return { stdout: out.stdout, stderr: out.stderr, code: out.exit_code, timedOut: false };
      },
      { appPort, windowSec: readyWindowSec, pidPath: PID_PATH, logPath: LOG_PATH },
    );
  }

  function hostOf(info: Agent37Instance): string {
    const port = info.public_ports?.find((p) => p.port === appPort)?.url;
    const url = port ?? info.url ?? "";
    const host = url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!host) throw new Error(`agent37 deploy ${info.id}: the API named no URL for the app`);
    return host;
  }

  const endpointOf = (host: string): DeployEndpoint => ({
    host,
    port: ENDPOINT_PORT,
    tls: true,
    publicUrl: `https://${host}/`,
  });

  const serialized = <T>(d: Deployment, fn: () => Promise<T>): Promise<T> =>
    queue(d.id, () => advisoryLock.withLock(`agent37-deploy:${d.id}`, fn));

  async function liveStored(d: Deployment): Promise<StoredAgent37DeployBody | null> {
    const stored = await store.get(d.id);
    if (!stored) return null;
    const res = await api("GET", `/v1/instances/${encodeURIComponent(stored.instanceId)}`);
    if (res.ok) {
      const info = (await res.json()) as Agent37Instance;
      if (!GONE_STATES.has(info.status)) return stored;
    } else if (res.status !== 404) {
      throw await fail(`get ${stored.instanceId}`, res);
    }
    await store.delete(d.id).catch((e) => swallow("agent37-deploy: drop dead body pointer", e));
    return null;
  }

  async function deleteInstance(instanceId: string): Promise<void> {
    const res = await api("DELETE", `/v1/instances/${encodeURIComponent(instanceId)}`, undefined, 120_000);
    if (!res.ok && res.status !== 404) throw await fail(`delete ${instanceId}`, res);
  }

  return {
    // Our instances sleep when idle and wake on the routed request, so qm must not run its own
    // reaper: it would delete an app the owner still has, and rebuild it from scratch on the
    // next visit, where a wake is under a second.
    profile: { managedScaleToZero: true, inPlaceReconcile: true, dataDir: DATA_DIR },

    apply: (d, version) =>
      serialized(d, async () => {
        resolveCache.delete(d.id);
        await ensureTemplate();
        const stale = await store.get(d.id);
        if (stale) {
          await deleteInstance(stale.instanceId).catch((e) => swallow("agent37-deploy: retire stale body", e));
          await store.delete(d.id).catch((e) => swallow("agent37-deploy: clear stale pointer", e));
        }
        const name = `${baseName(d)}-${randomUUID().slice(0, 5)}`;
        const res = await send(
          "POST",
          "/v1/instances",
          {
            template,
            name,
            resources,
            auto_sleep: d.alwaysOn ? false : autoSleep,
            public_ports: [{ port: appPort }],
            metadata: { qm_deployment_id: d.id },
          },
          CREATE_TIMEOUT_MS,
        );
        if (!res.ok) throw await fail(`create ${name}`, res);
        const created = (await res.json()) as Agent37Instance;
        try {
          const info = await ensureRunning(created.id);
          const host = hostOf(info);
          await exec(created.id, `mkdir -p ${shq(APP_DIR)} ${shq(DATA_DIR)}`, 60);
          await installStartScript(created.id, version);
          await unpackTree(created.id, APP_DIR, version.snapshotDir);
          if (version.homeDir) await unpackTree(created.id, HOME_DIR, version.homeDir);
          await restartApp(created.id);
          await store.put(d.id, { deploymentId: d.id, instanceId: created.id, name, host, createdAtMs: Date.now() });
          return endpointOf(host);
        } catch (e) {
          await deleteInstance(created.id).catch((err) => swallow("agent37-deploy: abandon failed body", err));
          throw e;
        }
      }),

    // Live editing: push only what changed into the instance that is already serving.
    reconcile: (d, version, input: DeployReconcileInput) =>
      serialized(d, async () => {
        const stored = await liveStored(d);
        if (!stored) throw new Error(`agent37 deploy ${d.id}: no live instance to reconcile`);
        await ensureRunning(stored.instanceId);
        await removePaths(stored.instanceId, APP_DIR, input.deletedPaths);
        if (input.changedPaths.length)
          await unpackTree(stored.instanceId, APP_DIR, version.snapshotDir, input.changedPaths);
        await installStartScript(stored.instanceId, version);
        await restartApp(stored.instanceId);
        resolveCache.delete(d.id);
        return endpointOf(stored.host);
      }),

    async setAlwaysOn(d, alwaysOn): Promise<void> {
      const stored = await liveStored(d);
      if (!stored) return;
      const res = await api("PATCH", `/v1/instances/${encodeURIComponent(stored.instanceId)}`, {
        auto_sleep: alwaysOn ? false : autoSleep,
      });
      if (!res.ok) throw await fail(`set auto_sleep ${stored.instanceId}`, res);
    },

    async resolveEndpoint(d): Promise<DeployEndpoint | null> {
      const cached = resolveCache.get(d.id);
      if (cached) return cached;
      const stored = await liveStored(d);
      if (!stored) {
        resolveCache.delete(d.id);
        return null;
      }
      const endpoint = endpointOf(stored.host);
      if (resolveCacheMs > 0) resolveCache.set(d.id, endpoint);
      return endpoint;
    },

    async logs(d, logOpts): Promise<string | null> {
      const stored = await liveStored(d);
      if (!stored) return null;
      const lines = Math.max(1, Math.min(2000, Math.floor(logOpts.tailLines)));
      const r = await exec(stored.instanceId, `tail -n ${lines} ${shq(LOG_PATH)} 2>/dev/null || true`, 30).catch(
        (e) => {
          swallow("agent37-deploy: logs", e);
          return null;
        },
      );
      return r?.stdout ?? null;
    },

    destroy: (d) =>
      serialized(d, async () => {
        resolveCache.delete(d.id);
        const stored = await store.get(d.id);
        if (!stored) return;
        await deleteInstance(stored.instanceId).catch((e) => {
          throw new Error(`agent37 deploy destroy ${d.id}: ${errMessage(e)}`, { cause: e });
        });
        await store.delete(d.id).catch((e) => swallow("agent37-deploy: destroy clear pointer", e));
      }),
  };
}
