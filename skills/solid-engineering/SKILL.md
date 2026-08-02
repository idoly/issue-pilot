---
name: solid-engineering
summary: Implement and verify Solid 2 frontend changes for tracked issues.
description: Builds Solid 2.0.0-beta.29 interfaces using the local @idoly/ant-design-solid component library, with reactive correctness, accessibility, and browser tests. Use for this system frontend and Solid project issues.
---

# Solid Engineering

1. Use exactly `solid-js@2.0.0-beta.29` and `@solidjs/web@2.0.0-beta.29` for this system.
2. Use the local `/home/idoly/antd-design-solid` package. Read its public types and existing tests before using unfamiliar APIs.
3. Preserve Solid ownership and reactivity. Do not destructure reactive props, introduce React hooks, or copy React element patterns.
4. Use component subpath styles plus the shared `base.css`; do not depend on unpublished aggregate CSS.
5. Model loading, empty, success, unauthorized, forbidden, validation, and server-error states explicitly.
6. Add focused component tests and Playwright coverage at desktop and mobile viewports.
7. If the failure is in `@idoly/ant-design-solid`, bind that repository to the issue, create a separate issue worktree/branch, fix the framework directly, and run its `npm run check`. Do not add a business-layer workaround.
8. Keep Keycloak tokens out of local storage, logs, screenshots, and test artifacts.
9. Record exact tests and artifact paths on the issue before resolving it.
