import fs from "node:fs";
import path from "node:path";
import { all } from "./db";

export type Enhancement = {
  id: string;
  ref: string;
  title: string;
  brief: string | null;
  requirements: string | null;
  impacts: string | null;
  expected_outcome: string | null;
  success_criteria: string | null;
  markdown: string | null;
  status: string;
  github_path: string | null;
  submitted_by: string | null;
  submitted_by_name: string | null;
  department_id: string | null;
  department_name: string | null;
  votes: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export function listEnhancements(): Enhancement[] {
  return all<Enhancement>(
    `SELECT e.*, p.name AS submitted_by_name, d.name AS department_name
       FROM enhancements e
       LEFT JOIN people p ON p.id = e.submitted_by
       LEFT JOIN departments d ON d.id = e.department_id
      ORDER BY CASE e.status WHEN 'Reviewing' THEN 1 WHEN 'Submitted' THEN 2 WHEN 'Accepted' THEN 3
                             WHEN 'Building' THEN 4 WHEN 'Built' THEN 5 WHEN 'Archived' THEN 6 ELSE 7 END,
               e.created_at DESC`
  );
}

export function vaultFiles(): string[] {
  const dir = path.join(process.cwd(), "enhancements");
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const sub = path.join(dir, entry.name);
      for (const file of fs.readdirSync(sub)) {
        if (file.endsWith(".md") && file.toLowerCase() !== "readme.md") out.push(`enhancements/${entry.name}/${file}`);
      }
    } else if (entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md") {
      out.push(`enhancements/${entry.name}`);
    }
  }
  return out.sort();
}
