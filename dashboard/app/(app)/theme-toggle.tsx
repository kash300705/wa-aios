"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const SUN = "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z";
const MOON = "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = (document.documentElement.getAttribute("data-theme") as Theme) || "light";
    setTheme(current);
  }, []);

  function apply(next: Theme) {
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("aios-theme", next); } catch { /* private mode */ }
  }

  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      <button
        type="button"
        className={theme === "light" ? "active" : ""}
        aria-pressed={theme === "light"}
        onClick={() => apply("light")}
        title="Light theme"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={SUN} /></svg>
        Light
      </button>
      <button
        type="button"
        className={theme === "dark" ? "active" : ""}
        aria-pressed={theme === "dark"}
        onClick={() => apply("dark")}
        title="Dark theme"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={MOON} /></svg>
        Dark
      </button>
    </div>
  );
}
