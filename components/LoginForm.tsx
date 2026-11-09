"use client";

import { useActionState, useEffect, useState } from "react";
import { loginAction, type LoginState } from "@/app/actions/auth";
import { Icon } from "./icons";
import type { LoginScope } from "@/lib/org";

export function LoginForm({ scope }: { scope: LoginScope }) {
  const { companies, entities, accounts, selectedCompanyId, selectedEntityId } = scope;
  const firstFillable = accounts.find((a) => a.is_demo === 1) ?? accounts.find((a) => a.has_login === 1) ?? null;
  const [state, formAction, pending] = useActionState<LoginState, FormData>(loginAction, {});
  const [email, setEmail] = useState(firstFillable?.email ?? "");
  const [password, setPassword] = useState(firstFillable?.is_demo === 1 ? "demo1234" : "");

  // When the company/entity scope changes, re-anchor the email to a sign-in-able
  // account in the new scope instead of keeping a stale one.
  useEffect(() => {
    const next = accounts.find((a) => a.is_demo === 1) ?? accounts.find((a) => a.has_login === 1) ?? null;
    setEmail(next?.email ?? "");
    setPassword(next?.is_demo === 1 ? "demo1234" : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCompanyId, selectedEntityId]);

  const companyHref = (id: string) => `/login?company=${encodeURIComponent(id)}`;
  const entityHref = (id: string | null) =>
    `/login?company=${encodeURIComponent(selectedCompanyId)}${id ? `&entity=${encodeURIComponent(id)}` : ""}`;

  const selectedCompany = companies.find((c) => c.id === selectedCompanyId);
  const selectedEntity = entities.find((e) => e.id === selectedEntityId) ?? null;
  const scopeName = selectedEntity?.name ?? selectedCompany?.name ?? "workspace";
  const demoCount = accounts.filter((a) => a.is_demo === 1).length;

  const fill = (account: (typeof accounts)[number]) => {
    if (!account.email) return;
    setEmail(account.email);
    setPassword(account.is_demo === 1 ? "demo1234" : "");
  };

  return (
    <div className="login-card card card-pad">
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="brand-mark" style={{ width: 40, height: 40 }}>HF</div>
        <div>
          <h2>Sign in</h2>
          <div className="card-sub">QA Activity Calendar · FY27 workspace</div>
        </div>
      </div>

      {companies.length > 0 ? (
        <div className="login-scope">
          <div className="label" style={{ marginBottom: 6 }}>Company</div>
          <div className="scope-chips">
            {companies.map((company) => (
              <a
                key={company.id}
                href={companyHref(company.id)}
                className={`scope-chip ${company.id === selectedCompanyId ? "active" : ""}`}
                aria-current={company.id === selectedCompanyId ? "true" : undefined}
              >
                <span className="strong">{company.name}</span>
                <span className="muted">
                  {company.department_count} dept{company.department_count === 1 ? "" : "s"} · {company.person_count} people
                  {company.is_default ? " · default" : ""}
                </span>
              </a>
            ))}
          </div>

          <div className="label" style={{ margin: "10px 0 6px" }}>Entity</div>
          <div className="scope-chips">
            <a href={entityHref(null)} className={`scope-chip ${!selectedEntityId ? "active" : ""}`} aria-current={!selectedEntityId ? "true" : undefined}>
              <span className="strong">All entities</span>
              <span className="muted">whole company</span>
            </a>
            {entities.map((entity) => (
              <a
                key={entity.id}
                href={entityHref(entity.id)}
                className={`scope-chip ${entity.id === selectedEntityId ? "active" : ""}`}
                aria-current={entity.id === selectedEntityId ? "true" : undefined}
              >
                <span className="strong">{entity.name}</span>
                <span className="muted">
                  {entity.department_count} dept{entity.department_count === 1 ? "" : "s"} · {entity.person_count} people
                </span>
              </a>
            ))}
            {entities.length === 0 ? (
              <span className="card-sub" style={{ alignSelf: "center" }}>
                No entities configured — departments sit directly under the company.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <form action={formAction} className="stack-sm" style={{ marginTop: 4 }}>
        <div className="field">
          <label htmlFor="email">Work email</label>
          <input
            id="email"
            name="email"
            type="email"
            className="input"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            className="input"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {state.error ? (
          <div className="banner bad">
            <Icon name="alert" size={15} /> {state.error}
          </div>
        ) : null}
        <button className="btn btn-primary" type="submit" disabled={pending} style={{ marginTop: 4 }}>
          <Icon name="lock" size={15} />
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <div className="demo-accounts">
        <div className="label" style={{ marginBottom: 6 }}>
          People in {scopeName} — one click to fill{demoCount > 0 ? ` (${demoCount} demo)` : ""}
        </div>
        {accounts.length === 0 ? (
          <div className="card-sub">No active people in this scope yet.</div>
        ) : (
          accounts.map((account) => {
            const clickable = account.has_login === 1 && !!account.email;
            const initials = account.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
            return (
              <button
                key={account.id}
                type="button"
                className={`demo-account ${clickable ? "" : "demo-account-disabled"}`}
                onClick={() => fill(account)}
                disabled={!clickable}
                title={
                  account.has_login === 1
                    ? account.is_demo === 1
                      ? "Demo identity — fills the shared demo password"
                      : "Fills the email; enter your password"
                    : "No credentials set yet — ask an administrator"
                }
              >
                <span className="row" style={{ gap: 10 }}>
                  <span className="avatar-dot" aria-hidden="true">{initials}</span>
                  <span>
                    <strong>{account.name}</strong>
                    <span className="muted"> · {account.title ?? account.role}{account.department_name ? ` · ${account.department_name}` : ""}</span>
                  </span>
                </span>
                <span className={`badge ${account.is_demo === 1 ? "badge-blue" : account.has_login === 1 ? "badge-green" : "badge-slate"}`}>
                  {account.is_demo === 1 ? "demo" : account.has_login === 1 ? "sign-in ready" : "credentials not set"}
                </span>
              </button>
            );
          })
        )}
        <div className="sso-note">
          Demo identities share the password <code className="mono">demo1234</code>. Imported people keep their access
          until an administrator sets their credentials — the HFM import never invents logins. Replace with your
          approved identity provider before production — see <strong>docs/DEPLOYMENT.md</strong>.
        </div>
      </div>
    </div>
  );
}
