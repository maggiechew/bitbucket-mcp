export type Alignment = "direct" | "subject" | "neighbourhood" | "none";

export interface TestAlignment {
  alignment: Alignment;
  matched_changes: string[];
}

const SPEC_ROOTS = ["spec", "test", "tests", "__tests__", "unit_tests", "integration_tests", "features", "contracts"];
const SPEC_SUFFIX = /(_spec|\.spec|\.test)\.[a-z]+$/;
const EXTENSION = /\.[a-z]+$/;
const NEIGHBOURHOOD_DEPTH = 2;

/**
 * How closely a failing test sits to the files a PR changed: the test itself, the code it names,
 * the same corner of the codebase, or nothing nearby.
 */
export function alignTest(specPath: string, changedPaths: string[]): TestAlignment {
  const direct = changedPaths.filter((path) => path === specPath);
  if (direct.length) return { alignment: "direct", matched_changes: direct };

  const subject = changedPaths.filter((path) => isSubjectOf(specPath, path));
  if (subject.length) return { alignment: "subject", matched_changes: subject };

  const neighbourhood = changedPaths.filter((path) => isNeighbourOf(specPath, path));
  if (neighbourhood.length) return { alignment: "neighbourhood", matched_changes: neighbourhood };

  return { alignment: "none", matched_changes: [] };
}

function isSubjectOf(specPath: string, changedPath: string): boolean {
  return !isSpec(changedPath) && baseName(changedPath) === subjectName(specPath);
}

function isSpec(path: string): boolean {
  return SPEC_SUFFIX.test(path);
}

function subjectName(specPath: string): string {
  return fileName(specPath).replace(SPEC_SUFFIX, "");
}

function baseName(path: string): string {
  return fileName(path).replace(EXTENSION, "");
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

// The last two directories of the spec's path once the spec roots are stripped, e.g.
// spec/unit_tests/controllers/admin/x_spec.rb -> "controllers/admin". One directory alone
// (spec/models/x_spec.rb -> "models") is too broad to call a neighbourhood.
function isNeighbourOf(specPath: string, changedPath: string): boolean {
  const domain = domainOf(specPath);
  return domain !== null && changedPath.includes(`${domain}/`);
}

function domainOf(specPath: string): string | null {
  const directories = specPath
    .split("/")
    .slice(0, -1)
    .filter((segment) => !SPEC_ROOTS.includes(segment));
  if (directories.length < NEIGHBOURHOOD_DEPTH) return null;
  return directories.slice(-NEIGHBOURHOOD_DEPTH).join("/");
}
