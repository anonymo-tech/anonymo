import type { ReactNode } from 'react';
import type { ObjectGlyphProps } from './object-materials';

export const UTILITY_OBJECT_MATERIALS: Record<string, string[]> = {
  send: ['paper', 'paperEdge', 'ink', 'accent', 'halftone'],
  attach: ['metal', 'metalEdge', 'paper', 'ink'],
  add: ['paper', 'paperEdge', 'ink', 'accent', 'accentEdge', 'halftone'],
  close: ['paper', 'paperEdge', 'ink', 'accent', 'accentEdge', 'halftone'],
  forward: ['accent', 'accentEdge', 'paper', 'halftone'],
  open: ['paper', 'paperEdge', 'ink', 'accent', 'accentEdge', 'halftone'],
  download: [
    'metal',
    'metalEdge',
    'ink',
    'paper',
    'accent',
    'accentEdge',
    'halftone',
  ],
  upload: [
    'metal',
    'metalEdge',
    'ink',
    'paper',
    'paperEdge',
    'accent',
    'halftone',
  ],
  pin: ['accent', 'accentEdge', 'metal', 'metalEdge', 'paper', 'halftone'],
  remove: ['metal', 'metalEdge', 'paper', 'ink', 'halftone'],
  search: [
    'metal',
    'metalEdge',
    'ink',
    'inkEdge',
    'glass',
    'paper',
    'halftone',
  ],
  select: ['paper', 'paperEdge', 'ink', 'accent', 'accentEdge', 'halftone'],
  settings: [
    'metal',
    'metalEdge',
    'ink',
    'accent',
    'accentEdge',
    'paper',
    'halftone',
  ],
  help: ['paper', 'paperEdge', 'ink', 'accent', 'accentEdge', 'halftone'],
  fit: ['metal', 'metalEdge', 'ink', 'paper', 'accent', 'halftone'],
};

type Paint = ObjectGlyphProps['paint'];

function ObjectTile({
  paint,
  material,
  children,
}: {
  paint: Paint;
  material: string;
  children: ReactNode;
}) {
  return (
    <g stroke="none">
      <rect x="5" y="6" width="24" height="23" rx="2" fill={paint('ink')} />
      <rect
        x="4"
        y="3.5"
        width="24"
        height="23"
        rx="2"
        fill={paint(material)}
        stroke={paint('ink')}
        strokeWidth=".8"
      />
      <path d="M22 4h6v22H8Z" fill={paint('halftone')} opacity=".22" />
      <path
        d="M6 6h20v18.5H6Z"
        fill="none"
        stroke={paint(`${material}Edge`)}
        strokeWidth=".7"
      />
      <path
        d="M8 8h4M8 8v4M24 22h-4M24 22v-4"
        fill="none"
        stroke={paint('ink')}
        strokeWidth=".7"
        opacity=".4"
      />
      {children}
    </g>
  );
}

function Tray({ paint, material }: { paint: Paint; material: string }) {
  return (
    <g stroke="none">
      <path
        d="m6 19 20 0 3 7v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2Z"
        fill={paint(`${material}Edge`)}
      />
      <path d="M6 18h20l3 7H3Z" fill={paint(material)} />
      <path d="m8 20-1 3h18l-1-3Z" fill={paint('ink')} opacity=".65" />
      <path
        d="M3 25h9l1.5 2h5l1.5-2h9v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"
        fill={paint(material)}
      />
      <path
        d="M4 26h7l2 2h6l2-2h7v3H4Z"
        fill={paint('halftone')}
        opacity=".38"
      />
      <path
        d="M5 25h6M21 25h6"
        fill="none"
        stroke={paint('paper')}
        strokeWidth="1"
        strokeLinecap="round"
        opacity=".6"
      />
    </g>
  );
}

