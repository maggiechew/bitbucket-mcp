interface JenkinsAuth {
  baseUrl: string;
  user: string;
  apiToken: string;
}

const REQUEST_TIMEOUT_MS = 60_000;

export function jenkinsConfigured(): boolean {
  return Boolean(process.env.JENKINS_URL && process.env.JENKINS_API_TOKEN && jenkinsUser());
}

// Jenkins usually knows people by the same address as Bitbucket does, so the Bitbucket email
// stands in unless a distinct Jenkins username is given.
function jenkinsUser(): string | undefined {
  return process.env.JENKINS_USER || process.env.BITBUCKET_EMAIL;
}

function getAuth(): JenkinsAuth {
  const baseUrl = process.env.JENKINS_URL;
  const user = jenkinsUser();
  const apiToken = process.env.JENKINS_API_TOKEN;

  if (!baseUrl || !user || !apiToken) {
    throw new Error(
      "JENKINS_URL and JENKINS_API_TOKEN environment variables are required (JENKINS_USER defaults to BITBUCKET_EMAIL)",
    );
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), user, apiToken };
}

export function jenkinsBaseUrl(): string {
  return getAuth().baseUrl;
}

/**
 * The Jenkins multibranch folder for a repository: its entry in JENKINS_JOBS (`slug=folder,...`)
 * when one is listed, otherwise the slug itself.
 * @param repoSlug the Bitbucket repository slug
 * @return the folder name as it appears in Jenkins URLs
 */
export function jenkinsFolderFor(repoSlug: string): string {
  return jenkinsFolderMap().get(repoSlug) ?? repoSlug;
}

function jenkinsFolderMap(): Map<string, string> {
  const pairs = (process.env.JENKINS_JOBS ?? "")
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => pair.split("=").map((part) => part.trim()))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts.every(Boolean));
  return new Map(pairs);
}

function authHeader(auth: JenkinsAuth): string {
  return "Basic " + Buffer.from(`${auth.user}:${auth.apiToken}`).toString("base64");
}

function resolveUrl(auth: JenkinsAuth, pathOrUrl: string): string {
  return pathOrUrl.startsWith("http") ? pathOrUrl : `${auth.baseUrl}${pathOrUrl}`;
}

function unreachableMessage(auth: JenkinsAuth, error: unknown): string {
  const cause = error instanceof Error ? error.message : String(error);
  return `Cannot reach Jenkins at ${auth.baseUrl} (${cause}). If it lives on an internal network, connect the VPN and try again.`;
}

function refusedMessage(auth: JenkinsAuth, status: number): string {
  return `Jenkins refused the credentials (HTTP ${status}). Create an API token at ${auth.baseUrl}/me/security and set JENKINS_USER and JENKINS_API_TOKEN.`;
}

/** A Jenkins build URL (absolute or relative) as the path Jenkins uses to name it: `job/folder/job/name/42/`. */
export function buildPathOf(url: string): string {
  return url
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^\/+/, "")
    .replace(/\/*$/, "/");
}

/** The absolute URL of a Jenkins build from its job path and number. */
export function buildUrlFor(job: string, number: number): string {
  return `${jenkinsBaseUrl()}${job}/${number}/`;
}

async function fetchFromJenkins(path: string, accept: string, method = "GET"): Promise<Response | null> {
  const auth = getAuth();
  let response: Response;
  try {
    response = await fetch(resolveUrl(auth, path), {
      method,
      headers: { Authorization: authHeader(auth), Accept: accept },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(unreachableMessage(auth, error));
  }

  if (response.status === 404) return null;
  if (response.status === 401 || response.status === 403) throw new Error(refusedMessage(auth, response.status));
  if (!response.ok) throw new Error(`Jenkins ${method} ${path} returned ${response.status}: ${await response.text()}`);

  return response;
}

/** GET a Jenkins JSON endpoint. Returns null when Jenkins answers 404. */
export async function jenkinsJson<T>(path: string): Promise<T | null> {
  const response = await fetchFromJenkins(path, "application/json");
  return response ? ((await response.json()) as T) : null;
}

/** GET a Jenkins plain-text endpoint such as consoleText. Returns null when Jenkins answers 404. */
export async function jenkinsText(path: string): Promise<string | null> {
  const response = await fetchFromJenkins(path, "text/plain");
  return response ? response.text() : null;
}

export interface ProgressiveText {
  text: string;
  size_bytes: number;
  more: boolean;
}

const CONSOLE_NOTE = /\x1b\[8mha:\/\/\/\/[A-Za-z0-9+/=]+\x1b\[0m/g;

/** Removes the serialized ConsoleNote blobs that progressiveText leaves on `[Pipeline]` lines, and CRs. */
export function stripConsoleNotes(text: string): string {
  return text.replace(CONSOLE_NOTE, "").replace(/\r/g, "");
}

/**
 * The size of a progressiveText log (a build's `logText/progressiveText` or a step's
 * `log/logText/progressiveText`) without reading it: a HEAD for X-Text-Size.
 * @param path the progressiveText endpoint, without query
 * @return the byte size and whether Jenkins says more is coming, or null when Jenkins answers 404
 */
export async function jenkinsLogSize(path: string): Promise<{ size_bytes: number; more: boolean } | null> {
  const response = await fetchFromJenkins(`${path}?start=0`, "text/plain", "HEAD");
  return response ? sizeHeaders(response) : null;
}

/**
 * The part of a progressiveText log from a byte offset on, ConsoleNote blobs stripped.
 * @param path the progressiveText endpoint, without query
 * @param start the raw byte offset to read from; past the end Jenkins restarts at 0, so callers clamp it
 * @return the text with the log's size at read time, or null when Jenkins answers 404
 */
export async function jenkinsLogFrom(path: string, start: number): Promise<ProgressiveText | null> {
  const response = await fetchFromJenkins(`${path}?start=${Math.max(0, start)}`, "text/plain");
  if (!response) return null;
  return { text: stripConsoleNotes(await response.text()), ...sizeHeaders(response) };
}

/**
 * The last `bytes` of a progressiveText log in two requests: a HEAD for the size, a GET from size − bytes.
 * @return the tail text and the size it was read against, or null when the log does not exist
 */
export async function jenkinsLogTail(path: string, bytes: number): Promise<ProgressiveText | null> {
  const size = await jenkinsLogSize(path);
  if (!size) return null;
  if (size.size_bytes === 0) return { text: "", ...size };
  return jenkinsLogFrom(path, size.size_bytes - bytes);
}

function sizeHeaders(response: Response): { size_bytes: number; more: boolean } {
  return {
    size_bytes: Number(response.headers.get("x-text-size") ?? 0),
    more: response.headers.get("x-more-data") === "true",
  };
}

/** POST to a Jenkins endpoint with no body. Returns the Location header, which names the queue item for a build request. */
export async function jenkinsPost(path: string): Promise<string | undefined> {
  const response = await fetchFromJenkins(path, "application/json", "POST");
  if (!response) throw new Error(`Jenkins has nothing at ${path}.`);
  return response.headers.get("location") ?? undefined;
}
