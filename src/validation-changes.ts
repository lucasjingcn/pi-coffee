import { acceptancePath } from "./acceptance.js";
import { gitRaw } from "./worktree.js";

/**
 * Directory components that mark a path as validation code. Every component
 * (not just the first) is compared case-insensitively.
 */
const VALIDATION_DIRECTORIES = new Set(["test", "tests", "__tests__", "spec", "specs", "__snapshots__"]);

/** Lowercased file name prefixes that mark a path as validation code. */
const VALIDATION_FILE_PREFIXES = [
  "test_",
  "jest.config.",
  "vitest.config.",
  "playwright.config.",
  "cypress.config.",
] as const;

/** Lowercased exact file names that mark a path as validation code. */
const VALIDATION_FILE_NAMES = new Set(["conftest.py", "pytest.ini", "tox.ini"]);

/** Lowercased substrings that mark a file name as validation code. */
const VALIDATION_FILE_SUBSTRINGS = ["_test.", ".test.", ".spec."] as const;

function isValidationName(name: string): boolean {
  const lower = name.toLowerCase();
  if (VALIDATION_FILE_NAMES.has(lower)) return true;
  if (VALIDATION_FILE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  return VALIDATION_FILE_SUBSTRINGS.some((part) => lower.includes(part));
}

/** A path is validation evidence if it is custom-declared or matches conventional test names. */
function isValidationPath(path: string, customPaths: readonly string[]): boolean {
  if (customPaths.some((custom) => path === custom || path.startsWith(`${custom}/`))) return true;
  const segments = path.split("/");
  const name = segments.pop() ?? "";
  if (segments.some((segment) => VALIDATION_DIRECTORIES.has(segment.toLowerCase()))) return true;
  return isValidationName(name);
}

/** Decode NUL-delimited git output without unquoting, trimming or re-encoding paths. */
function nulPaths(output: string): string[] {
  return output.split("\0").filter((path) => path.length > 0);
}

/** Refuse to diff against anything that cannot be resolved to a commit. */
async function requireCommit(repo: string, ref: string): Promise<void> {
  try {
    await gitRaw(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Not a valid commit ref in ${repo}: ${ref} (${detail})`);
  }
}

/**
 * Exact Git evidence of pre-existing validation files the worker changed.
 *
 * The diff runs with `--no-renames`, so a rename reports the old path as a
 * deletion and the new path as an addition. Membership in the base tree keeps
 * only the pre-existing side, which excludes files the worker introduced no
 * matter what they are named. Every modification counts, including append-only
 * edits, because the review gate needs the path, not a line-level heuristic.
 *
 * Custom `validationPaths` are normalized with `acceptancePath`, so traversal,
 * absolute and Git-metadata paths fail before any Git call. Returned paths are
 * decoded from NUL-delimited output and sorted, so spaces, tabs, newlines and
 * Unicode survive exactly.
 */
export async function existingValidationChanges(
  repo: string,
  baseSha: string,
  workerSha: string,
  validationPaths: string[] = [],
): Promise<string[]> {
  const customPaths = validationPaths.map((path) => acceptancePath(path.replace(/\/$/, "")).split("\\").join("/"));
  await requireCommit(repo, baseSha);
  await requireCommit(repo, workerSha);

  const [changedRaw, baseTreeRaw] = await Promise.all([
    gitRaw(repo, ["diff", "--no-renames", "--name-only", "-z", baseSha, workerSha]),
    gitRaw(repo, ["ls-tree", "-r", "--name-only", "-z", baseSha]),
  ]);

  const existedInBase = new Set(nulPaths(baseTreeRaw));
  const changed = new Set<string>();
  for (const path of nulPaths(changedRaw)) {
    if (!existedInBase.has(path)) continue;
    if (isValidationPath(path, customPaths)) changed.add(path);
  }
  return [...changed].sort();
}
