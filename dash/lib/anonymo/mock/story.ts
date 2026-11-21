import { createAnonymoClient } from '../client.ts';
import { STORY_PROMPT, type Story, type StoryAction } from '../story.ts';
import type { ChatMessage } from '../types.ts';
import type { MockGateway } from './gateway.ts';

export const DEMO_STORY: Story = {
  id: 'sample-story',
  title: 'The Lantern at Low Tide',
  bible: {
    premise: 'A lighthouse keeper finds a lantern that reveals the road the sea has taken.',
    cast: 'The keeper — methodical, more comfortable with clocks than people.\nThe ferryman — observant, unwilling to cross after dark.',
    setting: 'A tidal town where the lighthouse stands above a drowned road.',
    tone: 'Quiet, eerie, and tender.',
    pov: 'Close third person, with the keeper.',
    rules: 'Keep it in present tense. Let the tide and ordinary objects carry the unease.',
  },
  chapters: [
    {
      id: 'sample-chapter-one',
      title: 'The Last Crossing',
      text: 'At dusk the ferryman ties his boat to the highest ring on the quay. He winds the rope twice, then winds it a third time.\n\n“Nothing crosses tonight,” he tells the keeper. He opens a wooden box just long enough for her to see the lantern inside. Its glass is clear and dry. Everything else in the box is wet.\n\nBy the time she reaches the lighthouse, the tide has covered the road.',
      recap: 'The ferryman ends crossings before dark and entrusts the keeper with a lantern that stays dry inside a soaked box. The tide covers the road before she reaches the lighthouse.',
      undo: [],
    },
    {
      id: 'sample-chapter-two',
      title: 'A Light Below',
      text: 'The tide is out when the keeper wakes. An hour ago the sea was resting against the lighthouse wall. Now the steps are dry to the bottom, and beyond them a row of white stones leads away across the sand.\n\nShe takes the lantern down. The flame bends toward the water although there is no wind. In its light the stones look less like stones than the backs of hands.\n\nAt the first bend, someone has left a key on the road.',
      recap: '',
      undo: [],
    },
  ],
};

const replies: Record<StoryAction, string> = {
  continue: [
    'She puts the lantern on a flat stone and kneels. The key is brass, its teeth worn almost smooth. A loop of blue thread is tied through its bow. She recognizes the thread before she recognizes the key. It comes from the spool in the drawer beneath the lighthouse clock, the spool she uses to mark the days when the foghorn fails.',
    'She has never seen a lock for it. The drawer has no lock. The clock takes a winding crank, as any visitor who stays long enough to be bored will discover. She picks up the key anyway. It is warmer than her hand.',
    'Behind her, the lantern glass ticks once. The light reaches farther than before. Where the road should disappear into the flats, it goes on between two low walls. A stone bench stands on the left. Farther along there is a bell hung from a beam. A strip of cloth has been tied round its clapper.',
    'She starts to turn back for a longer coat. Then she notices the wet marks beside the bench. There are two of them, level with the seat and about the width of her palms. Somebody has rested there after coming out of the water. The marks have narrow dry edges. In another minute they will be gone.',
    'The ferryman has taught her to read time from smaller things. How long a rope has dragged in the harbor. How recently a fish has touched the air. He says it is a habit you pick up on the coast, because the clocks here describe what happens ashore.',
    'She takes the lantern by its handle and walks as far as the bell. A wooden door stands behind the beam, set into a wall scarcely higher than her shoulders. She holds up the key. The blue thread lifts and points through the keyhole.',
    '“Are you expecting me?” she asks. She speaks as quietly as she would in the lantern room when the clock is about to strike.',
    'There is a short wait. Then, on the other side of the door, someone sets down a cup. She hears the small, familiar rattle of a saucer on uneven wood.',
  ].join('\n\n'),
  rewrite: 'The keeper carries the lantern to the foot of the steps. Its flame leans seaward. She moves it to her other hand, and the flame keeps leaning. The white stones are dry on top, but as she passes, water rises around each one.',
  expand: 'At the first bend the road dips. A key rests on the exposed crown of a cobble, its stem pointed back toward the lighthouse. Sand has collected in the teeth. The keeper brushes it away with her sleeve and finds blue thread wound through the bow, three knots close together. She stands very still. Those are the knots she ties in the dark when there is no one to hold the other end.',
  summarize: 'The keeper wakes to find the tide gone and a road of white stones exposed beyond the lighthouse. The ferryman’s lantern bends toward the sea and changes how the stones appear. At the first bend, she discovers a key left where she will see it.',
};

export function demoStoryReply(messages: ChatMessage[]) {
  if (!messages[0]?.content.startsWith(STORY_PROMPT)) return null;
  const request = messages[1]?.content ?? '';
  const action = /^Action: (continue|rewrite|expand|summarize)\n/.exec(request)?.[1] as StoryAction | undefined;
  if (action === 'rewrite' && /^Writer’s instruction\n\n[^\n]*dialogue/im.test(request)) {
    return '“Is that the road?” she asks.\n\nThe ferryman stays on the steps. “It is tonight.”\n\nShe lifts the lantern. The flame draws out until its tip touches the glass. “And in the morning?”\n\nHe puts one hand on the railing. “In the morning you can ask me again.”';
  }
  return action ? replies[action] : null;
}

const demoClients = new WeakMap<MockGateway, ReturnType<typeof makeDemoClient>>();

async function makeDemoClient(mock: MockGateway) {
  const options = { baseUrl: 'https://demo.anonymo.invalid', fetch: mock.fetch };
  const { key } = await createAnonymoClient(options).createKey();
  await mock.simulateDeposit(key, 'rhc', 'USDG', 10_000_000);
  return createAnonymoClient({ ...options, key });
}

export function storyDemoClient(mock: MockGateway) {
  const existing = demoClients.get(mock);
  if (existing) return existing;
  const client = makeDemoClient(mock).catch((error) => {
    demoClients.delete(mock);
    throw error;
  });
  demoClients.set(mock, client);
  return client;
}
