import type { Dictionary } from '../index.ts';

/** Simplified Chinese, keyed by the exact English source text. See lib/i18n/TRANSLATING.md. */
export default {
  'Know your route': '了解你的路由',
  'Privacy has a definition.': '隐私，有明确的定义。',
  'A model name tells you who answers. A Route Card tells you where your request goes, what the host can see, and which promises have evidence behind them.':
    '模型名称告诉你由谁回答。路由卡告诉你请求发往何处、托管方能看到什么，以及哪些承诺有证据支持。',
  'Read before you send': '发送前，先看清',
  'Every provider × model route needs its own card. Look for retention, training use, jurisdiction, legal hold, and dated evidence. An unknown answer stays unverified.':
    '每一种提供方与模型的路由组合，都需要独立的路由卡。请查看数据保留、训练用途、司法管辖区、法律保留要求，以及带日期的证据。未知的信息仍应标为未经验证。',
  'Set your minimum': '设定你的最低要求',
  'Strict mode must refuse a route below your chosen policy. If an eligible provider is unavailable, the request stops. It must never silently choose a weaker route.':
    '严格模式必须拒绝低于你所选策略要求的路由。如果合格的提供方不可用，请求就会停止，绝不能悄悄改用防护更弱的路由。',
  'Understand Sanctum': '了解 Sanctum',
  'Sanctum is designed for supported open models in attested, sealed hardware. It does not make a frontier vendor unable to read your prompt. Hardware attestation also has limits.':
    'Sanctum 旨在让受支持的开放模型在经过证明的密封硬件中运行。它并不能让前沿模型厂商无法读取你的提问。硬件证明也有局限。',
  'Before anything leaves': '在信息离开之前',
  'A pause at the threshold.': '在门槛前，停一停。',
  'The guard layer is designed to inspect a request on your device before that request is built. The interactive example below uses harmless markers to explain the flow.':
    '防护层的设计目标是在请求构建之前，先在你的设备上检查请求。下面的交互示例用无害标记说明这一流程。',
  'Key Guard': '密钥防护',
  'The production requirement is to block checksum-valid seed phrases and supported private-key encodings. A pattern warning alone is not a complete key detector.':
    '生产环境的要求是拦截校验和有效的助记词，以及受支持编码格式的私钥。仅凭模式匹配发出警告，并不等于完整的密钥检测。',
  'Leak Guard': '泄露防护',
  'Common API secrets, JWTs, PEM blocks and environment-file values should be blocked or redacted by your choice. No detector can promise to catch every secret.':
    '常见的 API 密钥、JWT、PEM 块及环境文件中的值，应按你的选择予以拦截或脱敏。任何检测器都无法保证发现所有机密信息。',
  'Context stays context': '上下文只作上下文',
  'Uploaded documents and pasted instructions are untrusted source material. The injection shield should quote them as data, rather than grant them authority over tools.':
    '上传的文档和粘贴的指令都是不可信的来源材料。注入防护应将它们作为数据引用，而不是赋予它们操控工具的权限。',
  'A second opinion': '多听一种意见',
  'Let the differences show.': '让分歧看得见。',
  'Ask several models the same question. Keep the disagreement visible. A useful answer is one you can inspect, compare and make a decision from.':
    '向多个模型提出同一个问题，让分歧始终可见。有用的回答，应当经得起查看、比较，并能帮助你作出决策。',
  'Side by Side': '并排比较',
  'Compare up to four model responses. Blind mode conceals model labels until you vote, helping you choose the response before the brand.':
    '最多比较 4 个模型的回答。盲评模式会在你投票前隐藏模型标签，帮助你先选回答，再看品牌。',
  'The Brief': '简报',
  'Bring the responses into one document: each model’s summary, agreement and disagreement, sources, cost, and your own decision. Export it when the decision is ready.':
    '将回答汇成一份文档：各模型的摘要、共识与分歧、来源、费用，以及你自己的决策。决策确定后即可导出。',
  'Cross-Check': '交叉核查',
  'At least three model families review claims independently against quoted source passages. They never see each other’s answers. Dissent stays visible; consensus can still be wrong.':
    '至少 3 个模型家族依据引用的原文片段，独立核查各项说法。它们不会看到彼此的回答。异议始终可见；即使达成共识，也仍可能出错。',
  'One balance': '统一余额',
  'Know the cost of a question.': '清楚每次提问的费用。',
  'The intended billing model is prepaid usage. A maximum estimate is held before a call, actual cost is captured afterwards, and the remainder is released.':
    '预期的计费方式是预付费使用。调用前冻结最高预估费用，调用后扣除实际费用，再释放剩余额度。',
  'Usage, with a visible margin': '用量与加价，一目了然',
  'The proposed pricing is provider cost + 5% for standard routes and + 15% for Sanctum. It is not final; a real quote must be shown before a paid request.':
    '拟议定价为：标准路由在提供方成本上加收 5%，Sanctum 加收 15%。定价尚未最终确定；付费请求发出前，必须展示真实报价。',
  'A receipt for the call': '每次调用，都有收据',
  'Production receipts must include route, privacy level, model, cost and time. Cryptographic signatures and Solana inclusion are future integrations, not properties of the preview’s sample history.':
    '生产环境的收据必须包含路由、隐私级别、模型、费用和时间。密码学签名及 Solana 上链属于未来集成，并非预览中示例历史记录已具备的功能。',
  'Prepaid, not tradeable': '预付额度，不可交易',
  'Credits are usage balances and cannot be transferred between accounts. Top-ups require a finalized on-chain deposit. Never send funds to a preview or a placeholder address.':
    '额度是用于使用服务的余额，不能在账户之间转移。充值需要已最终确认的链上充值交易。切勿向预览或占位地址发送资金。',
  'Work as a Chapter': '以章节协作',
  'A shared room. Clear boundaries.': '共享议事厅，边界清晰。',
  'Chapters are designed for teams whose ownership and spending limits live in a Squads multisig. Members can join with a wallet or a passkey.':
    '章节面向通过 Squads 多签管理所有权和支出限额的团队而设计。成员可以使用钱包或通行密钥加入。',
  'Give each role a purpose': '让每种角色各司其职',
  'Owners are multisig members. Officers coordinate the workspace. Members use their assigned allowance. Guests have limited access. Production authorization must enforce these boundaries on the server.':
    '所有者是多签成员。管理者协调工作区。成员使用分配给自己的额度。访客的访问权限有限。生产环境必须在服务端通过授权机制落实这些边界。',
  'Make the budget explicit': '把预算说清楚',
  'The plan calls for a revocable Squads spending limit, daily usage settlement, and per-member caps. Chapters are proposed at 9 USDC per member each month, plus usage.':
    '计划采用可撤销的 Squads 支出限额、每日用量结算，以及每位成员的额度上限。章节拟按每位成员每月 9 USDC 收费，另计使用费用。',
  'Helpers draft. People decide.': '助手起草，人来决定。',
  'Helpers receive a rulebook and an allowance. They may draft or simulate proposals, but never sign or execute them. Encrypted rooms need device keys and key rotation when membership changes.':
    '助手会获得规则手册和额度。它们可以起草或模拟提案，但绝不能签名或执行。加密议事厅需要设备密钥，并在成员变动时轮换密钥。',
  'Beyond the browser': '走出浏览器',
  'Take the room with you.': '随身带上议事厅。',
  'Conclave’s web experience is the starting point. The roadmap also includes native mobile, Telegram and developer surfaces. Their production connections are still required.':
    'Conclave 的网页体验是起点。路线图还包括原生移动应用、Telegram 和开发者接口，它们仍需完成生产环境集成。',
  'MCP & API': 'MCP 与 API',
  'The planned MCP tools are conclave_ask, conclave_compare, conclave_crosscheck and conclave_explain_tx. Each needs OAuth, revocation and spending caps. The initial API contract is chat completions only.':
    '计划中的 MCP 工具包括 conclave_ask、conclave_compare、conclave_crosscheck 和 conclave_explain_tx。每项工具都需要 OAuth 授权、撤销机制和支出上限。初始 API 规范仅支持 chat completions。',
  'Mobile & Telegram': '移动端与 Telegram',
  'Android/Seeker uses Mobile Wallet Adapter; iOS uses passkeys and wallet deep links. Telegram is planned around /ask, /check, /explain and /balance. No app-store release is implied by this website.':
    'Android/Seeker 使用 Mobile Wallet Adapter；iOS 使用通行密钥和钱包深层链接。Telegram 计划围绕 /ask、/check、/explain 和 /balance 构建。本网站并不表示应用已在应用商店发布。',
  'Wallets are not accounts alone': '连接钱包，不等于验证账户',
  "A connected address is not proof of ownership. Production sign-in requires a nonce-bound, domain-bound signature or verified passkey ceremony, then a server session. A wallet that offers Sign In With Solana must use it, so the wallet itself checks which site is asking; signing the exact sign-in text is accepted only from wallets without that feature, and every signed field is compared with the server's challenge.":
    '连接地址不能证明所有权。生产环境登录需要绑定一次性随机数和域名的签名，或经过验证的通行密钥认证流程，随后建立服务端会话。提供 Sign In With Solana 功能的钱包必须使用该功能，让钱包自行核查发起请求的网站；只有不支持该功能的钱包，才接受对指定登录文本的签名，且每个签名字段都会与服务端的验证挑战进行比对。',
  'Local companion': '本地伴随程序',
  LOCAL: '本地',
  'Runs on your device': '在你的设备上运行',
  'Controlled by your local runtime': '由你的本地运行环境控制',
  'Check your installed runtime': '请检查已安装的运行环境',
  'Your device': '你的设备',
  'Requires a connected local companion': '需要连接本地伴随程序',
  'Frontier provider': '前沿模型提供方',
  UNVERIFIED: '未经验证',
  'Provider can read your prompt': '提供方可读取你的提问',
  'Not verified': '未经验证',
  'Dated vendor evidence required': '需要带日期的厂商证据',
  'Sanctum route': 'Sanctum 路由',
  'E2EE TO SEALED': '端到端加密至密封主机',
  'Encrypted to a sealed host': '加密传输至密封主机',
  'Subject to the verified host policy': '以经验证的托管方策略为准',
  'Must be declared by host': '必须由托管方声明',
  'Valid attestation required before sending': '发送前需要有效的证明',
  'Normal request': '普通请求',
  'Compare these two public project proposals.': '比较这两份公开的项目提案。',
  'Ready for review': '可供审查',
  'No demonstration marker found. This does not certify arbitrary text as safe.':
    '未发现演示标记。这并不代表任意文本都已被认证为安全。',
  'Synthetic key': '模拟密钥',
  'Please store this: [SYNTHETIC_PRIVATE_KEY]':
    '请保存这个：[SYNTHETIC_PRIVATE_KEY]',
  'Send blocked': '已阻止发送',
  'The harmless demo marker is blocked locally. Nothing is sent or saved.':
    '无害的演示标记已在本地被拦截。不会发送或保存任何内容。',
  'Synthetic API secret': '模拟 API 密钥',
  'The test config is API_KEY=[SYNTHETIC_SECRET]':
    '测试配置为 API_KEY=[SYNTHETIC_SECRET]',
  'Secret redacted': '机密信息已脱敏',
  'The demonstration secret is replaced before the preview is built.':
    '演示用的机密信息会在构建预览之前被替换。',
  HOLDS: '成立',
  'All valid independent reviews support a claim with exact source quotes.':
    '所有有效的独立审查均引用准确的原文来支持这项说法。',
  'DOESN’T HOLD': '不成立',
  'All valid independent reviews contradict a claim with exact source quotes.':
    '所有有效的独立审查均引用准确的原文来反驳这项说法。',
  PARTLY: '部分成立',
  'At answer level, some claims hold and others do not. Open the claim-by-claim result.':
    '就整个回答而言，部分说法成立，部分不成立。请打开逐项核查结果。',
  'NO CONSENSUS': '无共识',
  'Reviews disagree, evidence is insufficient, or a definite answer cannot be established. The uncertainty stays visible.':
    '审查意见存在分歧、证据不足，或无法得出确定的回答。不确定性始终可见。',
  'Squads ownership & spending limits': 'Squads 所有权与支出限额',
  'Server-enforced member permissions': '服务端强制执行的成员权限',
  'Device keys & room key rotation': '设备密钥与议事厅密钥轮换',
  'Signed monthly usage statements': '带签名的月度使用报表',
  'Wallet & passkey authentication': '钱包与通行密钥认证',
  'Paid model gateway & source retrieval': '付费模型网关与来源检索',
  'Sealed hosts & cryptographic receipts': '密封主机与密码学收据',
  'MCP, Telegram & native mobile': 'MCP、Telegram 与原生移动应用',
  'Illustrative Route Card inspector': '路由卡查看示例',
  'INTERACTIVE / ROUTE CARD': '交互示例 / 路由卡',
  ILLUSTRATIVE: '示例',
  'Route example': '路由示例',
  'Content visibility': '内容可见性',
  Retention: '数据保留',
  'Training use': '训练用途',
  Jurisdiction: '司法管辖区',
  Evidence: '证据',
  'Example card only. No provider or sealed host has been verified in this local preview.':
    '仅为示例卡片。此本地预览尚未验证任何提供方或密封主机。',
  'Inspect the required card fields': '查看卡片必填字段',
  'Synthetic guard demonstration': '模拟防护演示',
  'TRY THE THRESHOLD': '试试发送前防护',
  'ON THIS DEVICE': '在此设备上',
  'Some things should{break}{emphasis}': '有些东西{break}{emphasis}',
  'never leave the room.': '绝不该离开议事厅。',
  'Select a harmless example. This sandbox illustrates the flow; it is not the production key detector.':
    '选择一个无害示例。此沙盒用于演示流程，并非生产环境的密钥检测器。',
  'Synthetic examples': '模拟示例',
  'SYNTHETIC INPUT': '模拟输入',
  'Run the local example': '运行本地示例',
  'No network request. No storage. Synthetic examples only.':
    '不发起网络请求，不存储内容。仅使用模拟示例。',
  'Illustrative usage calculator': '用量计算示例',
  'SHOW YOUR WORK': '费用怎么算',
  'PRICING EXAMPLE': '定价示例',
  'Small margin.{break}{emphasis}': '少量加价。{break}{emphasis}',
  'Visible arithmetic.': '计算清清楚楚。',
  'Example provider cost (USDC)': '示例提供方成本（USDC）',
  'Standard · 5%': '标准 · 5%',
  'Sanctum · 15%': 'Sanctum · 15%',
  'Provider cost': '提供方成本',
  'Conclave margin': 'Conclave 加价',
  'Illustrative total': '示例总额',
  'Based on proposed pricing terms. This is not a live quote, charge or deposit interface.':
    '根据拟议定价条款计算。这并非实时报价、扣费或充值界面。',
  'THE LANGUAGE OF A CHECK': '核查结果说明',
  'FOUR OUTCOMES': '四种结果',
  'A shared mistake is possible even when every model agrees. Cross-Check reports evidence and model views, not certainty.':
    '即使所有模型都同意，也可能一起出错。交叉核查呈现的是证据和模型观点，并不保证结论确定无误。',
  'CONNECTION REGISTER': '集成清单',
  'LOCAL PREVIEW': '本地预览',
  'The interface is here.{break}{emphasis}': '界面已就绪。{break}{emphasis}',
  'The connections come next.': '集成仍待完成。',
  'INTEGRATION REQUIRED': '仍需集成',
  'The workspace uses clearly labelled sample behavior and browser-local state. It does not connect to these production services.':
    '工作区使用明确标注的示例行为和浏览器本地状态，尚未连接这些生产环境服务。',
  'Explore the workspace preview': '探索工作区预览',
  'Documentation navigation': '文档导航',
  'Conclave home': 'Conclave 首页',
  'The experience': '产品体验',
  Workspace: '工作区',
  'THE CONCLAVE FIELD GUIDE': 'CONCLAVE 使用指南',
  'VOL. 001 / AN OPEN BOOK': '第 001 卷 / 开卷可读',
  'Know {room}': '了解{room}',
  'the room.': '议事厅。',
  'How the models meet.': '模型如何汇聚。',
  'Where your words travel.': '你的话语去往何处。',
  'What stays in your hands.': '哪些仍由你掌握。',
  'An ornate scarlet Conclave banner with engraved floral borders':
    '一面华丽的绯红色 Conclave 旗帜，饰有雕刻花卉边框',
  'INDEPENDENT MINDS. INFORMED DECISIONS.': '独立思考，明智决策。',
  'Read the field guide': '阅读使用指南',
  'Find your subject': '查找主题',
  'Search documentation topics': '搜索文档主题',
  'Clear search': '清除搜索',
  'IN THIS VOLUME / {count} SUBJECTS': '本卷 / {count} 个主题',
  'Field guide topics': '使用指南主题',
  'No subjects found. Try “privacy”, “cost”, or “models”.':
    '未找到主题。试试“隐私”“费用”或“模型”。',
  'A label is only as useful as the evidence behind it.':
    '标签的价值，取决于背后的证据。',
  'A NOTE FROM THE ROOM': '议事厅寄语',
  'CHAPTER {number}': '第 {number} 章',
  'CONCLAVE / EXPLAINED': 'CONCLAVE / 详解',
  'YOUR NEXT PAGE': '下一页',
  'THE DOOR IS OPEN': '大门已敞开',
  'Less blind trust.{break}{emphasis}': '少一点盲目信任。{break}{emphasis}',
  'More room to think.': '多一点思考空间。',
  'Enter the workspace': '进入工作区',
  'Local product preview. Explore with sample data.':
    '本地产品预览。使用示例数据探索。',
  'Back to Conclave': '返回 Conclave',
  'EVERY MODEL. ONE ROOM.': '汇聚所有模型，共处一个议事厅。',
  'BACK TO TOP ↑': '返回顶部 ↑',
} satisfies Dictionary;
