"use server";

import { redirect } from "next/navigation";
import { get } from "@/lib/db";
import {
  createSession,
  destroySession,
  setImpersonation,
  setLoginWelcomeCookie,
  setSessionCookie,
  verifyPassword,
} from "@/lib/auth";
import {
  getViewer,
  loadOrg,
  descendantsOf,
  companiesForPerson,
  COMPANY_COOKIE,
  ENTITY_COOKIE,
  DEPARTMENTS_COOKIE,
  LEGACY_DEPARTMENT_COOKIE,
} from "@/lib/access";
import { listCompanies } from "@/lib/org";
import { getSession } from "@/lib/auth";
import { ensureBootstrapped } from "@/lib/bootstrap";
import { recordAudit } from "@/lib/audit";

export type LoginState = { error?: string };

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  await ensureBootstrapped();
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

  // The company/entity chosen on the login screen is a *selection* within the
  // account's authorised tenants. A forged value is ignored, never granted.
  const requestedCompany = String(formData.get("companyId") ?? "").trim();
  const requestedEntity = String(formData.get("entityId") ?? "").trim();
  const fullPerson = get<any>("SELECT * FROM people WHERE id = ?", person.id);
  const permitted = companiesForPerson(fullPerson, listCompanies() as any);
  const { cookies } = await import("next/headers");
  const store = await cookies();
  if (requestedCompany && permitted.some((company) => company.id === requestedCompany)) {
    store.set(COMPANY_COOKIE, requestedCompany, { path: "/", sameSite: "lax" });
    if (requestedEntity) {
      const entity = get<{ company_id: string }>("SELECT company_id FROM entities WHERE id = ?", requestedEntity);
      if (entity?.company_id === requestedCompany) {
        store.set(ENTITY_COOKIE, requestedEntity, { path: "/", sameSite: "lax" });
      } else {
        store.delete(ENTITY_COOKIE);
      }
    } else {
      store.delete(ENTITY_COOKIE);
    }
    store.delete(DEPARTMENTS_COOKIE);
    store.delete(LEGACY_DEPARTMENT_COOKIE);
  }

  recordAudit({ actorId: person.id, actorName: person.name, action: "auth.login", entity: "person", entityId: person.id });
  await setLoginWelcomeCookie({ sessionId: session.id, personId: person.id, expires: session.expires });
  redirect("/calendar"); // QA calendar, scoped to the selected company/department
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
  const org = viewer.org;
  const target = personId ? org.byId.get(personId) : null;
  const actingScope = viewer.person.role === "department_admin" ? (viewer.person.role_scope_department_id ?? null) : null;
  const allowed =
    !personId ||
    personId === viewer.person.id ||
    viewer.person.role === "admin" ||
    viewer.person.role === "exec" ||
    (viewer.person.role === "manager" && descendantsOf(org.people, viewer.person.id).has(personId)) ||
    (actingScope !== null && target?.department_id === actingScope);

  if (!allowed) return;
  if (personId && !target) return;
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

/** Tenants the signed-in account may switch to, validated server-side. */
export async function switchCompanyAction(formData: FormData) {
  const viewer = await getViewer();
  const companyId = String(formData.get("companyId") ?? "").trim();
  const redirectTo = safeRedirect(formData.get("redirectTo"));
  if (!viewer.companies.some((company) => company.id === companyId)) {
    redirect(redirectTo); // unknown or unauthorised tenant: no change, no error page
  }
  const { cookies } = await import("next/headers");
  const store = await cookies();
  store.set(COMPANY_COOKIE, companyId, { path: "/", sameSite: "lax" });
  // Eentity and department selections are tenant-local; clear them on switch.
  store.delete(ENTITY_COOKIE);
  store.delete(DEPARTMENTS_COOKIE);
  store.delete(LEGACY_DEPARTMENT_COOKIE);
  // Drop a preview that belongs to the previous tenant.
  if (viewer.previewing) await setImpersonation(null);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "scope.company_switch",
    entity: "company",
    entityId: companyId,
  });
  redirect(redirectTo);
}

export async function switchEntityAction(formData: FormData) {
  const viewer = await getViewer();
  const entityId = String(formData.get("entityId") ?? "").trim();
  const redirectTo = safeRedirect(formData.get("redirectTo"));
  const { cookies } = await import("next/headers");
  const store = await cookies();
  if (!entityId) store.delete(ENTITY_COOKIE);
  else if (viewer.entities.some((entity) => entity.id === entityId)) {
    store.set(ENTITY_COOKIE, entityId, { path: "/", sameSite: "lax" });
  } else {
    redirect(redirectTo);
  }
  store.delete(DEPARTMENTS_COOKIE);
  store.delete(LEGACY_DEPARTMENT_COOKIE);
  redirect(redirectTo);
}

/**
 * Select one, several or all authorised departments. A submitted id outside the
 * viewer's server-computed department set is discarded.
 */
export async function switchDepartmentsAction(formData: FormData) {
  const viewer = await getViewer();
  const redirectTo = safeRedirect(formData.get("redirectTo"));
  const requested = formData
    .getAll("departmentIds")
    .map(String)
    .filter((id) => viewer.departmentIds.has(id));
  const { cookies } = await import("next/headers");
  const store = await cookies();
  if (!requested.length) {
    store.delete(DEPARTMENTS_COOKIE);
  } else {
    store.set(DEPARTMENTS_COOKIE, [...new Set(requested)].join(","), { path: "/", sameSite: "lax" });
  }
  store.delete(LEGACY_DEPARTMENT_COOKIE);
  recordAudit({
    actorId: viewer.person.id,
    actorName: viewer.person.name,
    action: "scope.departments_switch",
    entity: "department",
    entityId: null,
    after: { departmentIds: [...new Set(requested)] },
  });
  redirect(redirectTo);
}

/** Backwards-compatible single-department switcher. */
export async function switchDepartmentAction(formData: FormData) {
  const viewer = await getViewer();
  const departmentId = String(formData.get("departmentId") ?? "");
  const redirectTo = safeRedirect(formData.get("redirectTo"));
  const { cookies } = await import("next/headers");
  const store = await cookies();
  if (!departmentId) {
    store.delete(DEPARTMENTS_COOKIE);
    store.delete(LEGACY_DEPARTMENT_COOKIE);
  } else if (viewer.departmentIds.has(departmentId)) {
    store.set(DEPARTMENTS_COOKIE, departmentId, { path: "/", sameSite: "lax" });
    store.delete(LEGACY_DEPARTMENT_COOKIE);
  }
  redirect(redirectTo);
}

