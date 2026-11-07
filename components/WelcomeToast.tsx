"use client";

import { useEffect, useState } from "react";
import { scheduleLoginWelcomeDismiss } from "@/lib/login-welcome";
import { Icon } from "./icons";

export function WelcomeToast({ name }: { name: string }) {
  const [visible, setVisible] = useState(true);
  const firstName = name.trim().split(/\s+/)[0] || "there";

  useEffect(() => {
    const timer = scheduleLoginWelcomeDismiss(() => setVisible(false));
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className="welcome-toast" role="status" aria-live="polite" aria-atomic="true">
      <span className="welcome-toast-icon" aria-hidden="true">
        <Icon name="check" size={18} />
      </span>
      <div className="welcome-toast-copy">
        <strong>Welcome back, {firstName}!</strong>
        <span>Your QA workspace is ready.</span>
      </div>
      <button
        type="button"
        className="icon-btn welcome-toast-close"
        onClick={() => setVisible(false)}
        aria-label="Dismiss welcome message"
        title="Dismiss"
      >
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}
