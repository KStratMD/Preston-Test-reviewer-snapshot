// SuiteCentral iframe control add-in.
//
// Declares the JavaScript-based control add-in that the
// SuiteCentralEmbeddedHostPart page references via its
// `usercontrol(SuiteCentralFrame; SuiteCentralIframeControl)` declaration.
// Without this object the AL project doesn't compile.
//
// The control hosts a single iframe element. The page's BootstrapSuiteCentral
// procedure calls .Load(<absoluteUrl>) with the SuiteCentral-origin URL after
// resolving the relative embedSrc returned by /api/embedded/host-bootstrap;
// the JS handler sets iframe.src to that URL.
controladdin SuiteCentralIframeControl
{
    Scripts = 'Resources/SuiteCentralIframe.js';
    HorizontalStretch = true;
    VerticalStretch = true;
    HorizontalShrink = true;
    VerticalShrink = true;
    MinimumHeight = 600;
    MinimumWidth = 400;
    RequestedHeight = 900;

    event ControlAddInReady();
    procedure Load(EmbedSrcUrl: Text);
}
