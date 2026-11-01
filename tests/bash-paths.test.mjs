import test from 'node:test';
import assert from 'node:assert/strict';
import { bashPaths } from '../dist/bash-paths.js';

const cases = [
  {
    title: 'backslash before ordinary char in double quotes is preserved',
    cmd: 'printf x > "a\\q.txt"',
    paths: ['a\\q.txt'],
  },
  {
    title: 'leading redirection and fd number do not consume command position',
    cmd: '2> err.txt tee out.txt',
    paths: ['err.txt', 'out.txt'],
  },
  {
    title: 'here-string is not a heredoc body',
    cmd: 'cat <<< "text"\nprintf ok > final.txt',
    paths: ['final.txt'],
  },
  {
    title: 'tee operands continue past interspersed redirections',
    cmd: 'tee one.txt > log.txt two.txt',
    paths: ['one.txt', 'log.txt', 'two.txt'],
  },
  {
    title: 'sed operands continue past interspersed redirections',
    cmd: "sed -i 's/a/b/' > log.txt src/app.ts",
    paths: ['log.txt', 'src/app.ts'],
  },
  {
    title: 'literal filename new is still claimed',
    cmd: 'printf x > new',
    paths: ['new'],
  },
  {
    title: 'literal filename setTimeout is still claimed',
    cmd: 'printf x > setTimeout',
    paths: ['setTimeout'],
  },
  {
    title: 'tee claims operands named new and setTimeout',
    cmd: 'tee new setTimeout',
    paths: ['new', 'setTimeout'],
  },
  {
    title: 'null device redirects are not write targets',
    cmd: 'ls /tmp/artifacts/ 2>/dev/null | head -50; printf x > /dev/null; printf y 1>/dev/null',
    paths: [],
  },
  {
    title: 'self-descriptor redirects are not write targets',
    cmd: 'ls 2> /dev/stderr; echo hi > /dev/stdout; echo x > /dev/fd/2; echo y > /proc/self/fd/2; echo z > /dev/tty',
    paths: [],
  },
  {
    title: 'quoted JS program is not scanned as shell',
    cmd: "node -e 'const task = () => new Promise(resolve => setTimeout(resolve, 5)); task();'",
    paths: [],
  },
  {
    title: 'heredoc body is not scanned as shell',
    cmd: "node <<'JS'\nconst task = () => new Promise(resolve => setTimeout(resolve, 5));\nconsole.log(\"tee fake.txt > ghost.txt\");\nJS\n",
    paths: [],
  },
];

test('bashPaths extracts only literal shell write targets', () => {
  for (const c of cases) {
    assert.deepEqual([...new Set(bashPaths(c.cmd))].sort(), [...new Set(c.paths)].sort(), c.title);
  }
});

test('literal copy/move/install targets are write targets', () => {
  const cases = [
    ['cp payload.txt ../outside/copied.txt', ['../outside/copied.txt']],
    ['mv a b .git/config', ['.git/config']],
    ['install -m 644 a b', ['b']],
    ['cp -t ../outside a b', ['../outside']],
    ['dd if=in.bin of=../outside/out.bin', ['../outside/out.bin']],
    ['touch ../outside/x .git/config', ['../outside/x', '.git/config']],
    ['mkdir -p ../outside/d', ['../outside/d']],
    ['sh -c "printf x > ../outside/f"', ['../outside/f']],
    ['bash -lc "cp a ../outside/g"', ['../outside/g']],
    ['cat a | cp /dev/stdin ../outside/h', ['../outside/h']],
    ['echo hi > /dev/stderr', []],
  ];
  for (const [cmd, expected] of cases) {
    assert.deepEqual(bashPaths(cmd).sort(), [...expected].sort(), cmd);
  }
});
