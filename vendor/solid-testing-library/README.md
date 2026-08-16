# Solid Testing Library metadata patch

This directory contains the MIT-licensed compiled files from
`@solidjs/testing-library@1.0.0-beta.2`.

The upstream package is developed against Solid 2 beta, but its published peer
ranges are `>=2.0.0`, which npm correctly treats as excluding prereleases.
Issue Pilot uses `solid-js` and `@solidjs/web` `2.0.0-beta.29` because
`@idoly/ant-design-solid@0.2.4` requires those exact versions.

The only local change is `package.json`: both Solid peer ranges are pinned to
`2.0.0-beta.29`. Remove this directory and return to the registry package when
an upstream release declares prerelease-compatible peers or the application
moves to stable Solid 2.
