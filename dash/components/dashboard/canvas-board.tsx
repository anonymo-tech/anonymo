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
import { useT, type Translator } from '@/lib/i18n';
import { MotionIcon } from './motion-icon';
import { AnswerCard, type AnswerActions } from './answer-card';
import { MODELS } from './data';
import type { Answer, Turn } from './canvas-state';
import { featureOn } from './feature-switches';
import { canvasLayoutKey, parseCanvasLayout, snapshotCanvasLayout, type CanvasLayout } from '../../lib/canvas-layout';
import '../../app/dashboard/canvas-extras.css';
import { useDeviceSetting } from './use-device-setting';
const validLayout = (value: unknown): value is CanvasLayout | null => value === null || parseCanvasLayout(value) !== null;

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

function graphNodes(
  turns: Turn[],
  actions: AnswerActions,
  t: Translator,
): GraphNode[] {
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
        ariaLabel: t('Prompt: {prompt}', { prompt: turn.prompt }),
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
        ariaLabel: t('{model} response', {
          model: String(
            MODELS.find((model) => model.id === answer.modelId)?.name,
          ),
        }),
      })),
    ];
  });
}

export default function CanvasBoard({
  turns,
  actions,
  accountScope,
  projectId,
}: {
  accountScope: string;
  projectId: string;
  turns: Turn[];
  actions: AnswerActions;
}) {
  const t = useT();
  const memoryEnabled = featureOn('canvasMemory');
  const storageKey = canvasLayoutKey(accountScope, projectId);
  const memory = useDeviceSetting<CanvasLayout | null>(storageKey, null, validLayout, memoryEnabled);
  const memoryReady = !memoryEnabled || memory.loaded;
  const restoredViewport = useRef(false);
  const initialLayout = useRef<CanvasLayout | null>(null);
  const initialLoaded = useRef(false);
  useEffect(() => {
    if (memoryReady && !initialLoaded.current) {
      initialLayout.current = memory.value;
      initialLoaded.current = true;
    }
  }, [memoryReady, memory.value]);
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
    if (!memoryReady) return;
    const next = graphNodes(turns, actions, t);
    setNodes((current) =>
      next.map((node) => ({
        ...node,
        position:
          current.find((old) => old.id === node.id)?.position || initialLayout.current?.positions[node.id] || node.position,
      })),
    );
  }, [turns, actions, setNodes, t, memoryReady]);

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

  const remember = useCallback(() => {
    if (!memoryEnabled || !memoryReady || !instance || !restoredViewport.current) return;
    const snapshot = snapshotCanvasLayout(instance.getNodes(), instance.getViewport());
    if (!snapshot) return;
    if (JSON.stringify(snapshot) !== JSON.stringify(memory.value)) memory.save(snapshot);
  }, [memoryEnabled, memoryReady, instance, memory]);

  useEffect(() => {
    if (!container.current || !instance || !memoryReady) return;
    if (!restoredViewport.current) {
      restoredViewport.current = true;
      if (memory.value) void instance.setViewport(memory.value.viewport);
      else resetView();
    }
    if (memoryEnabled) return;
    const observer = new ResizeObserver(resetView);
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [resetView, instance, memoryReady, memoryEnabled, memory.value]);

  useEffect(() => {
    if (!nodes.length) return;
    const timer = window.setTimeout(remember, 250);
    return () => window.clearTimeout(timer);
  }, [nodes, remember]);

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
          onMoveEnd={remember}
          onNodeDragStop={remember}
          minZoom={0.25}
          maxZoom={1.8}
          nodesConnectable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          panOnScroll
          zoomOnDoubleClick={false}
          ariaLabelConfig={{
            'node.a11yDescription.default': t(
              'Press enter or space to select a node. Press delete to remove it and escape to cancel.',
            ),
            'node.a11yDescription.keyboardDisabled': t(
              'Press enter or space to select a node. You can then use the arrow keys to move the node around. Press delete to remove it and escape to cancel.',
            ),
            'edge.a11yDescription.default': t(
              'Press enter or space to select an edge. You can then press delete to remove it or escape to cancel.',
            ),
            'handle.ariaLabel': t('Handle'),
            'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) =>
              t(
                'Moved selected node {direction}. New position, x: {x}, y: {y}',
                { direction: t(direction), x, y },
              ),
          }}
          aria-label={t(
            'Conversation canvas. Drag answer footers to move them; drag the background to pan.',
          )}
        >
          <Background gap={24} size={0.95} color="#cdd1ce" />
        </ReactFlow>
        {memoryEnabled && <output className="cw-layout-note">
          {memory.error || 'Layout saved on this device'}
        </output>}
        <div className="cw-zoom">
          <button
            data-icon-trigger
            onClick={resetView}
            title={t('Reset canvas view')}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            data-icon-trigger
            onClick={() =>
              void instance?.fitView({ padding: 0.12, maxZoom: 1 })
            }
            aria-label={t('Fit all answers')}
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
