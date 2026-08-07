// SuiteCentral embedded host — Business Central AL extension.
//
// Production rule: browser JavaScript never receives the raw SuiteCentral
// embedded service token. The AL host calls SuiteCentral host-bootstrap
// server-to-server via HttpClient and loads the returned iframe URL into
// a usercontrol. Real deployments must supply the service token through
// configured tenant settings, not via this file.

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
}
