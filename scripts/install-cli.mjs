#!/usr/bin/env node
/** Install a pinned, user-facing pi independently of the daemon checkout. */
import {execFileSync} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cmdQuote, shellQuote} from './lib/cli.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageName = '@earendil-works/pi-coding-agent';
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies[packageName];
const marker = '# Managed by pi-coffee user CLI installer';

const launcherSource = `import {fileURLToPath} from 'node:url';
import {envFilePath,loadEnvFile} from './env.mjs';
loadEnvFile(envFilePath());
const cli = new URL('./node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url);
const args = process.argv.slice(2);
// A subcommand must stay the first argument or pi treats it as an agent prompt
// and can recursively invoke itself (e.g. "pi mcp list" -> prompt "mcp" ->
// agent runs bash "pi mcp list" -> ...). Never inject default flags in front.
const commands = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth', 'mcp']);
const isCommand = args.length > 0 && commands.has(args[0]);
const options = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
const has = flag => options.some(arg => arg === flag || arg.startsWith(flag + '='));
const defaults = [];
if (!isCommand && !has('--provider') && !has('--model')) {
  if (process.env.PI_COFFEE_PROVIDER) defaults.push('--provider', process.env.PI_COFFEE_PROVIDER);
  if (process.env.PI_COFFEE_MODEL) defaults.push('--model', process.env.PI_COFFEE_MODEL);
}
if (!isCommand && !has('--thinking') && !has('--model') && process.env.PI_COFFEE_THINKING) defaults.push('--thinking', process.env.PI_COFFEE_THINKING);
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
  // Keep the runtime independent of disposable installer/cache paths. Some Node builds
  // (Homebrew's, linked against libnode.dylib) cannot be copied on their own: the copy fails
  // to start with a dyld error. The Unix launcher already prefers a supported node on PATH,
  // so on Unix a missing private runtime is a documented warning, not a failed install;
  // Windows launches the private runtime directly and keeps the hard failure.
  const runtimeDir = join(prefix, 'runtime');
  const runtime = join(runtimeDir, platform === 'win32' ? 'node.exe' : 'node');
  mkdirSync(runtimeDir, {recursive: true});
  if (nodePath !== runtime) copyFileSync(nodePath, runtime);
  if (platform !== 'win32') chmodSync(runtime, 0o755);
  let privateRuntime = true;
  try {
    privateRuntime = execFileSync(runtime, ['-p', 'process.versions.node'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim() === nodeVersion;
  } catch {
    privateRuntime = false;
  }
  if (!privateRuntime) {
    rmSync(runtime, {force: true});
    if (platform === 'win32') throw new Error('Private Node runtime verification failed');
  }
  copyFileSync(join(root, 'scripts', 'lib', 'env.mjs'), join(prefix, 'env.mjs'));
  writeFileSync(launcher, launcherSource);

  // Everything below writes user-visible state (the `pi` command and a shell rc
  // line). Record the previous entry so a failed verification can put it back:
  // a broken entry used to survive and shadow the user's own pi command.
  const previousEntry = existsSync(entry) ? readFileSync(entry) : null;
  const restoreEntry = () => {
    try {
      if (previousEntry === null) rmSync(entry, {force: true});
      else writeFileSync(entry, previousEntry);
    } catch { /* best effort: the thrown error is the actionable one */ }
  };

  if (platform === 'win32') {
    writeFileSync(entry, `@echo off\r\n@rem ${marker}\r\n@${cmdQuote(runtime)} ${cmdQuote(launcher)} %*\r\n`, {mode: 0o755});
  } else {
    writeFileSync(entry, `#!/bin/sh\n${marker}\nnode=$(command -v node 2>/dev/null || true)\nif [ -n "$node" ] && "$node" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' >/dev/null 2>&1; then\n  exec "$node" ${shellQuote(launcher)} "$@"\nfi\nexec ${shellQuote(runtime)} ${shellQuote(launcher)} "$@"\n`, {mode: 0o755});
    chmodSync(entry, 0o755);
  }

  // Verify from outside the checkout, without shell initialization or a model call,
  // BEFORE touching PATH: a failed check must leave the shell configuration alone.
  let result;
  try {
    result = platform === 'win32'
      ? execFileSync(runtime, [launcher, '--version'], {cwd: tmpdir(), encoding: 'utf8', timeout: 15000}).trim()
      : execFileSync(entry, ['--version'], {cwd: tmpdir(), encoding: 'utf8', timeout: 15000}).trim();
  } catch (error) {
    restoreEntry();
    throw error;
  }
  if (result !== version) {
    restoreEntry();
    throw new Error(`Unexpected installed pi version: ${result}`);
  }

  if (configurePath && platform === 'win32') {
    const literal = `'${binDir.replace(/'/g, "''")}'`;
    const script = `$bin=${literal}; $p=[Environment]::GetEnvironmentVariable('Path','User'); if (($p -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path',($bin+';'+$p),'User') }`;
    execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {stdio: 'inherit'});
  } else if (configurePath) {
    // The rc line must point at the directory the command was actually written to;
    // a literal $HOME/.local/bin was wrong for a non-default home.
    const quoted = binDir === join(homedir(), '.local', 'bin') ? '"$HOME/.local/bin"' : shellQuote(binDir);
    const line = `export PATH=${quoted}:$PATH`;
    const names = basename(shell) === 'zsh' ? ['.zshrc', '.zprofile']
      : basename(shell) === 'bash' ? ['.bashrc', existsSync(join(home, '.bash_profile')) ? '.bash_profile' : '.profile']
      : ['.profile'];
    for (const name of names) {
      const file = join(home, name);
      const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (!old.split('\n').includes(line)) writeFileSync(file, `${old}${old.endsWith('\n') || !old ? '' : '\n'}\n${marker}\n${line}\n`);
    }
  }
  return {entry, binDir, version, privateRuntime};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = installCli();
  console.log(`Installed pi ${result.version}: ${result.entry}`);
  if (!result.privateRuntime) {
    console.log('note: this Node build cannot be copied (dynamic libnode); the pi command uses the Node on PATH.');
  }
  console.log('Open a new terminal, then run pi from any project directory.');
}
