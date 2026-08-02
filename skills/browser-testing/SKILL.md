---
name: browser-testing
summary: Verify frontend issue fixes in a real browser with repeatable evidence.
description: Uses Playwright to test authenticated browser workflows, responsive layouts, accessibility, network failures, and regressions. Use when an issue affects a web interface or needs browser verification.
---

# Browser Testing

1. Read the issue acceptance criteria and locate the application's existing Playwright configuration.
2. Prefer role, label, and test-id locators over CSS structure. Do not use fixed sleeps; wait for user-visible state or a specific response.
3. Authenticate through a dedicated Keycloak test realm/user or approved stored browser state. Never print or commit credentials, cookies, or tokens.
4. Cover the shortest critical journey plus the reported failure. Include unauthorized and forbidden behavior for permission changes.
5. Exercise Chromium at desktop and mobile viewport sizes. Check long issue titles, empty states, loading, and errors for overlap.
6. Capture trace and screenshot only on failure unless the issue requires visual evidence. Sanitize artifacts before attaching them.
7. Run the focused spec, then the relevant browser suite. Treat console errors and failed network requests as failures unless explicitly expected.
8. Comment on the issue with the exact command, tested viewport, result, and artifact path. Resolve only when acceptance criteria pass.
