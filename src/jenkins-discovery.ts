import { jenkinsJson } from "./jenkins-client.js";
import {
  JenkinsBuild,
  JenkinsStage,
  consoleErrors,
  fetchBuild,
  fetchConsole,
  fetchStages,
  fetchTestReport,
  jobPath,
  stageCascade,
} from "./jenkins-build.js";
import { classifyFailure, classifyOutcome } from "./build-classification.js";

export interface StageProfile {
  name: string;
  seen_in_builds: number;
  runs_in_parallel_with: string[];
}

export interface SignatureProfile {
  classification: string;
  count: number;
  died_in: string[];
  example_errors: string[];
}

export interface PipelineProfile {
  job: string;
  kind: "multibranch_folder" | "job";
  jobs_sampled: string[];
  builds_sampled: number;
  outcomes: Record<string, number>;
  stages: StageProfile[];
  publishes_test_report: { with_failures: number; without_failures: number; none: number };
  failure_signatures: SignatureProfile[];
}

// A multibranch folder lists jobs; a standalone job lists builds. Jenkins answers with whichever
// fields the item has, so one request tells the two apart.
interface RawJobOrFolder {
  jobs?: { name: string; lastCompletedBuild?: { number: number } | null }[];
  builds?: { number: number; result: string | null }[];
}

interface SampleTarget {
  name: string;
  path: string;
  number: number;
}

interface SampledBuild {
  job: string;
  build: JenkinsBuild;
  stages: JenkinsStage[];
  outcome: string;
  classification?: string;
  died_in: string | null;
  errors: string[];
  test_report: "with_failures" | "without_failures" | "none";
}

const SIGNATURE_EXAMPLE_LIMIT = 3;

/**
 * Samples recent completed builds and describes how the pipeline behaves: one build per branch job
 * for a multibranch folder, or the last few builds of a standalone job such as a master branch.
 */
export async function discoverPipeline(job: string, sampleSize: number): Promise<PipelineProfile> {
  const path = jobPath(job);
  const listing = await jenkinsJson<RawJobOrFolder>(
    `${path}/api/json?tree=jobs[name,lastCompletedBuild[number]],builds[number,result]{0,${sampleSize}}`,
  );
  if (!listing) throw new Error(`Jenkins has no job or folder named "${job}".`);

  const kind = listing.jobs ? "multibranch_folder" : "job";
  const targets = listing.jobs ? recentJobs(path, listing.jobs, sampleSize) : recentBuilds(job, path, listing.builds ?? []);
  const samples = await Promise.all(targets.map((target) => sampleBuild(target.path, target.number)));
  const sampled = samples.filter((sample): sample is SampledBuild => sample !== null);

  return {
    job,
    kind,
    jobs_sampled: [...new Set(targets.map((target) => target.name))],
    builds_sampled: sampled.length,
    outcomes: countBy(sampled, (sample) => sample.outcome),
    stages: stageProfiles(sampled),
    publishes_test_report: {
      with_failures: sampled.filter((sample) => sample.test_report === "with_failures").length,
      without_failures: sampled.filter((sample) => sample.test_report === "without_failures").length,
      none: sampled.filter((sample) => sample.test_report === "none").length,
    },
    failure_signatures: signatureProfiles(sampled),
  };
}

function recentJobs(folderPath: string, jobs: NonNullable<RawJobOrFolder["jobs"]>, limit: number): SampleTarget[] {
  return jobs
    .filter((job) => job.lastCompletedBuild)
    .map((job) => ({
      name: job.name,
      path: `${folderPath}/job/${encodeURIComponent(job.name)}`,
      number: job.lastCompletedBuild!.number,
    }))
    .sort((a, b) => b.number - a.number)
    .slice(0, limit);
}

function recentBuilds(name: string, path: string, builds: NonNullable<RawJobOrFolder["builds"]>): SampleTarget[] {
  return builds.filter((build) => build.result !== null).map((build) => ({ name, path, number: build.number }));
}

async function sampleBuild(job: string, number: number): Promise<SampledBuild | null> {
  const build = await fetchBuild(job, number);
  if (!build) return null;

  const [stages, tests, consoleText] = await Promise.all([
    fetchStages(job, number),
    fetchTestReport(job, number),
    fetchConsole(job, number),
  ]);
  const cascade = stageCascade(stages, consoleText);
  const errors = consoleErrors(consoleText);
  const outcome = classifyOutcome(build, tests);

  return {
    job,
    build,
    stages,
    outcome,
    classification: outcome === "failed" ? classifyFailure(errors, cascade) : undefined,
    died_in: cascade.died_in,
    errors,
    test_report: tests ? (tests.failed.length ? "with_failures" : "without_failures") : "none",
  };
}

function stageProfiles(samples: SampledBuild[]): StageProfile[] {
  const names = [...new Set(samples.flatMap((sample) => sample.stages.map((stage) => stage.name)))];
  return names.map((name) => ({
    name,
    seen_in_builds: samples.filter((sample) => sample.stages.some((stage) => stage.name === name)).length,
    runs_in_parallel_with: parallelPeers(name, samples),
  }));
}

// Two stages ran in parallel when their time windows overlapped in the same build without one
// enclosing the other, which is a parent stage and its children rather than peers.
function parallelPeers(name: string, samples: SampledBuild[]): string[] {
  const peers = samples.flatMap((sample) => {
    const stage = sample.stages.find((candidate) => candidate.name === name);
    if (!stage) return [];
    return sample.stages.filter((other) => other.name !== name && overlaps(stage, other)).map((other) => other.name);
  });
  return [...new Set(peers)];
}

function overlaps(a: JenkinsStage, b: JenkinsStage): boolean {
  const intersect = a.started_ms < endOf(b) && b.started_ms < endOf(a);
  return intersect && !encloses(a, b) && !encloses(b, a);
}

function encloses(outer: JenkinsStage, inner: JenkinsStage): boolean {
  return outer.started_ms <= inner.started_ms && endOf(inner) <= endOf(outer);
}

function endOf(stage: JenkinsStage): number {
  return stage.started_ms + stage.duration_ms;
}

function signatureProfiles(samples: SampledBuild[]): SignatureProfile[] {
  const failed = samples.filter((sample) => sample.classification);
  const classifications = [...new Set(failed.map((sample) => sample.classification!))];
  return classifications.map((classification) => {
    const matching = failed.filter((sample) => sample.classification === classification);
    return {
      classification,
      count: matching.length,
      died_in: [...new Set(matching.map((sample) => sample.died_in).filter((name): name is string => name !== null))],
      example_errors: [...new Set(matching.flatMap((sample) => sample.errors))].slice(0, SIGNATURE_EXAMPLE_LIMIT),
    };
  });
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[key(item)] = (counts[key(item)] ?? 0) + 1;
    return counts;
  }, {});
}
