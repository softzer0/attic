# Security policy

## Reporting

Do not open public issues for suspected vulnerabilities. Report them privately through GitHub Security Advisories for `softzer0/attic`.

Include the affected version, reproduction details, impact, and any suggested mitigation. You should receive an acknowledgement within seven days.

## Operational guidance

Attic hashes query arguments in Redis keys but cached values contain application data. Use Redis authentication, TLS where traffic crosses a trusted boundary, least-privilege PostgreSQL and Redis credentials, and an isolated key namespace. Apply tenant or RLS extensions before Attic and use `$attic.withScope()` whenever database policy is not represented in Prisma arguments.
