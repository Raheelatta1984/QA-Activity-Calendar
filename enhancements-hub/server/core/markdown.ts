/**
 * Markdown rendering for enhancement records and handover documents.
 * Ported from the source app's `lib/enhancements.ts` (render/frontmatter/
 * filename half). Deterministic: the same record always renders byte-identical
 * Markdown, which is what makes vault reconciliation safe.
 */

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function enhancementFileName(ref: string, title: string): string {
  return `${ref}-${slugify(title) || "enhancement"}.md`;
}

/** Handover filenames carry a short instance suffix so two records that landed
 *  on the same ref on different instances never collide in one repository. */
export function handoverFileName(ref: string, title: string, recordId: string): string {
  const base = enhancementFileName(ref, title).replace(/\.md$/, "");
  const uniqueId = String(recordId).replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
  return `${base}-${uniqueId}.md`;
}

export function frontmatter(meta: Record<string, string | number | null | undefined>): string {
  const lines = Object.entries(meta)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: "${String(value).replace(/"/g, "'")}"`);
  return `---\n${lines.join("\n")}\n---\n`;
}

export type RenderInput = {
  ref: string;
  title: string;
  status: string;
  applicationName?: string | null;
  tenantName?: string | null;
  submittedBy?: string | null;
  submittedOn?: string | null;
  sections?: string | null;
  aiFields?: string[];
  rawMarkdown?: string | null;
  brief?: string | null;
  requirements?: string | null;
  impacts?: string | null;
  expectedOutcome?: string | null;
  successCriteria?: string | null;
  includeFooter?: boolean;
};

export function renderEnhancementMarkdown(input: RenderInput): { body: string; fileContent: string } {
  const trimmed = String(input.rawMarkdown ?? "").trim();
  const body =
    trimmed ||
    `# ${input.title}\n\n## Brief\n${input.brief ?? "_To be confirmed_"}\n\n## Requirements\n${
      input.requirements ?? "_To be confirmed_"
    }\n\n## Impacts\n${input.impacts ?? "_To be confirmed_"}\n\n## Expected outcome\n${
      input.expectedOutcome ?? "_To be confirmed_"
    }\n\n## Success criteria\n${input.successCriteria ?? "_To be confirmed_"}\n`;

  const aiFields = (input.aiFields ?? []).filter(Boolean);
  const header = frontmatter({
    ref: input.ref,
    title: input.title,
    status: input.status,
    application: input.applicationName ?? undefined,
    tenant: input.tenantName ?? undefined,
    submitted_by: input.submittedBy ?? undefined,
    submitted_on: input.submittedOn ?? undefined,
    app_sections: input.sections ?? undefined,
    ai_fields: aiFields.length ? aiFields.join(", ") : undefined,
    source: "Enhancements Hub — Future Enhancements",
  });

  const footer =
    input.includeFooter === false
      ? ""
      : `\n\n---\n\n_Generated from the Enhancements Hub. Fields drafted by the local assistant: ${
          aiFields.length ? aiFields.join(", ") : "none"
        }. Review with every change set and archive once built and tested._`;

  const normalizedBody = body.replace(/\s+$/, "");
  return { body, fileContent: `${header}${normalizedBody}${footer}\n` };
}

/** Parse a simple `key: "value"` frontmatter block. Never throws. */
export function parseFrontmatter(text: string): Record<string, string> | null {
  const content = String(text ?? "");
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const out: Record<string, string> = {};
  for (const line of content.slice(4, end).split(/\r?\n/)) {
    const match = line.match(/^([a-z_]+):\s*"?([^"]*)"?\s*$/i);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

/** Rewrite only the status line inside an existing frontmatter block. */
export function updateFrontmatterStatus(content: string, status: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return content;
  const header = content.slice(0, end);
  const rest = content.slice(end);
  if (/^status:\s*".*"$/m.test(header)) {
    return `${header.replace(/^status:\s*".*"$/m, `status: "${status.replace(/"/g, "'")}"`)}${rest}`;
  }
  return `${header}\nstatus: "${status.replace(/"/g, "'")}"${rest}`;
}

export function parseAiFields(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
