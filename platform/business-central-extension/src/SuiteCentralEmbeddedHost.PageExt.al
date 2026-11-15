// SuiteCentral embedded host — Business Central AL extension.
//
// Production rule: browser JavaScript never receives the raw SuiteCentral
// embedded service token. The AL host calls SuiteCentral host-bootstrap
// server-to-server via HttpClient and loads the returned iframe URL into
// a usercontrol. Real deployments must supply the service token through
// configured tenant settings, not via this file.
//
// Per-user grant enrolment (optional; see
// docs/runbooks/embedded-user-assertion-producers.md):
//   IsolatedStorage 'sc_grant_id'     — the embedded_role_grants id
//   IsolatedStorage 'sc_grant_secret' — that grant's secret, SetEncrypted
//
// Both are DataScope::User, so one user's grant cannot be read by another.
// When BOTH are present this host signs a user assertion and SuiteCentral marks
// the session squire_verified, activating that grant's role. When either is
// absent it sends the user id alone and the session stays host_asserted, which
// activates nothing — a missing enrolment must never resemble a verified one.
//
// UNVERIFIED FROM THIS REPOSITORY: whether CryptographyManagement.GenerateHash
// produces the same HMAC-SHA256 as Node, and in which hex case.
//
// AL cannot be EXECUTED in the Node test harness, which is a narrower gap than
// "untested". The material and header formats here are covered by source-text
// drift guards in tests/unit/embedded/businessCentralExtensionAdapter.test.ts:
// a careless edit to the format string or the field order fails CI. What those
// guards cannot do is run GenerateHash and compare its bytes, which is what the
// NetSuite producer gets by having its material builder extracted and executed
// against the published vector.
//
// So: format drift is caught here; primitive agreement is not. The known-answer
// check in the runbook is the only thing that establishes agreement, and it is
// required before the first real grant is issued — enforced by the operator CLI,
// which refuses to issue a grant for a platform absent from
// src/embedded/assertionConformance.ts.

pageextension 70050100 SuiteCentralCustomerCard extends "Customer Card"
{
    layout
    {
        addlast(FactBoxes)
        {
            part(SuiteCentralEmbeddedHost; SuiteCentralEmbeddedHostPart)
            {
                ApplicationArea = All;
            }
        }
    }
}

