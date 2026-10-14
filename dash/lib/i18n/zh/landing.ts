import type { Dictionary } from '../index.ts';

/** Simplified Chinese, keyed by the exact English source text. See lib/i18n/TRANSLATING.md. */
export default {
  'What is Conclave?': 'Conclave 是什么？',
  'A multi-model AI chat built for Solana. Ask seven models in one room, take a single answer or compare up to four side by side, and follow up with the context intact. Sign in with a Solana wallet or a passkey and start asking.':
    '为 Solana 打造的多模型 AI 对话。在同一个议事厅向七个模型提问，获取单个回答，或并排比较最多四个回答；继续追问时，上下文始终保留。使用 Solana 钱包或通行密钥登录，即可开始提问。',
  'Does every model have the same privacy?': '各模型的隐私政策都一样吗？',
  "No. Each model is hosted by its own maker, and every request travels through one inference provider rather than running on your device. Treat anything you type as shared with that provider and the model's host. Per-route privacy labels and strict refusal are planned, not yet available.":
    '不一样。每个模型都由其开发方托管，每次请求都经过同一家推理服务提供方，并非在你的设备上运行。请将输入的所有内容视为已与该提供方和模型托管方共享。各路由的隐私标签和严格拒绝机制仍在计划中，尚未开放。',
  'Which models can I ask?': '可以向哪些模型提问？',
  'Seven today: Claude, GPT, Gemini, Grok, DeepSeek, Qwen and Llama, all reached through one provider. Pick one model, mention several with @ to compare them, or choose Auto and let the room pick a model for the question. Model names belong to their makers.':
    '目前支持七个模型：Claude、GPT、Gemini、Grok、DeepSeek、Qwen 和 Llama，均通过同一家提供方接入。可以选择一个模型，用 @ 提及多个模型进行比较，或选择自动，让议事厅为问题挑选模型。模型名称归各自开发方所有。',
  'How do credits work?': '额度如何使用？',
  'You prepay one credit balance in US dollars. Before a request runs you see a quote, and the quote shows a 5% platform fee on top of model usage. The actual cost is settled afterwards against that quote. USDC deposits on Solana are planned and not yet available.':
    '预付额度以美元计价，统一计入一个余额。每次请求运行前都会显示报价，其中列明模型使用费及额外的 5% 平台费。实际费用在请求完成后依据该报价结算。Solana 上的 USDC 充值仍在计划中，尚未开放。',
  'Can Conclave sign or execute transactions?':
    'Conclave 可以签名或执行交易吗？',
  'No. Signing in with a wallet means signing a short message that proves the account is yours; the message says it authorizes no transaction or payment. Conclave never asks you to sign a transaction to chat, and no model can act on-chain for you.':
    '不可以。使用钱包登录时，你只需对一条简短消息签名来证明账户属于你；消息明确声明，不授权任何交易或付款。Conclave 绝不会要求你为进行对话而对交易签名，任何模型也都无法代你执行链上操作。',
  'Can I use the workspace now?': '现在可以使用工作区吗？',
  'Yes. Open the chat, sign in with a wallet or a passkey, and ask. Single answers, side-by-side comparison, @mentions, Auto routing and follow-ups are live. Chapters for teams, Cross-Check, Briefs and media generation are planned and not part of this release.':
    '可以。打开对话，使用钱包或通行密钥登录，即可提问。单个回答、并排比较、@ 提及、自动路由和追问均已开放。面向团队的章节、交叉核查、简报和媒体生成仍在计划中，不包含在本次发布中。',

  'Explain the trade-offs.': '分析利弊取舍。',
  'Find the blind spots.': '找出盲点。',
  'Challenge my thinking.': '质疑我的思路。',
  'A practical perspective': '务实的视角',
  'A questioning perspective': '质疑的视角',
  'What may be missing': '可能遗漏了什么',
  'Where the assumptions break': '哪些假设站不住脚',
  'The strongest argument': '最有力的论据',
  'A useful counterargument': '有价值的反驳',
  'THE COUNCIL ROOM': '议事厅',
  'INTERACTIVE SAMPLE · 02 VOICES': '互动示例 · 02 个视角',
  'Example comparison prompts': '比较提问示例',
  YOU: '你',
  'PERSPECTIVE I': '视角 I',
  'Sample A': '示例 A',
  'Start with the outcome. A shared workspace reduces friction, but each model carries a different set of assumptions.':
    '先看目标。共享工作区可以减少协作阻力，但每个模型都有不同的前提假设。',
  'An elegant answer can still hide a missing premise. Look for what the evidence does not cover before accepting the conclusion.':
    '漂亮的回答也可能缺少关键前提。接受结论之前，先看看证据没有涵盖哪些内容。',
  'A single coherent argument is useful. Break it into claims, trace its sources, and decide which assumptions you are willing to accept.':
    '一个逻辑连贯的论证很有价值。将它拆解为具体主张，追溯来源，再决定哪些假设可以接受。',
  '01 / EXPLORE THE CASE': '01 / 审视论证',
  'PERSPECTIVE II': '视角 II',
  'Sample B': '示例 B',
  'The alternative is worth hearing. Compare the actual evidence, not the confidence of the answer. Agreement is a signal, not a guarantee.':
    '另一种观点值得倾听。比较实际证据，而非回答的自信程度。一致意见是一种信号，并不意味着保证。',
  'Ask what would change the conclusion. Distinguish a lack of evidence from evidence against a claim. Keep uncertainty visible.':
    '追问什么会改变结论。区分缺乏证据与存在反证，让不确定性清晰可见。',
  'A useful dissent does more than disagree. It identifies the weak premise and explains what evidence would resolve the difference.':
    '有价值的异议不止于反对。它会指出薄弱的前提，并说明哪些证据可以化解分歧。',
  '02 / QUESTION THE CASE': '02 / 质疑论证',
  'Different perspectives. One decision: yours.': '不同的视角。由你做出决定。',
  'TRY SIDE BY SIDE': '试试并排比较',
  'One answer': '单个回答',
  'Side by side': '并排比较',
  'ILLUSTRATIVE MODEL USAGE': '模型使用费示例',
  'Model usage + {fee}%{br}One visible total.':
    '模型使用费 + {fee}%{br}总额清晰可见。',
  'Illustrative amounts, not a quote. No deposit or charge.':
    '金额仅作示例，不是报价。不涉及充值或扣费。',

  'Main navigation': '主导航',
  'The idea': '理念',
  Possibilities: '可能性',
  Workspace: '工作区',
  'Field guide': '使用指南',
  'Play animations': '播放动画',
  'Pause animations': '暂停动画',
  'ENTER CONCLAVE': '进入 CONCLAVE',
  'Close navigation': '关闭导航',
  'Open navigation': '打开导航',
  'Conclave home': 'Conclave 首页',
  'ASSEMBLING DIFFERENT PERSPECTIVES': '汇聚不同视角',
  'Enter now': '立即进入',
  'Skip to content': '跳至正文',
  'A MULTI-MODEL AI WORKSPACE': '多模型 AI 工作区',
  'BUILT FOR SOLANA / VOL. 001': '为 SOLANA 打造 / 第 001 期',
  'BRING DIFFERENT MINDS TO THE TABLE.': '让不同的心智齐聚一堂。',
  'ONE ANSWER, OR FOUR SIDE BY SIDE.': '一个回答，或四个并排比较。',
  'ASK AGAIN. THE CONTEXT FOLLOWS.': '继续追问，上下文始终相随。',
  'THE FINAL WORD IS ALWAYS YOURS.': '最终决定权，始终在你。',
  'MANY{br}GREAT MINDS.{br}ONE COMMON{br}GROUND.':
    '众多{br}卓越心智。{br}共寻一片{br}天地。',
  'MANY{line}GREAT MINDS.{line}ONE{line}COMMON{line}GROUND.':
    '众多{line}卓越心智。{line}共寻{line}一片{line}天地。',
  'YOUR{line}NEXT QUESTION.{line}MORE{line}THAN ONE{line}ANSWER.':
    '你的{line}下个问题。{line}不止{line}一种{line}回答。',
  'SEE{line}WHAT ONE{line}MODEL{line}ALONE{line}MISSES.':
    '看见{line}单个模型{line}独自{line}难以察觉的{line}盲点。',
  'Many great minds. One common ground.': '众多卓越心智，共寻一片天地。',
  'OPEN THE CHAT': '打开对话',
  'SEVEN MODELS · ONE ROOM': '七个模型 · 一个议事厅',
  'Discover Conclave': '了解 Conclave',
  'SCROLL TO CONVENE · SCROLL TO CONVENE ·':
    '向下滚动，齐聚一堂 · 向下滚动，齐聚一堂 ·',
  'Model families in the workspace preview, and Solana':
    '工作区预览中的模型系列与 Solana',

  '02 / THE POSSIBILITIES': '02 / 更多可能',
  'A different kind{br}of {intelligence}': '一种不同的{br}{intelligence}',
  'intelligence.': '智能。',
  'More than an answer box.{br}A place to see the whole picture.':
    '不止是一个回答框。{br}更是看清全貌的地方。',
  'THE COUNCIL': '议事厅',
  'Many minds.{br}{view}': '多种心智。{br}{view}',
  'A clearer view.': '更清晰的视野。',
  'Compare up to four models side by side. Choose the answer before you see the name.':
    '最多并排比较四个模型。先选回答，再看模型名称。',
  'GATHER THE COUNCIL': '召集议事厅',
  'THE BOUNDARY': '边界',
  'Know what{br}{boundary}': '清楚知道{br}{boundary}',
  'leaves the room.': '哪些信息会离开议事厅。',
  'Every request travels through one hosted provider to the model’s maker. The boundary is named before you type.':
    '每次请求都经由同一家托管服务提供方，传至模型开发方。输入之前，数据边界已明确告知。',
  'SEE THE BOUNDARY': '了解边界',
  'THE COMMON PURSE': '统一额度账户',
  'One balance.{br}{clarity}': '一个余额。{br}{clarity}',
  'No blind spots.': '没有盲点。',
  'A prepaid credit balance, a quote before you run, and the settled cost afterwards. USDC deposits are planned.':
    '统一的预付额度余额，运行前查看报价，完成后结算费用。USDC 充值仍在计划中。',
  'EXPLORE THE BALANCE': '了解余额',

  'Conclave horse film': 'Conclave 骏马短片',
  'INTERLUDE / COLLECTIVE INSTINCT': '幕间 / 群体本能',
  'CONCLAVE MOTION ARCHIVE — 001': 'CONCLAVE 动态影像档案 — 001',
  'Different by nature.{br}{company}': '生而不同。{br}{company}',
  'Stronger in company.': '同行更强。',
  'DIFFERENT{br}MINDS.': '不同{br}心智。',
  'SHARED{br}DIRECTION.': '共同{br}方向。',
  'A STUDY IN COLLECTIVE INSTINCT': '群体本能研究',
  'Watch the 15-second Conclave film': '观看 15 秒 Conclave 短片',
  'PLAY FILM': '播放短片',
  '00:15 / FOUR PERSPECTIVES': '00:15 / 四个视角',
  '01—04 / THE COUNCIL IN MOTION': '01—04 / 议事厅动态影像',
  'No single perspective sees everything.': '没有一个视角能看清一切。',
  'OPEN THE MOTION ARCHIVE': '打开动态影像档案',
  'WATCH FULL FILM': '观看完整短片',
  'Conclave motion archive': 'Conclave 动态影像档案',
  'CONCLAVE / MOTION ARCHIVE 001': 'CONCLAVE / 动态影像档案 001',
  'Close film': '关闭短片',
  'The film is not available in this preview yet.': '此预览暂未提供短片。',

  '03 / A ROOM FOR BETTER QUESTIONS': '03 / 提出更好问题的议事厅',
  'Pull up {chair}': '请{chair}',
  'a chair.': '入座。',
  'Ask once. Explore the differences.{br}Leave with a decision you can explain.':
    '提问一次，探索不同之处。{br}带走一个说得清理由的决定。',
  Assemble: '汇聚',
  'Choose your models, or let Auto pick one.':
    '选择模型，或让自动路由为你挑选一个。',
  Examine: '审视',
  'Compare the arguments and the dissent.': '比较论据与不同意见。',
  Decide: '决定',
  'Ask the follow-up. The context comes along.': '继续追问，上下文始终相随。',

  'A black and ivory halftone armored gauntlet':
    '黑色与象牙白色的网点印刷风格铠甲手套',
  'YOUR INFORMATION': '你的信息',
  'YOUR BOUNDARIES': '你的边界',
  '04 / THE TERMS OF TRUST': '04 / 信任的条件',
  'Plain terms,{br}before {typing}': '条款清晰，{br}在{typing}',
  'you type.': '输入之前。',
  'Privacy should be legible. Your prompts and the answers travel through one inference provider to each model’s host. Nothing runs on your device, and Conclave does not pretend otherwise.':
    '隐私应当清楚明白。你的提问和回答会经由同一家推理服务提供方，传至各模型托管方。模型并不在你的设备上运行，Conclave 也不会声称如此。',
  'Where requests go': '请求发往何处',
  'One provider, then the model’s host. Nothing local.':
    '先经提供方，再到模型托管方。不在本地运行。',
  'Guards, planned': '防护，计划中',
  'Secret checks before sending are not available yet.':
    '发送前的敏感信息检查尚未开放。',
  'Sign-in, not signing': '登录，无需交易签名',
  'A wallet signs a message, never a transaction.':
    '钱包只对消息签名，绝不对交易签名。',
  'Different hosts keep different policies. Treat anything you type as shared with the provider and the model’s host.':
    '不同托管方有不同的政策。请将输入的所有内容视为已与提供方和模型托管方共享。',

  '05 / CHAPTERS · PLANNED': '05 / 章节 · 计划中',
  'FOR PEOPLE WHO THINK TOGETHER': '为共同思考的人',
  'PLANNED · NOT YET AVAILABLE': '计划中 · 尚未开放',
  'A common purpose.{br}{conclave}': '共同的目标。{br}{conclave}',
  'A Conclave of your own.': '属于你的 Conclave。',
  'Chapters will bring your team into one Conclave: shared rooms, defined roles, and a clear allowance for every member. They are on the roadmap and not part of this release.':
    '章节将让团队齐聚一个 Conclave：共享议事厅、明确角色，并为每位成员设置清晰的额度分配。这些功能仍在路线图中，不包含在本次发布中。',
  'OPEN THE CHAT TODAY': '现在就打开对话',
  TEAMS: '团队',
  ROLES: '角色',
  ALLOWANCES: '额度分配',
  PLANNED: '计划中',
  '06 / CLEAR ACCOUNTS': '06 / 账目清晰',
  'Pay for the thought.{br}{lines}': '为思考付费。{br}{lines}',
  'See every line.': '每一笔都看得见。',
  'No mystery bundle. One prepaid credit balance, a quote before each request, and a 5% platform fee shown on that quote.':
    '没有不明不白的套餐。统一的预付额度余额，每次请求前显示报价，并在报价中列明 5% 平台费。',
  'READ THE BILLING PRINCIPLES': '查看计费原则',

  '07 / THE ROAD AHEAD': '07 / 前方的路',
  'Built in {chapters}': '分{chapters}构建。',
  'chapters.': '章节',
  'The intended path from a considered{br}workspace to a shared intelligence layer.':
    '计划从精心设计的{br}工作区，走向共享智能层。',
  'Open the room': '开放议事厅',
  'AVAILABLE NOW': '现已开放',
  'Seven models through one provider': '通过一家提供方接入七个模型',
  'Single answers & four side by side': '单个回答与四个回答并排比较',
  'Wallet or passkey sign-in & prepaid credits': '钱包或通行密钥登录与预付额度',
  'Establish trust': '建立信任',
  'USDC deposits on Solana': 'Solana 上的 USDC 充值',
  'Verified receipts for every call': '每次调用均有经过验证的收据',
  'Per-route privacy labels & guards': '各路由的隐私标签与防护',
  'Think together': '共同思考',
  'PRODUCT DIRECTION': '产品方向',
  'Chapters & shared allowances': '章节与共享额度分配',
  'Evidence-led Cross-Check': '以证据为依据的交叉核查',
  'Briefs, Studio media & APIs': '简报、工作室媒体与 API',
  '08 / BEFORE YOU ENTER': '08 / 进入之前',
  'A few{br}{questions}': '几个{br}{questions}',
  'good questions.': '值得问的问题。',
  'OPEN THE FIELD GUIDE': '打开使用指南',
} satisfies Dictionary;
