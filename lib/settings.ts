import { setting } from "./db";

export type AppSettings = {
  fiscalStartMonth: number;
  hoursPerDay: number;
  fteRegression: number;
  fteDefault: number;
  includeUnavailable: boolean;
  appName: string;
  timezone: string;
  blockingRule: string;
  visibilityRule: string;
};

export function appSettings(): AppSettings {
  return {
    fiscalStartMonth: Number(setting("fiscal.start_month", "7")),
    hoursPerDay: Number(setting("fte.hours_per_day", "7.6")),
    fteRegression: Number(setting("fte.regression_value", "1")),
    fteDefault: Number(setting("fte.default_value", "0.5")),
    includeUnavailable: setting("capacity.include_unavailable", "true") === "true",
    appName: setting("app.name", "HFM QA Activity Calendar"),
    timezone: setting("app.timezone", process.env.APP_TIMEZONE || "Australia/Sydney"),
    blockingRule: setting("pipeline.blocking_rule", "active-qa-overlap"),
    visibilityRule: setting("org.visibility_rule", "subtree-downward"),
  };
}
