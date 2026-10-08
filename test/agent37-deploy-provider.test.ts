import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAgent37DeployProvider } from "../src/deploy/agent37-deploy-provider.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";
import { installFakeAgent37, FAKE_AGENT37_API_KEY, type FakeAgent37 } from "./support/fake-agent37.ts";

const ID = "550e8400-e29b-41d4-a716-446655440000";
const scope = scopeId("personal", "tester");

// The fake runs exec scripts for real, so the app is a real server: that makes the readiness
// probe, the start script and the env it exports all genuinely exercised.
const SERVER_JS = `require('http').createServer((_q, r) => r.end(process.env.API_TOKEN ?? 'ok')).listen(Number(process.env.PORT));\n`;

let fake: FakeAgent37;
let roots: string[] = [];

function deployment(extra: Partial<Deployment> = {}): Deployment {
  return {
    id: ID,
    ownerScopeId: scope,
    createdBy: "tester",
    currentVersion: 1,
    status: "running",
    endpoint: null,
    versions: [],
    ...extra,
  } as Deployment;
}

function version(files: Record<string, string>, extra: Partial<DeploymentVersion> = {}): DeploymentVersion {
  const root = mkdtempSync(join(tmpdir(), "a37-deploy-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return {
    version: 1,
    createdAt: Date.now(),
    // The ready probe curls the app port, so the fake's `sh -c` has to serve something.
    entrypoint: "node server.js",
    snapshotDir: root,
    ...extra,
  };
}

function make(extra: Record<string, unknown> = {}): DeployProvider {
  return createAgent37DeployProvider({
    apiKey: FAKE_AGENT37_API_KEY,
    fetchImpl: fake.fetchImpl,
    namePrefix: "qmt",
    // The fake runs exec scripts for real on the host, so never wait a full minute on a probe.
    readyWindowSec: 2,
    store: createMemoryMap(),
    ...extra,
  });
}

beforeEach(() => {
  fake = installFakeAgent37();
});
after(() => fake?.cleanup());

test("tells qm it manages idleness itself, so qm never reaps an app", () => {
  const provider = make();
  assert.equal(provider.profile.managedScaleToZero, true);
  assert.equal(provider.profile.dataDir, "/data");
});

test("creates the runner template once, with a fixed entrypoint that runs the app's own start script", async () => {
  const provider = make();
  await provider.apply(deployment(), version({ "server.js": SERVER_JS })).catch(() => {});

  const templates = fake.templates();
  assert.equal(templates.length, 1);
  const [tpl] = templates;
  assert.equal(tpl!.name, "qm-app-runner");
  assert.equal(tpl!.default_port, 8080);
  // Fixed, because the per-app command is a file on the instance. That is what survives a sleep:
  // a command we only exec in would be gone after the first checkpoint.
  assert.ok(tpl!.entrypoint?.join(" ").includes("/app/.qm-start.sh"));

  // A second deploy reuses it rather than racing a duplicate create.
  await provider.apply(deployment({ id: "other-deployment-id" }), version({ "server.js": SERVER_JS })).catch(() => {});
  assert.equal(fake.templates().length, 1);
});

test("creates one sleeping instance per app with a public port, and returns its URL", async () => {
  const provider = make();
  const endpoint = await provider.apply(deployment(), version({ "server.js": SERVER_JS }));

  const [name] = fake.names();
  assert.ok(name!.startsWith("qmt-app-550e8400-e29"), `unexpected instance name ${name}`);
  const instance = fake.instance(name!);
  assert.equal(instance?.template, "qm-app-runner");
  assert.deepEqual(instance?.publicPorts, [8080]);
  // qm defaults an app to not-always-on, and that is the cheap path here: disk only while idle.
  assert.equal(instance?.autoSleep, true);

  assert.equal(endpoint.tls, true);
  assert.equal(endpoint.port, 443);
  assert.ok(endpoint.publicUrl?.startsWith("https://pp-"), `unexpected url ${endpoint.publicUrl}`);
});

test("an always-on deployment is created awake", async () => {
  const provider = make();
  await provider.apply(deployment({ alwaysOn: true }), version({ "server.js": SERVER_JS }));
  assert.equal(fake.instance(fake.names()[0]!)?.autoSleep, false);
});

test("setAlwaysOn flips sleeping on the live instance in both directions", async () => {
  const provider = make();
  const d = deployment();
  await provider.apply(d, version({ "server.js": SERVER_JS }));
  const name = fake.names()[0]!;

  await provider.setAlwaysOn!(d, true);
  assert.equal(fake.instance(name)?.autoSleep, false);

  await provider.setAlwaysOn!(d, false);
  assert.equal(fake.instance(name)?.autoSleep, true);
});

test("ships the app tree and writes a start script carrying the version's env", async () => {
  const provider = make();
  await provider.apply(
    deployment(),
    version({ "server.js": SERVER_JS, "lib/util.js": "" }, { env: { API_TOKEN: "t0ken", "bad name": "dropped" } }),
  );

  const scripts = fake.execScripts().join("\n");
  assert.match(scripts, /tar -xzmf/);
  assert.match(scripts, /chmod 0755 '\/app\/\.qm-start\.sh'/);
  // The start script is what the entrypoint re-runs on every boot, so the env has to live in it.
  const written = fake
    .execScripts()
    .filter((s) => s.includes("base64 -d"))
    .join("");
  assert.ok(written.length > 0, "app bundle was never written");
  // Keys that are not valid shell identifiers never reach the instance.
  assert.ok(!scripts.includes("bad name"));
});

test("reconcile pushes only the changed paths into the instance already serving", async () => {
  const provider = make();
  const d = deployment();
  await provider.apply(d, version({ "server.js": SERVER_JS, "keep.txt": "keep" }));
  const before = fake.names()[0]!;

  const next = version({ "server.js": SERVER_JS, "keep.txt": "keep", "added.txt": "new" });
  const endpoint = await provider.reconcile!(d, next, {
    changedPaths: ["added.txt"],
    deletedPaths: ["gone.txt"],
    allPaths: ["server.js", "keep.txt", "added.txt"],
  });

  // Same instance: live editing must not rebuild the box or change the app's URL.
  assert.deepEqual(fake.names(), [before]);
  assert.ok(endpoint.publicUrl?.startsWith("https://pp-"));
  const scripts = fake.execScripts().join("\n");
  assert.match(scripts, /rm -rf -- '\/app\/gone\.txt'/);
});

test("destroy deletes the instance and resolveEndpoint then reports nothing", async () => {
  const provider = make();
  const d = deployment();
  await provider.apply(d, version({ "server.js": SERVER_JS }));
  assert.equal(fake.names().length, 1);

  const v = version({ "server.js": SERVER_JS });
  assert.ok(await provider.resolveEndpoint!(d, v));
  await provider.destroy(d);
  assert.equal(fake.names().length, 0);
  assert.equal(await provider.resolveEndpoint!(d, v), null);

  // Destroying twice is not an error: the pointer is already gone.
  await provider.destroy(d);
});

test("logs tail the app's output, and are null once the instance is gone", async () => {
  const provider = make();
  const d = deployment();
  await provider.apply(d, version({ "server.js": SERVER_JS }));
  assert.equal(typeof (await provider.logs!(d, { tailLines: 10 })), "string");

  await provider.destroy(d);
  assert.equal(await provider.logs!(d, { tailLines: 10 }), null);
});

test("a create that never comes up leaves no orphan instance behind", async () => {
  const provider = make();
  // The instance is created, then poisoned before the provider can reach it.
  fake.failNext(500, { match: ({ path }) => /\/exec$/.test(path) });
  await assert.rejects(provider.apply(deployment(), version({ "server.js": SERVER_JS })));
  assert.deepEqual(fake.names(), []);
});

test("refuses to construct without an API key", () => {
  assert.throws(() => createAgent37DeployProvider({}), /AGENT37_DEPLOY_API_KEY/);
});
