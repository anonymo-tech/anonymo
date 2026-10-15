"use client";

import { useT } from '@/lib/i18n';
import { useEffect, useId, useRef, type ReactNode } from "react";
import {
  seekUiMorph,
  UI_MORPH_STATIC_TIME,
  type UiMorphFrame,
  type UiMorphKind,
  type UiMorphState,
} from "./ui-morph-engine";
import "./ui-morph.css";

// Set only when the first diagram enters view; poses still depend solely on
// elapsed time, and later visible instances share the same clock origin.
let visibleEpoch: number | undefined;

type PanelProps = {
  id: UiMorphState;
  frame: UiMorphFrame;
  prefix: string;
  children: ReactNode;
};

function Panel({ id, frame, prefix, children }: PanelProps) {
  const pose = frame.panels.find((panel) => panel.id === id);
  return (
    <g
      data-panel={id}
      opacity={pose?.opacity ?? 0}
      filter={`url(#${prefix}-${id})`}
    >
      {children}
    </g>
  );
}

function Arrow({
  x,
  y,
  paper = false,
}: {
  x: number;
  y: number;
  paper?: boolean;
}) {
  return (
    <path
      className={paper ? "morph-paper-stroke" : "morph-stroke"}
      d={`M${x} ${y + 6}h11m-5-5 5 5-5 5`}
    />
  );
}

function Check({
  x,
  y,
  paper = false,
}: {
  x: number;
  y: number;
  paper?: boolean;
}) {
  return (
    <path
      className={paper ? "morph-paper-stroke" : "morph-stroke"}
      d={`m${x} ${y + 5} 4 4 8-9`}
    />
  );
}

