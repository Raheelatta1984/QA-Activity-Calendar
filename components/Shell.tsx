"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { logoutAction, switchDepartmentAction, switchPersonaAction } from "@/app/actions/auth";

export type ShellTab = {
  id: string;
  label: string;
  icon: string;
  href: string;
  group_name: string;
  badge?: number;
};

export type ShellPerson = {
  id: string;
  name: string;
  role: string;
  title: string | null;
  colour: string;
};

export function Shell({
  tabs,
  user,
  actingAs,
  personaOptions,
  version,
  departments,
  activeDepartmentId,
  ephemeral,
  children,
}: {
  tabs: ShellTab[];
  user: ShellPerson;
  actingAs: ShellPerson;
  personaOptions: ShellPerson[];
  children: React.ReactNode;
  version: string;
  departments: { id: string; name: string; enabled: number }[];
  activeDepartmentId: string | null;
  ephemeral?: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const current = (document.documentElement.getAttribute("data-theme") as "dark" | "light") || "dark";
    setTheme(current);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("qa-theme", next);
    } catch {
      /* ignore */
    }
  }

  const groups = tabs.reduce<Record<string, ShellTab[]>>((acc, tab) => {
    acc[tab.group_name] = acc[tab.group_name] ?? [];
    acc[tab.group_name].push(tab);
    return acc;
  }, {});

  const current = tabs.find((t) => (t.href === "/" ? pathname === "/" : pathname.startsWith(t.href)));
  const previewing = user.id !== actingAs.id;
  const initials = (name: string) =>
    name
      .split(" ")
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? "open" : ""}`} aria-label="Primary navigation">
        <div className="brand">
          <div className="brand-mark">HF</div>
          <div className="grow">
            <div className="brand-name">QA Calendar</div>
            <div className="brand-sub">HFM · {version}</div>
          </div>
          <button className="icon-btn mobile-only" onClick={() => setOpen(false)} aria-label="Close navigation">
            <Icon name="close" size={16} />
          </button>
        </div>

        <nav className="nav">
          {Object.entries(groups).map(([group, items]) => (
            <div className="nav-group" key={group}>
              <div className="nav-label">{group}</div>
              {items.map((tab) => {
                const active = tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
                return (
                  <Link key={tab.id} href={tab.href} className={`nav-item ${active ? "active" : ""}`} title={tab.id}>
                    <Icon name={tab.icon} />
                    <span>{tab.label}</span>
                    {tab.badge ? <span className="nav-badge">{tab.badge}</span> : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="row" style={{ gap: 8 }}>
            <div className="avatar" style={{ background: actingAs.colour }}>
              {initials(actingAs.name)}
            </div>
            <div className="grow" style={{ minWidth: 0 }}>
              <div style={{ color: "var(--text)", fontWeight: 600, fontSize: "0.79rem" }}>{actingAs.name}</div>
              <div style={{ fontSize: "0.7rem" }}>
                {actingAs.title ?? actingAs.role} · <strong>{actingAs.role}</strong>
              </div>
            </div>
          </div>
          <form action={logoutAction} style={{ marginTop: 10 }}>
            <button className="btn btn-sm btn-ghost" type="submit" style={{ width: "100%" }}>
              <Icon name="logout" size={14} /> Sign out
            </button>
          </form>
        </div>
      </aside>

      {open ? (
        <div
          className="mobile-only"
          style={{ position: "fixed", inset: 0, zIndex: 35, background: "rgba(0,0,0,0.45)" }}
          onClick={() => setOpen(false)}
        />
      ) : null}

      <div className="content">
        <header className="topbar">
          <button className="icon-btn mobile-only" onClick={() => setOpen(true)} aria-label="Open navigation">
            <Icon name="menu" size={17} />
          </button>
          <div style={{ minWidth: 0 }}>
            <div className="topbar-title">{current?.label ?? "Workspace"}</div>
            <div className="crumbs">
              {current ? (
                <>
                  <span className="mono">{current.id}</span> · {current.group_name}
                </>
              ) : (
                "HFM Quality Engineering"
              )}
            </div>
          </div>

          <div className="topbar-actions">
            <form action={switchDepartmentAction} className="hide-sm">
              <input type="hidden" name="redirectTo" value={pathname} />
              <select
                className="select select-sm"
                name="departmentId"
                defaultValue={activeDepartmentId ?? ""}
                onChange={(e) => e.currentTarget.form?.requestSubmit()}
                aria-label="Department scope"
                style={{ maxWidth: 168 }}
              >
                <option value="">All departments</option>
                {departments
                  .filter((d) => d.enabled)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </form>

            {personaOptions.length > 1 ? (
              <form action={switchPersonaAction} className="hide-sm">
                <input type="hidden" name="redirectTo" value={pathname} />
                <select
                  className="select select-sm"
                  name="personId"
                  defaultValue={actingAs.id}
                  onChange={(e) => e.currentTarget.form?.requestSubmit()}
                  aria-label="View as employee"
                  style={{ maxWidth: 176 }}
                >
                  {personaOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      View as {p.name.split(" ")[0]} ({p.role})
                    </option>
                  ))}
                </select>
              </form>
            ) : null}

            <Link href="/changelog" className="icon-btn" title="What's new" aria-label="What's new">
              <Icon name="megaphone" size={16} />
            </Link>
            <button className="icon-btn" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
              <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
            </button>
            <div className="avatar hide-sm" style={{ background: actingAs.colour }} title={actingAs.name}>
              {initials(actingAs.name)}
            </div>
          </div>
        </header>

        {previewing ? (
          <div
            className="banner warn"
            style={{ margin: "12px 26px 0", borderRadius: 10 }}
            role="status"
          >
            <Icon name="eye" size={15} />
            <span>
              Previewing the app as <strong>{actingAs.name}</strong> ({actingAs.role}). Writes are disabled while
              previewing — switch back to your own identity to make changes.
            </span>
            <form action={switchPersonaAction}>
              <input type="hidden" name="personId" value="" />
              <input type="hidden" name="redirectTo" value={pathname} />
              <button className="btn btn-sm" type="submit">
                Exit preview
              </button>
            </form>
          </div>
        ) : null}

        {ephemeral ? (
          <div className="banner warn" style={{ margin: "12px 26px 0", borderRadius: 10 }} role="status">
            <Icon name="info" size={15} />
            <span>
              <strong>Serverless demo instance.</strong> The database lives on this instance&apos;s temporary disk, so
              changes reset when the function restarts and another instance may show different data. Configure a
              Postgres database for durable storage — see <span className="mono">docs/DEPLOYMENT.md</span>.
            </span>
          </div>
        ) : null}

        {children}
      </div>
    </div>
  );
}
