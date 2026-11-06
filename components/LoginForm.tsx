"use client";

import { useActionState, useState } from "react";
import { loginAction, type LoginState } from "@/app/actions/auth";
import { Icon } from "./icons";

type DemoAccount = { email: string; name: string; role: string; title: string | null };

export function LoginForm({ demoAccounts }: { demoAccounts: DemoAccount[] }) {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(loginAction, {});
  const [email, setEmail] = useState(demoAccounts[0]?.email ?? "");
  const [password, setPassword] = useState("demo1234");

  return (
    <div className="login-card card card-pad">
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="brand-mark" style={{ width: 40, height: 40 }}>HF</div>
        <div>
          <h2>Sign in</h2>
          <div className="card-sub">QA Activity Calendar · FY27 workspace</div>
        </div>
      </div>

      <form action={formAction} className="stack-sm">
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
        <div className="label" style={{ marginBottom: 6 }}>Demo identities — one click to fill</div>
        {demoAccounts.map((account) => (
          <button
            key={account.email}
            type="button"
            className="demo-account"
            onClick={() => {
              setEmail(account.email);
              setPassword("demo1234");
            }}
          >
            <span>
              <strong>{account.name}</strong>
              <span className="muted"> · {account.title ?? account.role}</span>
            </span>
            <span className="badge badge-slate">{account.role}</span>
          </button>
        ))}
        <div className="sso-note">
          All demo identities share the password <code className="mono">demo1234</code>. Replace with your approved
          identity provider before production — see <strong>docs/DEPLOYMENT.md</strong>.
        </div>
      </div>
    </div>
  );
}
