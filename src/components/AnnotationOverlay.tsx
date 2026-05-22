import React, { useCallback, useEffect, useRef, useState } from "react";

// Fullscreen drag-annotation overlay (phase 2). Shown on top of a frozen
// snapshot of the cursor's display. The user drags arrows ("move this to
// there"); a second press of the drag hotkey (→ "annotation-finish") or the
// Done button exports the annotated frame to the screenshot tray. Esc cancels.
//
// The window covers exactly one display, so window.innerWidth/Height equal the
// display bounds in CSS px and window.devicePixelRatio equals its scaleFactor.
// We back the canvas at device pixels so the exported PNG is full resolution.

type Point = { x: number; y: number };
type Arrow = { from: Point; to: Point; color: string };

const COLORS = ["#ff3b30", "#0a84ff", "#34c759", "#ffd60a", "#ffffff", "#000000"];
const LINE_WIDTH = 4;

const api: any = (window as any).electronAPI || {};

export default function AnnotationOverlay() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const arrowsRef = useRef<Arrow[]>([]);
  const draftRef = useRef<Arrow | null>(null);
  const cursorRef = useRef<Point | null>(null);
  const drawingRef = useRef(false);
  const colorRef = useRef<string>(COLORS[0]);

  const [color, setColor] = useState<string>(COLORS[0]);
  const [, setTick] = useState(0); // force toolbar re-render

  const drawArrow = (ctx: CanvasRenderingContext2D, a: Arrow) => {
    const { from, to, color } = a;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const angle = Math.atan2(dy, dx);
    const head = 18;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = LINE_WIDTH;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  };

  const render = useCallback((includeCursor: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (bgImageRef.current) {
      ctx.drawImage(bgImageRef.current, 0, 0, w, h);
    }
    for (const a of arrowsRef.current) drawArrow(ctx, a);
    if (draftRef.current) drawArrow(ctx, draftRef.current);

    if (includeCursor && cursorRef.current) {
      const c = cursorRef.current;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 9, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = colorRef.current;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(c.x, c.y, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = colorRef.current;
      ctx.fill();
    }
  }, []);

  const sizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    render(true);
  }, [render]);

  const reset = useCallback(() => {
    arrowsRef.current = [];
    draftRef.current = null;
    drawingRef.current = false;
    bgImageRef.current = null;
    cursorRef.current = null;
    render(true);
  }, [render]);

  const exportAndFinish = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    render(false); // exclude the custom cursor from the export
    const dataUrl = canvas.toDataURL("image/png");
    api.annotationDone?.(dataUrl);
    reset();
  }, [render, reset]);

  const cancel = useCallback(() => {
    api.annotationCancel?.();
    reset();
  }, [reset]);

  // IPC wiring from main / windowManager.
  useEffect(() => {
    const offInit = api.onAnnotationInit?.((_e: unknown, payload: { dataUrl: string }) => {
      const img = new Image();
      img.onload = () => {
        bgImageRef.current = img;
        sizeCanvas();
      };
      img.src = payload.dataUrl;
    });
    const offFinish = api.onAnnotationFinish?.(() => exportAndFinish());
    const offReset = api.onAnnotationReset?.(() => reset());
    return () => {
      offInit?.();
      offFinish?.();
      offReset?.();
    };
  }, [sizeCanvas, exportAndFinish, reset]);

  useEffect(() => {
    const onResize = () => sizeCanvas();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
      else if (e.key === "Enter") exportAndFinish();
      else if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        arrowsRef.current.pop();
        render(true);
      }
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
    };
  }, [sizeCanvas, cancel, exportAndFinish, render]);

  const pointFromEvent = (e: React.MouseEvent): Point => ({ x: e.clientX, y: e.clientY });

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const p = pointFromEvent(e);
    drawingRef.current = true;
    draftRef.current = { from: p, to: p, color: colorRef.current };
    cursorRef.current = p;
    render(true);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const p = pointFromEvent(e);
    cursorRef.current = p;
    if (drawingRef.current && draftRef.current) {
      draftRef.current = { ...draftRef.current, to: p };
    }
    render(true);
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (!drawingRef.current || !draftRef.current) return;
    const p = pointFromEvent(e);
    const a = { ...draftRef.current, to: p };
    // Ignore accidental clicks with no drag distance.
    if (Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y) > 6) {
      arrowsRef.current.push(a);
    }
    draftRef.current = null;
    drawingRef.current = false;
    render(true);
  };

  const pickColor = (c: string) => {
    colorRef.current = c;
    setColor(c);
    setTick((t) => t + 1);
  };

  const btn: React.CSSProperties = {
    background: "rgba(255,255,255,0.12)",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 13,
    cursor: "pointer",
  };

  return (
    <div style={{ position: "fixed", inset: 0, cursor: "none", overflow: "hidden" }}>
      <canvas
        ref={canvasRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        style={{ display: "block", position: "absolute", inset: 0 }}
      />
      <div
        style={{
          position: "fixed",
          top: 16,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          borderRadius: 12,
          background: "rgba(20,20,22,0.82)",
          backdropFilter: "blur(12px)",
          boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
          cursor: "default",
          userSelect: "none",
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseMove={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
      >
        {COLORS.map((c) => (
          <button
            key={c}
            onClick={() => pickColor(c)}
            title={c}
            style={{
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: c,
              border: c === color ? "2px solid #fff" : "2px solid rgba(255,255,255,0.25)",
              cursor: "pointer",
              padding: 0,
            }}
          />
        ))}
        <span style={{ width: 1, height: 20, background: "rgba(255,255,255,0.2)" }} />
        <button
          style={btn}
          onClick={() => {
            arrowsRef.current.pop();
            render(true);
          }}
        >
          Undo
        </button>
        <button style={btn} onClick={cancel}>
          Annuleren
        </button>
        <button style={{ ...btn, background: "#0a84ff" }} onClick={exportAndFinish}>
          Klaar
        </button>
      </div>
    </div>
  );
}
