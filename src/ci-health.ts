import { jenkinsBaseUrl, jenkinsConfigured, jenkinsJson } from "./jenkins-client.js";
import { BitbucketStatus, fetchBitbucketStatus } from "./bitbucket-status.js";

export interface JenkinsHealth {
  url: string;
  reachable: boolean;
  error?: string;
  quieting_down?: boolean;
  executors?: { busy: number; total: number };
  queue?: { depth: number; oldest_wait_seconds: number | null };
  agents?: { online: number; offline: { name: string; reason: string }[] };
}

export interface CiHealth {
  checked_at: string;
  bitbucket: BitbucketStatus;
  jenkins?: JenkinsHealth;
}

interface RawRoot {
  quietingDown: boolean;
}

interface RawComputerSet {
  busyExecutors: number;
  totalExecutors: number;
  computer: { displayName: string; offline: boolean; offlineCauseReason: string }[];
}

interface RawQueue {
  items: { inQueueSince: number }[];
}

/** Bitbucket's status page plus, when Jenkins is configured, whether it is up and taking builds. */
export async function ciHealth(): Promise<CiHealth> {
  const [bitbucket, jenkins] = await Promise.all([
    fetchBitbucketStatus(),
    jenkinsConfigured() ? jenkinsHealth() : undefined,
  ]);
  return { checked_at: new Date().toISOString(), bitbucket, jenkins };
}

/** Why Jenkins would not run a build queued now, or null when it would. */
export function jenkinsNotAcceptingBuilds(health: JenkinsHealth): string | null {
  if (!health.reachable) return health.error ?? "Jenkins is unreachable.";
  if (health.quieting_down) return "Jenkins is quieting down for a restart and holds new builds in the queue until it comes back.";
  if (health.agents && health.agents.online === 0) return "Jenkins has no online agents to run a build.";
  return null;
}

export async function jenkinsHealth(): Promise<JenkinsHealth> {
  const url = jenkinsBaseUrl();
  try {
    const [root, computers, queue] = await Promise.all([
      jenkinsJson<RawRoot>("/api/json?tree=quietingDown"),
      jenkinsJson<RawComputerSet>("/computer/api/json?tree=busyExecutors,totalExecutors,computer[displayName,offline,offlineCauseReason]"),
      jenkinsJson<RawQueue>("/queue/api/json?tree=items[inQueueSince]"),
    ]);
    return {
      url,
      reachable: true,
      quieting_down: root?.quietingDown ?? false,
      executors: { busy: computers?.busyExecutors ?? 0, total: computers?.totalExecutors ?? 0 },
      queue: describeQueue(queue?.items ?? []),
      agents: describeAgents(computers?.computer ?? []),
    };
  } catch (error) {
    return { url, reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function describeQueue(items: { inQueueSince: number }[]): JenkinsHealth["queue"] {
  const oldest = items.length ? Math.min(...items.map((item) => item.inQueueSince)) : null;
  return {
    depth: items.length,
    oldest_wait_seconds: oldest === null ? null : Math.round((Date.now() - oldest) / 1000),
  };
}

function describeAgents(computers: RawComputerSet["computer"]): JenkinsHealth["agents"] {
  const offline = computers.filter((computer) => computer.offline);
  return {
    online: computers.length - offline.length,
    offline: offline.map((computer) => ({ name: computer.displayName, reason: computer.offlineCauseReason })),
  };
}
