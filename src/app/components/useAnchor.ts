"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

const WIDTH = 300;
const GAP = 6;

// Positions a popover against the viewport next to its trigger, so scrolling
// containers (the table, the side panel) can't clip it. Closes on scroll and
// is re-placed on resize.
export function useAnchor<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null);
  const [style, setStyle] = useState<CSSProperties>({});

  const place = useCallback(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(16, Math.min(r.right - WIDTH, vw - WIDTH - 16));
    const HEIGHT = 230; // roughly the popover's height
    const below = r.bottom + GAP;
    const above = r.top - GAP - HEIGHT;
    // Below the trigger if it fits, else above it, else clamped on screen.
    const top = below + HEIGHT <= vh ? below : above >= 16 ? above : Math.max(16, Math.min(below, vh - HEIGHT - 16));
    setStyle({ position: "fixed", left, right: "auto", top, width: Math.min(WIDTH, vw - 32) });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    // Resize (e.g. a phone keyboard opening) re-places it; scrolling closes it.
    const close = () => onClose();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, place, onClose]);

  return { ref, style };
}
