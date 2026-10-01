#!/usr/bin/env node
/** Install a pinned, user-facing pi independently of the daemon checkout. */
import {execFileSync} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageName = '@earendil-works/pi-coding-agent';
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies[packageName];
const marker = '# Managed by pi-coffee user CLI installer';
const shellQuote = value => `'${value.replace(/'/g, "'\\''")}'`;
const cmdQuote = value => `"${value.replace(/%/g, '%%')}"`;

export const launcherSource = `import {fileURLToPath} from 'node:url';
import {envFilePath,loadEnvFile} from './env.mjs';
loadEnvFile(envFilePath());
const cli = new URL('./node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url);
const args = process.argv.slice(2);
const options = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
const has = flag => options.some(arg => arg === flag || arg.startsWith(flag + '='));
const defaults = [];
if (!has('--provider') && !has('--model')) {
  if (process.env.PI_COFFEE_PROVIDER) defaults.push('--provider', process.env.PI_COFFEE_PROVIDER);
  if (process.env.PI_COFFEE_MODEL) defaults.push('--model', process.env.PI_COFFEE_MODEL);
}
if (!has('--thinking') && !has('--model') && process.env.PI_COFFEE_THINKING) defaults.push('--thinking', process.env.PI_COFFEE_THINKING);
process.argv = [process.execPath, fileURLToPath(cli), ...defaults, ...args];
await import(cli.href);
`;

export function installCli({home = homedir(), platform = process.platform, nodePath = process.execPath,
  npmCli = process.env.npm_execpath, configurePath = true, shell = process.env.SHELL || '/bin/sh'} = {}) {
  const nodeVersion = execFileSync(nodePath, ['-p', 'process.versions.node'], {encoding: 'utf8'}).trim();
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (!(major > 22 || (major === 22 && minor >= 19))) throw new Error(`pi requires Node >=22.19.0; installer is using ${nodeVersion}`);
  const prefix = join(home, '.local', 'share', 'pi-cli');
  const binDir = join(home, '.local', 'bin');
  const launcher = join(prefix, 'launch.mjs');
  const entry = join(binDir, platform === 'win32' ? 'pi.cmd' : 'pi');
  // Never replace an unrelated user command. Allow the prior manual entry to migrate.
  if (existsSync(entry)) {
    const old = readFileSync(entry, 'utf8');
    if (!old.includes(marker) && !old.includes(launcher)) throw new Error(`Existing unmanaged pi command: ${entry}`);
  }
  const packageDir = join(prefix, 'node_modules', '@earendil-works', 'pi-coding-agent');
  const cli = join(packageDir, 'dist', 'bundle', 'cli.js');
  let installed;
  try { installed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version; } catch {}
  if (installed !== version || !existsSync(cli)) {
    if (!npmCli || !existsSync(npmCli)) throw new Error('Run this installer with npm run install:cli');
    execFileSync(nodePath, [npmCli, 'install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', `${packageName}@${version}`], {stdio: 'inherit'});
  }
  mkdirSync(binDir, {recursive: true});
  mkdirSync(prefix, {recursive: true});
  // Keep the runtime independent of disposable installer/cache paths.
  const runtimeDir = join(prefix, 'runtime');
  const runtime = join(runtimeDir, platform === 'win32' ? 'node.exe' : 'node');
  mkdirSync(runtimeDir, {recursive: true});
  if (nodePath !== runtime) copyFileSync(nodePath, runtime);
  if (platform !== 'win32') chmodSync(runtime, 0o755);
  if (execFileSync(runtime, ['-p', 'process.versions.node'], {encoding: 'utf8'}).trim() !== nodeVersion) throw new Error('Private Node runtime verification failed');
  copyFileSync(join(root, 'scripts', 'lib', 'env.mjs'), join(prefix, 'env.mjs'));
  writeFileSync(launcher, launcherSource);
  if (platform === 'win32') {
    writeFileSync(entry, `@echo off\r\n@rem ${marker}\r\n@${cmdQuote(runtime)} ${cmdQuote(launcher)} %*\r\n`, {mode: 0o755});
    if (configurePath) {
      const literal = `'${binDir.replace(/'/g, "''")}'`;
      const script = `$bin=${literal}; $p=[Environment]::GetEnvironmentVariable('Path','User'); if (($p -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path',($bin+';'+$p),'User') }`;
      execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {stdio: 'inherit'});
    }
  } else {
    writeFileSync(entry, `#!/bin/sh\n${marker}\nnode=$(command -v node 2>/dev/null || true)\nif [ -n "$node" ] && "$node" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' >/dev/null 2>&1; then\n  exec "$node" ${shellQuote(launcher)} "$@"\nfi\nexec ${shellQuote(runtime)} ${shellQuote(launcher)} "$@"\n`, {mode: 0o755});
    chmodSync(entry, 0o755);
    if (configurePath) {
      const line = 'export PATH="$HOME/.local/bin:$PATH"';
      const names = basename(shell) === 'zsh' ? ['.zshrc', '.zprofile']
        : basename(shell) === 'bash' ? ['.bashrc', existsSync(join(home, '.bash_profile')) ? '.bash_profile' : '.profile']
        : ['.profile'];
      for (const name of names) {
        const file = join(home, name);
        const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
        if (!old.split('\n').includes(line)) writeFileSync(file, `${old}${old.endsWith('\n') || !old ? '' : '\n'}\n${marker}\n${line}\n`);
      }
    }
  }
  // Verify from outside the checkout, without shell initialization or a model call.
  const result = platform === 'win32' ? execFileSync(runtime, [launcher, '--version'], {cwd: tmpdir(), encoding: 'utf8', timeout: 15000}).trim() : execFileSync(entry, ['--version'], {cwd: tmpdir(), encoding: 'utf8', timeout: 15000}).trim();
  if (result !== version) throw new Error(`Unexpected installed pi version: ${result}`);
  return {entry, binDir, version};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = installCli();
  console.log(`Installed pi ${result.version}: ${result.entry}`);
  console.log('Open a new terminal, then run pi from any project directory.');
}
