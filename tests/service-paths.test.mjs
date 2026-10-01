import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const bash = existsSync("/bin/bash") ? "/bin/bash" : "bash";

/*
 * These tests never touch a real service. Every scratch tree is copied to a
 * private directory, HOME is private, and `id`, `systemctl`, `launchctl` and
 * `sleep` are shadowed by logging fakes on PATH. `id` always reports a normal
 * user so a root test runner cannot make the installer write /etc/systemd.
 */

function scratchRoot(tag) {
  return realpathSync(mkdtempSync(join(tmpdir(), `pi-coffee ${tag} % & <t> `)));
}

function seedTree(root, scripts) {
  for (const relative of scripts) {
    const destination = join(root, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repoRoot, relative), destination);
    chmodSync(destination, 0o755);
  }
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist/index.js"), "");
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts/start.mjs"), "");
}

function writeFakeCommands(binDir) {
  mkdirSync(binDir, { recursive: true });
  const write = (name, body) => {
    const file = join(binDir, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  };
  write("id", `#!/bin/sh
# Always report a normal user: a real root run would write /etc/systemd/system.
if [ "$1" = "-u" ]; then
  printf '%s\\n' "\${FAKE_ID_UID:-1000}"
  exit 0
fi
exit 1
`);
  for (const name of ["systemctl", "launchctl", "sleep"]) {
    write(name, `#!/bin/sh
printf '%s %s\\n' "${name}" "$*" >> "$FAKE_CMD_LOG"
exit 0
`);
  }
  write("node", `#!/bin/sh
exit 0
`);
}

function buildEnv({ home, binDir, logPath, envFile }) {
  return {
    ...process.env,
    HOME: home,
    USER: "service-paths-test",
    PATH: `${binDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    FAKE_ID_UID: "1000",
    FAKE_CMD_LOG: logPath,
    PI_COFFEE_ENV_FILE: envFile ?? "",
  };
}

function runScript(script, env) {
  const result = spawnSync(bash, [script], { cwd: dirname(script), env, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `install script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function findUnitValue(unit, prefix) {
  const matches = unit.split("\n").filter((line) => line.startsWith(prefix));
  assert.equal(matches.length, 1, `expected exactly one ${prefix} line`);
  return matches[0].slice(prefix.length);
}

/* Decode the subset of systemd syntax these unit files can contain:
 * extract_first_word() with EXTRACT_UNQUOTE|EXTRACT_CUNESCAPE, then per-setting
 * specifier expansion ('%%' -> '%') and, for ExecStart, runtime '$VAR'
 * expansion ('$$' -> '$'). */
const SYSTEMD_C_ESCAPES = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'" };

function systemdUnquoteWords(value, { runtime = false } = {}) {
  const words = [];
  let i = 0;
  const isSpace = (char) => char !== undefined && /\s/.test(char);
  while (i < value.length) {
    while (isSpace(value[i])) i++;
    if (i >= value.length) break;
    let word = "";
    if (value[i] === '"' || value[i] === "'") {
      const quote = value[i++];
      while (i < value.length && value[i] !== quote) {
        if (value[i] === "\\") {
          const escaped = value.slice(i + 1, i + 2);
          word += SYSTEMD_C_ESCAPES[escaped] ?? escaped;
          i += 2;
        } else {
          word += value[i++];
        }
      }
      assert.ok(i < value.length, `unbalanced ${quote} in systemd value: ${value}`);
      i++;
    } else {
      while (i < value.length && !isSpace(value[i])) {
        if (value[i] === "\\") {
          const escaped = value.slice(i + 1, i + 2);
          word += SYSTEMD_C_ESCAPES[escaped] ?? escaped;
          i += 2;
        } else {
          word += value[i++];
        }
      }
    }
    word = word.replace(/%%/g, "%");
    if (runtime) word = word.replace(/\$\$/g, () => "$");
    words.push(word);
  }
  return words;
}

function xmlEscape(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXmlEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, entity) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const radix = entity[1] === "x" ? 16 : 10;
    return String.fromCodePoint(Number.parseInt(entity.slice(2), radix));
  });
}

/* Strict enough for generated plists: balanced tags, a single root, quoted
 * attributes and only predefined/numeric entities in text. */
