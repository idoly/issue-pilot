---
name: react-engineering
summary: Implement and verify React frontend changes for tracked issues.
description: Builds React user interfaces with accessible interactions, stable state handling, API error states, and focused tests. Use for React, TypeScript, CSS, or browser-facing issue work.
---

# React Engineering

1. Read the issue and inspect existing routes, components, state management, design tokens, and tests.
2. Model loading, empty, success, unauthorized, forbidden, validation, and server-error states explicitly.
3. Use the authenticated Keycloak session through the application's existing auth adapter. Never persist access tokens in local storage unless the established security design explicitly requires it.
4. Keep API access behind the existing client layer and preserve cancellation behavior for unmounted views.
5. Use semantic controls, visible focus, keyboard operation, labels, and useful accessible names.
6. Keep operational screens compact and scannable. Avoid decorative landing-page composition for issue workflows.
7. Add component tests for state transitions and browser tests for critical user journeys.
8. Verify at desktop and mobile viewport sizes; check long titles, translated text, empty data, and errors for overlap.
9. Attach test commands and browser evidence to the issue before resolving it.
