# Embedded user-assertion producers — enrolment and known-answer verification

**Status: the code is written; the platform verification is NOT done — and the operator CLI enforces that, it does not merely warn.**

`npm run embedded-role:grant` REFUSES to issue a grant for a platform absent from
`src/embedded/assertionConformance.ts`. Passing step 2 and adding a record there is
what unblocks it. Revoking is never gated, so an incident response is never blocked
by this.
Until step 2 passes on each platform, no real grant should be issued, because
an HMAC disagreement fails closed and silently — see [Why this check exists](#why-this-check-exists).

Audience: an operator with administrator access to a NetSuite account or a
Business Central environment. No knowledge of the SuiteCentral codebase is
needed; every step is either a configuration value or a string comparison.

---

## What a producer does

SuiteCentral only grants a privileged role (`approver`, `admin`) from an
`embedded_role_grants` row, never from anything the host asserts. To use a
grant, the host proves possession of that grant's secret by signing a header:

```
X-Squire-User-Assertion: v1.<grantId>.<ts>.<nonce>.<hmacHex>

hmacHex = HMAC-SHA256(secret, "grantId|tenantId|platform|platformAccountId|userId|ts|nonce")
```

Without the header a session is `host_asserted`: the host has named a user, and
that activates nothing. With a valid header the session is `squire_verified`
and exactly one grant's role becomes active.

## Why this check exists

The one thing the repository's tests cannot establish is whether the platform's
HMAC primitive produces the same bytes as Node's. If it does not, **every
assertion fails verification and the failure is silent** — a wrong MAC is
indistinguishable from a wrong secret, so the operator just sees `403
insufficient_role` forever, with nothing anywhere saying the two
implementations disagree.

For Business Central this is not hypothetical: `GenerateHash`'s hex case is
undocumented, which is why the AL wraps it in `LowerCase`. Step 2 is what turns
that from an assumption into a fact.

**Verified in CI already** (do not re-check by hand):

| Property | NetSuite | Business Central |
|---|---|---|
| Material field order and delimiter | ✅ executed against the published vector | ⚠️ source-text assertion only |
| Header assembly and lowercasing | ✅ executed | ⚠️ source-text assertion only |
| Header sent only when enrolled | ✅ | ✅ |
| **Platform HMAC agrees with Node** | ❌ **step 2** | ❌ **step 2** |

AL cannot run in the Node test harness, so the Business Central row is weaker
by nature, not by omission.

---

## The published conformance vector

From `src/embedded/userAssertionVector.ts`. The secret is a fixed test value and
is not sensitive.

| Field | Value |
|---|---|
| secret | `sc_test_secret_do_not_use_in_production` |
| material | `erg_000102030405060708090a0b\|t_vector\|netsuite\|ACCT_VECTOR_1\|12345\|1788350400\|bm9uY2VfdmVjdG9yXzAwMDE` |
| **expected hex** | `555837ae59a8b3652722b4374493d08f6b27823907b400f1d74c8ff4271f39e1` |

Reproduce it locally at any time:

```bash
node -e "console.log(require('crypto').createHmac('sha256','sc_test_secret_do_not_use_in_production').update('erg_000102030405060708090a0b|t_vector|netsuite|ACCT_VECTOR_1|12345|1788350400|bm9uY2VfdmVjdG9yXzAwMDE').digest('hex'))"
```

---

## Step 1 — configure

### NetSuite

Script parameters on the host Suitelet deployment:

| Parameter | Value |
|---|---|
| `custscript_sc_base_url` | SuiteCentral base URL (**https only** — the Suitelet refuses http) |
| `custscript_sc_embedded_token` | the embedded service token |
| `custscript_sc_tenant_id` | the SuiteCentral tenant id |

Two per-employee custom fields (entity fields on Employee):

| Field | Type | Purpose |
|---|---|---|
| `custentity_sc_grant_id` | Free-Form Text | the `erg_…` grant id |
| `custentity_sc_grant_guid` | Free-Form Text | the credential GUID for that grant's secret |

The secret itself is entered into a **credential field** with
`restrictToCurrentUser: true`, so only the employee who entered it can use it,
and NetSuite hands back a GUID. The Suitelet signs via that GUID and never sees
the plaintext.

### Business Central

Configure `SuiteCentralBaseUrl`, `SuiteCentralEmbeddedServiceToken`,
`SuiteCentralPlatformAccountId`, and `SuiteCentralTenantId`. Each currently
raises `Configure … before deployment` until set; a CI test asserts that list
matches the adapter descriptor, so it cannot silently drift.

> `SuiteCentralTenantId` is **not** sent in the bootstrap body — the server
> takes the tenant from the service-token row — but it *is* part of the signed
> material. Configuring it wrongly produces a valid HMAC over the wrong
> material, which fails exactly like a wrong secret.

Each user then runs **Enroll Squire grant** on the SuiteCentral part and enters
the grant id and secret their operator issued. Both are stored
`DataScope::User`; the secret uses `SetEncrypted`.

---

## Step 2 — the known-answer check (REQUIRED before the first real grant)

### NetSuite

Enter `sc_test_secret_do_not_use_in_production` into the credential field, note
the GUID, and run this once in a scratch Suitelet or the debugger:

```javascript
require(['N/crypto', 'N/encode'], function (crypto, encode) {
  var material = 'erg_000102030405060708090a0b|t_vector|netsuite|ACCT_VECTOR_1|12345|1788350400|bm9uY2VfdmVjdG9yXzAwMDE';
  var key = crypto.createSecretKey({ guid: '<PASTE THE CREDENTIAL GUID>', encoding: encode.Encoding.UTF_8 });
  var hmac = crypto.createHmac({ algorithm: crypto.HashAlg.SHA256, key: key });
  hmac.update({ input: material, inputEncoding: encode.Encoding.UTF_8 });
  log.audit('known-answer', hmac.digest({ outputEncoding: encode.Encoding.HEX }).toLowerCase());
});
```

### Business Central

```al
codeunit 70050199 SuiteCentralHmacKnownAnswer
{
    trigger OnRun()
    var
        CryptographyManagement: Codeunit "Cryptography Management";
        Material: Text;
    begin
        Material := 'erg_000102030405060708090a0b|t_vector|netsuite|ACCT_VECTOR_1|12345|1788350400|bm9uY2VfdmVjdG9yXzAwMDE';
        Message(LowerCase(CryptographyManagement.GenerateHash(
            Material, 'sc_test_secret_do_not_use_in_production', HashAlgorithmType::HMACSHA256)));
    end;
}
```

### Passing

The output must equal, character for character:

```
555837ae59a8b3652722b4374493d08f6b27823907b400f1d74c8ff4271f39e1
```

**If it matches**, record the platform, the date and the output in the PR that
enables that producer, and delete the throwaway credential/codeunit.

**If it does not match**, stop — do not issue grants. The likely causes, in the
order worth checking:

| Symptom | Likely cause |
|---|---|
| Same hex, different case | Digest case; already handled by `LowerCase`, so re-check you compared lowercased output |
| Completely different hex | The platform hashed the *key* differently — e.g. treating it as hex or base64 rather than raw UTF-8 bytes |
| Different hex, right length | The material differs — check for a smart-quote, a trailing newline, or a substituted pipe |
| Error resolving the key | NetSuite only: the credential GUID is not visible to the script that is signing (`restrictToScriptIds`) |

A mismatch is a genuine finding, not a configuration nuisance: it means the two
implementations disagree and no grant would ever have worked.

---

## Step 3 — end-to-end

With one real grant issued to a test user (`npm run embedded-role:grant -- --tenant … --platform … --account … --user … --role viewer --granted-by <you>`):

1. Open the embedded page as that user.
2. Confirm the session row has `user_identity = 'squire_verified'` and
   `verified_grant_id` equal to the issued grant.
3. Confirm a second load succeeds — if it fails with `user_assertion_replayed`,
   the nonce is not fresh per request.
4. Revoke the grant and confirm the next load falls back to `host_asserted`
   rather than erroring.

Use a `viewer` grant for this, not `approver`. A viewer grant proves the whole
path works while activating no authority, so a mistake during verification
cannot approve anything.
