const BASE_URL = "https://api.bitbucket.org/2.0";

interface BitbucketAuth {
  email: string;
  apiToken: string;
}

export interface PaginatedResponse<T> {
  size?: number;
  page?: number;
  pagelen?: number;
  next?: string;
  previous?: string;
  values: T[];
}

function getAuth(): BitbucketAuth {
  const email = process.env.BITBUCKET_EMAIL;
  const apiToken = process.env.BITBUCKET_API_TOKEN;

  if (!email || !apiToken) {
    throw new Error(
      "BITBUCKET_EMAIL and BITBUCKET_API_TOKEN environment variables are required",
    );
  }

  return { email, apiToken };
}

function authHeader(): string {
  const { email, apiToken } = getAuth();
  return "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
}

export async function bitbucketRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    accept?: string;
  } = {},
): Promise<T> {
  const { method = "GET", body, accept = "application/json" } = options;

  const headers: Record<string, string> = {
    "Authorization": authHeader(),
    "Accept": accept,
  };

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bitbucket API ${method} ${path} returned ${response.status}: ${text}`);
  }

  if (accept === "text/plain") {
    return (await response.text()) as T;
  }

  return (await response.json()) as T;
}

export async function bitbucketPaginated<T>(
  path: string,
  params: { page?: number; pagelen?: number } = {},
): Promise<PaginatedResponse<T>> {
  const searchParams = new URLSearchParams();
  if (params.page) searchParams.set("page", String(params.page));
  if (params.pagelen) searchParams.set("pagelen", String(params.pagelen));

  const query = searchParams.toString();
  const fullPath = query ? `${path}?${query}` : path;

  return bitbucketRequest<PaginatedResponse<T>>(fullPath);
}
