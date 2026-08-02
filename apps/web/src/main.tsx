import { render } from "@solidjs/web";

import { App } from "./App";
import { initializeAuthentication, logout, type AuthenticatedUser } from "./auth";
import "./styles.css";
import "./statistics.css";
import "./configuration.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element");
const root: HTMLElement = rootElement;

async function bootstrap(): Promise<void> {
  let user: AuthenticatedUser | undefined;
  if (import.meta.env.VITE_AUTH_DISABLED !== "true") {
    user = await initializeAuthentication();
  }
  render(() => <App user={user} onLogout={user ? () => { void logout(); } : undefined} />, root);
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  root.textContent = `Authentication failed: ${message}`;
});
