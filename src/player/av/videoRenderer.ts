export type VideoFitMode = "contain" | "cover";

/**
 * Draws decoded `VideoFrame`s onto a 2D canvas. Keeps the most recent frame
 * alive so the picture can be redrawn after a resize or while paused.
 */
export class CanvasVideoRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private current: VideoFrame | null = null;
  private fit: VideoFitMode = "cover";
  private observer: ResizeObserver | null = null;
  private pendingRedraw: number | null = null;
  private frameWidth = 0;
  private frameHeight = 0;

  attach(canvas: HTMLCanvasElement | null) {
    if (this.canvas === canvas) {
      return;
    }
    this.observer?.disconnect();
    this.observer = null;
    this.canvas = canvas;
    this.context = canvas ? canvas.getContext("2d", { alpha: false, desynchronized: true }) : null;
    if (canvas) {
      this.observer = new ResizeObserver(() => this.scheduleRedraw());
      this.observer.observe(canvas);
      this.scheduleRedraw();
    }
  }

  setFit(fit: VideoFitMode) {
    if (this.fit !== fit) {
      this.fit = fit;
      this.scheduleRedraw();
    }
  }

  get hasFrame() {
    return this.current !== null;
  }

  get frameSize() {
    return { width: this.frameWidth, height: this.frameHeight };
  }

  /** Takes ownership of `frame`; the previous frame is closed. */
  present(frame: VideoFrame) {
    if (this.current && this.current !== frame) {
      this.current.close();
    }
    this.current = frame;
    this.frameWidth = frame.displayWidth || frame.codedWidth;
    this.frameHeight = frame.displayHeight || frame.codedHeight;
    this.draw();
  }

  clear() {
    if (this.current) {
      this.current.close();
      this.current = null;
    }
    this.frameWidth = 0;
    this.frameHeight = 0;
    const canvas = this.canvas;
    const context = this.context;
    if (canvas && context) {
      context.fillStyle = "#020304";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  dispose() {
    this.observer?.disconnect();
    this.observer = null;
    if (this.pendingRedraw !== null) {
      cancelAnimationFrame(this.pendingRedraw);
      this.pendingRedraw = null;
    }
    this.clear();
    this.canvas = null;
    this.context = null;
  }

  private scheduleRedraw() {
    if (this.pendingRedraw !== null) {
      return;
    }
    this.pendingRedraw = requestAnimationFrame(() => {
      this.pendingRedraw = null;
      this.draw();
    });
  }

  private draw() {
    const canvas = this.canvas;
    const context = this.context;
    if (!canvas || !context) {
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) {
      return;
    }
    const frame = this.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const frameWidth = frame ? frame.displayWidth || frame.codedWidth : 0;
    const frameHeight = frame ? frame.displayHeight || frame.codedHeight : 0;
    // Never allocate a larger backing store than the source needs.
    const scale = frame && frameWidth > 0 ? Math.min(dpr, Math.max(1, frameWidth / bounds.width)) : dpr;
    const targetWidth = Math.max(1, Math.round(bounds.width * scale));
    const targetHeight = Math.max(1, Math.round(bounds.height * scale));
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    context.fillStyle = "#020304";
    context.fillRect(0, 0, targetWidth, targetHeight);
    if (!frame || frameWidth <= 0 || frameHeight <= 0) {
      return;
    }

    const scaleX = targetWidth / frameWidth;
    const scaleY = targetHeight / frameHeight;
    const factor = this.fit === "cover" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
    const drawWidth = Math.round(frameWidth * factor);
    const drawHeight = Math.round(frameHeight * factor);
    const left = Math.round((targetWidth - drawWidth) / 2);
    const top = Math.round((targetHeight - drawHeight) / 2);
    try {
      context.drawImage(frame, left, top, drawWidth, drawHeight);
    } catch {
      // The frame may already be closed during teardown.
    }
  }
}
