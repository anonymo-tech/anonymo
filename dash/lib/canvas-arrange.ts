import type { CanvasPoint } from './canvas-layout.ts';
type MeasuredNode = { id: string; position: CanvasPoint; measured?: { width?: number; height?: number } };
type TurnGroup = { id: string; answers: readonly { id: string }[] };
/** Arrange actual measured boxes. Refuse partial measurements instead of overlapping long answers. */
export function arrangeCanvas<T extends MeasuredNode>(nodes: readonly T[], turns: readonly TurnGroup[]): T[] | null {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const dimensions = (id: string) => {
    const node = byId.get(id);
    const width = node?.measured?.width, height = node?.measured?.height;
    return typeof width === 'number' && typeof height === 'number' &&
      Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? { width, height } : null;
  };
  const positions = new Map<string, CanvasPoint>();
  let y = 0;
  for (const turn of turns) {
    const prompt = dimensions(turn.id);
    const answers = turn.answers.map(answer => ({ id: answer.id, box: dimensions(answer.id) }));
    if (!prompt || answers.some(answer => !answer.box)) return null;
    const rowWidth = answers.reduce((total, answer) => total + answer.box!.width, 0) + Math.max(0, answers.length - 1) * 60;
    const width = Math.max(prompt.width, rowWidth, 1000);
    positions.set(turn.id, { x: (width - prompt.width) / 2, y });
    const answerY = y + prompt.height + 80;
    let x = (width - rowWidth) / 2;
    for (const answer of answers) {
      positions.set(answer.id, { x, y: answerY });
      x += answer.box!.width + 60;
    }
    y = answerY + Math.max(0, ...answers.map(answer => answer.box!.height)) + 120;
  }
  return nodes.map(node => ({ ...node, position: positions.get(node.id) ?? node.position }));
}
