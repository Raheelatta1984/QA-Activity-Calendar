export const LOGIN_WELCOME_COOKIE = "qa_login_welcome";
export const LOGIN_WELCOME_HEADER = "x-login-welcome";
export const LOGIN_WELCOME_COOKIE_MAX_AGE_SECONDS = 60;
export const LOGIN_WELCOME_VISIBLE_MS = 2000;

/** Kept separate from the component so the two-second contract is testable without a browser. */
export function scheduleLoginWelcomeDismiss(
  onDismiss: () => void,
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = setTimeout
): ReturnType<typeof setTimeout> {
  return schedule(onDismiss, LOGIN_WELCOME_VISIBLE_MS);
}
