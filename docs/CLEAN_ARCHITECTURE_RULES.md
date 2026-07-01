# Clean Architecture Rules

These rules exist to prevent the codebase from turning into a patch stack or all-in-one app file.

## Non-negotiable rules

- No runtime patch files.
- No `node -r patch-file` startup chains.
- No HTML string injection as a normal feature strategy.
- No all-in-one admin, portal, dashboard, or app pages.
- No business logic inside frontend HTML files.
- No hardcoded live customer, client, host, tenant, or lead records in runtime code.
- No giant catch-all `index.js`, `server.js`, `app.js`, or single route file that owns unrelated features.
- No hidden feature behavior that depends on file preload order.

## Required structure for new work

Every feature should have a clear home:

1. A route/module that owns HTTP behavior.
2. A service/module that owns business logic.
3. A page/component/script that owns UI behavior.
4. A data model/table/schema that owns persistence.
5. A documented migration path if replacing legacy behavior.

## When touching legacy code

- Do not pile another patch onto a patch.
- Do not inject UI through string replacement unless it is a temporary emergency fix.
- If a file is becoming too large, split it before adding more features.
- If a feature touches multiple domains, create a proper service boundary first.

## Review checklist

Before merging any meaningful change, ask:

- Does this make startup simpler or more fragile?
- Does this make the file tree clearer or more confusing?
- Could a new developer find the route, service, and UI for this feature quickly?
- Are we copying old behavior intentionally, or copying old architecture accidentally?
- Is this something we would be comfortable building on for a year?

## Default answer

If a change requires runtime patching, string-injected UI, or a giant all-in-one file, stop and redesign it.