export function UtilityObjectGlyph({ name, paint }: ObjectGlyphProps) {
  switch (name) {
    case 'send':
      return (
        <g className="mi-part mi-flight" stroke="none">
          <path d="m3 14 26-10-8.5 25-7-10Z" fill={paint('ink')} />
          <path
            d="m3 12 26-9-15.5 14Z"
            fill={paint('paper')}
            stroke={paint('ink')}
            strokeWidth=".65"
          />
          <path d="m13.5 17 15.5-14-9 23Z" fill={paint('paperEdge')} />
          <path
            d="m13.5 17 15.5-14-9 23Z"
            fill={paint('halftone')}
            opacity=".28"
          />
          <path d="m13.5 17 1 9 3-5Z" fill={paint('paperEdge')} />
          <path d="m14.5 26-.2-7 3.2 2Z" fill={paint('paper')} />
          <path
            d="m13.5 17 12-11"
            fill="none"
            stroke={paint('accent')}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </g>
      );
    case 'attach':
      return (
        <g
          className="mi-part mi-tilt"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path
            d="m11 19 8-8a3.3 3.3 0 0 1 4.7 4.7L14 25.4a5.7 5.7 0 0 1-8-8L17 6.3a7 7 0 0 1 9.9 9.9"
            stroke={paint('ink')}
            strokeWidth="6"
          />
          <path
            d="m11 19 8-8a3.3 3.3 0 0 1 4.7 4.7L14 25.4a5.7 5.7 0 0 1-8-8L17 6.3a7 7 0 0 1 9.9 9.9"
            transform="translate(0 1.5)"
            stroke={paint('metalEdge')}
            strokeWidth="5.7"
          />
          <path
            d="m11 19 8-8a3.3 3.3 0 0 1 4.7 4.7L14 25.4a5.7 5.7 0 0 1-8-8L17 6.3a7 7 0 0 1 9.9 9.9"
            stroke={paint('metal')}
            strokeWidth="5.1"
          />
          <path
            d="m7 17 10.6-10.5a6 6 0 0 1 8.1.2M11 18.2l8-8"
            stroke={paint('paper')}
            strokeWidth="1"
            opacity=".7"
          />
        </g>
      );
    case 'add':
      return (
        <ObjectTile paint={paint} material="paper">
          <g className="mi-part mi-turn">
            <path
              d="M13.3 9h5.4v6h6v5.4h-6v6h-5.4v-6h-6V15h6Z"
              fill={paint('accentEdge')}
            />
            <path
              d="M13.3 7h5.4v6h6v5.4h-6v6h-5.4v-6h-6V13h6Z"
              fill={paint('accent')}
            />
            <path
              d="M14.6 8.5v6H9"
              fill="none"
              stroke={paint('paper')}
              strokeWidth="1"
              opacity=".55"
              strokeLinecap="round"
            />
          </g>
        </ObjectTile>
      );
    case 'close':
      return (
        <ObjectTile paint={paint} material="paper">
          <g className="mi-part mi-turn">
            <path
              d="m10 9 6 6 6-6 3 3-6 6 6 6-3 3-6-6-6 6-3-3 6-6-6-6Z"
              fill={paint('accentEdge')}
            />
            <path
              d="m10 7 6 6 6-6 3 3-6 6 6 6-3 3-6-6-6 6-3-3 6-6-6-6Z"
              fill={paint('accent')}
            />
            <path
              d="m10 8.6 6 6 6-6"
              fill="none"
              stroke={paint('paper')}
              strokeWidth="1"
              opacity=".5"
              strokeLinecap="round"
            />
          </g>
        </ObjectTile>
      );
    case 'forward':
      return (
        <g className="mi-part mi-forward" stroke="none">
          <path d="M3 13h13V6l14 12-14 12v-7H3Z" fill={paint('accentEdge')} />
          <path d="M3 10h13V3l14 12-14 12v-7H3Z" fill={paint('accent')} />
          <path
            d="M3 17h14l12-2-13 12v-7H3Z"
            fill={paint('halftone')}
            opacity=".32"
          />
          <path
            d="M5 12h13V7l8 7"
            fill="none"
            stroke={paint('paper')}
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity=".6"
          />
        </g>
      );
    case 'open':
      return (
        <g stroke="none">
          <path
            d="M3 9a3 3 0 0 1 3-3h7l3 3h9a3 3 0 0 1 3 3v16H3Z"
            fill={paint('ink')}
          />
          <path
            d="M4 8a3 3 0 0 1 3-3h6l3 3h9a2 2 0 0 1 2 2v14H4Z"
            fill={paint('paperEdge')}
          />
          <path d="M8 11h15v12H8Z" fill={paint('paperEdge')} />
          <path d="M8 9h15v12H8Z" fill={paint('paper')} />
          <path d="M2 16h26l-2 12H4Z" fill={paint('ink')} />
          <path
            d="M2 14h26l-2 12H4Z"
            fill={paint('paper')}
            stroke={paint('ink')}
            strokeWidth=".65"
          />
          <path d="m20 14 8 0-2 12H15Z" fill={paint('halftone')} opacity=".3" />
          <path
            d="M5 16h11"
            fill="none"
            stroke={paint('ink')}
            strokeWidth="1"
            strokeLinecap="round"
            opacity=".6"
          />
          <path
            d="m8 21 1-2 2 .3 1.7-1 1 1.7 2 .7-.8 2 .2 1.7-2 .3-1.5 1-1.4-1.3-1.8-.5Z"
            fill={paint('accentEdge')}
          />
          <circle cx="11.8" cy="21.5" r="2.4" fill={paint('accent')} />
          <g className="mi-part mi-open-arrow">
            <path
              d="M20 4h10v10h-4V11l-8 8-3-3 8-8h-3Z"
              fill={paint('accentEdge')}
            />
            <path
              d="M20 2h10v10h-4V9l-8 8-3-3 8-8h-3Z"
              fill={paint('accent')}
            />
            <path
              d="M22 3.5h6.5V9"
              fill="none"
              stroke={paint('paper')}
              strokeWidth="1"
              strokeLinecap="round"
              opacity=".65"
            />
          </g>
        </g>
      );
    case 'download':
    case 'upload': {
      const down = name === 'download';
      const material = down ? 'accent' : 'paper';
      const arrow = down
        ? 'M12.7 2h6.6v10h6.2L16 22 6.5 12h6.2Z'
        : 'M12.7 21h6.6V11h6.2L16 1 6.5 11h6.2Z';
      return (
        <g stroke="none">
          <Tray paint={paint} material="metal" />
          <g className={`mi-part mi-${name}-arrow`}>
            <path
              d={arrow}
              transform="translate(0 2)"
              fill={paint(`${material}Edge`)}
            />
            <path
              d={arrow}
              fill={paint(material)}
              stroke={paint('ink')}
              strokeWidth=".65"
            />
            <path d={arrow} fill={paint('halftone')} opacity=".16" />
            <path
              d={down ? 'M14.1 4v10H10' : 'm10 9 6-6 6 6M14.1 12v7'}
              fill="none"
              stroke={paint(down ? 'paper' : 'accent')}
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity=".7"
            />
          </g>
        </g>
      );
    }
    case 'pin':
      return (
        <g transform="rotate(24 16 16)" stroke="none">
          <path d="M14.3 20h3.4L16 31Z" fill={paint('metalEdge')} />
          <path d="M14.3 20H16v9Z" fill={paint('metal')} />
          <g className="mi-part mi-pin-head">
            <path
              d="m16 3 3 2 4 .3 1 3.7 2.5 3-1.5 3.6.1 4-3.9 1.7-2.5 2.8-3.7-1-3.7 1L9 21.3l-3.9-1.7.1-4L3.7 12l2.5-3 1-3.7 4-.3Z"
              fill={paint('accentEdge')}
            />
            <path
              d="m16 1 3 2 4 .3 1 3.7 2.5 3-1.5 3.6.1 4-3.9 1.7-2.5 2.8-3.7-1-3.7 1L9 19.3l-3.9-1.7.1-4L3.7 10l2.5-3 1-3.7 4-.3Z"
              fill={paint('accent')}
            />
            <path
              d="m23 3.3 1 3.7 2.5 3-1.5 3.6.1 4-3.9 1.7-2.5 2.8-3.7-1-3.7 1Z"
              fill={paint('halftone')}
              opacity=".28"
            />
            <circle
              cx="15"
              cy="11"
              r="6.4"
              fill="none"
              stroke={paint('accentEdge')}
              strokeWidth="1.4"
            />
            <path
              d="M12 14V8h5M12 11h4"
              fill="none"
              stroke={paint('paper')}
              strokeWidth="1.1"
              strokeLinecap="round"
              opacity=".55"
            />
          </g>
        </g>
      );
    case 'remove':
      return (
        <g stroke="none">
          <path
            d="M6 10h21l-2 17a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3Z"
            fill={paint('metalEdge')}
          />
          <path
            d="M5 9h21l-2 17a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3Z"
            fill={paint('metal')}
          />
          <path
            d="M20 9h6l-2 17a3 3 0 0 1-3 3h-5Z"
            fill={paint('halftone')}
            opacity=".38"
          />
          <path
            d="m11 14 1 10m5-10v10m5-10-1 10"
            fill="none"
            stroke={paint('ink')}
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          <path
            d="m9 13 1.3 11"
            fill="none"
            stroke={paint('paper')}
            strokeWidth="1"
            opacity=".4"
            strokeLinecap="round"
          />
          <g className="mi-part mi-bin-lid">
            <path
              d="M11 6V4a3 3 0 0 1 3-3h5a3 3 0 0 1 3 3v2h-3V4h-5v2Z"
              fill={paint('metalEdge')}
            />
            <path
              d="M10 5V3a3 3 0 0 1 3-3h5a3 3 0 0 1 3 3v2h-3V3h-5v2Z"
              fill={paint('metal')}
            />
            <rect
              x="3"
              y="7"
              width="26"
              height="5"
              rx="2.5"
              fill={paint('metalEdge')}
            />
            <rect
              x="3"
              y="4"
              width="26"
              height="5"
              rx="2.5"
              fill={paint('metal')}
            />
            <path
              d="M6 5.5h16"
              fill="none"
              stroke={paint('paper')}
              strokeWidth="1.1"
              strokeLinecap="round"
              opacity=".6"
            />
          </g>
        </g>
      );
    case 'search':
      return (
        <g stroke="none">
          <path d="m20 17 10 9a3 3 0 0 1-4 4l-10-9Z" fill={paint('inkEdge')} />
          <path d="m20 16 9 8.5a3 3 0 0 1-4 4L16 20Z" fill={paint('ink')} />
          <path
            d="m23 22 4.5 4.5"
            fill="none"
            stroke={paint('paper')}
            strokeWidth="1.2"
            strokeLinecap="round"
            opacity=".35"
          />
          <g className="mi-part mi-search-glass">
            <circle cx="13" cy="14.5" r="11" fill={paint('metalEdge')} />
            <circle cx="13" cy="13" r="11" fill={paint('metal')} />
            <circle cx="13" cy="13" r="7.7" fill={paint('metalEdge')} />
            <circle cx="13" cy="13.7" r="7.1" fill={paint('glass')} />
            <path
              d="M13 2a11 11 0 0 1 0 22l0-3.3a7.7 7.7 0 0 0 0-15.4Z"
              fill={paint('halftone')}
              opacity=".25"
            />
            <path
              d="m8 14 6-6m-3 9 6-6"
              fill="none"
              stroke={paint('paper')}
              strokeWidth="1"
              strokeLinecap="round"
              opacity=".5"
            />
          </g>
        </g>
      );
    case 'select':
      return (
        <ObjectTile paint={paint} material="paper">
          <g className="mi-part mi-check">
            <path
              d="m7 17 6 6 13-13-3-3-10 10-3-3Z"
              transform="translate(0 2)"
              fill={paint('accentEdge')}
            />
            <path d="m7 17 6 6 13-13-3-3-10 10-3-3Z" fill={paint('accent')} />
            <path
              d="m9 17 4 4L24 10"
              fill="none"
              stroke={paint('paper')}
              strokeWidth="1"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity=".5"
            />
          </g>
        </ObjectTile>
      );
    case 'settings':
      return (
        <g className="mi-part mi-gear" stroke="none">
          <g transform="translate(0 2)" fill={paint('metalEdge')}>
            <circle cx="16" cy="16" r="11" />
            {[0, 60, 120, 180, 240, 300].map((angle) => (
              <rect
                key={angle}
                x="12.5"
                y="2.5"
                width="7"
                height="8"
                rx=".7"
                transform={`rotate(${angle} 16 16)`}
              />
            ))}
          </g>
          <g fill={paint('metal')}>
            <circle cx="16" cy="16" r="11" />
            {[0, 60, 120, 180, 240, 300].map((angle) => (
              <rect
                key={angle}
                x="12.5"
                y="2.5"
                width="7"
                height="8"
                rx=".7"
                transform={`rotate(${angle} 16 16)`}
              />
            ))}
          </g>
          <path
            d="M16 5a11 11 0 0 1 0 22Z"
            fill={paint('halftone')}
            opacity=".38"
          />
          <circle cx="16" cy="16" r="6.4" fill={paint('metalEdge')} />
          <circle cx="16" cy="16.7" r="5.4" fill={paint('ink')} />
          <circle cx="16" cy="17" r="3.6" fill={paint('accentEdge')} />
          <circle cx="16" cy="16" r="3.6" fill={paint('accent')} />
          <path
            d="M13.7 16h4.6"
            fill="none"
            stroke={paint('ink')}
            strokeWidth="1.2"
          />
          <path
            d="M7.6 12a9 9 0 0 1 5.5-4.4M14 3.2h4M14 15.7a2 2 0 0 1 2-1.7"
            fill="none"
            stroke={paint('paper')}
            strokeWidth="1.1"
            strokeLinecap="round"
            opacity=".6"
          />
        </g>
      );
    case 'help':
      return (
        <g stroke="none">
          <path d="M7 3h19v6l3 3-3 3v15H6V17l-3-3 3-3V3Z" fill={paint('ink')} />
          <path
            d="M6 2h19v7l3 3-3 3v13H5V16l-3-3 3-3V2Z"
            fill={paint('paper')}
            stroke={paint('ink')}
            strokeWidth=".7"
          />
          <path
            d="M20 2h5v7l3 3-3 3v13h-9Z"
            fill={paint('halftone')}
            opacity=".23"
          />
          <path
            d="M8 5h14v20H8Z"
            fill="none"
            stroke={paint('paperEdge')}
            strokeWidth=".9"
          />
          <g className="mi-part mi-question">
            <path
              d="M12 11.5c0-4.7 8.5-4.7 8.5 0 0 3.5-4.5 3.2-4.5 6.5"
              fill="none"
              stroke={paint('accentEdge')}
              strokeWidth="4"
              strokeLinecap="round"
              transform="translate(0 1.4)"
            />
            <path
              d="M12 11.5c0-4.7 8.5-4.7 8.5 0 0 3.5-4.5 3.2-4.5 6.5"
              fill="none"
              stroke={paint('accent')}
              strokeWidth="3.6"
              strokeLinecap="round"
            />
            <circle cx="16" cy="23" r="2" fill={paint('accentEdge')} />
            <circle cx="16" cy="21.8" r="2" fill={paint('accent')} />
          </g>
        </g>
      );
    case 'fit':
      return (
        <g stroke="none">
          <g className="mi-part mi-fit-corners">
            <path
              d="M10 3H4a2 2 0 0 0-2 2v7h5V8h5V3ZM22 3h6a2 2 0 0 1 2 2v7h-5V8h-5V3ZM2 22v7a2 2 0 0 0 2 2h8v-5H7v-4ZM25 22v4h-5v5h8a2 2 0 0 0 2-2v-7Z"
              fill={paint('metalEdge')}
            />
            <path
              d="M10 1.5H4a2 2 0 0 0-2 2v7h5v-4h5v-5ZM22 1.5h6a2 2 0 0 1 2 2v7h-5v-4h-5v-5ZM2 20.5v7a2 2 0 0 0 2 2h8v-5H7v-4ZM25 20.5v4h-5v5h8a2 2 0 0 0 2-2v-7Z"
              fill={paint('metal')}
            />
            <path
              d="M7 6.5h5v-5H9v3H4v6h3ZM25 6.5h-5v-5h3v3h5v6h-3ZM2 25v2.5a2 2 0 0 0 2 2h8v-3H4V25ZM25 25v1.5h-5v3h8a2 2 0 0 0 2-2V25Z"
              fill={paint('halftone')}
              opacity=".4"
            />
            <path
              d="M8 12V8h4M20 8h4v4M8 20v4h4M20 24h4v-4"
              fill="none"
              stroke={paint('ink')}
              strokeWidth=".65"
            />
            <path
              d="M4 9V3.5h6M22 3.5h6V9M4 23v3.5h5"
              fill="none"
              stroke={paint('paper')}
              strokeWidth="1"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity=".65"
            />
          </g>
          <circle cx="16" cy="16" r="4" fill={paint('paper')} />
          <circle cx="16" cy="16" r="2.5" fill={paint('accent')} />
        </g>
      );
    default:
      return null;
  }
}
