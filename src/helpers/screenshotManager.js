const { nativeImage, screen, systemPreferences } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const debugLogger = require("./debugLogger");

// In-memory screenshot tray. Screenshots are collected here (NOT on the
// clipboard, which only holds one item) so the user can capture several in a
// row and have them all pasted into one chat message when dictation completes.
//
// macOS only for now: relies on the native `screencapture` CLI for interactive
// region selection (handles multi-monitor and Retina with zero coordinate math)
// and full-screen capture (the "freeze" snapshot used by the drag-annotation
// overlay in phase 2).
class ScreenshotManager {
  constructor() {
    /** @type {import("electron").NativeImage[]} */
    this.tray = [];
  }

  getTrayCount() {
    return this.tray.length;
  }

  clearTray() {
    this.tray = [];
  }

  addImage(image) {
    if (image && !image.isEmpty()) {
      this.tray.push(image);
      debugLogger.debug("[Screenshot] Added to tray", { count: this.tray.length });
    }
  }

  addDataUrl(dataUrl) {
    try {
      this.addImage(nativeImage.createFromDataURL(dataUrl));
    } catch (err) {
      debugLogger.warn("[Screenshot] Failed to add data URL to tray", { error: err.message });
    }
  }

  /** Returns all collected screenshots and empties the tray. */
  takeAll() {
    const shots = this.tray;
    this.tray = [];
    return shots;
  }

  /**
   * Interactive region capture via native `screencapture -i`. The user drags to
   * pick the region (works across all displays). Resolves true when an image was
   * captured and added to the tray, false when the user pressed Esc to cancel.
   */
  captureRegionToTray() {
    return new Promise((resolve) => {
      if (process.platform !== "darwin") {
        debugLogger.warn("[Screenshot] Region capture only implemented on macOS");
        resolve(false);
        return;
      }
      const tmp = path.join(os.tmpdir(), `openwhispr-shot-${Date.now()}.png`);
      const proc = spawn("screencapture", ["-i", tmp]);
      proc.on("error", (err) => {
        debugLogger.warn("[Screenshot] screencapture spawn failed", { error: err.message });
        resolve(false);
      });
      proc.on("close", () => {
        if (!fs.existsSync(tmp)) {
          // No file written => user cancelled (Esc).
          resolve(false);
          return;
        }
        try {
          const img = nativeImage.createFromPath(tmp);
          this.addImage(img);
          resolve(!img.isEmpty());
        } catch (err) {
          debugLogger.warn("[Screenshot] Failed to read capture", { error: err.message });
          resolve(false);
        } finally {
          try {
            fs.unlinkSync(tmp);
          } catch {}
        }
      });
    });
  }

  /**
   * Full-screen capture of the display the cursor is on, returned as a data URL.
   * Used as the frozen background for the drag-annotation overlay (phase 2): we
   * snapshot first so an open context menu stays visible even after the overlay
   * steals focus and the real menu dismisses.
   */
  captureCursorDisplay() {
    return new Promise((resolve) => {
      if (process.platform !== "darwin") {
        resolve(null);
        return;
      }
      const cursor = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(cursor);
      const tmp = path.join(os.tmpdir(), `openwhispr-freeze-${Date.now()}.png`);
      // -x: silent (no capture sound). -R<x,y,w,h>: capture an explicit screen
      // rect in the global coordinate space. We do NOT use -D<id> because
      // Electron's display.id is NOT the index/CGDirectDisplayID screencapture
      // expects, so -D silently fails and writes no file. -R with the display
      // bounds works reliably across multiple monitors and Retina.
      const b = display.bounds;
      const proc = spawn("screencapture", [
        "-x",
        `-R${b.x},${b.y},${b.width},${b.height}`,
        tmp,
      ]);
      proc.on("error", (err) => {
        debugLogger.warn("[Screenshot] freeze capture spawn failed", { error: err.message });
        resolve(null);
      });
      proc.on("close", () => {
        if (!fs.existsSync(tmp)) {
          resolve(null);
          return;
        }
        try {
          const img = nativeImage.createFromPath(tmp);
          resolve({
            dataUrl: img.toDataURL(),
            display: { id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor },
          });
        } catch (err) {
          debugLogger.warn("[Screenshot] Failed to read freeze capture", { error: err.message });
          resolve(null);
        } finally {
          try {
            fs.unlinkSync(tmp);
          } catch {}
        }
      });
    });
  }

  /** macOS Screen Recording permission status: "granted" | "denied" | "restricted" | "not-determined". */
  getScreenPermissionStatus() {
    try {
      return systemPreferences.getMediaAccessStatus("screen");
    } catch {
      return "unknown";
    }
  }
}

module.exports = ScreenshotManager;
