'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useNodesState,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import { MotionIcon } from './motion-icon';
import { AnswerCard, type AnswerActions } from './answer-card';
import { MODELS } from './data';
import type { Answer, Turn } from './canvas-state';

type GraphData = { prompt?: string; answer?: Answer; actions: AnswerActions };
type GraphNode = Node<GraphData>;

function PromptNode({ data }: NodeProps<GraphNode>) {
  return (
    <div className="cw-prompt-node">
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Long prompts must be keyboard-scrollable. */}
      <span className="nodrag nowheel" tabIndex={0}>
        {data.prompt}
      </span>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}
function ResponseNode({ data }: NodeProps<GraphNode>) {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      {data.answer && (
        <AnswerCard answer={data.answer} actions={data.actions} />
      )}
    </>
  );
}
const nodeTypes = { prompt: PromptNode, response: ResponseNode };

function graphNodes(turns: Turn[], actions: AnswerActions): GraphNode[] {
  return turns.flatMap((turn, index) => {
    const count = turn.answers.length;
    const width =
      count === 1 ? 470 : Math.min(470, (1000 - 45 * (count - 1)) / count);
    return [
      {
        id: turn.id,
        type: 'prompt',
        position: { x: 330, y: index * 610 },
        data: { prompt: turn.prompt, actions },
        style: { width: 340 },
        ariaLabel: `Prompt: ${turn.prompt}`,
      },
      ...turn.answers.map((answer, position) => ({
        id: answer.id,
        type: 'response',
        position: {
          x: count === 1 ? 265 : position * (width + (count === 2 ? 60 : 45)),
          y: index * 610 + 200,
        },
        data: { answer, actions },
        dragHandle: '.cw-node-drag',
        style: { width },
        ariaLabel: `${MODELS.find((model) => model.id === answer.modelId)?.name} response`,
      })),
    ];
  });
}

export default function CanvasBoard({
  turns,
  actions,
}: {
  turns: Turn[];
  actions: AnswerActions;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mobileCanvas = useRef<HTMLDivElement>(null);
  const [instance, setInstance] = useState<ReactFlowInstance<GraphNode> | null>(
    null,
  );
  const [zoom, setZoom] = useState(1);
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const ids = turns.map((turn) => turn.id).join(':');
  const previousIds = useRef(ids);

  useEffect(() => {
    const next = graphNodes(turns, actions);
    setNodes((current) =>
      next.map((node) => ({
        ...node,
        position:
          current.find((old) => old.id === node.id)?.position || node.position,
      })),
    );
  }, [turns, actions, setNodes]);

  const resetView = useCallback(() => {
    const el = container.current;
    if (!el || !instance || !el.clientWidth || !el.clientHeight) return;
    const scale = Math.max(
      0.25,
      Math.min(1, (el.clientWidth - 72) / 1000, (el.clientHeight - 70) / 505),
    );
    void instance.setViewport(
      {
        x: (el.clientWidth - 1000 * scale) / 2,
        y: Math.max(30, 52 * scale),
        zoom: scale,
      },
      { duration: 0 },
    );
  }, [instance]);

  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(resetView);
    observer.observe(container.current);
    resetView();
    return () => observer.disconnect();
  }, [resetView]);

  useEffect(() => {
    if (previousIds.current !== ids && turns.length > 1 && instance) {
      const mobile = mobileCanvas.current;
      if (mobile?.clientWidth) {
        mobile.lastElementChild?.scrollIntoView({
          block: 'start',
          behavior: 'instant',
        });
        previousIds.current = ids;
        return;
      }
      const last = turns[turns.length - 1];
      const frame = requestAnimationFrame(
        () =>
          void instance.fitView({
            nodes: [
              { id: last.id },
              ...last.answers.map((answer) => ({ id: answer.id })),
            ],
            padding: 0.16,
            maxZoom: 1,
            duration: window.matchMedia('(prefers-reduced-motion: reduce)')
              .matches
              ? 0
              : 250,
          }),
      );
      previousIds.current = ids;
      return () => cancelAnimationFrame(frame);
    }
  }, [ids, instance, turns]);

  const edges = useMemo(
    () =>
      turns.flatMap((turn) =>
        turn.answers.map((answer) => ({
          id: `${turn.id}-${answer.id}`,
          source: turn.id,
          target: answer.id,
          type: 'default',
          style: { stroke: '#ea2a22', strokeWidth: 2 },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: '#ea2a22',
            width: 16,
            height: 16,
          },
        })),
      ),
    [turns],
  );

  return (
    <>
      <div className="cw-board" ref={container}>
        <ReactFlow<GraphNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onInit={setInstance}
          onMove={(_, viewport) => setZoom(viewport.zoom)}
          minZoom={0.25}
          maxZoom={1.8}
          nodesConnectable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          panOnScroll
          zoomOnDoubleClick={false}
          aria-label="Conversation canvas. Drag answer footers to move them; drag the background to pan."
        >
          <Background gap={24} size={0.95} color="#cdd1ce" />
        </ReactFlow>
        <div className="cw-zoom">
          <button
            data-icon-trigger
            onClick={resetView}
            title="Reset canvas view"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            data-icon-trigger
            onClick={() =>
              void instance?.fitView({ padding: 0.12, maxZoom: 1 })
            }
            aria-label="Fit all answers"
          >
            <MotionIcon name="fit" size={18} />
          </button>
        </div>
      </div>
      <div className="cw-mobile-canvas" ref={mobileCanvas}>
        {turns.map((turn) => (
          <section key={turn.id}>
            <div className="cw-mobile-prompt">{turn.prompt}</div>
            <div className="cw-mobile-answers">
              {turn.answers.map((answer) => (
                <AnswerCard key={answer.id} answer={answer} actions={actions} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