function CouncilPanels({
  frame,
  prefix,
}: {
  frame: UiMorphFrame;
  prefix: string;
}) {
  const t = useT();
  const experiment = t("Start with one{line}clear experiment.", { line: "\n" }).split("\n");
  const risks = t("Find the risks{line}before you commit.", { line: "\n" }).split("\n");
  return (
    <>
      <Panel id="prompt" frame={frame} prefix={prefix}>
        <path className="morph-stroke" d="M43 111v14m-7-7h14" />
        <text x="65" y="122" className="morph-strong" fontSize="14">
          {t("A second perspective?")}
        </text>
        <circle cx="300" cy="118" r="17" className="morph-ink" />
        <Arrow x={294} y={112} paper />
      </Panel>
      <Panel id="loading" frame={frame} prefix={prefix}>
        <circle cx="175" cy="117.5" r="20" className="morph-rule" />
        <g data-detail="spinner">
          <path
            d="M175 97.5a20 20 0 0 1 20 20"
            stroke="var(--morph-red)"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </g>
        <path
          className="morph-ink"
          d="m175 111 2 4.5 4.5 2-4.5 2-2 4.5-2-4.5-4.5-2 4.5-2Z"
        />
      </Panel>
      <Panel id="tabs" frame={frame} prefix={prefix}>
        <defs>
          <clipPath id={`${prefix}-tab-selection`}>
            <rect
              data-detail="tab-clip"
              x={frame.details.tabEdges.left}
              y="93"
              width={frame.details.tabEdges.right - frame.details.tabEdges.left}
              height="28"
              rx="6"
            />
          </clipPath>
        </defs>
        <text x="42" y="74" className="morph-title">
          {t("Choose your council.")}
        </text>
        <rect
          x="39"
          y="90"
          width="272"
          height="34"
          rx="8"
          className="morph-inset"
        />
        <rect
          data-detail="tab-selection"
          x={frame.details.tabEdges.left}
          y="93"
          width={frame.details.tabEdges.right - frame.details.tabEdges.left}
          height="28"
          rx="6"
          className="morph-ink"
        />
        <text x="84" y="112" textAnchor="middle">
          {t("Reason")}
        </text>
        <text x="172" y="112" textAnchor="middle">
          {t("Question")}
        </text>
        <text x="262" y="112" textAnchor="middle" className="morph-strong">
          {t("Compare")}
        </text>
        <g clipPath={`url(#${prefix}-tab-selection)`}>
          <text x="84" y="112" textAnchor="middle" className="morph-paper">
            {t("Reason")}
          </text>
          <text x="172" y="112" textAnchor="middle" className="morph-paper">
            {t("Question")}
          </text>
          <text
            x="262"
            y="112"
            textAnchor="middle"
            className="morph-paper morph-strong"
          >
            {t("Compare")}
          </text>
        </g>
        <circle cx="47" cy="150" r="4" className="morph-red" />
        <text x="60" y="154" className="morph-muted">
          {t("One question. Different minds.")}
        </text>
        <path d="M42 170h266" className="morph-rule" />
      </Panel>
      <Panel id="compare" frame={frame} prefix={prefix}>
        <text x="31" y="55" className="morph-title">
          {t("Two ways to see it.")}
        </text>
        <rect
          x="270"
          y="41"
          width="48"
          height="22"
          rx="11"
          className="morph-ink"
        />
        <text
          x="294"
          y="56"
          textAnchor="middle"
          className="morph-paper morph-small"
        >
          {t("Blind")}
        </text>
        <path d="M30 72h289M175 83v103" className="morph-rule" />
        <circle cx="42" cy="94" r="9" className="morph-ink" />
        <text
          x="42"
          y="98"
          textAnchor="middle"
          className="morph-paper morph-small"
        >
          A
        </text>
        <text x="58" y="98" className="morph-small morph-muted">
          {t("Perspective A")}
        </text>
        <circle cx="197" cy="94" r="9" className="morph-red" />
        <text
          x="197"
          y="98"
          textAnchor="middle"
          className="morph-paper morph-small"
        >
          B
        </text>
        <text x="213" y="98" className="morph-small morph-muted">
          {t("Perspective B")}
        </text>
        <text x="32" y="128" className="morph-large">
          {t("Build fast.")}
        </text>
        <text x="187" y="128" className="morph-large">
          {t("Check first.")}
        </text>
        <text x="32" y="151">
          {experiment[0]}
        </text>
        <text x="32" y="167">
          {experiment[1]}
        </text>
        <text x="187" y="151">
          {risks[0]}
        </text>
        <text x="187" y="167">
          {risks[1]}
        </text>
        <path d="M32 185h120M187 185h130" className="morph-rule" />
      </Panel>
      <Panel id="vote" frame={frame} prefix={prefix}>
        <text x="44" y="66" className="morph-title">
          {t("Which answer holds?")}
        </text>
        <rect
          x="42"
          y="82"
          width="266"
          height="36"
          rx="8"
          className="morph-inset"
        />
        <text x="56" y="105">
          {t("A / The practical case")}
        </text>
        <circle cx="286" cy="100" r="7" fill="none" className="morph-rule" />
        <rect
          x="42"
          y="127"
          width="266"
          height="36"
          rx="8"
          className="morph-ink"
        />
        <text x="56" y="150" className="morph-paper">
          {t("B / The critical perspective")}
        </text>
        <circle
          cx="286"
          cy="145"
          r="7"
          fill="none"
          stroke="var(--morph-paper)"
        />
        <g data-detail="vote" opacity={frame.details.vote}>
          <circle cx="286" cy="145" r="7" className="morph-red" />
          <path d="m282 145 3 3 5-6" className="morph-paper-stroke" />
        </g>
        <text x="44" y="184" className="morph-small morph-muted">
          {t("Choose the thought, then reveal the model.")}
        </text>
      </Panel>
      <Panel id="brief" frame={frame} prefix={prefix}>
        <rect
          x="64"
          y="37"
          width="28"
          height="30"
          rx="5"
          className="morph-ink"
        />
        <path d="M72 46h12m-12 5h12m-12 5h7" className="morph-paper-stroke" />
        <text x="104" y="49" className="morph-title">
          {t("Decision Brief")}
        </text>
        <text x="104" y="65" className="morph-small morph-muted">
          {t("Keep the reasoning.")}
        </text>
        <path d="M64 81h222" className="morph-rule" />
        <text x="64" y="103" className="morph-strong">
          {t("The next step")}
        </text>
        <text x="64" y="127">
          {t("Test the idea.")}
        </text>
        <text x="64" y="146">
          {t("Keep the objections.")}
        </text>
        <text x="64" y="165">
          {t("Record the decision.")}
        </text>
        <rect
          x="64"
          y="181"
          width="222"
          height="22"
          rx="6"
          className="morph-inset"
        />
        <text x="77" y="196" className="morph-small morph-strong">
          {t("A portable record")}
        </text>
        <Arrow x={265} y={186} />
      </Panel>
    </>
  );
}

