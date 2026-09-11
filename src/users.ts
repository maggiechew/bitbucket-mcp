import { bitbucketRequest, bitbucketAllPages } from "./client.js";

export interface BitbucketUser {
  uuid: string;
  display_name: string;
  nickname?: string;
  account_id?: string;
}

interface WorkspaceMembership {
  user: BitbucketUser;
}

const UUID_PATTERN = /^\{?[0-9a-f-]{36}\}?$/i;

let currentUserCache: BitbucketUser | undefined;

function compactUser(user: BitbucketUser): BitbucketUser {
  return {
    uuid: user.uuid,
    display_name: user.display_name,
    nickname: user.nickname,
    account_id: user.account_id,
  };
}

export async function getCurrentUser(): Promise<BitbucketUser> {
  if (!currentUserCache) {
    currentUserCache = compactUser(await bitbucketRequest<BitbucketUser>("/user"));
  }
  return currentUserCache;
}

export async function listWorkspaceMembers(workspace: string): Promise<BitbucketUser[]> {
  const result = await bitbucketAllPages<WorkspaceMembership>(
    `/workspaces/${workspace}/members`,
    new URLSearchParams(),
    500,
  );
  return result.values.map((m) => compactUser(m.user));
}

export async function findUsers(workspace: string, query: string): Promise<BitbucketUser[]> {
  const needle = query.toLowerCase();
  const members = await listWorkspaceMembers(workspace);
  return members.filter((u) =>
    u.display_name.toLowerCase().includes(needle) ||
    (u.nickname ?? "").toLowerCase().includes(needle),
  );
}

export async function resolveAuthorUuid(workspace: string, author: string): Promise<string> {
  if (author === "me") {
    return (await getCurrentUser()).uuid;
  }

  if (UUID_PATTERN.test(author)) {
    return author.startsWith("{") ? author : `{${author}}`;
  }

  const matches = await findUsers(workspace, author);
  if (matches.length === 1) {
    return matches[0].uuid;
  }

  if (matches.length === 0) {
    throw new Error(`No workspace member matches "${author}". Use findUser to search.`);
  }

  const names = matches.map((u) => `${u.display_name} (${u.uuid})`).join(", ");
  throw new Error(
    `"${author}" matches ${matches.length} workspace members: ${names}. Pass a uuid or a more specific name.`,
  );
}
