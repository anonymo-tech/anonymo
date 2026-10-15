export type SecondLookFeature = {
  id: string;
  name: string;
  line: string;
  description: string;
  phase: string;
  icon: string;
  checks: string[];
  note: string;
};

export const secondLookFeatures: SecondLookFeature[] = [
  {
    id: 'before-you-buy',
    name: 'Before You Buy',
    line: 'A closer look before the leap.',
    description:
      'Turn a token address or link into a clear, evidence-led card. See who controls the token, how its supply is held and what a simulated sell reveals.',
    phase: 'SECOND LOOK / PHASE 01',
    icon: 'shield',
    checks: [
      'Token controls & transfer rules',
      'Sell simulation & liquidity',
      'Early buyers & holder concentration',
      'Deployer history & lookalike tokens',
    ],
    note: 'Planned cards show reasons, sources and check times. “No red flags found” describes the checks, not a guarantee about the token.',
  },
  {
    id: 'signature-firewall',
    name: 'Signature Firewall',
    line: 'Read before you sign.',
    description:
      'Understand a transaction, signing request or suspicious link before approving it. Make permissions and simulated balance changes easier to inspect.',
    phase: 'SECOND LOOK / PHASE 01',
    icon: 'key',
    checks: [
      'Transaction & message explanations',
      'Simulated balance changes',
      'Unexpected permissions & transfers',
      'Lookalike domains & app checks',
    ],
    note: 'Builds on the transaction Explainer. Findings explain recognised patterns and the scope of the inspection.',
  },
  {
    id: 'true-pnl',
    name: 'True P&L + Tax',
    line: 'Know your real number.',
    description:
      'Bring trades, fees and transfers into one wallet history. Understand realised and open positions, then prepare records for your tax workflow.',
    phase: 'PHASE 01 / TAX EXPORTS IN PHASE 02',
    icon: 'coins',
    checks: [
      'Fee-aware profit & loss',
      'Transfers between your own wallets',
      'Illiquid positions & marked estimates',
      'CSV exports with transaction references',
    ],
    note: 'Tax exports are planned as records for review with your tax adviser. Cost-basis methods and supported formats depend on the applicable rules.',
  },
  {
    id: 'follow-check',
    name: 'Follow Check',
    line: 'Know who you’re following.',
    description:
      'Look beyond a winning screenshot. Review a trader’s on-chain record, drawdowns, holding periods and the activity around their entries and exits.',
    phase: 'SECOND LOOK / PHASE 02',
    icon: 'scroll',
    checks: [
      '90-day performance & drawdown',
      'Holding periods & early entries',
      'Selling during follower buying',
      'Follow alerts, mutes & quiet hours',
    ],
    note: 'Sample sizes stay visible. Possible wallet links describe observed patterns; they do not establish identity or intent.',
  },
  {
    id: 'cool-head',
    name: 'Cool Head',
    line: 'A little perspective. At the right time.',
    description:
      'Notice patterns in your own trading: chasing a sudden move, re-entering after a loss or increasing position sizes. Set a budget and choose when to pause.',
    phase: 'SECOND LOOK / PHASE 02',
    icon: 'gauntlet',
    checks: [
      'Personal trading-pattern reminders',
      'Daily budgets & progress',
      'Short, factual notes from your history',
      'Adjustable signals & an off switch',
    ],
    note: 'Linked wallets receive reminders after observed trades. Enforced trading limits belong to the later, optional Guarded Wallet.',
  },
  {
    id: 'why-it-moved',
    name: 'Why It Moved',
    line: 'Follow the move back to the evidence.',
    description:
      'Explore the buying, selling and events around a price move. Put wallet flows, liquidity changes and sourced news into a single timeline.',
    phase: 'SECOND LOOK / PHASE 02',
    icon: 'scroll',
    checks: [
      'Buyer and seller flow breakdowns',
      'Large-wallet & cluster activity',
      'Liquidity, listing & promotion events',
      'A timeline with traceable sources',
    ],
    note: 'The goal is a grounded explanation of observed activity, with the difference between evidence and inference kept clear.',
  },
  {
    id: 'exit-plan',
    name: 'Exit Plan',
    line: 'Give the decision a plan.',
    description:
      'Set the levels and position sizes that matter to you. Get an alert when a level is reached, with optional execution planned for the Guarded Wallet.',
    phase: 'PHASE 02 / GUARDED EXECUTION IN PHASE 03',
    icon: 'scroll',
    checks: [
      'Take-profit & stop reminders',
      'Position sizes & slippage settings',
      'Telegram, push & in-app alerts',
      'Optional Guarded Wallet execution',
    ],
    note: 'External wallets receive reminders. Future execution depends on the market, liquidity and the limits you approve; a stop is not a guaranteed fill.',
  },
  {
    id: 'guarded-wallet',
    name: 'Guarded Wallet',
    line: 'Your wallet. Your rules.',
    description:
      'An optional Solana wallet designed to enforce your chosen trading limits on-chain. Keep daily budgets, token exposure and cooling-off periods part of the transaction itself.',
    phase: 'SECOND LOOK / PHASE 03',
    icon: 'shield',
    checks: [
      'Daily spend & per-token limits',
      'Gross realised-loss caps & cool-downs',
      'Token policies checked at purchase',
      'A home-wallet withdrawal path',
    ],
    note: 'Planned for a staged beta and independent review. Limits govern trading inside this wallet; strict mode adds open-position checks through an additional service.',
  },
  {
    id: 'rooms',
    name: 'Rooms',
    line: 'Every call has a record.',
    description:
      'Give a trading group a shared place for research cards and recorded calls. See when a call was made, what followed and how the caller’s position changed.',
    phase: 'SECOND LOOK / PHASE 03',
    icon: 'scroll',
    checks: [
      'Timestamped calls & entry context',
      'Results over consistent time windows',
      'Caller history with sample sizes',
      'Shared token cards & Concur reviews',
    ],
    note: 'Rooms records calls and their outcomes. Chapters is the separate team-workspace direction for projects, roles and shared allowances.',
  },
  {
    id: 'everywhere',
    name: 'Everywhere',
    line: 'A second look, within reach.',
    description:
      'Carry the same research into the places you already work: the web, Telegram, mobile share sheets and the tools used by AI agents.',
    phase: 'ACROSS PHASES / WIDER CHAINS IN PHASE 04',
    icon: 'key',
    checks: [
      'Telegram bot, inline cards & mini app',
      'Seeker / Android & iOS share flows',
      'API & MCP tools for agents',
      'Read-only expansion to more chains',
    ],
    note: 'Solana leads the trading roadmap. Other-chain research starts with read-only P&L and Follow Check, with coverage expanded as it is validated.',
  },
];