function BoundaryPanels({
  frame,
  prefix,
}: {
  frame: UiMorphFrame;
  prefix: string;
}) {
  const t = useT();
  return (
    <>
      <Panel id="route" frame={frame} prefix={prefix}>
        <rect
          data-detail="route-focus"
          x="40"
          y="76"
          width="270"
          height="30"
          rx="6"
          className="morph-inset"
          opacity={frame.details.routeFocus}
        />
        <text x="49" y="52" className="morph-title">
          {t("Route Card")}
        </text>
        <rect
          x="249"
          y="36"
          width="52"
          height="22"
          rx="11"
          className="morph-inset"
        />
        <text x="275" y="51" textAnchor="middle" className="morph-small">
          {t("Preview")}
        </text>
        <path d="M49 68h252" className="morph-rule" />
        <text x="49" y="93" className="morph-muted">
          {t("Destination")}
        </text>
        <text x="301" y="93" textAnchor="end" className="morph-strong">
          {t("Hosted model")}
        </text>
        <text x="49" y="119" className="morph-muted">
          {t("Retention")}
        </text>
        <text x="301" y="119" textAnchor="end" className="morph-strong">
          {t("Policy shown")}
        </text>
        <text x="49" y="145" className="morph-muted">
          {t("Your minimum")}
        </text>
        <text x="301" y="145" textAnchor="end" className="morph-strong">
          {t("You decide")}
        </text>
        <rect
          x="49"
          y="163"
          width="252"
          height="29"
          rx="7"
          className="morph-ink"
        />
        <text x="63" y="182" className="morph-paper">
          {t("Inspect the terms")}
        </text>
        <Arrow x={277} y={171} paper />
      </Panel>
      <Panel id="privacy" frame={frame} prefix={prefix}>
        <text x="51" y="80" className="morph-title">
          {t("Set your boundary.")}
        </text>
        <text x="51" y="121" className="morph-strong" fontSize="14">
          {t("Strict privacy")}
        </text>
        <rect
          x="247"
          y="103"
          width="48"
          height="26"
          rx="13"
          className="morph-inset"
        />
        <rect
          data-detail="toggle-track"
          x="247"
          y="103"
          width="48"
          height="26"
          rx="13"
          className="morph-red"
          opacity={frame.details.toggle}
        />
        <rect
          data-detail="toggle-thumb"
          x={frame.details.toggleEdges.left}
          y="106"
          width={
            frame.details.toggleEdges.right - frame.details.toggleEdges.left
          }
          height="20"
          rx="10"
          className="morph-paper"
          stroke="var(--morph-line)"
        />
        <path d="M51 143h246" className="morph-rule" />
        <text x="51" y="163" className="morph-small morph-muted">
          {t("Refuse a route below your minimum.")}
        </text>
      </Panel>
      <Panel id="guard" frame={frame} prefix={prefix}>
        <text x="48" y="59" className="morph-title">
          {t("Before anything leaves.")}
        </text>
        <rect
          x="47"
          y="77"
          width="256"
          height="44"
          rx="8"
          className="morph-inset"
        />
        <g
          data-detail="guard-raw"
          opacity={Math.max(0, 1 - 2 * frame.details.redaction)}
        >
          <text x="61" y="104" className="morph-strong">
            API_KEY = demo_example
          </text>
        </g>
        <g
          data-detail="guard-clean"
          opacity={Math.max(0, 2 * frame.details.redaction - 1)}
        >
          <rect
            x="59"
            y="88"
            width="100"
            height="22"
            rx="4"
            className="morph-ink"
          />
          <text x="67" y="103" className="morph-paper morph-small">
            {t("[REDACTED]")}
          </text>
          <Check x={278} y={94} />
        </g>
        <circle cx="54" cy="140" r="4" className="morph-red" />
        <text x="66" y="144" className="morph-small morph-muted">
          {t("Synthetic example · caught locally")}
        </text>
        <rect
          x="47"
          y="158"
          width="256"
          height="28"
          rx="7"
          className="morph-ink"
        />
        <text x="61" y="177" className="morph-paper">
          {t("Review & continue")}
        </text>
        <Arrow x={279} y={165} paper />
      </Panel>
    </>
  );
}

