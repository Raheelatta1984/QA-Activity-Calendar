/**
 * GitHub connector — publishes Building handovers into the *target*
 * application's repository via the GitHub Contents API.
 *
 * Ported from the source app's `lib/github-enhancements.ts`, but instead of one
 * hard-coded repo/path, every application row carries its own connector
 * settings (repo, branch, handover directory) and the NAME of the environment
 * variable holding its token. Tokens are never persisted.
 */

const GITHUB_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

export type ConnectorConfig = {
  repo: string | null;
  branch: string;
  handoverDir: string;
  tokenEnv: string | null;
};

export type PublishResult = { filePath: string; url: string };

/**
 * Resolve the connector token. `tokenEnv` names an environment variable
 * (e.g. ACME_PORTAL_TOKEN); the shared GITHUB_TOKEN is the fallback. Returns
 * null when no token is configured — never guesses.
 */
export function resolveToken(connector: ConnectorConfig): string | null {
  const names = [connector.tokenEnv?.trim(), "GITHUB_TOKEN"].filter(Boolean) as string[];
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export function connectorSummary(connector: ConnectorConfig): {
  repo: string | null;
  branch: string;
  handoverDir: string;
  tokenEnv: string | null;
  tokenPresent: boolean;
} {
  return {
    repo: connector.repo,
    branch: connector.branch,
    handoverDir: connector.handoverDir,
    tokenEnv: connector.tokenEnv,
    tokenPresent: Boolean(resolveToken(connector)),
  };
}

export function validateConnector(connector: ConnectorConfig): string | null {
  if (!connector.repo) return "This application has no GitHub repository configured — it runs in local-vault mode.";
  if (!GITHUB_NAME_RE.test(connector.repo)) return "GitHub repository must look like owner/name.";
  if (!resolveToken(connector)) {
    return `No GitHub token found${connector.tokenEnv ? ` (expected env ${connector.tokenEnv})` : ""}. Set it on the server — tokens are never stored in the database.`;
  }
  return null;
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Verify the connector can see the repository. Cheap read; never throws. */
export async function testConnector(connector: ConnectorConfig): Promise<{ ok: boolean; detail: string }> {
  const problem = validateConnector(connector);
  if (problem) return { ok: false, detail: problem };
  const token = resolveToken(connector) as string;
  try {
    const response = await fetch(`https://api.github.com/repos/${connector.repo}`, {
      headers: apiHeaders(token),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return { ok: true, detail: `Connected to ${connector.repo}.` };
    if (response.status === 401) return { ok: false, detail: "GitHub rejected the token (401). Check expiry and scopes." };
    if (response.status === 404) return { ok: false, detail: "Repository not found for this token (404). Check the repo path and token scope." };
    return { ok: false, detail: `GitHub responded with HTTP ${response.status}.` };
  } catch (error) {
    return { ok: false, detail: `GitHub request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Create or update `handoverDir/<filename>` on the configured branch.
 * Throws with a reviewable message on failure; callers surface it verbatim.
 */
export async function publishHandover(
  connector: ConnectorConfig,
  filename: string,
  content: string
): Promise<PublishResult> {
  const problem = validateConnector(connector);
  if (problem) throw new Error(problem);
  if (!/^ENH-[0-9]+-[a-z0-9-]+\.md$/i.test(filename)) throw new Error(`Invalid handover filename: ${filename}`);
  const token = resolveToken(connector) as string;
  const dir = connector.handoverDir.replace(/^\/+|\/+$/g, "") || "future-enhancements";
  const filePath = `${dir}/${filename}`;
  const url = `https://api.github.com/repos/${connector.repo}/contents/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  const previous = await fetch(`${url}?ref=${encodeURIComponent(connector.branch)}`, {
    headers: apiHeaders(token),
    cache: "no-store",
  }).catch((error) => {
    throw new Error(`GitHub could not be reached (${error instanceof Error ? error.message : "network error"}). Check server network access and the configured token.`);
  });
  let sha: string | undefined;
  if (previous.ok) {
    const file = (await previous.json()) as { type?: string; sha?: string };
    if (file.type !== "file" || !file.sha) throw new Error("The GitHub handover path is not a file.");
    sha = file.sha;
  } else if (previous.status !== 404) {
    throw new Error(`GitHub could not read the handover (HTTP ${previous.status}).`);
  }

  const response = await fetch(url, {
    method: "PUT",
    headers: { ...apiHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `docs: publish ${filename} via Enhancements Hub`,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch: connector.branch,
      ...(sha ? { sha } : {}),
    }),
  }).catch((error) => {
    throw new Error(`GitHub could not be reached while publishing (${error instanceof Error ? error.message : "network error"}).`);
  });
  if (!response.ok) {
    throw new Error(
      `GitHub could not publish the handover (HTTP ${response.status}). Check repository permissions and branch protection.`
    );
  }
  const payload = (await response.json()) as { content?: { html_url?: string } };
  return { filePath, url: payload.content?.html_url ?? `https://github.com/${connector.repo}/blob/${connector.branch}/${filePath}` };
}
