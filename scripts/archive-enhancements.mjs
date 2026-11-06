import fs from "node:fs";
import path from "node:path";

// Require an explicit full filename on a line by itself. Never interpret PR
// text as a shell command or archive a similarly numbered, unrelated request.
const body = process.env.PR_BODY || "";
const names = [...body.matchAll(/^Enhancement-Archive:\s*(ENH-[0-9]+-[a-z0-9-]+\.md)\s*$/gm)].map((m) => m[1]);
const root = path.join(process.cwd(), "lib", "future-enhancements");
for (const name of new Set(names)) {
  const source = path.join(root, name);
  const destination = path.join(root, "archive", name);
  if (!fs.existsSync(source)) {
    console.warn(`No active handover ${name}; skipping.`);
    continue;
  }
  if (fs.existsSync(destination)) throw new Error(`Archive already exists: ${name}; refusing to overwrite.`);
  const content = fs.readFileSync(source, "utf8");
  if (!/^---\n[\s\S]*?\n---\n/.test(content) || !/^status: "Building"$/m.test(content.split("\n---\n")[0])) {
    throw new Error(`${name} is not a Building handover.`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content.replace(/^status: "Building"$/m, 'status: "Archived"'));
  fs.unlinkSync(source);
  console.log(`Archived ${name}`);
}