function UsageChart({
  tooltip = false,
  frame,
}: {
  tooltip?: boolean;
  frame: UiMorphFrame;
}) {
  const t = useT();
  return (
    <>
      <rect
        data-detail="chart-focus"
        x={frame.details.chartFocus.x}
        y="101"
        width="30"
        height="78"
        rx="4"
        className="morph-ink"
        opacity={frame.details.chartFocus.opacity}
      />
      <text x="44" y="49" className="morph-title">
        {t("Model usage")}
      </text>
      <text x="302" y="49" textAnchor="end" className="morph-small">
        {t("Receipt ↗")}
      </text>
      <text x="44" y="82" className="morph-total">
        20.00
      </text>
      <text x="119" y="81" className="morph-small morph-muted">
        USDC
      </text>
      <path
        d="M44 174h263M44 108h263M44 141h263"
        className="morph-rule"
        strokeDasharray="2 3"
      />
      {frame.details.bars.map((height, index) => (
        <g key={index}>
          <rect
            x={49 + index * 35}
            y={174 - height}
            width="20"
            height={height}
            rx="3"
            className={index === 4 ? "morph-red" : "morph-ink"}
          />
          <text
            x={59 + index * 35}
            y="192"
            textAnchor="middle"
            className="morph-small morph-muted"
          >
            {t(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][index]).slice(0, t.locale === "en" ? 1 : undefined)}
          </text>
        </g>
      ))}
      {tooltip && (
        <>
          <path
            d="M199 93v78"
            stroke="var(--morph-red)"
            strokeDasharray="2 3"
          />
          <rect
            x="180"
            y="65"
            width="120"
            height="45"
            rx="8"
            className="morph-ink"
          />
          <path d="m191 109 8 7 8-7" className="morph-ink" />
          <text x="193" y="82" className="morph-paper morph-small">
            {t("Friday")}
          </text>
          <text x="193" y="100" className="morph-paper morph-strong">
            3.20 USDC
          </text>
        </>
      )}
    </>
  );
}

