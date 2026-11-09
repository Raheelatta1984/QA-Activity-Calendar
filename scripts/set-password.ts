/**
 * Set (or reset) a person's password by email — the supported way to give an
 * imported person a login. The HFM import never creates credentials.
 *
 *   npm run db:set-password -- --email ratta@harrisfarm.com.au --password-stdin
 *   npm run db:set-password -- --email ratta@harrisfarm.com.au --password 'a-long-secret'
 *
 * --password-stdin reads the password from stdin and is preferred (keeps it out
 * of shell history). The password must be at least 10 characters. Prints the
 * audit entry recorded; never logs the password.
 */
import readline from "node:readline";
import { get, run, migrate, dbFile } from "../lib/db";
import { hashPassword } from "../lib/auth";
import { recordAudit } from "../lib/audit";

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin });
    let data = "";
    rl.on("line", (line) => (data += line));
    rl.on("close", () => resolve(data.trim()));
    rl.on("error", reject);
  });
}

async function main() {
  const email = (arg("--email") ?? "").trim().toLowerCase();
  if (!email) throw new Error("--email is required");
  const password = process.argv.includes("--password-stdin") ? await readStdin() : arg("--password") ?? "";
  if (password.length < 10) throw new Error("Password must be at least 10 characters.");

  migrate();
  const person = get<{ id: string; name: string; email: string | null }>(
    "SELECT id, name, email FROM people WHERE LOWER(email) = ?",
    email
  );
  if (!person) throw new Error(`No person found with email ${email}.`);
  run("UPDATE people SET password_hash = ? WHERE id = ?", hashPassword(password), person.id);
  recordAudit({
    actorId: null,
    actorName: "operator (scripts/set-password.ts)",
    action: "person.password_set",
    entity: "person",
    entityId: person.id,
    meta: { email, note: "Password set via operator script; value never logged" },
  });
  console.log(`Password set for ${person.name} <${person.email}>. Recorded in audit_events.`);
  console.log(`Database: ${dbFile}`);
}

main().catch((err) => {
  console.error(`set-password: ${err.message}`);
  process.exitCode = 1;
});