page 70050101 SuiteCentralEmbeddedHostPart
{
    PageType = CardPart;
    ApplicationArea = All;
    Caption = 'SuiteCentral';

    layout
    {
        area(content)
        {
            usercontrol(SuiteCentralFrame; SuiteCentralIframeControl)
            {
                ApplicationArea = All;

                trigger ControlAddInReady()
                begin
                    BootstrapSuiteCentral();
                end;
            }
        }
    }

    actions
    {
        area(Processing)
        {
            action(EnrollSquireGrant)
            {
                ApplicationArea = All;
                Caption = 'Enroll Squire grant';
                ToolTip = 'Store the grant id and secret issued to you by a Squire operator. Both are kept per-user; the secret is encrypted at rest.';
                Image = EncryptionKeys;

                trigger OnAction()
                var
                    GrantId: Text;
                    Secret: Text;
                begin
                    if not Dialog.Confirm('Enroll a Squire grant for your user?', true) then
                        exit;
                    GrantId := PromptForText('Grant id (erg_...)');
                    Secret := PromptForText('Grant secret (shown once by the operator)');
                    if (GrantId = '') or (Secret = '') then
                        Error('Both the grant id and the secret are required. Nothing was stored.');

                    // Per-user scope: another user on this tenant cannot read
                    // it. SetEncrypted, not Set — the secret is the only thing
                    // standing between a host operator and impersonating this
                    // user to SuiteCentral.
                    IsolatedStorage.Set('sc_grant_id', GrantId, DataScope::User);
                    IsolatedStorage.SetEncrypted('sc_grant_secret', Secret, DataScope::User);
                    Message('Squire grant enrolled. Reopen this page to sign in with it.');
                end;
            }
        }
    }

    local procedure BootstrapSuiteCentral()
    var
        Client: HttpClient;
        Request: HttpRequestMessage;
        Response: HttpResponseMessage;
        Content: HttpContent;
        Headers: HttpHeaders;
        BodyObject: JsonObject;
        BodyText: Text;
        ResponseText: Text;
        ResponseObject: JsonObject;
        EmbedSrcToken: JsonToken;
        EmbedSrc: Text;
        BaseUrl: Text;
        UserId: Text;
        GrantId: Text;
        GrantSecret: Text;
        Nonce: Text;
        Timestamp: Integer;
        Material: Text;
        AssertionHeader: Text;
    begin
        // Build the request body via AL JsonObject so quotes/backslashes in
        // configured identifiers or the host URL can't break the JSON envelope.
        // platformAccountId must equal the BC environment identifier configured
        // on the matching service-token row (validateHostBootstrap cross-checks
        // body.platformAccountId against the token's platform_account_id at
        // src/middleware/embeddedAuthMiddleware.ts:126). CompanyName() is not
        // stable enough (e.g. 'CRONUS USA, Inc.' varies per company); use the
        // explicit per-deployment configuration getter.
        BodyObject.Add('platformAccountId', GetSuiteCentralPlatformAccountId());
        // expectedHostOrigin must be the ORIGIN only (no path) so it matches
        // the server-side allowlist regex `^https://[^/]+\.dynamics\.com$`
        // enforced by src/routes/embedded/hostBootstrapRouter.ts.
        BodyObject.Add('expectedHostOrigin', GetCurrentHostOrigin());
        // UserSecurityId is the identity a Squire grant is scoped to for BC
        // users. Sent unconditionally: it tells the guest UI who is looking,
        // and on its own it authorizes nothing.
        UserId := Format(UserSecurityId());
        BodyObject.Add('userId', UserId);
        BodyObject.WriteTo(BodyText);

        Content.WriteFrom(BodyText);
        Content.GetHeaders(Headers);
        Headers.Clear();
        Headers.Add('Content-Type', 'application/json');

        // Normalize once — a configured BaseUrl with a trailing slash would
        // otherwise produce double-slash request URIs (https://host//api/...)
        // and double-slash iframe URLs (https://host//modulePath?...) below.
        BaseUrl := NormalizeBaseUrl(GetSuiteCentralBaseUrl());
        Request.SetRequestUri(BaseUrl + '/api/embedded/host-bootstrap');
        Request.Method := 'POST';
        Request.Content := Content;
        Request.GetHeaders(Headers);
        Headers.Add('Authorization', 'Bearer ' + GetSuiteCentralEmbeddedServiceToken());
        Headers.Add('X-Embedded-Platform', 'business_central');

        // Only a COMPLETE enrolment signs. A grant id without its secret cannot
        // be signed for, and a secret without its grant id has nothing to name;
        // sending a half-formed assertion would earn a 401 and lock the user
        // out of a page that otherwise works.
        if TryGetGrantEnrolment(GrantId, GrantSecret) then begin
            Nonce := NewAssertionNonce();
            Timestamp := CurrentUnixSeconds();
            Material := BuildAssertionMaterial(
                GrantId,
                GetSuiteCentralTenantId(),
                'business_central',
                GetSuiteCentralPlatformAccountId(),
                UserId,
                Timestamp,
                Nonce);
            AssertionHeader := BuildUserAssertionHeader(
                GrantId, Timestamp, Nonce, ComputeHmacSha256Hex(Material, GrantSecret));
            Headers.Add('X-Squire-User-Assertion', AssertionHeader);
        end;

        if not Client.Send(Request, Response) then
            Error('SuiteCentral host-bootstrap request failed');
        if not Response.IsSuccessStatusCode() then
            // Don't include Response body — it can carry internal detail
            // and may be arbitrarily large. Status code is enough for an
            // operator-visible Error; full body lives in server-side logs.
            Error('SuiteCentral host-bootstrap returned %1', Response.HttpStatusCode());

        Response.Content().ReadAs(ResponseText);
        if not ResponseObject.ReadFrom(ResponseText) then
            Error('SuiteCentral host-bootstrap returned non-JSON response');
        if not ResponseObject.Get('embedSrc', EmbedSrcToken) then
            Error('SuiteCentral host-bootstrap response missing embedSrc');
        EmbedSrc := EmbedSrcToken.AsValue().AsText();
        if (EmbedSrc = '') or (EmbedSrc[1] <> '/') then
            Error('SuiteCentral host-bootstrap returned an invalid embedSrc');

        // embedSrc is a RELATIVE path (`/modulePath?embeddedContextId=...`).
        // Prefix with BaseUrl so the iframe loads from the SuiteCentral
        // origin, not the BC tenant origin.
        CurrPage.SuiteCentralFrame.Load(BaseUrl + EmbedSrc);
    end;

    local procedure NormalizeBaseUrl(RawBaseUrl: Text): Text
    var
        Stripped: Text;
    begin
        // Require https:// — BootstrapSuiteCentral sends 'Authorization: Bearer
        // <token>' to BaseUrl + '/api/embedded/host-bootstrap', so a configured
        // http:// value would transmit the embedded service token over plaintext.
        // Hard-fail at the normalization boundary so the misconfiguration cannot
        // even reach the HttpClient.Send call.
        if not RawBaseUrl.StartsWith('https://') then
            Error('SuiteCentralBaseUrl must use https:// — refusing to send bearer token over plaintext');

        // Strip exactly one trailing slash if present. We don't loop because
        // the configured value is operator-supplied; a value ending in `//`
        // is malformed enough that the caller should fix the configuration.
        Stripped := RawBaseUrl;
        if (StrLen(Stripped) > 0) and (Stripped[StrLen(Stripped)] = '/') then
            exit(CopyStr(Stripped, 1, StrLen(Stripped) - 1));
        exit(Stripped);
    end;

    local procedure GetCurrentHostOrigin(): Text
    var
        FullUrl: Text;
        SchemeEnd: Integer;
        OriginEnd: Integer;
    begin
        // GetUrl returns the full URL (e.g. https://businesscentral.dynamics.com/abc/...).
        // The server allowlist requires origin only — extract scheme + host.
        FullUrl := GetUrl(ClientType::Web);
        SchemeEnd := StrPos(FullUrl, '://');
        if SchemeEnd = 0 then
            Error('GetUrl returned an unexpected shape: %1', FullUrl);
        OriginEnd := StrPos(CopyStr(FullUrl, SchemeEnd + 3), '/');
        if OriginEnd = 0 then
            exit(FullUrl);
        exit(CopyStr(FullUrl, 1, SchemeEnd + 2 + OriginEnd - 1));
    end;

    local procedure GetSuiteCentralBaseUrl(): Text
    begin
        // Fail loudly until a deployment configures the real SuiteCentral base
        // URL. Returning a hardcoded placeholder here would risk sending the
        // bearer token to the wrong host if an operator configured the token
        // but missed this URL (credential exfiltration shape).
        Error('Configure SuiteCentralBaseUrl before deployment');
    end;

    local procedure GetSuiteCentralEmbeddedServiceToken(): Text
    begin
        Error('Configure SuiteCentralEmbeddedServiceToken before deployment');
    end;

    local procedure GetSuiteCentralPlatformAccountId(): Text
    begin
        // The configured BC environment identifier that matches the service
        // token's platform_account_id (see validateHostBootstrap at
        // src/middleware/embeddedAuthMiddleware.ts:126). Fail loudly until
        // a deployment configures this.
        Error('Configure SuiteCentralPlatformAccountId before deployment');
    end;

    local procedure GetSuiteCentralTenantId(): Text
    begin
        // The SuiteCentral tenant id. This is NOT sent in the bootstrap body —
        // the server takes the tenant from the service-token row — but it IS
        // part of the signed assertion material, so the producer has to know
        // the same value the server will use. A mismatch here produces a valid
        // HMAC over the wrong material, which fails verification and is
        // indistinguishable from a wrong secret.
        Error('Configure SuiteCentralTenantId before deployment');
    end;

    /// <summary>
    /// The material SuiteCentral signs, byte for byte.
    /// MUST match assertionMaterial() in src/embedded/userAssertion.ts.
    /// </summary>
    local procedure BuildAssertionMaterial(GrantId: Text; TenantId: Text; Platform: Text; PlatformAccountId: Text; UserId: Text; Timestamp: Integer; Nonce: Text): Text
    begin
        exit(StrSubstNo('%1|%2|%3|%4|%5|%6|%7', GrantId, TenantId, Platform, PlatformAccountId, UserId, Timestamp, Nonce));
    end;

    /// <summary>
    /// Assemble the header. The digest is lowercased because SuiteCentral
    /// compares hex in constant time against a lowercase digest, and an
    /// uppercase string is a silent mismatch rather than an error.
    /// </summary>
    local procedure BuildUserAssertionHeader(GrantId: Text; Timestamp: Integer; Nonce: Text; HmacHex: Text): Text
    begin
        exit(StrSubstNo('v1.%1.%2.%3.%4', GrantId, Timestamp, Nonce, LowerCase(HmacHex)));
    end;

    /// <summary>
    /// HMAC-SHA256 of Material under Secret, as hex.
    ///
    /// THE ONE STEP THIS REPOSITORY CANNOT VERIFY. AL does not run in the Node
    /// test harness, so nothing in CI proves GenerateHash agrees with Node's
    /// crypto — and a disagreement fails closed and silently, looking exactly
    /// like a wrong secret. The known-answer check in
    /// docs/runbooks/embedded-user-assertion-producers.md is what establishes
    /// agreement, and it is required before the first real grant is issued.
    /// </summary>
    local procedure ComputeHmacSha256Hex(Material: Text; Secret: Text): Text
    var
        CryptographyManagement: Codeunit "Cryptography Management";
    begin
        exit(LowerCase(CryptographyManagement.GenerateHash(Material, Secret, HashAlgorithmType::HMACSHA256)));
    end;

    /// <summary>
    /// A fresh nonce: a v4 GUID stripped to 32 hex characters.
    ///
    /// Inside SuiteCentral's 22..128 bound and within its base64url character
    /// set, so the header parses. A GUID is used rather than a counter or a
    /// timestamp because a predictable nonce would let someone spend a
    /// legitimate user's nonce before they do — a denial of service rather than
    /// a forgery, but there is no reason to accept it.
    /// </summary>
    local procedure NewAssertionNonce(): Text
    begin
        exit(DelChr(Format(CreateGuid()), '=', '{}-'));
    end;

    local procedure CurrentUnixSeconds(): Integer
    begin
        // SuiteCentral rejects an assertion more than 300 seconds from its own
        // clock, so this must be real UTC epoch seconds, not local time.
        exit(Round((CurrentDateTime() - CreateDateTime(DMY2Date(1, 1, 1970), 0T)) / 1000, 1, '<'));
    end;

    /// <summary>
    /// Read this user's grant enrolment. Returns false unless BOTH halves are
    /// present — either alone is a half-finished enrolment, and treating it as
    /// usable would produce assertions SuiteCentral rejects with no indication
    /// why.
    /// </summary>
    local procedure TryGetGrantEnrolment(var GrantId: Text; var Secret: Text): Boolean
    begin
        if not IsolatedStorage.Contains('sc_grant_id', DataScope::User) then
            exit(false);
        if not IsolatedStorage.Contains('sc_grant_secret', DataScope::User) then
            exit(false);
        if not IsolatedStorage.Get('sc_grant_id', DataScope::User, GrantId) then
            exit(false);
        // GetEncrypted, matching the SetEncrypted used at enrolment.
        if not IsolatedStorage.GetEncrypted('sc_grant_secret', DataScope::User, Secret) then
            exit(false);
        exit((GrantId <> '') and (Secret <> ''));
    end;

    local procedure PromptForText(Prompt: Text): Text
    var
        Entered: Text;
    begin
        // A plain input prompt. The secret is echoed as the operator types it;
        // BC has no masked-input primitive on this surface, which is one more
        // reason the secret is delivered out of band and stored encrypted
        // immediately rather than kept anywhere the user can re-read it.
        if not Dialog.Input(Prompt, Entered) then
            exit('');
        exit(Entered);
    end;
}
