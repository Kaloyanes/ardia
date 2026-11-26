import { readGitHubJson, type GitHubJsonAnswer } from "../lib/appUpdate";

const GITHUB_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

export async function fetchGitHubJson(url: string, signal: AbortSignal): Promise<GitHubJsonAnswer> {
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers: GITHUB_HEADERS, credentials: "omit", cache: "no-store", signal });
  } catch {
    return { kind: "unreachable" };
  }
  if (response.status === 404) return { kind: "missing" };
  if (response.status !== 200) return { kind: "refused" };
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { kind: "unreachable" };
  }
  const body = readGitHubJson(text);
  return body === undefined ? { kind: "refused" } : { kind: "json", body };
}
