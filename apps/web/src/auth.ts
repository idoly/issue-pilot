import Keycloak from "keycloak-js";

export interface AuthenticatedUser {
  subject: string;
  name: string;
  email: string;
}

const keycloak = new Keycloak({
  url: import.meta.env.VITE_KEYCLOAK_URL ?? "http://127.0.0.1:8081",
  realm: import.meta.env.VITE_KEYCLOAK_REALM ?? "issue-agent",
  clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? "issue-agent-web",
});

export async function initializeAuthentication(): Promise<AuthenticatedUser> {
  const authenticated = await keycloak.init({
    onLoad: "login-required",
    pkceMethod: "S256",
    checkLoginIframe: false,
    enableLogging: import.meta.env.DEV,
  });
  if (!authenticated) {
    await keycloak.login();
    throw new Error("Keycloak login redirect did not start");
  }
  const profile = await keycloak.loadUserProfile();
  return {
    subject: keycloak.subject ?? "",
    name: [profile.firstName, profile.lastName].filter(Boolean).join("") || profile.username || "用户",
    email: profile.email ?? "",
  };
}

export async function logout(): Promise<void> {
  await keycloak.logout({ redirectUri: window.location.origin });
}

export function accessToken(): string | undefined {
  return keycloak.token;
}
