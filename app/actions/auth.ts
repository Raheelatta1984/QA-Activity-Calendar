"use server";

import { redirect } from "next/navigation";
import { get } from "@/lib/db";
import {
  createSession,
  destroySession,
  setImpersonation,
  setSessionCookie,
  verifyPassword,
} from "@/lib/auth";
import { getViewer, loadOrg, descendantsOf } from "@/lib/access";
import { getSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

export type LoginState = { error?: string };

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };

  const person = get<{ id: string; name: string; password_hash: string | null; active: number }>(
    `SELECT id, name, password_hash, active FROM people WHERE LOWER(email) = ?`,
    email
  );
  if (!person || !person.active) return { error: "No active account found for that email." };
  if (!verifyPassword(password, person.password_hash)) return { error: "That password doesn't match our records." };

  const session = createSession(person.id);
  await setSessionCookie({ sessionId: session.id, personId: person.id, expires: session.expires });
  recordAudit({ actorId: person.id, actorName: person.name, action: "auth.login", entity: "person", entityId: person.id });
  redirect("/");
}

export async function logoutAction() {
  const session = await getSession();
  if (session) {
    recordAudit({
      actorId: session.person.id,
      actorName: session.person.name,
      action: "auth.logout",
      entity: "person",
      entityId: session.person.id,
    });
  }
  await destroySession();
  redirect("/login");
}

function safeRedirect(raw: unknown): string {
  const value = String(raw ?? "/");
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export async function switchPersonaAction(formData: FormData) {
  const personId = String(formData.get("personId") ?? "");
  const redirectTo = safeRedirect(formData.get("redirectTo"));
  const session = await getSession();
  if (!session) redirect("/login");
  const viewer = await getViewer();
  const org = loadOrg();
  const target = org.byId.get(personId);
  const allowed =
    !personId ||
    personId === viewer.person.id ||
    viewer.person.role === "admin" ||
    viewer.person.role === "exec" ||
    (viewer.person.role === "manager" && descendantsOf(org.people, viewer.person.id).has(personId));

  if (!allowed || !target) {
    return;
  }
  await setImpersonation(personId || null);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "auth.switch_persona",
    entity: "person",
    entityId: personId || viewer.person.id,
    meta: { previewRole: target?.role ?? viewer.person.role },
  });
  redirect(redirectTo);
}

export async function switchDepartmentAction(formData: FormData) {
  const departmentId = String(formData.get("departmentId") ?? "");
  const redirectTo = safeRedirect(formData.get("redirectTo"));
  const { cookies } = await import("next/headers");
  const store = await cookies();
  if (!departmentId) store.delete("qa_dept");
  else store.set("qa_dept", departmentId, { path: "/", sameSite: "lax" });
  redirect(redirectTo);
}