function assertWellFormedXml(xml, label) {
  const stack = [];
  let roots = 0;
  let i = 0;
  const fail = (message) => assert.fail(`${label}: ${message} (offset ${i})`);
  const checkText = (text) => {
    for (const token of text.matchAll(/&[^;]*;?/g)) {
      if (!/^&(?:#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);$/.test(token[0])) {
        fail(`invalid or unescaped entity ${JSON.stringify(token[0])}`);
      }
    }
  };
  while (i < xml.length) {
    const nextTag = xml.indexOf("<", i);
    checkText(nextTag === -1 ? xml.slice(i) : xml.slice(i, nextTag));
    if (nextTag === -1) break;
    i = nextTag;
    if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i);
      if (end === -1) fail("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i);
      if (end === -1) fail("unterminated comment");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<!DOCTYPE", i)) {
      const end = xml.indexOf(">", i);
      if (end === -1) fail("unterminated DOCTYPE");
      i = end + 1;
      continue;
    }
    if (xml.startsWith("</", i)) {
      const end = xml.indexOf(">", i);
      if (end === -1) fail("unterminated closing tag");
      const name = xml.slice(i + 2, end).trim();
      const open = stack.pop();
      if (open !== name) fail(`closing </${name}> does not match <${open ?? "(none)"}>`);
      i = end + 1;
      continue;
    }
    let end = i + 1;
    let quote = null;
    for (; end < xml.length; end++) {
      const char = xml[end];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (end >= xml.length) fail("unterminated opening tag");
    let inner = xml.slice(i + 1, end);
    const selfClosing = inner.endsWith("/");
    if (selfClosing) inner = inner.slice(0, -1);
    const name = inner.split(/\s/, 1)[0];
    if (!/^[A-Za-z_][\w.:-]*$/.test(name)) fail(`invalid tag name <${name}>`);
    if (stack.length === 0) roots++;
    if (!selfClosing) stack.push(name);
    i = end + 1;
  }
  if (stack.length > 0) fail(`unclosed tags: ${stack.join(", ")}`);
  assert.equal(roots, 1, `${label}: expected exactly one root element, found ${roots}`);
}

function plistStringValues(xml) {
  assertWellFormedXml(xml, "launchd plist");
  const values = {};
  const pattern = /<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g;
  for (const match of xml.matchAll(pattern)) {
    values[decodeXmlEntities(match[1])] = decodeXmlEntities(match[2]);
  }
  return values;
}

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function decodePlistWithSystemParser(plistPath) {
  const candidates = [];
  if (existsSync("/usr/bin/plutil")) {
    candidates.push(["/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath]]);
  }
  const python = findOnPath("python3");
  if (python) {
    candidates.push([
      python,
      ["-c", "import plistlib,json,sys;print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))", plistPath],
    ]);
  }
  for (const [command, args] of candidates) {
    try {
      return JSON.parse(execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    } catch {
      // The strict local checks below still run when no host parser can load it.
    }
  }
  return null;
}

test("systemd unit preserves special paths without specifier substitution", (t) => {
  const root = scratchRoot("systemd");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const project = join(root, "project %h%i & <angle> $dollar");
  const home = join(root, "home %h%i & <angle> $dollar 'quote'");
  const envFile = join(root, "env %h%i & <angle> $dollar");
  const binDir = join(project, "fake bin %h%i & <angle> $dollar");
  const logPath = join(root, "commands.log");
  seedTree(project, ["deploy/linux/install-service.sh"]);
  writeFakeCommands(binDir);
  writeFileSync(envFile, "PI_COFFEE_PORT=1\n");

  runScript(join(project, "deploy/linux/install-service.sh"), buildEnv({ home, binDir, logPath, envFile }));

  const unitPath = join(home, ".config/systemd/user/pi-coffee.service");
  const unit = readFileSync(unitPath, "utf8");
  const nodeBin = join(binDir, "node");
  const startScript = join(project, "scripts/start.mjs");
  const daemonPath = `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${home}/.local/bin:${home}/.pi/agent/bin`;

  // Any lone '%' is a unit specifier that systemd would substitute or reject.
  assert.doesNotMatch(unit, /(?<!%)%(?!%)/);

  // systemd takes WorkingDirectory= verbatim (no quote removal), so the
  // project directory stays unquoted and only '%' is doubled.
  const workdir = findUnitValue(unit, "WorkingDirectory=");
  assert.ok(!workdir.startsWith('"') && !workdir.endsWith('"'), "WorkingDirectory must stay unquoted");
  assert.equal(workdir.replace(/%%/g, "%"), project);

  assert.ok(findUnitValue(unit, "ExecStart=").startsWith(":"), "fixed paths disable environment expansion");
  // ExecStart= is word-split by systemd with quote removal and C escapes,
  // specifier-expanded; the ':' prefix disables runtime variable expansion.
  assert.deepEqual(
    systemdUnquoteWords(findUnitValue(unit, "ExecStart=").slice(1)),
    [nodeBin, startScript],
  );

  const environment = {};
  for (const line of unit.split("\n").filter((entry) => entry.startsWith("Environment="))) {
    const [assignment] = systemdUnquoteWords(line.slice("Environment=".length));
    const separator = assignment.indexOf("=");
    assert.ok(separator > 0, `bad environment entry: ${assignment}`);
    environment[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  assert.deepEqual(Object.keys(environment).sort(), ["PATH", "PI_COFFEE_ENV_FILE"]);
  assert.equal(environment.PATH, daemonPath);
  assert.equal(environment.PI_COFFEE_ENV_FILE, envFile);

  // Raw escaping evidence, independent of the decoder above.
  assert.match(findUnitValue(unit, "ExecStart="), /%%h%%i & <angle> \$dollar/);
  assert.match(findUnitValue(unit, "WorkingDirectory="), /%%h%%i & <angle> \$dollar/);
  assert.match(unit, /Environment="PATH=[^"]*%%h%%i & <angle> \$dollar/);

  // The fakes prove both calls were user-scoped and never a real service.
  const commands = readFileSync(logPath, "utf8");
  assert.match(commands, /^systemctl --user daemon-reload$/m);
  assert.match(commands, /^systemctl --user enable --now pi-coffee$/m);
  assert.doesNotMatch(commands, /^systemctl (daemon-reload|enable)/m);

  // Existing default: without PI_COFFEE_ENV_FILE no Environment line is added.
  runScript(join(project, "deploy/linux/install-service.sh"), buildEnv({ home, binDir, logPath, envFile: "" }));
  const defaultUnit = readFileSync(unitPath, "utf8");
  assert.ok(!defaultUnit.includes("PI_COFFEE_ENV_FILE"), "env file must be omitted when unset");
  assert.doesNotMatch(defaultUnit, /(?<!%)%(?!%)/);
});

test("launchd plist is valid XML and decodes to the original special paths", (t) => {
  const root = scratchRoot("launchd");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const project = join(root, "project %h%i & <angle> $dollar");
  const home = join(root, "home %h%i & <angle> $dollar 'quote'");
  const envFile = join(root, "env %h%i & <angle> $dollar");
  const binDir = join(project, "fake bin %h%i & <angle> $dollar");
  const logPath = join(root, "commands.log");
  seedTree(project, ["deploy/macos/install-daemon.sh"]);
  writeFakeCommands(binDir);
  writeFileSync(envFile, "PI_COFFEE_PORT=1\n");

  runScript(join(project, "deploy/macos/install-daemon.sh"), buildEnv({ home, binDir, logPath, envFile }));

  const plistPath = join(home, "Library/LaunchAgents/com.picoffee.daemon.plist");
  const plist = readFileSync(plistPath, "utf8");
  const nodeBin = join(binDir, "node");
  const startScript = join(project, "scripts/start.mjs");
  const logDir = join(home, ".pi-coffee/logs");
  const daemonPath = `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${home}/.local/bin:${home}/.pi/agent/bin:${home}/.bun/bin`;

  const expected = {
    nodeBin,
    startScript,
    WorkingDirectory: project,
    home,
    PATH: daemonPath,
    PI_COFFEE_ENV_FILE: envFile,
    StandardOutPath: join(logDir, "daemon.out.log"),
    StandardErrorPath: join(logDir, "daemon.err.log"),
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.ok(plist.includes(`<string>${xmlEscape(value)}</string>`), `${name} is not XML-escaped in the plist`);
  }
  assert.doesNotMatch(plist, /&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/, "raw '&' in plist");

  // Always decode with the strict local checks, even without a host parser.
  const fallback = plistStringValues(plist);
  assert.equal(fallback.WorkingDirectory, project);
  assert.equal(fallback.HOME, home);
  assert.equal(fallback.PATH, daemonPath);
  assert.equal(fallback.PI_COFFEE_ENV_FILE, envFile);
  assert.equal(fallback.StandardOutPath, expected.StandardOutPath);
  assert.equal(fallback.StandardErrorPath, expected.StandardErrorPath);

  // A real plist parser (plutil on macOS, python3 elsewhere) must decode every
  // path byte-for-byte back to the original values.
  const parsed = decodePlistWithSystemParser(plistPath);
  if (parsed) {
    assert.equal(parsed.Label, "com.picoffee.daemon");
    assert.deepEqual(parsed.ProgramArguments, [nodeBin, startScript]);
    assert.equal(parsed.WorkingDirectory, project);
    assert.equal(parsed.EnvironmentVariables.PATH, daemonPath);
    assert.equal(parsed.EnvironmentVariables.HOME, home);
    assert.equal(parsed.EnvironmentVariables.PI_COFFEE_ENV_FILE, envFile);
    assert.equal(parsed.StandardOutPath, expected.StandardOutPath);
    assert.equal(parsed.StandardErrorPath, expected.StandardErrorPath);
  }

  const commands = readFileSync(logPath, "utf8");
  assert.match(commands, /^launchctl bootout gui\/\d+\/com\.picoffee\.daemon$/m);
  assert.match(commands, /^launchctl bootstrap gui\/\d+ /m);
  assert.doesNotMatch(commands, /^launchctl (unload|load)\b/m);
  assert.match(commands, /^sleep 1$/m);

  // Existing default: without PI_COFFEE_ENV_FILE the plist key is omitted.
  runScript(join(project, "deploy/macos/install-daemon.sh"), buildEnv({ home, binDir, logPath, envFile: "" }));
  const defaultPlist = readFileSync(plistPath, "utf8");
  assert.ok(!defaultPlist.includes("PI_COFFEE_ENV_FILE"), "env file key must be omitted when unset");
  assertWellFormedXml(defaultPlist, "launchd plist without env file");
});