function PursePanels({
  frame,
  prefix,
}: {
  frame: UiMorphFrame;
  prefix: string;
}) {
  const t = useT();
  return (
    <>
      <Panel id="chart" frame={frame} prefix={prefix}>
        <UsageChart frame={frame} />
      </Panel>
      <Panel id="tooltip" frame={frame} prefix={prefix}>
        <UsageChart frame={frame} tooltip />
      </Panel>
      <Panel id="receipt" frame={frame} prefix={prefix}>
        <text x="61" y="48" className="morph-title">
          {t("Usage receipt")}
        </text>
        <circle cx="281" cy="43" r="11" className="morph-ink" />
        <g data-detail="receipt-mark" opacity={frame.details.receiptMark}>
          <Check x={275} y={38} paper />
        </g>
        <path d="M61 64h228" className="morph-rule" />
        <text x="61" y="88" className="morph-muted">
          {t("Reserved usage")}
        </text>
        <text x="289" y="88" textAnchor="end" className="morph-strong">
          21.00
        </text>
        <text x="61" y="114" className="morph-muted">
          {t("Unused balance released")}
        </text>
        <text x="289" y="114" textAnchor="end" className="morph-strong">
          1.00
        </text>
        <path d="M61 132h228" className="morph-rule" strokeDasharray="3 3" />
        <text x="61" y="158" className="morph-strong">
          {t("Total")}
        </text>
        <text x="289" y="159" textAnchor="end" className="morph-large">
          20.00 USD
        </text>
        <text x="61" y="192" className="morph-small morph-muted">
          {t("Illustrative usage receipt")}
        </text>
      </Panel>
    </>
  );
}

type UiMorphProps = { kind: UiMorphKind; paused?: boolean };

