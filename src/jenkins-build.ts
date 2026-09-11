import { jenkinsJson, jenkinsText } from "./jenkins-client.js";
import { toLocalTime } from "./pull-request-format.js";

export interface JenkinsBuild {
  job: string;
  number: number;
  result: string | null;
  building: boolean;
  started_at: string;
  started_local?: string;
  duration_seconds: number;
  url: string;
  commit?: string;
}

export interface JenkinsStage {
  name: string;
  status: string;
  started_ms: number;
  duration_ms: number;
}

export interface FailedTest {
  file: string;
  example: string;
  error?: string;
  failing_for_builds: number;
}

export interface TestReport {
  passed: number;
  skipped: number;
  failed: FailedTest[];
}

export interface StageCascade {
  died_in: string | null;
  failed: string[];
  aborted: string[];
  skipped: string[];
}

interface RawBuild {
  number: number;
  result: string | null;
  building: boolean;
  timestamp: number;
  duration: number;
  url: string;
  actions?: { lastBuiltRevision?: { SHA1?: string } }[];
}

interface RawStage {
  name: string;
  status: string;
  startTimeMillis: number;
  durationMillis: number;
}

interface RawTestCase {
  className: string;
  name: string;
  status: string;
  age: number;
  errorDetails?: string | null;
}

interface RawTestReport {
  passCount?: number;
  skipCount?: number;
  suites?: { cases?: RawTestCase[] }[];
}

const BUILD_FIELDS = "number,result,building,timestamp,duration,url,actions[lastBuiltRevision[SHA1]]";
const TEST_CASE_FIELDS = "className,name,status,age,errorDetails";
const FAILED_CASE_STATUSES = ["FAILED", "REGRESSION"];
const ERROR_DETAIL_LIMIT = 300;
const CONSOLE_ERROR_LIMIT = 10;
const SKIPPED_STAGE_LINE = /^Stage "(.+)" skipped due to earlier failure/;
const CONSOLE_ERROR_LINE = /^(?:\[[^\]]+\] )?(ERROR: .+|CONFLICT .+|Automatic merge failed.*|.*Failed in branch .+)$/;
const TIMESTAMP_PREFIX = /^\[[^\]]+\] /;

/** The Jenkins job path (`/job/folder/job/name`) and build number a build-status URL points at, or null. */
export function jobFromStatusUrl(url: string | undefined): { job: string; number: number } | null {
  const match = url?.match(/(\/job\/[^/]+(?:\/job\/[^/]+)*)\/(\d+)(?:\/|$)/);
  return match ? { job: match[1], number: Number(match[2]) } : null;
}

export function pullRequestJob(folder: string, pullRequestId: number): string {
  return `/job/${encodeURIComponent(folder)}/job/PR-${pullRequestId}`;
}

export async function fetchBuild(job: string, number: number | "lastBuild"): Promise<JenkinsBuild | null> {
  const raw = await jenkinsJson<RawBuild>(`${job}/${number}/api/json?tree=${BUILD_FIELDS}`);
  return raw ? compactBuild(job, raw) : null;
}

function compactBuild(job: string, raw: RawBuild): JenkinsBuild {
  return {
    job,
    number: raw.number,
    result: raw.result,
    building: raw.building,
    started_at: new Date(raw.timestamp).toISOString(),
    started_local: toLocalTime(new Date(raw.timestamp).toISOString()),
    duration_seconds: Math.round(raw.duration / 1000),
    url: raw.url,
    commit: raw.actions?.map((action) => action.lastBuiltRevision?.SHA1).find(Boolean),
  };
}

/** The number of the job's most recent finished build, or null when none has finished. */
export async function fetchLastCompletedBuildNumber(job: string): Promise<number | null> {
  const listing = await jenkinsJson<{ lastCompletedBuild?: { number: number } | null }>(
    `${job}/api/json?tree=lastCompletedBuild[number]`,
  );
  return listing?.lastCompletedBuild?.number ?? null;
}

