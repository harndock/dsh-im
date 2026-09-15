import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const staging = resolve(dist, 'harndock-plugin');
const pluginId = 'dsh-im';
const signingPrefix = 'DSH-PLUGIN-MANIFEST-V1\0';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${result.stderr || result.stdout || ''}`
      : '';
    throw new Error(`${command} ${args.join(' ')} failed${detail}`);
  }
  return result.stdout;
}

function readSigningKey() {
  const encoded = process.env.HARNDOCK_PLUGIN_SIGNING_PRIVATE_KEY_BASE64;
  if (!encoded) {
    throw new Error('HARNDOCK_PLUGIN_SIGNING_PRIVATE_KEY_BASE64 is required');
  }
  const seed = Buffer.from(encoded, 'base64');
  if (seed.length !== 32) {
    throw new Error('HARNDOCK_PLUGIN_SIGNING_PRIVATE_KEY_BASE64 must contain a 32-byte Ed25519 seed');
  }
  return createPrivateKey({ key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]), format: 'der', type: 'pkcs8' });
}

function assertManifestSignature(manifest, privateKey) {
  const payload = {
    pluginId: manifest.pluginId,
    version: manifest.version,
    pluginTypes: manifest.pluginTypes,
    summary: manifest.summary,
    description: manifest.description,
    harness: manifest.harness,
    runtimeApi: manifest.runtimeApi,
    platforms: manifest.platforms,
    permissions: manifest.permissions,
    artifact: manifest.artifact,
  };
  const bytes = Buffer.concat([Buffer.from(signingPrefix), Buffer.from(JSON.stringify(payload))]);
  const signature = sign(null, bytes, privateKey);
  if (!verify(null, bytes, createPublicKey(privateKey), signature)) {
    throw new Error('generated plugin manifest signature did not verify');
  }
  return signature.toString('base64');
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
run('npm', ['run', 'build']);
run('node', ['scripts/verify-package.mjs']);

const packageOutput = run('npm', [
  'pack',
  '--ignore-scripts',
  '--json',
], { capture: true });
const [packed] = JSON.parse(packageOutput);
if (!packed?.filename) throw new Error('npm pack did not report an archive filename');

const packageArchive = resolve(root, packed.filename);
run('tar', ['-xzf', packageArchive, '-C', dist]);
await cp(resolve(dist, 'package'), staging, { recursive: true });
await rm(resolve(dist, 'package'), { recursive: true, force: true });
await rm(packageArchive, { force: true });

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const archiveName = `${pluginId}-${packageJson.version}.tar.zst`;
const tarPath = resolve(dist, `${pluginId}-${packageJson.version}.tar`);
const archivePath = resolve(dist, archiveName);
run('tar', ['--format=ustar', '-cf', tarPath, '-C', dist, 'harndock-plugin']);
run('zstd', ['--no-progress', '--force', '--ultra', '-22', '-o', archivePath, tarPath]);
await rm(tarPath, { force: true });
await rm(staging, { recursive: true, force: true });

const artifact = await readFile(archivePath);
const manifest = {
  pluginId,
  version: packageJson.version,
  pluginTypes: ['host', 'client'],
  summary: 'Connect eleven IM channels and a public AI Office to a local DeepSeek Harness.',
  description: packageJson.description,
  harness: {
    minVersion: '0.1.2-alpha.4',
    maxVersion: null,
  },
  runtimeApi: 1,
  platforms: ['darwin-aarch64', 'darwin-x64'],
  permissions: {
    filesystem: ['dsh-home', 'workspace'],
    network: [
      'api.dingtalk.com',
      'api.slack.com',
      'api.telegram.org',
      'discord.com',
      'ilinkai.weixin.qq.com',
      'novac2c.cdn.weixin.qq.com',
      'oapi.dingtalk.com',
      'open.feishu.cn',
      'open.larksuite.com',
      'qyapi.weixin.qq.com',
      'registry.npmjs.org',
      'slack.com',
      'work.weixin.qq.com',
    ],
    process: ['dsh', 'osascript', 'security', 'sqlite3'],
  },
  artifact: {
    sha256: createHash('sha256').update(artifact).digest('hex'),
    size: (await stat(archivePath)).size,
  },
};
manifest.signature = {
  keyId: 'marketplace-dev-rfc8032',
  value: assertManifestSignature(manifest, readSigningKey()),
};

await writeFile(resolve(dist, 'plugin-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built ${archiveName} and plugin-manifest.json in ${dist}`);
