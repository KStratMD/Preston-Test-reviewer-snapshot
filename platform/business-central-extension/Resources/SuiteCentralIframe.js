// SuiteCentral iframe control add-in — browser-side bundle.
//
// The AL host page calls Microsoft.Dynamics.NAV.InvokeExtensibilityMethod
// to invoke `Load(url)` with the absolute SuiteCentral URL the AL code
// resolved server-side. This script renders a sandboxed iframe into the
// control add-in container and updates its `src` on each Load() call.
//
// Important: this script never holds the SuiteCentral embedded service
// token. The AL page receives that token from a per-deployment placeholder
// (`GetSuiteCentralEmbeddedServiceToken`), uses it server-side via the
// HttpClient, and only ever passes the iframe URL down to this script.
(function () {
    "use strict";

    var iframe = null;

    function ensureIframe() {
        if (iframe) {
            return iframe;
        }
        var controlAddIn = document.getElementById("controlAddIn");
        if (!controlAddIn) {
            controlAddIn = document.body;
        }
        iframe = document.createElement("iframe");
        iframe.title = "SuiteCentral";
        iframe.style.width = "100%";
        iframe.style.height = "100%";
        iframe.style.border = "0";
        iframe.setAttribute("loading", "lazy");
        // sandbox is intentionally narrow; the SuiteCentral guest controls
        // its own CSP via /api/embedded/host-bootstrap response.
        iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
        controlAddIn.appendChild(iframe);
        return iframe;
    }

    function Load(embedSrcUrl) {
        var frame = ensureIframe();
        frame.src = embedSrcUrl;
    }

    // Two exposure paths to match the repo's existing BC control-add-in
    // convention (see integrations/business_central/src/scripts/startup.js):
    //   1. Top-level function `Load` so AL's CurrPage.SuiteCentralFrame.Load(...)
    //      dispatches by procedure name (BC runtime resolves the JS callable
    //      against the global function name).
    //   2. window.SuiteCentralIframeControl namespace so other in-page JS can
    //      drive the control add-in without colliding with unrelated globals,
    //      mirroring the window.PrestonEmbed pattern in the reference bundle.
    if (typeof window.Load !== "function") {
        window.Load = Load;
    }
    window.SuiteCentralIframeControl = window.SuiteCentralIframeControl || {};
    window.SuiteCentralIframeControl.Load = Load;

    // Signal the AL host that the control add-in is ready to receive Load().
    if (typeof Microsoft !== "undefined" &&
        Microsoft.Dynamics &&
        Microsoft.Dynamics.NAV &&
        typeof Microsoft.Dynamics.NAV.InvokeExtensibilityMethod === "function") {
        Microsoft.Dynamics.NAV.InvokeExtensibilityMethod("ControlAddInReady", []);
    }
})();
