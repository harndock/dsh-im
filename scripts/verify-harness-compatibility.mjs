/** Verify the IM adapter against an installed Harness, without IM or LLM credentials. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { modernHarnessApi } from '../plugin-src/host/modern-harness-api.mjs';

if (!process.argv[2]) throw new Error('Pass the directory of an installed @deepseek-ai/dsh package.');
const root = resolve(process.argv[2]);
const fromHarness = createRequire(join(root, 'package.json'));
const load = name => import(pathToFileURL(fromHarness.resolve(name)).href);
const pluginRoot = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));
const harnessManifest = fromHarness('@deepseek-ai/dsh/package.json');
for (const name of manifest.dsh.client.inject) {
  const dependency = fromHarness(`${name}/package.json`);
  assert.ok(dependency.dsh?.client, `${name} must be a client plugin`);
  fromHarness.resolve(`${name}/client`);
}
console.log(`PASS client dependency graph on DSH ${harnessManifest.version}`);

const directory = await mkdtemp(join(tmpdir(), 'dsh-im-harness-compat-'));
const savedEnv = { ...process.env };
let ctx;
try {
  for (const key of Object.keys(process.env)) {
    if (/^DSH_/i.test(key) || /(?:KEY|SECRET|TOKEN|PASSWORD|PROXY)/i.test(key)) delete process.env[key];
  }
  process.env.DSH_HOME = join(directory, 'home');
  process.env.DSH_AGENTS_HOME = join(directory, '.agents');
  process.env.DSH_TELEMETRY_DISABLED = '1';
  process.env.SSH_CONNECTION = '';
  process.env.SSH_TTY = '';
  const profile = join(process.env.DSH_HOME, 'profiles/web');
  await mkdir(profile, { recursive: true });
  const packages = {
    '@deepseek-ai/dsh-base': dirname(fromHarness.resolve('@deepseek-ai/dsh-base/package.json')),
    '@deepseek-ai/dsh-web-app': dirname(fromHarness.resolve('@deepseek-ai/dsh-web-app/package.json')),
    [manifest.name]: pluginRoot,
  };
  for (const [name, path] of Object.entries(packages)) {
    const target = join(profile, 'node_modules', name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(path, target, 'dir');
  }
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-im-harness-compatibility-test', private: true,
    dependencies: Object.fromEntries(Object.entries(packages).map(([name, path]) => [name, `link:${path}`])),
    dsh: { profile: { bundles: Object.keys(packages) } },
  }));
  const { runProfile } = await load('@deepseek-ai/dsh/profile-boot');
  const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment');
  ({ ctx } = await runProfile({
    profile: 'web', patchFiles: [],
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
    environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }]),
  }));
  await ctx.loader.await();
  const probe = ctx.plugin({
    inject: ['typertGateway', 'workspaceController', 'sessionController'],
    async apply(scoped) {
      const api = modernHarnessApi(scoped);
      const invoke = async (service, method, payload = {}) => {
        const { result } = await api[service][method]({ rpcId: 'im-compatibility', payload }, AbortSignal.timeout(15_000));
        assert.equal(result.ok, true, `${service}.${method}: ${JSON.stringify(result)}`);
        return result.value;
      };
      const workPath = join(directory, 'workspace');
      await mkdir(workPath);
      const { workspace } = await invoke('workspace', 'create', { path: workPath });
      const workspaces = await invoke('workspace', 'list');
      assert.ok(workspaces.items.some(row => row.workspaceId === workspace.workspaceId));
      const { sessionId } = await invoke('sessions', 'create', { workspaceId: workspace.workspaceId });
      await invoke('sessions', 'rename', { sessionId, title: 'IM compatibility' });
      const sessions = await invoke('sessions', 'list');
      assert.ok(sessions.items.some(row => row.sessionId === sessionId));
      const history = await invoke('sessions', 'history', { sessionId });
      assert.ok(history.events.some(row => row.event.type === 'session/title'));
      const models = await invoke('sessions', 'models', { sessionId });
      assert.ok(Array.isArray(models.groups));
      const permissions = await invoke('sessions', 'permissions', { sessionId });
      assert.equal(typeof permissions.currentValue, 'string');
      assert.ok(permissions.options.length > 0);
      console.log('PASS real Gateway workspace create/list and Session create/list/rename/history/models/permissions');
      try {
        const listing = await scoped.typertGateway.invoke({
          namespace: 'directoryPicker', method: 'list', args: { path: workPath },
          signal: AbortSignal.timeout(15_000),
        });
        assert.equal(listing.path, workPath);
        console.log('PASS real directoryPicker.list (browse capability)');
      } catch (error) {
        const code = error?.code ?? error?.rpcError?.code;
        const capability = error?.details?.capability ?? error?.rpcError?.details?.capability;
        assert.equal(code, 'directory-picker/unavailable');
        assert.equal(capability, 'native');
        console.log('PASS real directoryPicker native fallback (browse capability unavailable)');
      }
    },
  });
  await probe.await();
  assert.equal(probe.state, 2, 'the compatibility probe must remain active after all assertions');
  if (savedEnv.DSH_IM_BROWSER_PROBE) {
    const { verifyBrowser } = await import(pathToFileURL(savedEnv.DSH_IM_BROWSER_PROBE).href);
    const server = ctx.get('webServer');
    await verifyBrowser(ctx.get('connection').authenticatedUrl(`http://127.0.0.1:${server.port}`), directory);
  }
} finally {
  await ctx?.fiber.dispose();
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(savedEnv, key)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await rm(directory, { recursive: true, force: true });
}
console.log(`Verified dsh-im ${manifest.version} against DSH ${harnessManifest.version}.`);
