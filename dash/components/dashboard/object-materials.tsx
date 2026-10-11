export type ObjectGlyphProps = {
  name: string;
  paint: (material: string) => string;
};

const materials: Record<string, readonly [string, string, string, string]> = {
  paper: ['#fffdf3', '#f7f5e9', '#f0eee2', '#d8d6cd'],
  paperEdge: ['#eeeade', '#b3b1a9', '#343431', '#080808'],
  ink: ['#252525', '#111111', '#060606', '#000000'],
  inkEdge: ['#141414', '#080808', '#000000', '#000000'],
  accent: ['#333333', '#151515', '#080808', '#000000'],
  accentEdge: ['#181818', '#090909', '#000000', '#000000'],
  metal: ['#fffdf3', '#f1efe4', '#d2d0c7', '#74746e'],
  metalEdge: ['#ceccc3', '#8d8c85', '#292929', '#000000'],
  glass: ['#edebdf', '#c6c4b9', '#3a3a35', '#050505'],
};

export function ObjectMaterials({
  id,
  names,
}: {
  id: string;
  names: readonly string[];
}) {
  return (
    <defs>
      {names.map((name) => {
        if (name === 'halftone') {
          return (
            <pattern
              key={name}
              id={`${id}-${name}`}
              patternUnits="userSpaceOnUse"
              width="1.8"
              height="1.8"
            >
              <circle cx="0.45" cy="0.45" r="0.4" fill="#000" />
              <circle cx="1.35" cy="1.35" r="0.4" fill="#000" />
            </pattern>
          );
        }
        if (name === 'stipple') {
          return (
            <pattern
              key={name}
              id={`${id}-${name}`}
              patternUnits="userSpaceOnUse"
              width="2.4"
              height="2.4"
            >
              <circle cx="0.6" cy="0.6" r="0.48" fill="#000" />
              <circle cx="1.8" cy="1.8" r="0.32" fill="#000" />
            </pattern>
          );
        }
        const colors = materials[name];
        if (!colors) return null;
        const stops = (
          <>
            <stop offset="0" stopColor={colors[0]} />
            <stop offset="0.36" stopColor={colors[1]} />
            <stop offset="0.74" stopColor={colors[2]} />
            <stop offset="1" stopColor={colors[3]} />
          </>
        );
        return name !== 'accent' ? (
          <linearGradient
            key={name}
            id={`${id}-${name}`}
            x1="0"
            y1="0"
            x2="0.75"
            y2="1"
          >
            {stops}
          </linearGradient>
        ) : (
          <radialGradient
            key={name}
            id={`${id}-${name}`}
            cx="0.24"
            cy="0.1"
            r="1.06"
            fx="0.2"
            fy="0.06"
          >
            {stops}
          </radialGradient>
        );
      })}
    </defs>
  );
}
