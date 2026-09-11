const STATUS_PAGE = "https://bitbucket.status.atlassian.com/api/v2";
const INCIDENT_HISTORY = 50;

export interface StatusIncident {
  name: string;
  status: string;
  impact: string;
  started_at: string;
  resolved_at: string | null;
  url: string;
}

export interface BitbucketStatus {
  indicator: string;
  description: string;
  degraded_components: { name: string; status: string }[];
  open_incidents: StatusIncident[];
}

interface RawIncident {
  name: string;
  status: string;
  impact: string;
  created_at: string;
  resolved_at: string | null;
  shortlink: string;
}

interface RawSummary {
  status: { indicator: string; description: string };
  components: { name: string; status: string }[];
  incidents: RawIncident[];
}

/** Bitbucket Cloud's public status page: overall indicator, components not operational, open incidents. */
export async function fetchBitbucketStatus(): Promise<BitbucketStatus> {
  const summary = await statusPage<RawSummary>("summary.json");
  return {
    indicator: summary.status.indicator,
    description: summary.status.description,
    degraded_components: summary.components.filter((component) => component.status !== "operational"),
    open_incidents: summary.incidents.map(compactIncident),
  };
}

/** Incidents on Bitbucket's status page that overlap a time window, from the most recent 50. */
export async function bitbucketIncidentsBetween(start: Date, end: Date): Promise<StatusIncident[]> {
  const history = await statusPage<{ incidents: RawIncident[] }>("incidents.json");
  return history.incidents
    .slice(0, INCIDENT_HISTORY)
    .filter((incident) => overlaps(incident, start, end))
    .map(compactIncident);
}

/** One line for an error message when Bitbucket is reporting trouble, or null when it is not. */
export async function bitbucketStatusNote(): Promise<string | null> {
  try {
    const status = await fetchBitbucketStatus();
    if (status.indicator === "none") return null;
    const incidents = status.open_incidents.map((incident) => incident.name).join("; ");
    return `Bitbucket's status page reports: ${status.description}${incidents ? ` (${incidents})` : ""}.`;
  } catch {
    return null;
  }
}

function overlaps(incident: RawIncident, start: Date, end: Date): boolean {
  const from = new Date(incident.created_at);
  const to = incident.resolved_at ? new Date(incident.resolved_at) : new Date();
  return from <= end && to >= start;
}

function compactIncident(incident: RawIncident): StatusIncident {
  return {
    name: incident.name,
    status: incident.status,
    impact: incident.impact,
    started_at: incident.created_at,
    resolved_at: incident.resolved_at,
    url: incident.shortlink,
  };
}

async function statusPage<T>(file: string): Promise<T> {
  const response = await fetch(`${STATUS_PAGE}/${file}`);
  if (!response.ok) throw new Error(`Bitbucket status page returned ${response.status}.`);
  return (await response.json()) as T;
}
