import type { BriefDocument } from '../../lib/brief-document';

export interface Answer {
  live?: {
    callId: string;
    state: string;
    errorCode: string | null;
    billing: {
      state: string;
      maximumUsd6: string | null;
      actualUsd6: string | null;
    };
    modelName?: string;
    routeVersionId?: string | null;
    label?: string;
    output?: string;
    outputTruncated?: boolean;
    outputLength?: number;
    /** A stop is draining the upstream; output is frozen until the call settles. */
    cancelRequested?: boolean;
  };
  id: string;
  modelId: string;
  heading: string;
  paragraphs: string[];
}

export interface Turn {
  live?: {
    comparisonId: string;
    blind: boolean;
    revealedAt?: string | null;
    votedCallId?: string | null;
    createdAt?: string;
  };
  id: string;
  prompt: string;
  answers: Answer[];
}

export interface Room {
  live?: { revision: number; historyCursor?: string | null };
  id: string;
  name: string;
  pinned: boolean;
  updatedAt: number;
  draft: string;
  selectedModels: string[];
  turns: Turn[];
}

export interface CanvasBrief {
  live?: { revision: number; document?: BriefDocument };
  id: string;
  title: string;
  body: string;
  roomId: string;
  createdAt: number;
}

export interface WorkspaceState {
  version: 1;
  activeRoomId: string;
  rooms: Room[];
  briefs: CanvasBrief[];
}

export const workspaceKey = 'conclave-canvas-workspace-v1';

export const canvasPrompts = {
  launch: 'How should I launch my notes app in two weeks?',
  checklist: 'Turn this into a two-week checklist.',
  solana: 'What should I check before approving a Solana transaction?',
  website: 'How can I make my website clearer without a full redesign?',
} as const;

export const canvasLimits = {
  rooms: 24,
  turnsPerRoom: 40,
  modelsPerTurn: 4,
  paragraphsPerAnswer: 8,
  briefs: 100,
  roomName: 80,
  prompt: 6000,
  draft: 6000,
  answerHeading: 160,
  paragraph: 4000,
  briefTitle: 120,
  briefBody: 24000,
  totalText: 400000,
} as const;

// Kept independent of rendering and browser APIs; tests check this catalog against MODELS.
const modelNames: Readonly<Record<string, string>> = {
  claude: 'Claude',
  gpt: 'GPT',
  gemini: 'Gemini',
  grok: 'Grok',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  llama: 'Llama',
};
const defaultModels = ['claude', 'gemini'];
type SampleAnswer = Pick<Answer, 'heading' | 'paragraphs'>;
type SamplePair = Record<'claude' | 'gemini', SampleAnswer>;

const launchSamples: SamplePair = {
  claude: {
    heading: 'Test the core loop first.',
    paragraphs: [
      'Invite five people to save a note and find it again. Fix what stops them.',
      'Spend week two inviting a small beta group.',
    ],
  },
  gemini: {
    heading: 'Choose a narrow audience.',
    paragraphs: [
      'Pick one group with a shared problem. Build a 30-second demo around their workflow.',
      'Use week two to recruit your first ten users.',
    ],
  },
};

const checklistSamples: SamplePair = {
  claude: {
    heading: 'Prove the loop, then invite people.',
    paragraphs: [
      'Days 1–3: ask five people to save a note, close the app, and find it again. Record the points where they get stuck.',
      'Days 4–7: fix the biggest obstacles. Check onboarding, search, and recovery before adding features.',
      'Days 8–14: invite a small beta group, collect feedback, and check whether people return to their notes.',
    ],
  },
  gemini: {
    heading: 'Keep one audience in view.',
    paragraphs: [
      'Days 1–3: choose one audience and describe the note-taking problem you are solving for them.',
      'Days 4–7: make a 30-second demonstration and a simple invitation page around that workflow.',
      'Days 8–14: recruit ten people, help them try the app, and compare what they need with what you built.',
    ],
  },
};

const solanaSamples: SamplePair = {
  claude: {
    heading: 'Read what the transaction can change.',
    paragraphs: [
      'For this example, inspect the program, accounts, recipient, amount, and any change of authority. An approval can grant permission even when it transfers nothing immediately.',
      'This workspace has not decoded or simulated a transaction. Keep your wallet closed until you can verify the request in a trusted, read-only inspector.',
    ],
  },
  gemini: {
    heading: 'Check permissions and expected balance changes.',
    paragraphs: [
      'Compare the requested action with the program and accounts shown by your wallet. Look for unexpected delegates, authority changes, and writable accounts.',
      'A simulation is supporting evidence, not a guarantee. This is a sample checklist only: no RPC request, wallet connection, signature, or transaction has been made.',
    ],
  },
};

const websiteSamples: SamplePair = {
  claude: {
    heading: 'Give each page one clear job.',
    paragraphs: [
      'Start with the first screen: say who the product helps, what it helps them do, and what they can try next.',
      'Keep the main action visible. Remove repeated claims and move supporting detail below the essentials.',
    ],
  },
  gemini: {
    heading: 'Test the path before changing the look.',
    paragraphs: [
      'Ask a few people to find the product explanation and the next step. Observe where they hesitate without coaching them.',
      'Improve labels, page order, and mobile readability first. Retest the same tasks after each small change.',
    ],
  },
};

