'use client';

import {
  useEffect,
  useId,
  useRef,
  type HTMLAttributes,
  type CSSProperties,
} from 'react';
import '@/app/dashboard/motion-icons.css';
import { ObjectMaterials } from './object-materials';
import {
  UtilityObjectGlyph,
  UTILITY_OBJECT_MATERIALS,
} from './utility-object-glyphs';

export type MotionIconName =
  | 'rooms'
  | 'chat'
  | 'canvas'
  | 'studio'
  | 'agents'
  | 'more'
  | 'library'
  | 'decisions'
  | 'connections'
  | 'purse'
  | 'chapters'
  | 'brief'
  | 'copy'
  | 'branch'
  | 'route'
  | 'send'
  | 'attach'
  | 'add'
  | 'close'
  | 'forward'
  | 'open'
  | 'download'
  | 'upload'
  | 'pin'
  | 'remove'
  | 'search'
  | 'select'
  | 'settings'
  | 'help'
  | 'fit';

type MotionIconProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  name: MotionIconName;
  size?: number;
  active?: boolean;
};

const sculptedIcons: Partial<Record<MotionIconName, string>> = {
  rooms: 'dashboard-rooms-halftone-v2.webp',
  chat: 'dashboard-chat-halftone-v2.webp',
  canvas: 'dashboard-canvas-halftone-v2.webp',
  studio: 'dashboard-studio-halftone-v2.webp',
  agents: 'dashboard-agents-halftone-v2.webp',
  more: 'dashboard-more-halftone-v2.webp',
  library: 'dashboard-library-halftone-v2.webp',
  decisions: 'dashboard-decisions-halftone-v2.webp',
  connections: 'dashboard-connections-halftone-v2.webp',
  purse: 'dashboard-purse-halftone-v2.webp',
  chapters: 'dashboard-chapters-halftone-v2.webp',
  brief: 'dashboard-brief-halftone-v2.webp',
  copy: 'dashboard-copy-halftone-v2.webp',
  branch: 'dashboard-branch-halftone-v2.webp',
  route: 'dashboard-route-halftone-v2.webp',
};

export function MotionIcon({
  name,
  size = 24,
  active = false,
  className = '',
  style,
  ...props
}: MotionIconProps) {
  const root = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const materialId = `mo-${useId().replace(/:/g, '')}`;
  const sculpture = sculptedIcons[name];
  const fallbackName = name === 'attach' ? 'upload' : name;
  const materialNames = UTILITY_OBJECT_MATERIALS[fallbackName] ?? [];
  const renderName = name === 'select' && !active ? 'select-empty' : name;
  useEffect(() => {
    let disposed = false;
    let unmount: (() => void) | undefined;
    import('./icon-renderer')
      .then(({ mountIcon3d }) => {
        if (!disposed && root.current && canvas.current)
          unmount = mountIcon3d(root.current, canvas.current, renderName);
      })
      .catch(() => {
        if (!disposed && root.current)
          root.current.dataset.renderer = 'fallback';
      });
    return () => {
      disposed = true;
      unmount?.();
    };
  }, [renderName]);
  return (
    <span
      {...props}
      ref={root}
      className={`mi-icon mi-${name}${active ? ' mi-active' : ''}${className ? ` ${className}` : ''}`}
      style={{ '--mi-size': `${size}px`, ...style } as CSSProperties}
      aria-hidden="true"
    >
      <canvas ref={canvas} className="mi-3d-canvas" />
      <svg
        className="mi-fallback"
        viewBox="0 0 32 32"
        fill="none"
        stroke="none"
        focusable="false"
      >
        {sculpture ? (
          <image
            href={`/brand/icons/${sculpture}`}
            width="32"
            height="32"
            preserveAspectRatio="xMidYMid meet"
          />
        ) : (
          <>
            <ObjectMaterials id={materialId} names={materialNames} />
            <UtilityObjectGlyph
              name={fallbackName}
              paint={(material) => `url(#${materialId}-${material})`}
            />
          </>
        )}
      </svg>
    </span>
  );
}

export default MotionIcon;
