import { ProgressiveText, jenkinsJson, jenkinsLogSize, jenkinsLogTail, jenkinsText } from "./jenkins-client.js";
import { toLocalTime } from "./pull-request-format.js";

export interface JenkinsBuild {
  job: string;
  number: number;
  result: string | null;
  building: boolean;
  started_at: string;
  started_local?: string;
  duration_seconds: number;
  estimated_duration_ms: number | null;
  url: string;
  commit?: string;
  interrupted_by?: string[];
}

export interface JenkinsStage {
  id: string;
  name: string;
  status: string;
  started_ms: number;
  duration_ms: number;
}

export interface JenkinsRun {
  started_ms: number;
  stages: JenkinsStage[];
}

export interface JenkinsStep {
  id: string;
  name: string;
  status: string;
  started_ms: number;
  duration_ms: number;
  command?: string;
}

export interface StepLog {
  text: string;
  truncated: boolean;
}

export interface FailedTest {
  file: string;
  example: string;
  error?: string;
  failing_for_builds?: number;
}

export interface JenkinsArtifact {
  fileName: string;
  relativePath: string;
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
  estimatedDuration?: number;
  url: string;
  actions?: {
    _class?: string;
    lastBuiltRevision?: { SHA1?: string };
    causes?: { shortDescription?: string }[];
  }[];
}

interface RawStage {
  id: string;
  name: string;
  status: string;
  startTimeMillis: number;
  durationMillis: number;
}

interface RawFlowNode {
  id: string;
  name: string;
  status: string;
  startTimeMillis?: number;
  durationMillis?: number;
  parameterDescription?: string;
}

interface RawNodeLog {
  text?: string;
  hasMore?: boolean;
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

const BUILD_FIELDS =
  "number,result,building,timestamp,duration,estimatedDuration,url,actions[_class,lastBuiltRevision[SHA1],causes[shortDescription]]";
const INTERRUPTED_ACTION = "jenkins.model.InterruptedBuildAction";
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

/** The Jenkins job path for a name like `my-job` or a nested `folder/branch`. */
export function jobPath(name: string): string {
  return name
    .split("/")
    .filter(Boolean)
    .map((segment) => `/job/${encodeURIComponent(segment)}`)
    .join("");
}

/**
 * Explains a null from fetchBuild: the job path resolves to nothing, or the job exists without that build.
 * @param job the Jenkins job path (`/job/folder/job/name`)
 * @param number the build asked for
 * @return a message naming which of the two it was
 */
export async function missingBuildMessage(job: string, number: number | "lastBuild"): Promise<string> {
  const listing = await jenkinsJson<{ name?: string }>(`${job}/api/json?tree=name`);
  if (!listing) return `Jenkins has no job at ${job}.`;
  return `Jenkins job ${job} exists but has no build ${number}.`;
}

export async function fetchBuild(job: string, number: number | "lastBuild"): Promise<JenkinsBuild | null> {
  const raw = await jenkinsJson<RawBuild>(`${job}/${number}/api/json?tree=${BUILD_FIELDS}`);
  return raw ? compactBuild(job, raw) : null;
}

/** The job's most recent builds, newest first, or null when Jenkins has no such job. */
export async function fetchRecentBuilds(job: string, limit: number): Promise<JenkinsBuild[] | null> {
  const listing = await jenkinsJson<{ builds?: RawBuild[] }>(
    `${job}/api/json?tree=builds[${BUILD_FIELDS}]{0,${limit}}`,
  );
  return listing ? (listing.builds ?? []).map((raw) => compactBuild(job, raw)) : null;
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
    estimated_duration_ms: raw.estimatedDuration && raw.estimatedDuration > 0 ? raw.estimatedDuration : null,
    url: raw.url,
    commit: raw.actions?.map((action) => action.lastBuiltRevision?.SHA1).find(Boolean),
    interrupted_by: interruptedBy(raw),
  };
}

function interruptedBy(raw: RawBuild): string[] | undefined {
  const causes = (raw.actions ?? [])
    .filter((action) => action._class === INTERRUPTED_ACTION)
    .flatMap((action) => action.causes ?? [])
    .map((cause) => cause.shortDescription)
    .filter((description): description is string => Boolean(description));
  return causes.length ? causes : undefined;
}

/** The number of the job's most recent finished build, or null when none has finished. */
export async function fetchLastCompletedBuildNumber(job: string): Promise<number | null> {
  const listing = await jenkinsJson<{ lastCompletedBuild?: { number: number } | null }>(
    `${job}/api/json?tree=lastCompletedBuild[number]`,
  );
  return listing?.lastCompletedBuild?.number ?? null;
}