function modelExists(value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(modelNames, value);
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function normalizedPrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').toLowerCase();
}

function sampleFor(prompt: string): SamplePair | null {
  const normalized = normalizedPrompt(prompt);
  if (normalized === normalizedPrompt(canvasPrompts.launch))
    return launchSamples;
  if (
    [
      canvasPrompts.checklist,
      'Turn that into a 14-day checklist.',
      'Give me a two-week checklist.',
      'Make it a checklist.',
      'Make it a checklist',
    ].some((sample) => normalized === normalizedPrompt(sample))
  )
    return checklistSamples;
  if (normalized === normalizedPrompt(canvasPrompts.solana))
    return solanaSamples;
  if (normalized === normalizedPrompt(canvasPrompts.website))
    return websiteSamples;
  return null;
}

function modelSelection(value: unknown): value is string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > canvasLimits.modelsPerTurn
  )
    return false;
  const seen = new Set<string>();
  for (const model of value) {
    if (!modelExists(model) || seen.has(model)) return false;
    seen.add(model);
  }
  return true;
}

function makeTurn(prompt: string, modelIds: string[], turnId: string): Turn {
  if (
    typeof prompt !== 'string' ||
    !prompt.trim() ||
    prompt.length > canvasLimits.prompt ||
    !modelSelection(modelIds)
  ) {
    throw new RangeError(
      'Enter a question within the length limit and choose one to four available models.',
    );
  }
  const samples = sampleFor(prompt);
  return {
    id: turnId,
    prompt,
    answers: modelIds.map((modelId) => {
      const sample =
        samples && (modelId === 'claude' || modelId === 'gemini')
          ? samples[modelId]
          : null;
      return {
        id: `${turnId}-${modelId}`,
        modelId,
        heading: sample?.heading ?? 'No live model result.',
        paragraphs: sample
          ? [...sample.paragraphs]
          : [
              'This preview is not connected to a model. Your question stays in this browser, and no answer has been generated for it.',
              'Use a prepared example to explore the comparison, or keep this question in your project for later.',
            ],
      };
    }),
  };
}

export function createRoom(name: string): Room {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > canvasLimits.roomName
  ) {
    throw new RangeError('Give the project a name of 1–80 characters.');
  }
  return {
    id: id('room'),
    name: name.trim(),
    pinned: false,
    updatedAt: Date.now(),
    draft: '',
    selectedModels: [...defaultModels],
    turns: [],
  };
}

export function createSampleTurn(prompt: string, modelIds: string[]): Turn {
  return makeTurn(prompt, modelIds, id('turn'));
}

export function initialWorkspace(): WorkspaceState {
  const now = Date.now();
  const rooms: Room[] = [
    {
      id: 'room-launch',
      name: 'Launch plan',
      pinned: true,
      updatedAt: now,
      draft: '',
      selectedModels: [...defaultModels],
      turns: [
        makeTurn(canvasPrompts.launch, defaultModels, 'turn-launch-sample'),
      ],
    },
    {
      id: 'room-solana',
      name: 'Solana research',
      pinned: false,
      updatedAt: now - 3600000,
      draft: '',
      selectedModels: [...defaultModels],
      turns: [
        makeTurn(canvasPrompts.solana, defaultModels, 'turn-solana-sample'),
      ],
    },
    {
      id: 'room-website',
      name: 'Website refresh',
      pinned: false,
      updatedAt: now - 86400000,
      draft: '',
      selectedModels: [...defaultModels],
      turns: [
        makeTurn(canvasPrompts.website, defaultModels, 'turn-website-sample'),
      ],
    },
  ];
  return { version: 1, activeRoomId: rooms[0].id, rooms, briefs: [] };
}

function record(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Reflect.ownKeys(value).length !== keys.length) return false;
  return keys.every(
    (key) => Object.getOwnPropertyDescriptor(value, key)?.value !== undefined,
  );
}

function timestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8640000000000000
  );
}

