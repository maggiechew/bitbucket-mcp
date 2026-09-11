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

export type MatchStrength = "exact" | "word" | "prefix" | "substring";

export interface UserLookup {
  name: string;
  resolved: BitbucketUser | null;
  candidates: (BitbucketUser & { match: MatchStrength })[];
}

/**
 * What the server decides for each name: the one member it resolves to, or null when the
 * strongest matches tie, plus every candidate with how strongly it matched. The write tools
 * and list filters resolve names with exactly this rule.
 */
export async function lookupUsers(workspace: string, names: string[]): Promise<UserLookup[]> {
  const members = await listWorkspaceMembers(workspace);
  return names.map((name) => describeLookup(members, name));
}

function describeLookup(members: BitbucketUser[], name: string): UserLookup {
  const needle = name.toLowerCase();
  const candidates = members
    .map((member) => ({ member, tier: matchTier(member, needle) }))
    .filter(({ tier }) => tier >= 0)
    .sort((a, b) => a.tier - b.tier)
    .map(({ member, tier }) => ({ ...member, match: MATCH_STRENGTHS[tier] }));
  const strongest = candidates.filter((candidate) => candidate.match === candidates[0]?.match);
  return { name, resolved: strongest.length === 1 ? candidates[0] : null, candidates };
}

export async function resolveAuthorUuid(workspace: string, author: string): Promise<string> {
  const [uuid] = await resolveUserUuids(workspace, [author]);
  return uuid;
}

/**
 * The uuid of each named user, resolving "me", a uuid, or a name fragment that matches exactly one
 * workspace member. Reads the member list once for the whole batch.
 *
 * @throws when a name matches no member or more than one; the message lists the candidates
 */
export async function resolveUserUuids(workspace: string, users: string[]): Promise<string[]> {
  const needsLookup = users.some((user) => user !== "me" && !UUID_PATTERN.test(user));
  const members = needsLookup ? await listWorkspaceMembers(workspace) : [];
  return Promise.all(users.map((user) => resolveOne(user, members)));
}

async function resolveOne(user: string, members: BitbucketUser[]): Promise<string> {
  if (user === "me") return (await getCurrentUser()).uuid;
  if (UUID_PATTERN.test(user)) return user.startsWith("{") ? user : `{${user}}`;

  const matches = bestMatches(members, user);
  if (matches.length === 1) return matches[0].uuid;
  if (matches.length === 0) throw new Error(`No workspace member matches "${user}". Use findUsers to see candidates.`);

  const names = matches.map((u) => `${u.display_name} (${u.uuid})`).join(", ");
  throw new Error(`"${user}" matches ${matches.length} workspace members: ${names}. Pass a uuid or a more specific name.`);
}

// Ordered from the strongest reading of a name to the weakest: the whole name, one whole word
// of it ("an" is An before it is Andrew), a word that starts with it ("stan" is Stanley before
// it is Tristan), then any substring.
const MATCH_STRENGTHS: MatchStrength[] = ["exact", "word", "prefix", "substring"];
const MATCH_TIERS: ((name: string, needle: string) => boolean)[] = [
  (name, needle) => name === needle,
  (name, needle) => words(name).includes(needle),
  (name, needle) => words(name).some((word) => word.startsWith(needle)),
  (name, needle) => name.includes(needle),
];

function words(name: string): string[] {
  return name.split(/[\s._-]+/);
}

function bestMatches(members: BitbucketUser[], query: string): BitbucketUser[] {
  const needle = query.toLowerCase();
  const tiers = members.map((member) => matchTier(member, needle));
  const best = Math.min(...tiers.filter((tier) => tier >= 0));
  return members.filter((_, index) => tiers[index] === best);
}

function matchTier(member: BitbucketUser, needle: string): number {
  const names = [member.display_name, member.nickname ?? ""].map((name) => name.toLowerCase());
  return MATCH_TIERS.findIndex((matches) => names.some((name) => matches(name, needle)));
}
