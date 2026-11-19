# Task 12.2 live invitation readiness

This follow-up is source readiness only until the actual Cloudflare API response
shape, exact scoped policy and recipient authentication are verified on staging.
It does not create or edit Access policies, provision credentials or send email.

The trusted staging assembly pins the existing Cloudflare account, custom
Members application, audience, hostname and shared Owner policy ID in source.
Only the custom Members application's separate recipient policy may include the
approved test recipient. The shared Owner policy and direct Worker application
must remain unchanged. A complete inventory verifies that the recipient policy
is not attached to another application and that no other application route
overlaps the custom Members hostname.

## Temporary server configuration

- `ACCESS_POLICY_READ_TOKEN`: temporary secret with **Access: Apps and Policies
  Read** on the existing account; no write or administrative permissions.
- `ACCESS_POLICY_EXPECTED_IDPS`: JSON array containing the exact existing
  application IdP IDs, independently inspected before configuration. This is a
  pin, not a value copied automatically from an unverified response.
- `ACCESS_POLICY_RECIPIENT`: exact approved controlled recipient contact. Do not
  put the private contact or credential value in the repository or evidence logs.

Missing configuration, a revoked token, unsupported policy rules, incomplete
pagination, drift, routing overrides, unproven MFA or an API failure all prevent
new code release. Existing activated Member and Owner login never invokes this
readback and therefore continues after token revocation.

## Verify before the one approved real invitation

The existing authenticated Owner may GET
`/app/manage/invitation-preflight`. This performs no D1 mutation and returns only
a branded ready/unavailable result. It checks the existing active Owner plus the
configured approved recipient against the effective policy contacts, without
requiring an invitation record or minting a usable receipt. Do not generate the
real invitation until this preflight succeeds. A failed issue must be inspected
before retrying; no proof is recoverable from a stored digest.

Generation repeats the full live inventory and D1 comparison. Only completion
of the trusted live readback creates the in-process receipt accepted by the
existing `blocked -> projected` transition. The Owner still separately confirms
private delivery. Claiming remains recipient-bound, signed OTP, CSRF-protected
and atomic; no service grant is created.

The supported API subset is deliberately small: exact email Allow rules with no
Require/Exclude selectors; inherited or equally restrictive custom MFA; at most
24-hour application, policy and MFA sessions; supported public URI and Worker
destinations with no public bypass overrides. Groups, unknown routing shapes,
unscoped policies and unsupported selectors block readiness. Both complete API
inventories must match, and D1 must remain unchanged across verification.
The collector permits at most 40 external GETs per request, leaving headroom
for the existing authentication checks. Larger or heavily paginated inventories
fail closed. Actual Worker CPU/runtime behavior still needs live preflight.

After the real test, revoke the temporary credential and remove its Worker
secret. Do not claim later invitation issuance works without renewed approved
readback access. Real recipient OTP/MFA, subsequent login, mobile checks and
Greg's acceptance remain separate from synthetic tests.

Primary API references:

- https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/get/
- https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/subresources/policies/methods/list/
- https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/

Live API compatibility (October 30): the complete inventory also includes the
built-in App Launcher, which is absent from the self-hosted-app dashboard list.
Its exact existing ID and tenant hostname are pinned in source; destination or
alias fields remain unsupported and block readiness. It stays in both repeated
inventories and recipient-policy reuse checks. Unknown app types still fail shut.

Two applications are read concurrently, each with parallel detail and policy
reads (at most four external requests in flight); the 15-second deadline and 40-GET cap remain unchanged. The full
seven-app live inventory requires 30 GETs across both repeated snapshots.

Worker runtime compatibility: requests use manual redirects; the existing
non-2xx/redirected-response checks deny every redirect without forwarding the
credential. An actual workerd Request-constructor regression covers this mode.
