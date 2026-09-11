import { JenkinsBuild, StageCascade, TestReport } from "./jenkins-build.js";

export type BuildOutcome = "passed" | "in_progress" | "aborted" | "tests_failed" | "failed";

export interface FailureSignature {
  classification: string;
  pattern: RegExp;
}

// Console lines the pipeline itself writes when it stops for a reason the test report cannot see.
// Matched against the collected console errors; the first hit names the failure.
export const FAILURE_SIGNATURES: FailureSignature[] = [
  { classification: "merge_conflict", pattern: /CONFLICT \(|Automatic merge failed/i },
  { classification: "checkout_failed", pattern: /ERROR: Checkout failed|Maximum checkout retry/i },
  { classification: "formatting", pattern: /prettier/i },
  { classification: "lint", pattern: /rubocop|pronto|eslint/i },
  { classification: "dependency_audit", pattern: /bundle-audit|bundler-audit|npm audit/i },
  { classification: "quality_gate", pattern: /quality gate|sonar/i },
  { classification: "coverage", pattern: /coverage/i },
  { classification: "timeout", pattern: /timeout|timed out/i },
  { classification: "agent_offline", pattern: /agent .*(offline|disconnected)|node .*offline/i },
  { classification: "disk_full", pattern: /no space left/i },
];

export const UNRECOGNISED = "unrecognised";

export function classifyOutcome(build: JenkinsBuild, tests: TestReport | null): BuildOutcome {
  if (build.building) return "in_progress";
  if (build.result === "SUCCESS") return "passed";
  if (build.result === "ABORTED") return "aborted";
  if (tests && tests.failed.length > 0) return "tests_failed";
  return "failed";
}

/** The named failure a build's console evidence matches, or "unrecognised" when nothing does. */
export function classifyFailure(errors: string[], cascade: StageCascade): string {
  const matched = FAILURE_SIGNATURES.find((signature) => errors.some((line) => signature.pattern.test(line)));
  if (matched) return matched.classification;
  return cascade.died_in === null ? "checkout_failed" : UNRECOGNISED;
}