export async function fetchStages(job: string, number: number): Promise<JenkinsStage[]> {
  return (await fetchRun(job, number)).stages;
}

/**
 * The workflow view of a build: when the pipeline started and every stage and parallel branch as a flat
 * list. A live stage's status cannot be trusted: one that has started and has no finished child yet
 * reads SUCCESS with a negative duration, so `stageUnfinished` is the test for "still going".
 */
export async function fetchRun(job: string, number: number): Promise<JenkinsRun> {
  const described = await jenkinsJson<{ startTimeMillis?: number; stages?: RawStage[] }>(
    `${job}/${number}/wfapi/describe`,
  );
  return {
    started_ms: described?.startTimeMillis ?? 0,
    stages: (described?.stages ?? []).map((stage) => ({
      id: stage.id,
      name: stage.name,
      status: stage.status,
      started_ms: stage.startTimeMillis,
      duration_ms: stage.durationMillis,
    })),
  };
}

/** Whether a stage or step is still going: IN_PROGRESS, or a live one that Jenkins reports finished with a negative duration. */
export function stageUnfinished(node: { status: string; duration_ms: number }): boolean {
  return node.status === "IN_PROGRESS" || node.duration_ms < 0;
}

/** The steps that ran inside one stage, in order, each with the command it ran when it was a shell step. */
export async function fetchStageSteps(job: string, number: number, stageId: string): Promise<JenkinsStep[]> {
  const described = await jenkinsJson<{ stageFlowNodes?: RawFlowNode[] }>(
    `${job}/${number}/execution/node/${stageId}/wfapi/describe`,
  );
  return (described?.stageFlowNodes ?? []).map((node) => ({
    id: node.id,
    name: node.name,
    status: node.status,
    started_ms: node.startTimeMillis ?? 0,
    duration_ms: node.durationMillis ?? 0,
    command: node.parameterDescription || undefined,
  }));
}

function stepLogPath(job: string, number: number, stepId: string): string {
  return `${job}/${number}/execution/node/${stepId}/log/logText/progressiveText`;
}

function consoleLogPath(job: string, number: number): string {
  return `${job}/${number}/logText/progressiveText`;
}

/** The last `bytes` of one step's own log, plain text and free of annotations, or null when the step has no log. */
export async function fetchStepLogTail(
  job: string,
  number: number,
  stepId: string,
  bytes: number,
): Promise<ProgressiveText | null> {
  return jenkinsLogTail(stepLogPath(job, number, stepId), bytes);
}

/** The last `bytes` of the build's console, ConsoleNote blobs stripped. */
export async function fetchConsoleTail(job: string, number: number, bytes: number): Promise<ProgressiveText | null> {
  return jenkinsLogTail(consoleLogPath(job, number), bytes);
}

/** The build console's current size in bytes without reading it, or null when the build has no log. */
export async function fetchConsoleSize(job: string, number: number): Promise<number | null> {
  return (await jenkinsLogSize(consoleLogPath(job, number)))?.size_bytes ?? null;
}

/** The link to a step's log page, for a reader. */
export function stepLogUrl(baseUrl: string, job: string, number: number, stepId: string): string {
  return `${baseUrl}${job}/${number}/execution/node/${stepId}/log/`;
}

/**
 * One step's own output. The workflow API trims long logs, so when it reports more the plain-text
 * endpoint is read instead; if that is unavailable too the trimmed text is returned and flagged.
 */
export async function fetchStepLog(job: string, number: number, stepId: string): Promise<StepLog | null> {
  const log = await jenkinsJson<RawNodeLog>(`${job}/${number}/execution/node/${stepId}/wfapi/log`);
  if (!log) return null;
  if (!log.hasMore) return { text: log.text ?? "", truncated: false };

  const full = await jenkinsText(`${stepLogPath(job, number, stepId)}?start=0`);
  return full !== null ? { text: full, truncated: false } : { text: log.text ?? "", truncated: true };
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

/** The files the build archived, each with its name and its path under the build's artifact root. */
export async function fetchArtifacts(job: string, number: number): Promise<JenkinsArtifact[]> {
  const raw = await jenkinsJson<{ artifacts?: JenkinsArtifact[] }>(
    `${job}/${number}/api/json?tree=artifacts[fileName,relativePath]`,
  );
  return raw?.artifacts ?? [];
}

/** The text of one archived file, or null when the build has no artifact at that path. */
export async function fetchArtifact(job: string, number: number, relativePath: string): Promise<string | null> {
  return jenkinsText(`${job}/${number}/artifact/${relativePath}`);
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
