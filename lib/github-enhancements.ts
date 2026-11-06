/** Publish approved handovers using the GitHub Contents API. Never log the token. */
export async function publishBuildingEnhancement(filename: string, content: string): Promise<string> {
  const repo = process.env.GITHUB_REPO?.trim();
  const token = process.env.GITHUB_TOKEN?.trim();
  const branch = process.env.GITHUB_ENHANCEMENTS_BRANCH?.trim() || "main";
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) {
    throw new Error("GitHub publishing is not configured. Set GITHUB_REPO and GITHUB_TOKEN on the server.");
  }
  if (!/^ENH-[0-9]+-[a-z0-9-]+\.md$/.test(filename)) throw new Error("Invalid enhancement filename.");
  const filePath = `lib/future-enhancements/${filename}`;
  const url = `https://api.github.com/repos/${repo}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const previous = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers, cache: "no-store" });
  let sha: string | undefined;
  if (previous.ok) {
    const file = await previous.json();
    if (file.type !== "file" || !file.sha) throw new Error("The GitHub handover path is not a file.");
    sha = file.sha;
  } else if (previous.status !== 404) {
    throw new Error(`GitHub could not read the handover (HTTP ${previous.status}).`);
  }
  const response = await fetch(url, {
    method: "PUT", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message: `docs: publish ${filename} for building`, content: Buffer.from(content, "utf8").toString("base64"), branch, ...(sha ? { sha } : {}) }),
  });
  if (!response.ok) throw new Error(`GitHub could not publish the handover (HTTP ${response.status}). Check repository permissions and branch protection.`);
  return filePath;
}