export type RoadmapTrack = 'Workspace' | 'Second Look' | 'Access';
export type RoadmapChapter = {
  id: string;
  number: string;
  title: string;
  line: string;
  status: string;
  track: RoadmapTrack;
  label: string;
  icon: string;
  features: { name: string; description: string }[];
  milestone: string;
};
export const roadmapChapters: RoadmapChapter[] = [
  {
    id: 'foundation',
    number: '01',
    title: 'Gather the minds.',
    track: 'Workspace',
    label: 'THE FOUNDATION',
    status: 'Core features available',
    icon: 'gauntlet',
    line: 'A model council, a clear account and a shared place to think.',
    features: [
      {
        name: 'Multi-model Chat',
        description:
          'Ask up to four models together, compare responses, follow up with context and use blind comparison to focus on the answer.',
      },
      {
        name: 'Concur / Cross-Check · planned',
        description:
          'Bring independent model reviews and source checks to a claim. Keep agreement, dissent and inconclusive findings visible.',
      },
      {
        name: 'Key Guard & Explainer · planned',
        description:
          'Recognise sensitive key material before it is sent, and explain supported on-chain transactions in plain language.',
      },
      {
        name: 'Identity & the Common Purse',
        description:
          'Solana wallet and passkey sign-in, native mainnet USDC funding, usage quotes and settled costs. Standalone receipts remain a separate release.',
      },
    ],
    milestone:
      'Claude, GPT, Gemini, Grok, DeepSeek, Qwen and Llama text requests and Common Purse USDC top-ups are available. Cross-Check, Explainer and receipts are not released yet.',
  },
  {
    id: 'creative-workspace',
    number: '02',
    title: 'Keep the idea moving.',
    track: 'Workspace',
    label: 'THE CREATIVE WORKSPACE',
    status: 'Workspace available · more planned',
    icon: 'scroll',
    line: 'From a conversation to a canvas, a film or a finished brief.',
    features: [
      {
        name: 'Canvas & branching',
        description:
          'Arrange model responses, sources and notes spatially. Branch a promising direction while keeping its project context.',
      },
      {
        name: 'Studio: image & video',
        description:
          'Choose creative models, generate assets, compare takes and keep selected outputs with the project that inspired them.',
      },
      {
        name: 'Briefs & the Library',
        description:
          'Turn selected responses and evidence into editable briefs. Keep decisions, references and generated assets within reach.',
      },
      {
        name: 'Specialist agents',
        description:
          'Bring research, creative and task-focused agents into the workspace with clear tools, context and user controls.',
      },
      {
        name: 'Chapters',
        description:
          'Shared workspaces for teams, with rooms, roles and member allowances built around a common project.',
      },
    ],
    milestone:
      'Projects, Canvas, the Library and saved decisions are available. Studio, automated brief synthesis, specialist agents and Chapters remain planned.',
  },
  {
    id: 'second-look-1',
    number: '03',
    title: 'Take a second look.',
    track: 'Second Look',
    label: 'SECOND LOOK / PHASE 01',
    status: 'In development',
    icon: 'shield',
    line: 'Check a token. Understand a signature. See your wallet clearly.',
    features: [
      {
        name: 'Before You Buy',
        description:
          'A sourced token card covering authority controls, sell simulation, holders, early buyers, deployer history, liquidity and lookalikes.',
      },
      {
        name: 'Signature Firewall',
        description:
          'Inspect signing requests, balance changes, suspicious permissions and lookalike links before approving them.',
      },
      {
        name: 'True P&L',
        description:
          'Read-only wallet linking and a fee-aware view of trades, transfers and positions, with estimates identified.',
      },
      {
        name: 'Telegram cards',
        description:
          'Bring token checks into Telegram through a bot and inline cards that are easy to share.',
      },
    ],
    milestone:
      'Release quality is grounded in historical checks, simulation coverage, sourced explanations and reconciled wallet records.',
  },
  {
    id: 'second-look-2',
    number: '04',
    title: 'See the whole decision.',
    track: 'Second Look',
    label: 'SECOND LOOK / PHASE 02',
    status: 'In development',
    icon: 'coins',
    line: 'Understand the trader, the market move and your own habits.',
    features: [
      {
        name: 'Follow Check',
        description:
          'Review trader history, drawdowns, early entries and selling patterns. Follow selected wallets with useful, configurable alerts.',
      },
      {
        name: 'Cool Head',
        description:
          'Personal pattern reminders, adjustable budgets and the option to pause, using your own trading history where the sample supports it.',
      },
      {
        name: 'Why It Moved',
        description:
          'An evidence-led timeline of wallet flows, liquidity events, promotions and sourced news around a move.',
      },
      {
        name: 'Exit Plan reminders',
        description:
          'Choose levels and position sizes, then receive Telegram, push and in-app reminders when those levels are reached.',
      },
      {
        name: 'Tax-ready records',
        description:
          'Export transaction-linked CSV records for a tax workflow, with supported cost-basis methods and clear treatment of estimates.',
      },
      {
        name: 'First read-only chain expansion',
        description:
          'Extend P&L and Follow Check to Robinhood Chain after transaction attribution and data coverage are validated.',
      },
    ],
    milestone:
      'Research and coaching expand with validated data coverage, meaningful sample sizes and tested alert delivery.',
  },
  {
    id: 'second-look-3',
    number: '05',
    title: 'Put your rules to work.',
    track: 'Second Look',
    label: 'SECOND LOOK / PHASE 03',
    status: 'Planned',
    icon: 'shield',
    line: 'An optional Guarded Wallet and a shared record for trading groups.',
    features: [
      {
        name: 'Guarded Wallet',
        description:
          'On-chain daily spend, per-token exposure, gross realised-loss limits and cool-downs for trading inside the wallet.',
      },
      {
        name: 'Deliberate controls',
        description:
          'Tighten limits immediately; relax them after a waiting period. Keep a home-wallet withdrawal path independent of Conclave services.',
      },
      {
        name: 'Optional Exit Plan execution',
        description:
          'Execute approved plan legs inside the Guarded Wallet, subject to size, price floors and available liquidity.',
      },
      {
        name: 'Rooms & call records',
        description:
          'Share research cards, capture timestamped calls and review outcomes and caller history against on-chain activity.',
      },
    ],
    milestone:
      'A staged wallet beta, independent security review and tested withdrawal paths precede wider access.',
  },
  {
    id: 'second-look-4',
    number: '06',
    title: 'Widen the view.',
    track: 'Second Look',
    label: 'SECOND LOOK / PHASE 04',
    status: 'Planned',
    icon: 'scroll',
    line: 'The same depth of research, across more of your on-chain activity.',
    features: [
      {
        name: 'More EVM chains',
        description:
          'Expand read-only P&L and Follow Check beyond the first supported chains, guided by user demand and reliable coverage.',
      },
      {
        name: 'A connected wallet picture',
        description:
          'Bring supported wallet histories into a consistent view, keeping chain coverage and estimates explicit.',
      },
      {
        name: 'Deeper research',
        description:
          'Extend token and trader context as the underlying data becomes more complete, with traceable evidence and consistent methods.',
      },
    ],
    milestone:
      'Read-only research expands first. The trading roadmap remains centred on Solana.',
  },
  {
    id: 'access',
    number: '07',
    title: 'Take Conclave with you.',
    track: 'Access',
    label: 'MOBILE, AGENTS & DEVELOPER ACCESS',
    status: 'Planned across releases',
    icon: 'key',
    line: 'The workspace and the second opinion, wherever the question starts.',
    features: [
      {
        name: 'Telegram mini app',
        description:
          'A compact home for cards, followed wallets, P&L and Exit Plans, alongside the bot and inline sharing.',
      },
      {
        name: 'Seeker / Android',
        description:
          'Share a token or explorer link straight into a check, with mobile access designed around the device’s wallet capabilities.',
      },
      {
        name: 'iOS',
        description:
          'Share-sheet entry points and a dedicated mobile experience for research, alerts and supported wallet tools.',
      },
      {
        name: 'API & MCP',
        description:
          'Let authorised agents request token, trader, signature and market-move checks, with account-scoped access for personal wallet data.',
      },
    ],
    milestone:
      'Each surface follows the capabilities it exposes, with permission, signing and notification behaviour checked on the target device.',
  },
];