/** Validate the complete saved workspace. Never discard only the malformed records. */
export function parseWorkspace(value: unknown): WorkspaceState | null {
  try {
    let budget = canvasLimits.totalText as number;
    const identifiers = new Set<string>();
    const text = (
      entry: unknown,
      max: number,
      empty = false,
    ): entry is string => {
      if (
        typeof entry !== 'string' ||
        entry.length > max ||
        (!empty && !entry.trim())
      )
        return false;
      budget -= entry.length;
      return budget >= 0;
    };
    const identifier = (entry: unknown): entry is string => {
      if (
        !text(entry, 120) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entry) ||
        identifiers.has(entry)
      )
        return false;
      identifiers.add(entry);
      return true;
    };
    if (
      !record(value, ['version', 'activeRoomId', 'rooms', 'briefs']) ||
      value.version !== 1 ||
      !text(value.activeRoomId, 120)
    )
      return null;
    if (
      !Array.isArray(value.rooms) ||
      value.rooms.length < 1 ||
      value.rooms.length > canvasLimits.rooms
    )
      return null;
    if (
      !Array.isArray(value.briefs) ||
      value.briefs.length > canvasLimits.briefs
    )
      return null;
    const rooms: Room[] = [];
    for (const room of value.rooms) {
      if (
        !record(room, [
          'id',
          'name',
          'pinned',
          'updatedAt',
          'draft',
          'selectedModels',
          'turns',
        ]) ||
        !identifier(room.id) ||
        !text(room.name, canvasLimits.roomName) ||
        typeof room.pinned !== 'boolean' ||
        !timestamp(room.updatedAt) ||
        !text(room.draft, canvasLimits.draft, true) ||
        !modelSelection(room.selectedModels) ||
        !Array.isArray(room.turns) ||
        room.turns.length > canvasLimits.turnsPerRoom
      )
        return null;
      const turns: Turn[] = [];
      for (const turn of room.turns) {
        if (
          !record(turn, ['id', 'prompt', 'answers']) ||
          !identifier(turn.id) ||
          !text(turn.prompt, canvasLimits.prompt) ||
          !Array.isArray(turn.answers) ||
          turn.answers.length < 1 ||
          turn.answers.length > canvasLimits.modelsPerTurn
        )
          return null;
        const answers: Answer[] = [];
        const answerModels = new Set<string>();
        for (const answer of turn.answers) {
          if (
            !record(answer, ['id', 'modelId', 'heading', 'paragraphs']) ||
            !identifier(answer.id) ||
            !modelExists(answer.modelId) ||
            answerModels.has(answer.modelId) ||
            !text(answer.heading, canvasLimits.answerHeading) ||
            !Array.isArray(answer.paragraphs) ||
            answer.paragraphs.length < 1 ||
            answer.paragraphs.length > canvasLimits.paragraphsPerAnswer
          )
            return null;
          answerModels.add(answer.modelId);
          const paragraphs: string[] = [];
          for (const paragraph of answer.paragraphs) {
            if (!text(paragraph, canvasLimits.paragraph)) return null;
            paragraphs.push(paragraph);
          }
          answers.push({
            id: answer.id,
            modelId: answer.modelId,
            heading: answer.heading,
            paragraphs,
          });
        }
        turns.push({ id: turn.id, prompt: turn.prompt, answers });
      }
      rooms.push({
        id: room.id,
        name: room.name,
        pinned: room.pinned,
        updatedAt: room.updatedAt,
        draft: room.draft,
        selectedModels: [...room.selectedModels],
        turns,
      });
    }
    const roomIds = new Set(rooms.map((room) => room.id));
    if (!roomIds.has(value.activeRoomId)) return null;
    const briefs: CanvasBrief[] = [];
    for (const brief of value.briefs) {
      if (
        !record(brief, ['id', 'title', 'body', 'roomId', 'createdAt']) ||
        !identifier(brief.id) ||
        !text(brief.title, canvasLimits.briefTitle) ||
        !text(brief.body, canvasLimits.briefBody) ||
        typeof brief.roomId !== 'string' ||
        !roomIds.has(brief.roomId) ||
        !timestamp(brief.createdAt)
      )
        return null;
      briefs.push({
        id: brief.id,
        title: brief.title,
        body: brief.body,
        roomId: brief.roomId,
        createdAt: brief.createdAt,
      });
    }
    return { version: 1, activeRoomId: value.activeRoomId, rooms, briefs };
  } catch {
    return null;
  }
}

/** Copy chosen perspectives into a local artifact without inventing a synthesis. */
export function createBrief(
  room: Room,
  answerIds: string[],
): CanvasBrief | null {
  if (
    !Array.isArray(answerIds) ||
    !answerIds.length ||
    answerIds.length > canvasLimits.turnsPerRoom * canvasLimits.modelsPerTurn ||
    new Set(answerIds).size !== answerIds.length
  )
    return null;
  const checked = parseWorkspace({
    version: 1,
    activeRoomId: room?.id,
    rooms: [room],
    briefs: [],
  });
  if (!checked) return null;
  const selected = new Set(answerIds);
  const sections: string[] = [];
  let count = 0;
  for (const turn of checked.rooms[0].turns) {
    const answers = turn.answers.filter((answer) => selected.has(answer.id));
    if (!answers.length) continue;
    sections.push(`## ${turn.prompt}`);
    for (const answer of answers) {
      sections.push(
        `### ${modelNames[answer.modelId]} — ${answer.heading}\n\n${answer.paragraphs.join('\n\n')}`,
      );
      count += 1;
    }
  }
  if (count !== answerIds.length) return null;
  const body = `Local sample comparison. No live models were called.\n\n${sections.join('\n\n')}`;
  if (body.length > canvasLimits.briefBody) return null;
  return {
    id: id('brief'),
    title: checked.rooms[0].name,
    body,
    roomId: checked.rooms[0].id,
    createdAt: Date.now(),
  };
}
