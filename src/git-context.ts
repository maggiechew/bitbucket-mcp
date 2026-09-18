import { execSync } from "node:child_process";

interface GitContext {
  workspace: string;
  repoSlug: string;
}

export function detectGitContext(cwd?: string): GitContext | null {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      encoding: "utf-8",
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    return parseRemoteUrl(remoteUrl);
  } catch {
    return null;
  }
}

function parseRemoteUrl(url: string): GitContext | null {
  // SSH: git@bitbucket.org:workspace/repo.git
  const sshMatch = url.match(/bitbucket\.org[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (sshMatch) {
    return { workspace: sshMatch[1], repoSlug: sshMatch[2] };
  }

  // HTTPS: https://bitbucket.org/workspace/repo.git
  const httpsMatch = url.match(/bitbucket\.org\/([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (httpsMatch) {
    return { workspace: httpsMatch[1], repoSlug: httpsMatch[2] };
  }

  return null;
}

export function resolveWorkspace(explicitWorkspace?: string): string {
  if (explicitWorkspace) return explicitWorkspace;

  const detected = detectGitContext();
  if (!detected) {
    throw new Error(
      "Could not detect workspace from git remote. " +
        "Pass workspace explicitly, or run from a directory with a Bitbucket remote.",
    );
  }
  return detected.workspace;
}

export function resolveContext(
  explicitWorkspace?: string,
  explicitRepoSlug?: string,
): { workspace: string; repoSlug: string } {
  if (explicitWorkspace && explicitRepoSlug) {
    return { workspace: explicitWorkspace, repoSlug: explicitRepoSlug };
  }

  const detected = detectGitContext();
  if (!detected) {
    throw new Error(
      "Could not detect workspace/repo from git remote. " +
        "Pass workspace and repo_slug explicitly, or run from a directory with a Bitbucket remote.",
    );
  }

  return {
    workspace: explicitWorkspace || detected.workspace,
    repoSlug: explicitRepoSlug || detected.repoSlug,
  };
}
