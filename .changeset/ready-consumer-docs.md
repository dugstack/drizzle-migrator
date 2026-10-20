---
"@dugstack/drizzle-migrator-cli": patch
"@dugstack/drizzle-migrator": patch
---

Document direct core installation for migration imports and the supported Drizzle ORM version. Correct bundled agent instructions for automatic migration discovery and dialect transaction guarantees.

Initialize audit storage before first-run lock and validation events, and record CLI commands after database guards and bootstrap complete.

Exclude tracking tables from adoption eligibility so validation alone never makes an empty application database adoptable.
