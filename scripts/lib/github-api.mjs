/** Small, dependency-free GitHub REST/GraphQL helpers used by the automation scripts. */
import fs from "node:fs";

export function repositoryFromEnv(env = process.env) {
  const fullName = String(env.GITHUB_REPOSITORY || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw new Error("GITHUB_REPOSITORY must be OWNER/REPO.");
  }
  const [owner, name] = fullName.split("/");
  return { owner, name, fullName };
}

export function apiBase(env = process.env) {
  return String(env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
}

export function graphqlUrl(env = process.env) {
  if (env.GITHUB_GRAPHQL_URL) return String(env.GITHUB_GRAPHQL_URL).replace(/\/+$/, "");
  return `${apiBase(env).replace(/\/api\/v3$/, "/api")}/graphql`;
}

export function githubToken(env = process.env, key = "GITHUB_TOKEN") {
  const token = String(env[key] || "").trim();
  if (!token) throw new Error(`${key} is not configured.`);
  return token;
}

export function parseNextLink(header) {
  const next = String(header || "")
    .split(",")
    .map((part) => part.trim())
    .find((part) => /rel\s*=\s*"next"/i.test(part));
  return next?.match(/<([^>]+)>/)?.[1] || null;
}

/**
 * Call a GitHub REST endpoint. `pathOrUrl` may be an absolute URL (for Link
 * headers and GraphQL) or an API path beginning with `/`.
 */
export async function githubRequest(env, pathOrUrl, options = {}) {
  const {
    method = "GET",
    body,
    token,
    headers = {},
    fetchImpl = globalThis.fetch,
    allow = [],
  } = options;
  const authToken = token || githubToken(env);
  const url = /^https?:\/\//i.test(pathOrUrl)
    ? pathOrUrl
    : `${apiBase(env)}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
  const response = await fetchImpl(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${authToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = typeof response.text === "function" ? await response.text() : "";
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (!response.ok && !allow.includes(response.status)) {
        throw new Error(`GitHub API ${method} ${pathOrUrl} failed (HTTP ${response.status}).`);
      }
    }
  }
  if (!response.ok && !allow.includes(response.status)) {
    const detail = typeof data?.message === "string" ? `: ${data.message}` : "";
    throw new Error(`GitHub API ${method} ${pathOrUrl} failed (HTTP ${response.status})${detail}`);
  }
  return { response, data, text };
}

/** Follow GitHub's `Link: rel="next"` pagination with a hard page cap. */
export async function githubPages(env, pathOrUrl, options = {}) {
  const { extract = (data) => (Array.isArray(data) ? data : []), maxPages = 20, ...requestOptions } = options;
  let url = pathOrUrl;
  const values = [];
  for (let page = 0; page < maxPages; page += 1) {
    const { response, data } = await githubRequest(env, url, requestOptions);
    values.push(...extract(data));
    const next = parseNextLink(response.headers?.get?.("link"));
    if (!next) break;
    url = next;
  }
  return values;
}

export function readGithubEvent(env = process.env) {
  if (!env.GITHUB_EVENT_PATH) throw new Error("GITHUB_EVENT_PATH is not configured.");
  return JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
}
