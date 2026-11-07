import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ACTIVE_DIR, appendStepSummary, isSafeHandoverName, readLines } from "./lib/enhancement-utils.mjs";

/**
 * Move resolved handovers from **Building** to **Built** before they are archived.
 *
 * The lifecycle has one honest intermediate state: once the implementation PR has
 * merged and its build check passed, the handover is *built* — it stays in
 * `lib/future-enhancements/` (so the record is still visible and reviewable) and
 * only then becomes **Archived** when the completion workflow moves it into
 * `archived/`. Both transitions are written to the same Markdown file, so the
 * status never has to be guessed from a commit message.
 *
 * Only explicitly resolved, valid handover names are touched.
 */
export function markHandoversBuilt({ names, root = process.cwd() }) {
  const results = [];
  for (const name of names) {
    if (!isSafeHandoverName(name)) throw new Error(`Refusing invalid handover filename: ${name}`);
    const file = path.join(root, ACTIVE_DIR, name);
    if (!fs.existsSync(file)) {
      results.push({ name, status: "missing" });
      continue;
    }
    const content = fs.readFileSync(file, "utf8");
    if (!content.startsWith("---\n")) {
      results.push({ name, status: "no-frontmatter" });
      continue;
    }
    if (/^status:\s*"Built"\s*$/m.test(content)) {
      results.push({ name, status: "already-built" });
      continue;
    }
    if (!/^status:\s*"Building"\s*$/m.test(content)) {
      results.push({ name, status: "not-building" });
      continue;
    }
    fs.writeFileSync(file, content.replace(/^status:\s*"Building"\s*$/m, 'status: "Built"'), "utf8");
    results.push({ name, status: "built" });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const names = readLines(process.env.ARCHIVE_NAMES_FILE || "");
    const results = markHandoversBuilt({ names });
    for (const result of results) console.log(`${result.name}: ${result.status}`);
    appendStepSummary(
      process.env,
      "Handovers marked Built",
      results.length
        ? results.map((result) => `${result.name}: ${result.status}`)
        : ["No resolved handovers in this run."],
    );
    if (results.some((result) => result.status === "built")) {
      console.log("mark-handovers-built:changed=true");
    }
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