export function UiMorph({ kind, paused = false }: UiMorphProps) {
  const node = useRef<SVGSVGElement>(null);
  const prefix = `ui-morph-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const initial = seekUiMorph(kind, UI_MORPH_STATIC_TIME[kind]);

  useEffect(() => {
    const svg = node.current;
    if (!svg) return;
    const surface = svg.querySelector<SVGRectElement>("[data-surface]");
    const clip = svg.querySelector<SVGRectElement>("[data-clip]");
    const cursor = svg.querySelector<SVGGElement>("[data-cursor]");
    const pointer = svg.querySelector<SVGPathElement>("[data-pointer]");
    const ring = svg.querySelector<SVGCircleElement>("[data-ring]");
    const panels = Array.from(
      svg.querySelectorAll<SVGGElement>("[data-panel]"),
    ).map((group) => ({
      group,
      id: group.dataset.panel,
      blur: svg.querySelector<SVGFEGaussianBlurElement>(
        `[data-blur="${group.dataset.panel}"]`,
      ),
    }));
    const detail = (name: string) =>
      svg.querySelector<SVGElement>(`[data-detail="${name}"]`);
    const spinner = detail("spinner");
    const track = detail("toggle-track");
    const thumb = detail("toggle-thumb");
    const raw = detail("guard-raw");
    const clean = detail("guard-clean");
    const vote = detail("vote");
    const tabSelection = detail("tab-selection");
    const tabClip = detail("tab-clip");
    const routeFocus = detail("route-focus");
    const chartFocus = Array.from(
      svg.querySelectorAll<SVGRectElement>('[data-detail="chart-focus"]'),
    );
    const receiptMark = detail("receipt-mark");
    const set = (
      element: Element | null,
      name: string,
      value: number | string,
    ) => element?.setAttribute(name, String(value));
    const paint = (frame: UiMorphFrame, quiet = false) => {
      svg.dataset.morphState = frame.state;
      for (const rect of [surface, clip]) {
        set(rect, "x", frame.shape.x);
        set(rect, "y", frame.shape.y);
        set(rect, "width", frame.shape.width);
        set(rect, "height", frame.shape.height);
        set(rect, "rx", frame.shape.radius);
      }
      for (const panel of panels) {
        const pose = frame.panels.find((item) => item.id === panel.id);
        if (!pose) continue;
        set(panel.group, "opacity", pose.opacity);
        set(panel.group, "transform", `translate(0 ${pose.y})`);
        set(panel.blur, "stdDeviation", pose.blur);
      }
      set(cursor, "opacity", quiet ? 0 : frame.cursor.opacity);
      set(
        cursor,
        "transform",
        `translate(${frame.cursor.x} ${frame.cursor.y})`,
      );
      set(pointer, "transform", `scale(${frame.cursor.scale})`);
      set(ring, "r", frame.cursor.ring);
      set(ring, "opacity", frame.cursor.ringOpacity);
      set(spinner, "transform", `rotate(${frame.details.spinner} 175 117.5)`);
      set(track, "opacity", frame.details.toggle);
      set(thumb, "x", frame.details.toggleEdges.left);
      set(
        thumb,
        "width",
        frame.details.toggleEdges.right - frame.details.toggleEdges.left,
      );
      for (const selection of [tabSelection, tabClip]) {
        set(selection, "x", frame.details.tabEdges.left);
        set(
          selection,
          "width",
          frame.details.tabEdges.right - frame.details.tabEdges.left,
        );
      }
      set(raw, "opacity", Math.max(0, 1 - 2 * frame.details.redaction));
      set(clean, "opacity", Math.max(0, 2 * frame.details.redaction - 1));
      set(vote, "opacity", frame.details.vote);
      set(routeFocus, "opacity", frame.details.routeFocus);
      for (const focus of chartFocus) {
        set(focus, "x", frame.details.chartFocus.x);
        set(focus, "opacity", quiet ? 0 : frame.details.chartFocus.opacity);
      }
      set(receiptMark, "opacity", frame.details.receiptMark);
    };
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    let frameId = 0;
    let destroyed = false;
    const stop = () => {
      cancelAnimationFrame(frameId);
      frameId = 0;
    };
    const shouldRun = () =>
      !destroyed && visible && !paused && !reduced.matches && !document.hidden;
    const tick = (now: number) => {
      frameId = 0;
      if (!shouldRun()) return;
      visibleEpoch ??= now;
      paint(seekUiMorph(kind, (now - visibleEpoch) / 1000));
      frameId = requestAnimationFrame(tick);
    };
    const sync = () => {
      stop();
      if (shouldRun()) frameId = requestAnimationFrame(tick);
      else if (paused || reduced.matches)
        paint(seekUiMorph(kind, UI_MORPH_STATIC_TIME[kind]), true);
    };
    paint(seekUiMorph(kind, UI_MORPH_STATIC_TIME[kind]), true);
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        sync();
      },
      { threshold: 0.08 },
    );
    observer.observe(svg);
    reduced.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      destroyed = true;
      stop();
      observer.disconnect();
      reduced.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [kind, paused]);

  return (
    <div className={`ui-morph ui-morph--${kind} orrery`} aria-hidden="true">
      <svg
        ref={node}
        viewBox="0 0 350 235"
        fill="none"
        data-morph-state={initial.state}
      >
        <defs>
          <clipPath id={`${prefix}-clip`}>
            <rect
              data-clip
              x={initial.shape.x}
              y={initial.shape.y}
              width={initial.shape.width}
              height={initial.shape.height}
              rx={initial.shape.radius}
            />
          </clipPath>
          {initial.panels.map((panel) => (
            <filter
              key={panel.id}
              id={`${prefix}-${panel.id}`}
              x="-10%"
              y="-10%"
              width="120%"
              height="120%"
              colorInterpolationFilters="sRGB"
            >
              <feGaussianBlur data-blur={panel.id} stdDeviation={panel.blur} />
            </filter>
          ))}
        </defs>
        <rect
          data-surface
          className="morph-surface"
          x={initial.shape.x}
          y={initial.shape.y}
          width={initial.shape.width}
          height={initial.shape.height}
          rx={initial.shape.radius}
        />
        <g clipPath={`url(#${prefix}-clip)`}>
          {kind === "council" && (
            <CouncilPanels frame={initial} prefix={prefix} />
          )}
          {kind === "boundary" && (
            <BoundaryPanels frame={initial} prefix={prefix} />
          )}
          {kind === "purse" && <PursePanels frame={initial} prefix={prefix} />}
        </g>
        <g data-cursor opacity="0">
          <circle data-ring className="morph-cursor-ring" r="0" />
          <path
            data-pointer
            className="morph-cursor"
            d="m0 0 3 19 4-6 6 9 4-3-6-9 7-1Z"
          />
        </g>
      </svg>
    </div>
  );
}
