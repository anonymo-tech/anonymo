"use client";

import { useEffect, useRef, useState } from "react";
import { createShader, type PresetConfig, type ShaderInstance } from "shaders/js";

// A two-ink halftone press: hard black dots and scarlet plates on muted stock.
export const HERO_PRINT = {
  ink: "#070806",
  paper: "#d1d2c6",
  accent: "#ee281c",
  dotDensity: 155,
  grain: 0.028,
  cursorStrength: 0.08,
  cursorDecay: 4.8,
} as const;

const HERO_PRESET: PresetConfig = {
  components: [
    {
      type: "FilmGrain",
      id: "hero-grain",
      props: { strength: HERO_PRINT.grain, bias: 2, animated: false },
      children: [
        {
          type: "Halftone",
          id: "hero-halftone",
          props: {
            style: "cmyk",
            frequency: HERO_PRINT.dotDensity,
            cyanAngle: 45,
            magentaAngle: 45,
            yellowAngle: 45,
            blackAngle: 45,
            misprint: 0,
            paperColor: HERO_PRINT.paper,
            cyanColor: HERO_PRINT.ink,
            magentaColor: HERO_PRINT.accent,
            yellowColor: HERO_PRINT.accent,
            blackColor: HERO_PRINT.ink,
          },
          children: [
            {
              type: "GridDistortion",
              id: "hero-cursor",
              props: {
                intensity: HERO_PRINT.cursorStrength,
                decay: HERO_PRINT.cursorDecay,
                radius: 0.35,
                gridSize: 28,
                edges: "stretch",
              },
              children: [
                {
                  type: "BrightnessContrast",
                  id: "hero-exposure",
                  props: { brightness: -0.025, contrast: 0.28 },
                  children: [
                    {
                      type: "VideoTexture",
                      id: "hero-horse",
                      props: { url: "/media/conclave-hero-film.mp4", objectFit: "cover", loop: true },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

export default function EngravedSurface({ onUnavailable }: { onUnavailable: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const unavailableRef = useRef(onUnavailable);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    unavailableRef.current = onUnavailable;
  }, [onUnavailable]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // A separate canvas per effect protects a new run from an older async init.
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:100%;height:100%";
    canvas.dataset.renderer = "shaders";
    host.appendChild(canvas);

    let disposed = false;
    let reportedUnavailable = false;
    let instance: ShaderInstance | null = null;
    const reportUnavailable = () => {
      if (disposed || reportedUnavailable) return;
      reportedUnavailable = true;
      setReady(false);
      unavailableRef.current();
    };

    createShader(canvas, HERO_PRESET, {
      colorSpace: "srgb",
      toneMapping: "linear",
      disableTelemetry: true,
      onReady: () => {
        if (!disposed && !reportedUnavailable) setReady(true);
      },
      onError: () => {
        if (disposed) return;
        setReady(false);
        // Device loss can recover; the instance only records terminal failures.
        if (instance?.getFailureReason()) reportUnavailable();
      },
    })
      .then((shader) => {
        if (disposed) {
          shader.destroy();
          return;
        }
        instance = shader;
        // Initialization may report a terminal failure before returning its handle.
        if (shader.getFailureReason()) reportUnavailable();
      })
      .catch(reportUnavailable);

    return () => {
      disposed = true;
      canvas.remove();
      instance?.destroy();
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className="engraved-hero-surface"
      data-shader-ready={ready}
      style={{ width: "100%", height: "100%" }}
    />
  );
}
