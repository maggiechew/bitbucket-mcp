import { jenkinsBaseUrl, jenkinsConfigured, jenkinsJson } from "./jenkins-client.js";
import { BitbucketStatus, fetchBitbucketStatus } from "./bitbucket-status.js";
import { toLocalTime } from "./pull-request-format.js";

export interface QueueItem {
  task: string;
  url?: string;
  queued_since_local: string;
  waiting_minutes: number;
  reason: string;
  stuck: boolean;
}

export interface JenkinsNode {
  name: string;
  online: boolean;
  offline_reason?: string;
  executors: { busy: number; total: number };
}

export interface JenkinsHealth {
  url: string;
  reachable: boolean;
  error?: string;
  quieting_down?: boolean;
  executors?: { busy: number; total: number };
  queue?: { depth: number; oldest_wait_minutes: number | null; items: QueueItem[] };
  nodes?: JenkinsNode[];
  labels_without_nodes?: string[];
}

export type HealthStatus = "ok" | "degraded" | "down";

export interface HealthFinding {
  condition: string;
  evidence: string;
  advice: string;
}

export interface HealthAssessment {
  status: HealthStatus;
  summary: string;
  findings: HealthFinding[];
}

export interface CiHealth {
  checked_at: string;
  checked_at_local: string;
  assessment: HealthAssessment;
  bitbucket: BitbucketStatus;
  jenkins?: JenkinsHealth;
}

export type BuildExecution =
  | { state: "running" }
  | { state: "waiting_for_agent"; reason: string; waiting_minutes: number };

interface RawRoot {
  quietingDown: boolean;
}

interface RawComputer {
  displayName: string;
  offline: boolean;
  offlineCauseReason: string;
  numExecutors: number;
  executors?: { idle: boolean }[];
}

interface RawComputerSet {
  busyExecutors: number;
  totalExecutors: number;
  computer: RawComputer[];
}

interface RawQueueItem {
  inQueueSince: number;
  why?: string;
  stuck?: boolean;
  task?: { name?: string; url?: string };
}

interface RawQueue {
  items: RawQueueItem[];
}

const OFFLINE_LABEL = /All nodes of label ‘([^’]+)’ are offline/;
const LONG_WAIT_MINUTES = 30;

/** Bitbucket's status page plus, when Jenkins is configured, whether it is up and taking builds, with a verdict. */
export async function ciHealth(): Promise<CiHealth> {
  const [bitbucket, jenkins] = await Promise.all([
    fetchBitbucketStatus(),
    jenkinsConfigured() ? jenkinsHealth() : undefined,
  ]);
  const checkedAt = new Date().toISOString();
  const checkedAtLocal = toLocalTime(checkedAt)!;
  return {
    checked_at: checkedAt,
    checked_at_local: checkedAtLocal,
    assessment: assess(bitbucket, jenkins, checkedAtLocal),
    bitbucket,
    jenkins,
  };
}

/** Why Jenkins would not run a build queued now, or null when it would. */
export function jenkinsNotAcceptingBuilds(health: JenkinsHealth): string | null {
  if (!health.reachable) return health.error ?? "Jenkins is unreachable.";
  if (health.quieting_down) return "Jenkins is quieting down for a restart and holds new builds in the queue until it comes back.";
  if (health.labels_without_nodes?.length) {
    return `No online node serves the label(s) ${health.labels_without_nodes.join(", ")}; queued builds are stuck until agents come back.`;
  }
  if (health.nodes && !health.nodes.some((node) => node.online && node.executors.total > 0)) return "Jenkins has no online agents to run a build.";
  return null;
}

/** Whether a build Jenkins calls "building" is on an executor or still waiting in the queue for one. */
export async function buildExecution(job: string, number: number): Promise<BuildExecution> {
  const queue = await jenkinsJson<RawQueue>("/queue/api/json?tree=items[inQueueSince,why,stuck,task[name,url]]");
  const item = (queue?.items ?? []).map(compactQueueItem).find((entry) => belongsTo(entry, job, number));
  return item ? { state: "waiting_for_agent", reason: item.reason, waiting_minutes: item.waiting_minutes } : { state: "running" };
}