export async function fetchStages(job: string, number: number): Promise<JenkinsStage[]> {
  const described = await jenkinsJson<{ stages?: RawStage[] }>(`${job}/${number}/wfapi/describe`);
  return (described?.stages ?? []).map((stage) => ({
    name: stage.name,
    status: stage.status,
    started_ms: stage.startTimeMillis,
    duration_ms: stage.durationMillis,
  }));
}

/** The build's JUnit report with only its failing cases, or null when no report was published. */
export async function fetchTestReport(job: string, number: number): Promise<TestReport | null> {
  const raw = await jenkinsJson<RawTestReport>(
    `${job}/${number}/testReport/api/json?tree=passCount,skipCount,suites[cases[${TEST_CASE_FIELDS}]]`,
  );
  if (!raw) return null;

  const cases = (raw.suites ?? []).flatMap((suite) => suite.cases ?? []);
  return {
    passed: raw.passCount ?? 0,
    skipped: raw.skipCount ?? 0,
    failed: cases.filter((testCase) => FAILED_CASE_STATUSES.includes(testCase.status)).map(compactFailedTest),
  };
}

function compactFailedTest(testCase: RawTestCase): FailedTest {
  return {
    file: specFileFor(testCase.className),
    example: testCase.name,
    error: firstLine(testCase.errorDetails),
    failing_for_builds: testCase.age,
  };
}

// rspec_junit_formatter reports the spec file as a dotted class name (spec.features.foo_spec).
// Other formatters already report a path, or a describe-block name that is left alone.
function specFileFor(className: string): string {
  if (className.includes("/")) return className;

  const parts = className.split(".");
  return parts[parts.length - 1].endsWith("_spec") ? `${parts.join("/")}.rb` : className;
}

function firstLine(details: string | null | undefined): string | undefined {
  const line = details?.trim().split("\n")[0]?.trim();
  if (!line) return undefined;
  return line.length > ERROR_DETAIL_LIMIT ? `${line.slice(0, ERROR_DETAIL_LIMIT)}...` : line;
}

export async function fetchConsole(job: string, number: number): Promise<string> {
  return (await jenkinsText(`${job}/${number}/consoleText`)) ?? "";
}

/** The console lines that name a failure, most recent last, capped so a noisy log stays readable. */
export function consoleErrors(consoleText: string): string[] {
  const lines = consoleText
    .split("\n")
    .map((line) => line.trim().match(CONSOLE_ERROR_LINE)?.[1].replace(TIMESTAMP_PREFIX, ""))
    .filter((line): line is string => Boolean(line));
  return [...new Set(lines)].slice(-CONSOLE_ERROR_LIMIT);
}

/**
 * Reconstructs how a failure spread through the stages. The build died in the failed stage that ended
 * first; failed stages already running at that moment were in flight, ABORTED stages were cut short,
 * and stages that started afterwards or that the console reports as skipped never really ran.
 */
export function stageCascade(stages: JenkinsStage[], consoleText: string): StageCascade {
  const declaredSkipped = skippedStages(consoleText);
  const failed = stages
    .filter((stage) => stage.status === "FAILED" && !declaredSkipped.includes(stage.name))
    .sort((a, b) => endOf(a) - endOf(b));
  const diedIn = failed[0];
  const inFlight = diedIn ? failed.filter((stage) => stage.started_ms <= endOf(diedIn)) : [];
  const neverRan = failed.filter((stage) => !inFlight.includes(stage)).map((stage) => stage.name);

  return {
    died_in: diedIn?.name ?? null,
    failed: inFlight.map((stage) => stage.name),
    aborted: stages.filter((stage) => stage.status === "ABORTED").map((stage) => stage.name),
    skipped: [...declaredSkipped, ...neverRan],
  };
}

function endOf(stage: JenkinsStage): number {
  return stage.started_ms + stage.duration_ms;
}

function skippedStages(consoleText: string): string[] {
  const names = consoleText
    .split("\n")
    .map((line) => line.trim().match(SKIPPED_STAGE_LINE)?.[1])
    .filter((name): name is string => Boolean(name));
  return [...new Set(names)];
}
