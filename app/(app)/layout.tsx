import { headers } from "next/headers";
import Link from "next/link";
import { all, get } from "@/lib/db";
import { canEdit, getViewer, loadOrg, ROLE_RANK, descendantsOf } from "@/lib/access";
import { Shell, type ShellPerson, type ShellTab } from "@/components/Shell";
import { validationSummary } from "@/lib/validation";
import { isoToday } from "@/lib/dates";
import { Icon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  const org = viewer.org;
  const roleRank = ROLE_RANK[viewer.role] ?? 0;

  const tabs = all<any>(
    `SELECT * FROM tabs WHERE enabled = 1 ORDER BY sort_order`
  ).filter((tab) => roleRank >= (ROLE_RANK[tab.min_role] ?? 1));

  const issues = validationSummary();
  const errorCount = issues.error ?? 0;
  const submittedEnhancements =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM enhancements WHERE status IN ('Submitted','Reviewing')`
    )?.n ?? 0;

  const shellTabs: ShellTab[] = tabs.map((tab) => ({
    id: tab.id,
    label: tab.label,
    icon: tab.icon,
    href: tab.href,
    group_name: tab.group_name,
    badge: tab.key === "validation" ? errorCount : tab.key === "enhancements" ? submittedEnhancements : 0,
  }));

  // Central tab gate: disabled tabs and insufficient roles are blocked even when
  // the URL is typed directly (the nav simply doesn't show them).
  const headerBag = await headers();
  const pathname = headerBag.get("x-pathname") ?? "";
  const allTabs = all<any>(`SELECT * FROM tabs ORDER BY sort_order`);
  const matchedTab = allTabs.find((tab) =>
    tab.href === "/" ? pathname === "/" : pathname === tab.href || pathname.startsWith(`${tab.href}/`)
  );
  const tabBlocked = matchedTab
    ? !matchedTab.enabled || roleRank < (ROLE_RANK[matchedTab.min_role] ?? 1)
    : false;

  const latest = get<{ version: string }>(`SELECT version FROM changelog ORDER BY date DESC, created_at DESC LIMIT 1`);

  const personaIds =
    viewer.person.role === "admin" || viewer.person.role === "exec"
      ? new Set(org.people.map((p) => p.id))
      : viewer.person.role === "manager"
        ? descendantsOf(org.people, viewer.person.id)
        : new Set([viewer.person.id]);

  const personaOptions: ShellPerson[] = org.people
    .filter((p) => !!p.active && personaIds.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, role: p.role, title: p.title, colour: p.colour }));

  return (
    <Shell
      tabs={shellTabs}
      user={{
        id: viewer.person.id,
        name: viewer.person.name,
        role: viewer.person.role,
        title: viewer.person.title,
        colour: viewer.person.colour,
      }}
      actingAs={{
        id: viewer.actingAs.id,
        name: viewer.actingAs.name,
        role: viewer.actingAs.role,
        title: viewer.actingAs.title,
        colour: viewer.actingAs.colour,
      }}
      personaOptions={personaOptions}
      version={latest?.version ? `v${latest.version}` : "v1.0.0"}
      departments={org.departments.map((d) => ({ id: d.id, name: d.name, enabled: d.enabled }))}
      activeDepartmentId={viewer.activeDepartmentId}
    >
      {tabBlocked ? (
        <main className="page">
          <div className="card card-pad" style={{ maxWidth: 640, margin: "48px auto", textAlign: "center" }}>
            <div className="brand-mark" style={{ margin: "0 auto 14px" }}>
              <Icon name="lock" size={18} />
            </div>
            <h1 style={{ fontSize: "1.3rem" }}>
              {matchedTab && !matchedTab.enabled ? "This tab is disabled" : "You do not have access to this tab"}
            </h1>
            <p className="muted" style={{ marginTop: 8 }}>
              {matchedTab && !matchedTab.enabled
                ? `An administrator disabled ${matchedTab.label}. No data has been deleted — re-enable it in Master Setup.`
                : `${matchedTab?.label ?? "This tab"} requires the ${matchedTab?.min_role ?? "manager"} role. Your role is ${viewer.role}.`}
            </p>
            <div className="row" style={{ justifyContent: "center", marginTop: 16 }}>
              <Link className="btn" href="/">
                Back to dashboard
              </Link>
              {viewer.role === "admin" ? (
                <Link className="btn btn-primary" href="/setup">
                  Open Master Setup
                </Link>
              ) : null}
            </div>
            <div className="card-sub mono" style={{ marginTop: 14 }}>{matchedTab?.id}</div>
          </div>
        </main>
      ) : (
        children
      )}
      <div className="page-foot" style={{ margin: "0 auto", maxWidth: 1560, width: "100%", padding: "0 26px 26px" }}>
        <span>
          HFM QA Calendar · fiscal year starts in July · display timezone Australia/Sydney · today {isoToday()}
        </span>
        <span>
          Signed in as {viewer.person.name} ({viewer.person.role}) · visibility: downward sub-tree only
          {canEdit(viewer) ? " · edit access" : " · read-only"}
        </span>
      </div>
    </Shell>
  );
}