export async function jenkinsHealth(): Promise<JenkinsHealth> {
  const url = jenkinsBaseUrl();
  try {
    const [root, computers, queue] = await Promise.all([
      jenkinsJson<RawRoot>("/api/json?tree=quietingDown"),
      jenkinsJson<RawComputerSet>("/computer/api/json?tree=busyExecutors,totalExecutors,computer[displayName,offline,offlineCauseReason,numExecutors,executors[idle]]"),
      jenkinsJson<RawQueue>("/queue/api/json?tree=items[inQueueSince,why,stuck,task[name,url]]"),
    ]);
    const items = (queue?.items ?? []).map(compactQueueItem).sort((a, b) => b.waiting_minutes - a.waiting_minutes);
    return {
      url,
      reachable: true,
      quieting_down: root?.quietingDown ?? false,
      executors: { busy: computers?.busyExecutors ?? 0, total: computers?.totalExecutors ?? 0 },
      queue: { depth: items.length, oldest_wait_minutes: items[0]?.waiting_minutes ?? null, items },
      nodes: (computers?.computer ?? []).map(compactNode),
      labels_without_nodes: labelsWithoutNodes(items),
    };
  } catch (error) {
    return { url, reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function assess(bitbucket: BitbucketStatus, jenkins: JenkinsHealth | undefined, checkedAt: string): HealthAssessment {
  const findings = [...bitbucketFindings(bitbucket), ...(jenkins ? jenkinsFindings(jenkins) : [])];
  const status = findings.some((finding) => DOWN_CONDITIONS.has(finding.condition)) ? "down" : findings.length ? "degraded" : "ok";
  return { status, summary: `As of ${checkedAt}, ${summarize(status, bitbucket, jenkins, findings)}`, findings };
}

const DOWN_CONDITIONS = new Set(["jenkins_unreachable", "no_nodes_for_label", "no_agents"]);

function bitbucketFindings(bitbucket: BitbucketStatus): HealthFinding[] {
  if (bitbucket.indicator === "none") return [];
  const incidents = bitbucket.open_incidents.map((incident) => `${incident.name} (${incident.impact}, ${incident.url})`).join("; ");
  return [{
    condition: "bitbucket_incident",
    evidence: `${bitbucket.description}. ${incidents || bitbucket.degraded_components.map((c) => `${c.name}: ${c.status}`).join(", ")}`,
    advice: "Pushes, PR statuses and API calls may fail or lag until Atlassian resolves it. Nothing on our side to fix; wait it out.",
  }];
}

function jenkinsFindings(jenkins: JenkinsHealth): HealthFinding[] {
  if (!jenkins.reachable) {
    return [{ condition: "jenkins_unreachable", evidence: jenkins.error ?? "", advice: "Check the VPN first, then whether the Jenkins host is up. Nothing else can be read until it answers." }];
  }
  const findings: HealthFinding[] = [];
  const queue = jenkins.queue!;
  const nodes = jenkins.nodes ?? [];

  if (jenkins.labels_without_nodes?.length) {
    const stuck = queue.items.filter((item) => item.stuck);
    findings.push({
      condition: "no_nodes_for_label",
      evidence: `No online node serves label ${jenkins.labels_without_nodes.join(", ")}; ${stuck.length} build(s) stuck in the queue, oldest ${formatWait(queue.oldest_wait_minutes ?? 0)}`,
      advice: "Builds needing that label cannot start until agents come back. If the label is served by cloud workers, they are not being provisioned; that is an infrastructure problem, and retriggering will not help.",
    });
  }
  if (jenkins.quieting_down) {
    findings.push({
      condition: "quieting_down",
      evidence: `Jenkins is quieting down; ${queue.depth} item(s) queued`,
      advice: "A restart is pending. Builds queue until Jenkins is back; do not retrigger, and check again in a few minutes.",
    });
  }
  const offline = nodes.filter((node) => !node.online);
  if (offline.length) {
    findings.push({
      condition: "agents_offline",
      evidence: offline.map((node) => `${node.name}: ${node.offline_reason || "no reason given"}`).join("; "),
      advice: "Reduced capacity. If a reason names a cause (disk, connection, manual), that is the thing to fix.",
    });
  }
  const online = nodes.filter((node) => node.online && node.executors.total > 0);
  if (!jenkins.labels_without_nodes?.length && online.length === 0) {
    findings.push({ condition: "no_agents", evidence: "No online node has an executor", advice: "Nothing can run. Agents need to come back before any build starts." });
  }
  const saturated = jenkins.executors!.total > 0 && jenkins.executors!.busy >= jenkins.executors!.total;
  if (!jenkins.labels_without_nodes?.length && saturated && queue.depth > 0) {
    findings.push({
      condition: "capacity",
      evidence: `${jenkins.executors!.busy}/${jenkins.executors!.total} executors busy, ${queue.depth} queued, oldest ${formatWait(queue.oldest_wait_minutes ?? 0)}`,
      advice: "Capacity, not failure. Builds will start as executors free up; a long oldest wait means a backlog, not a broken build.",
    });
  }
  const unexplained = queue.items.filter((item) => item.waiting_minutes >= LONG_WAIT_MINUTES && !findings.length);
  if (unexplained.length) {
    findings.push({
      condition: "unrecognised",
      evidence: unexplained.map((item) => `${item.task}: ${item.reason} (${formatWait(item.waiting_minutes)})`).join("; "),
      advice: "Builds have waited a long time for a reason this check does not recognise. Read the reasons above; they are Jenkins's own words.",
    });
  }
  return findings;
}

function summarize(status: HealthStatus, bitbucket: BitbucketStatus, jenkins: JenkinsHealth | undefined, findings: HealthFinding[]): string {
  if (status === "ok") {
    if (!jenkins) return `Bitbucket is ${bitbucket.description.toLowerCase()}.`;
    const executors = jenkins.executors!;
    const running = executors.busy === 1 ? "1 build running" : `${executors.busy} builds running`;
    const queued = jenkins.queue!.depth ? `${jenkins.queue!.depth} queued` : "nothing queued";
    return `situation normal: ${running}, ${queued}, all ${jenkins.nodes!.length} agents online, Bitbucket ${bitbucket.description.toLowerCase()}.`;
  }
  const headline = findings[0];
  const rest = findings.length > 1 ? ` Plus ${findings.length - 1} more finding(s).` : "";
  return `CI is ${status}: ${headline.evidence}.${rest}`;
}

function compactQueueItem(item: RawQueueItem): QueueItem {
  return {
    task: item.task?.name ?? "unknown",
    url: item.task?.url,
    queued_since_local: toLocalTime(new Date(item.inQueueSince).toISOString())!,
    waiting_minutes: Math.round((Date.now() - item.inQueueSince) / 60000),
    reason: item.why ?? "",
    stuck: item.stuck ?? false,
  };
}

function compactNode(computer: RawComputer): JenkinsNode {
  const executors = computer.executors ?? [];
  return {
    name: computer.displayName,
    online: !computer.offline,
    offline_reason: computer.offline ? computer.offlineCauseReason : undefined,
    executors: { busy: executors.filter((executor) => !executor.idle).length, total: computer.numExecutors },
  };
}

function labelsWithoutNodes(items: QueueItem[]): string[] {
  const labels = items.map((item) => OFFLINE_LABEL.exec(item.reason)?.[1]).filter((label): label is string => Boolean(label));
  return [...new Set(labels)];
}

function belongsTo(item: QueueItem, job: string, number: number): boolean {
  return Boolean(item.url?.includes(`${job.replace(/^\//, "")}/${number}/`));
}

function formatWait(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
