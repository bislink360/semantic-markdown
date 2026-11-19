/**
 * Drives one sandboxed preview `<iframe>`: builds its document, hands it a private update port once it loads, and
 * sends later edits through that port. The playground has three (Preview, and both sides of Compare); each gets
 * its own controller, so one frame navigating away or rebuilding never affects the others.
 *
 * Document text never becomes markup in the playground page itself: it only reaches the frame's `srcdoc`, under
 * the sandbox and CSP described in frame.ts and playground/README.md.
 */
import { PREVIEW_SANDBOX, needsRebuild, previewDocument, updateMessage, type FrameAssets, type FrameState, type ThemeSetting } from './frame';
import type { PreviewPane } from './panes';

export class PreviewFrame {
  private built: FrameState | undefined;
  private frameReady = false;
  private expectingLoad = false;
  /** The private channel to the current preview document; updates go only through it (see openPreviewPort). */
  private previewPort: MessagePort | undefined;
  private latest: { preview: PreviewPane; pref: ThemeSetting } | undefined;

  constructor(private readonly frame: HTMLIFrameElement, private readonly assets: FrameAssets) {
    frame.addEventListener('load', () => this.onLoad());
  }

  /** Shows a pane: rebuilds the frame when needed (frame.ts, needsRebuild), else updates it in place. */
  show(preview: PreviewPane, pref: ThemeSetting): void {
    this.latest = { preview, pref };
    const { assets } = this;
    if (needsRebuild(this.built, preview, Boolean(assets.mermaid))) {
      this.built = { lang: preview.lang, mermaid: Boolean(preview.mermaid && assets.mermaid), style: preview.style };
      this.closePreviewPort();
      this.expectingLoad = true;
      this.frame.setAttribute('sandbox', PREVIEW_SANDBOX);
      this.frame.srcdoc = previewDocument(preview, pref, assets, location.origin);
      return;
    }
    if (this.frameReady) this.previewPort?.postMessage(updateMessage(preview, pref));
  }

  private closePreviewPort(): void {
    this.previewPort?.close();
    this.previewPort = undefined;
    this.frameReady = false;
  }

  /**
   * Hands the preview document that just loaded a private MessageChannel port; every update goes through it, never
   * through window.postMessage. A port is bound to the document that received it, so if the frame later navigates
   * away (a shared document may hold raw HTML such as a meta refresh), updates stop reaching it instead of following
   * it to another site, even when that site never finishes loading. The handshake itself carries only the port.
   */
  private openPreviewPort(): void {
    const channel = new MessageChannel();
    this.previewPort = channel.port1;
    // The frame has an opaque origin, so '*' is the only target origin that reaches it; the message holds no content.
    this.frame.contentWindow?.postMessage({ type: 'smd-port' }, '*', [channel.port2]); // NOSONAR(typescript:S2819): see above
  }

  private onLoad(): void {
    if (!this.expectingLoad) {
      // The frame navigated away from the preview on its own: rebuild it on the next render.
      this.built = undefined;
      this.closePreviewPort();
      return;
    }
    this.expectingLoad = false;
    this.openPreviewPort();
    this.frameReady = true;
    if (this.latest) this.show(this.latest.preview, this.latest.pref);
  }
}
