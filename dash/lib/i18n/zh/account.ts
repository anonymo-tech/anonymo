import type { Dictionary } from '../index.ts';

/** Simplified Chinese account and tools copy. */
export default {
  ' (opens in a new tab)': ' （在新标签页中打开）',
  'Sample route': '示例路由',
  UNVERIFIED: '未经验证',
  'Design target': '设计目标',
  'Provider connection': '提供方连接',
  'Not configured': '未配置',
  'Prompt handling': '提问处理方式',
  'Would require encryption to an attested host. Neither is connected.':
    '需要将内容加密后发送到通过证明的主机。两者均未连接。',
  'A connected route would expose the prompt to the processing provider.':
    '已连接的路由会将提问暴露给处理它的提供方。',
  'Retention & training': '数据保留与训练',
  'No verified policy': '无已验证的政策',
  Evidence: '证据',
  'No live route or attestation evidence': '无实际路由或证明证据',
  'Sample estimate': '示例估算',
  '{amount} USDC per call · 0 charged': '每次调用 {amount} USDC · 已扣费 0',
  'Inspect a model’s proposed route. Every route in this workspace is a local sample.':
    '查看模型拟采用的路由。此工作区中的所有路由均为本地示例。',
  'Sample route details': '示例路由详情',
  '{family} · {kind} concept': '{family} · {kind}概念',
  'Selecting a card only opens its details. It does not change your project’s models or activate a privacy guarantee.':
    '选择卡片只会打开详情，不会更改项目的模型，也不会启用隐私保障。',
  'Read about route levels ': '了解路由级别 ',
  'SOL transfer': 'SOL 转账',
  'A transfer has a sender, recipient and amount.':
    '转账包含发送方、接收方和金额。',
  'This example describes a transfer instruction. The account labels are symbolic; no transaction has been built or submitted.':
    '此示例说明一条转账指令。账户标签仅作示意，尚未构建或提交任何交易。',
  Instruction: '指令',
  'System Program · transfer': 'System Program · transfer',
  Sender: '发送方',
  'Sample sender': '示例发送方',
  Recipient: '接收方',
  'Sample recipient': '示例接收方',
  Amount: '金额',
  '0.25 SOL · illustrative': '0.25 SOL · 示意',
  'A real review also needs the full transaction: every instruction, signer, writable account and fee payer.':
    '实际审查还需要完整交易：每条指令、签名者、可写账户和费用支付方。',
  'Solana documentation · Transactions': 'Solana 文档 · 交易',
  'Authority change': '权限变更',
  'An authority change affects a specific permission.':
    '权限变更影响某一项具体权限。',
  'The Token Program’s SetAuthority instruction changes an authority role on a mint or token account. The meaning depends on which role changes.':
    'Token Program 的 SetAuthority 指令会更改铸币账户或代币账户上的权限角色。具体含义取决于变更的是哪种角色。',
  'Token Program · SetAuthority': 'Token Program · SetAuthority',
  'Authority type': '权限类型',
  'Account owner · example': '账户所有者 · 示例',
  'Current authority': '当前权限持有者',
  'Sample current owner': '示例当前所有者',
  'New authority': '新权限持有者',
  'Sample replacement owner': '示例新所有者',
  'Read the authority type and destination together. A mint authority, account owner and close authority have different permissions.':
    '结合权限类型和新持有者一起查看。铸币权限、账户所有权和关闭账户权限各不相同。',
  'Solana documentation · Set Authority': 'Solana 文档 · 设置权限',
  'Failure & fees': '失败与费用',
  'Reverted changes do not mean a free transaction.':
    '更改被回滚不代表交易免费。',
  'If an instruction fails, the transaction’s state changes are reverted. A transaction processed by the network can still incur a fee.':
    '如果一条指令失败，交易的状态更改会被回滚。但经网络处理的交易仍可能产生费用。',
  'Example outcome': '示例结果',
  'Instruction failed': '指令失败',
  'State changes': '状态更改',
  Reverted: '已回滚',
  'Network fee': '网络费用',
  'Can still be charged': '仍可能收取',
  'This workspace': '此工作区',
  '0 charged · no network request': '已扣费 0 · 无网络请求',
  'A preview is not a guarantee of the eventual outcome. This example does not simulate execution or estimate a live fee.':
    '预览不能保证最终结果。此示例不会模拟执行，也不会估算实际费用。',
  'Read a Solana example in plain language. No RPC connection, wallet signature or onchain action.':
    '用通俗语言了解 Solana 示例。不连接 RPC、不请求钱包签名，也不进行链上操作。',
  'Solana examples': 'Solana 示例',
  'Educational sample': '教学示例',
  'Transaction fees': '交易费用',
  'A failed Solana transaction never costs SOL.':
    '失败的 Solana 交易绝不会消耗 SOL。',
  'The absolute claim is unsupported.': '这一绝对说法缺乏依据。',
  'The sample reviews separate reverted state changes from transaction fees. Their reasoning stays visible instead of becoming a single confidence score.':
    '示例评审将被回滚的状态更改与交易费用分开讨论。推理过程保持可见，不会被压缩成一个置信度分数。',
  Contradicted: '有证据反驳',
  'The source explicitly says a fee can remain after a transaction fails.':
    '来源明确指出，交易失败后仍可能产生费用。',
  'Incomplete framing': '表述不完整',
  'State rollback and fee charging are different parts of the transaction outcome.':
    '状态回滚和收取费用是交易结果的不同部分。',
  'Needs context': '需要背景信息',
  'Distinguish a transaction processed onchain from one that was never submitted.':
    '区分已在链上处理的交易与从未提交的交易。',
  'Fees are still charged on failure.': '失败时仍会收取费用。',
  'Authority scope': '权限范围',
  'Every authority change gives another wallet full control.':
    '任何权限变更都会让另一个钱包获得完全控制权。',
  'The scope matters. Keep the dissent.': '权限范围很重要。保留不同意见。',
  'The sample reviews disagree on how to frame the claim. All need the actual authority type before drawing a conclusion about its effects.':
    '示例评审对该说法的表述方式存在分歧。所有评审都需要知道实际权限类型，才能判断变更的影响。',
  'Too broad': '过于宽泛',
  'Changing a mint authority does not describe every other authority or account permission.':
    '铸币权限变更并不能说明其他所有权限或账户权限的变化。',
  'Cannot conclude': '无法下结论',
  'The claim does not name the account, authority type or new authority.':
    '该说法未指明账户、权限类型或新的权限持有者。',
  'Narrow the claim': '缩小说法范围',
  'Describe the one permission being changed, then review its consequences.':
    '说明具体变更的那一项权限，再评估其后果。',
  'Each call updates one authority type on one mint or token account.':
    '每次调用只会更新一个铸币账户或代币账户上的一种权限类型。',
  'Conclave · Sample Cross-Check\nPrewritten example; no model or retrieval request.\n\nClaim: {claim}\n{verdict}\n\n{reviews}\n\nSource: {source}':
    'Conclave · 交叉核查示例\n预先编写的示例；未发起模型或检索请求。\n\n说法：{claim}\n{verdict}\n\n{reviews}\n\n来源：{source}',
  '{label}: {text}': '{label}：{text}',
  'Sample Cross-Check copied.': '已复制交叉核查示例。',
  'Clipboard unavailable. You can select and copy the sample text.':
    '剪贴板不可用。你可以选中并复制示例文本。',
  'Explore how a claim, its sources and differing readings fit together. These are prewritten examples, not live model reviews.':
    '探索一个说法、它的来源和不同解读之间的关系。这些是预先编写的示例，并非模型的实时评审。',
  'Cross-Check samples': '交叉核查示例',
  'Sample claim': '示例说法',
  'Sample perspective {number}': '示例视角 {number}',
  'Source excerpt': '来源摘录',
  ' Copy sample summary': ' 复制示例摘要',
  'What is active for your account in this browser.':
    '此浏览器中你的账户已启用的功能。',
  Workspace: '工作区',
  'Signed-in account': '已登录账户',
  'Signed out': '已退出登录',
  'Projects and answers are saved to your account. Drafts stay in this tab.':
    '项目和回答会保存到账户。草稿留在当前标签页中。',
  'Sign in from Account & wallet to open your projects.':
    '从“账户与钱包”登录，即可打开你的项目。',
  'Model responses': '模型回答',
  'Live inference': '实时推理',
  'Live inference unavailable': '实时推理不可用',
  'Sent through reviewed routes only after you approve the cost.':
    '只有在你批准费用后，才会通过已审查的路由发送。',
  'No reviewed route is available right now. Nothing is sent.':
    '目前没有可用的已审查路由。不会发送任何内容。',
  'Sign in to use reviewed model routes.': '登录以使用已审查的模型路由。',
  'Prompt guard': '提问防护',
  'Local pattern check': '本地模式检查',
  'Runs before every quote. It can miss secrets, so keep sensitive information out of your questions.':
    '在每次报价前运行。它可能遗漏敏感信息，请勿在提问中包含此类内容。',
  'Balance & charges': '余额与费用',
  'Not signed in': '未登录',
  'Internal test credit': '内部测试额度',
  'Prepaid account balance': '预付账户余额',
  'Nothing is reserved or charged until you sign in and approve a request.':
    '在你登录并批准请求之前，不会预留额度或扣费。',
  'Charges apply. Approved requests reserve and settle against test credit, which is not USDC.':
    '会产生费用。获批请求会从测试额度中预留并结算费用；测试额度不是 USDC。',
  'Charges apply. Each approved request reserves its maximum and settles verified usage.':
    '会产生费用。每个获批请求会预留其最高费用，并按已验证的使用量结算。',
  'Standard routes are not private: the gateway and the model provider receive each question in plaintext.':
    '标准路由不提供隐私保障：网关和模型提供方会以明文接收每个提问。',
  'Open the field guide ': '打开使用指南 ',
  'What is active in this browser.': '此浏览器中已启用的功能。',
  'Local demo': '本地演示',
  'No cloud account or team sync.': '无云端账户或团队同步。',
  'Sample content': '示例内容',
  'Live inference is not connected.': '尚未连接实时推理。',
  'It can miss secrets. Keep sensitive information out of the demo.':
    '它可能遗漏敏感信息。请勿在演示中输入此类内容。',
  'Wallet & payments': '钱包与支付',
  'Not connected': '未连接',
  'No signatures, deposits or charges.': '无签名、充值或扣费。',
  'Browser-local data is not an encrypted vault. Other people using the same browser profile may be able to read it.':
    '浏览器本地数据并非加密保险库。使用同一浏览器配置的其他人可能可以读取这些数据。',
  'Understand the demo’s limits ': '了解演示的局限 ',
  'Write a question, explore sample perspectives and keep useful thinking in your workspace.':
    '写下提问，探索示例视角，并将有用的思考保存在工作区。',
  'Send a sample message': '发送示例消息',
  'Close an open menu or dialog': '关闭已打开的菜单或对话框',
  'Move between controls': '在控件之间移动',
  'Choose your view': '选择视图',
  'Use the view toggle in the workspace toolbar to change the layout.':
    '使用工作区工具栏中的视图切换按钮更改布局。',
  'Keep the limits in view': '了解功能局限',
  'Responses are samples. Cross-Check does not retrieve live evidence, and the Solana explainer does not simulate or sign transactions.':
    '回答均为示例。交叉核查不会检索实时证据，Solana 交易解读也不会模拟交易或为交易签名。',
  Account: '账户',
  Done: '完成',
  'Your wallet changed. Sign in again before accessing private data.':
    '你的钱包已更改。访问私密数据前，请重新登录。',
  'Your wallet accounts or permissions changed. Connect and sign in again to confirm the account.':
    '钱包账户或权限已更改。请重新连接并登录以确认账户。',
  'Wallet discovery is unavailable. Refresh account status to try again.':
    '无法发现钱包。请刷新账户状态后重试。',
  'Signed in. Your identity was verified by the server.':
    '已登录。服务器已验证你的身份。',
  'The sign-in may have completed. Refresh account status before trying again.':
    '登录可能已完成。重试前请刷新账户状态。',
  'Signed in with your passkey.': '已使用通行密钥登录。',
  'Signed out of Conclave. Your wallet connection is managed by your wallet.':
    '已退出 Conclave。钱包连接由你的钱包管理。',
  'Sign in to verify the selected account.': '请登录以验证所选账户。',
  'You are exploring without an account. No wallet or passkey is connected.':
    '你正在无账户状态下探索。未连接钱包或通行密钥。',
  'Checking account availability…': '正在检查账户服务是否可用…',
  'Account status could not be checked.': '无法检查账户状态。',
  'Your Conclave account is signed in. Identity prompts only appear after you choose a sign-in or security action.':
    '你的 Conclave 账户已登录。只有在你选择登录或安全操作后，才会出现身份确认提示。',
  'Create an account or sign in with a passkey or Solana wallet. Connecting a wallet alone does not verify a session.':
    '使用通行密钥或 Solana 钱包创建账户或登录。仅连接钱包不会验证会话。',
  'Solana wallet': 'Solana 钱包',
  'Signing and wallet identity are not connected.':
    '尚未连接签名功能和钱包身份。',
  '{address} · sign in again to confirm wallet changes':
    '{address} · 重新登录以确认钱包变更',
  '{address} · server-verified session': '{address} · 服务器已验证的会话',
  'A sign-in message does not authorize a transaction or payment.':
    '登录消息不授权任何交易或支付。',
  'Waiting for account service status.': '正在等待账户服务状态。',
  'Signing out…': '正在退出登录…',
  'Sign out': '退出登录',
  Unavailable: '不可用',
  Checking: '检查中',
  Passkey: '通行密钥',
  'A passkey is linked to this account.': '此账户已关联通行密钥。',
  'Create an account or use an existing passkey. No email or password is requested.':
    '创建账户或使用已有通行密钥。无需提供邮箱或密码。',
  'Passkey sign-in is not configured.': '尚未配置通行密钥登录。',
  Available: '可用',
  'Passkey sign-in': '通行密钥登录',
  'Use a passkey': '使用通行密钥',
  'Your browser or authenticator will ask you to confirm. If every previously enrolled wallet or passkey is lost, support cannot restore access. There is no email reset, recovery code, or manual override.':
    '浏览器或身份验证器会请你确认。如果所有已登记的钱包或通行密钥都丢失，客服也无法恢复访问。没有邮箱重置、恢复码或人工恢复途径。',
  'Create account with passkey': '使用通行密钥创建账户',
  'Sign in with passkey': '使用通行密钥登录',
  'Waiting for your authenticator…': '正在等待身份验证器…',
  'Sign-in may have completed. Refresh account status before trying again.':
    '登录可能已完成。重试前请刷新账户状态。',
  'Wallet sign-in': '钱包登录',
  'Connected accounts are not signed in until the server verifies a signature.':
    '连接的账户需经服务器验证签名后，才算登录。',
  'Choose an account': '选择账户',
  'Use account {address}': '使用账户 {address}',
  'Selected account': '已选账户',
  'Use this account': '使用此账户',
  'Choose another wallet to connect.': '选择另一个钱包进行连接。',
  'Choose another wallet': '选择其他钱包',
  'Sign-in method': '登录方式',
  'Waiting for wallet…': '正在等待钱包…',
  'Sign in with wallet': '使用钱包登录',
  'Use exact-message sign-in': '使用原文消息签名登录',
  'Choose a wallet': '选择钱包',
  'Connect first, then approve a sign-in message.': '先连接，再批准登录消息。',
  'No compatible Solana wallet was detected. Open this page in a wallet-enabled browser, then refresh account status.':
    '未检测到兼容的 Solana 钱包。请在支持钱包的浏览器中打开此页面，然后刷新账户状态。',
  'Available Solana wallets': '可用的 Solana 钱包',
  'Connect wallet': '连接钱包',
  'No signature or recovery phrase is needed to use the demo.':
    '使用演示无需签名或助记词。',
  'Conclave never asks for your recovery phrase or private key. Account sign-in does not send a transaction.':
    'Conclave 绝不会索取你的助记词或私钥。账户登录不会发送交易。',
  'Refresh account status': '刷新账户状态',
  'View integration status ': '查看集成状态 ',
  'Account status changed. Refresh before continuing.':
    '账户状态已更改。请刷新后继续。',
  'Wallet accounts or permissions changed. Choose the wallet again.':
    '钱包账户或权限已更改。请重新选择钱包。',
  'Identity confirmed. Review the action below, then continue.':
    '身份已确认。请查看下方操作，然后继续。',
  'Saved account security status refreshed.': '已刷新保存的账户安全状态。',
  'The approval was not confirmed. Refresh before continuing.':
    '授权未得到确认。请刷新后继续。',
  'Choose the existing wallet account shown in this review.':
    '请选择本次审查中显示的已有钱包账户。',
  'Return to Conclave, then confirm the action again.':
    '请返回 Conclave，然后重新确认操作。',
  'Choose the wallet address to link, then confirm it with an existing identity.':
    '选择要关联的钱包地址，再用已有身份确认。',
  'Choose the wallet to link again.': '请重新选择要关联的钱包。',
  'Return to Conclave and refresh account status before continuing.':
    '请返回 Conclave 并刷新账户状态后继续。',
  'Account security updated.': '账户安全设置已更新。',
  'Remove Passkey {number}': '移除通行密钥 {number}',
  'Remove Solana wallet': '移除 Solana 钱包',
  'Sign out this session started {date}': '退出始于 {date} 的当前会话',
  'Sign out the session started {date}': '退出始于 {date} 的会话',
  'Add a passkey to this Conclave account': '为此 Conclave 账户添加通行密钥',
  'Link Solana wallet {address} to this Conclave account':
    '将 Solana 钱包 {address} 关联到此 Conclave 账户',
  'Remove sign-in identity {id} from this Conclave account':
    '从此 Conclave 账户移除登录身份 {id}',
  'Sign out all other Conclave sessions': '退出所有其他 Conclave 会话',
  'Sign out Conclave session {id}': '退出 Conclave 会话 {id}',
  'Account security': '账户安全',
  'Keep access to another previously enrolled wallet or passkey, including a synced copy. If all enrolled credentials are lost, support cannot restore access. There is no email reset, recovery code, or manual override. Adding or removing a method signs out your other sessions.':
    '请确保仍能使用另一个已登记的钱包或通行密钥，包括同步副本。如果所有已登记的凭据都丢失，客服也无法恢复访问。没有邮箱重置、恢复码或人工恢复途径。添加或移除登录方式会让其他会话退出登录。',
  'Sign-in methods': '登录方式',
  'Passkey {number}': '通行密钥 {number}',
  'Solana wallet {address}': 'Solana 钱包 {address}',
  'Added {date}': '添加于 {date}',
  'Review removal': '审查移除操作',
  'Add passkey': '添加通行密钥',
  'Passkey enrollment is not configured.': '尚未配置通行密钥登记。',
  'Link a Solana wallet': '关联 Solana 钱包',
  'Connect the new wallet, approve the link with an existing sign-in method, then prove ownership of the new wallet.':
    '连接新钱包，使用已有登录方式批准关联，再证明你拥有新钱包。',
  'Connect {wallet}': '连接 {wallet}',
  'No compatible wallet was detected.': '未检测到兼容的钱包。',
  'Review linking {address}': '审查关联 {address}',
  Sessions: '会话',
  'This session': '当前会话',
  'Other session': '其他会话',
  'Started {started} · Expires {expires}':
    '开始于 {started} · 到期于 {expires}',
  'Review sign-out': '审查退出登录操作',
  'Showing the 50 most recent sessions. “Sign out other sessions” also covers older sessions.':
    '显示最近的 50 个会话。“退出其他会话”也会涵盖更早的会话。',
  'Sign out other sessions': '退出其他会话',
  'Account security details have not loaded.': '账户安全详情尚未加载。',
  'Review account action': '审查账户操作',
  'This method will no longer sign in. Confirm using a different method that remains on the account.':
    '此方式将无法再用于登录。请使用账户上保留的其他方式确认。',
  'Identity confirmed until {date}. This approval applies only to the action above.':
    '身份确认有效期至 {date}。此授权仅适用于上述操作。',
  'Create the new passkey': '创建新通行密钥',
  'Confirm with the new wallet': '使用新钱包确认',
  'Remove this sign-in method': '移除此登录方式',
  'Sign out reviewed sessions': '退出已审查的会话',
  'Approval expired. Confirm again with an existing identity.':
    '授权已过期。请用已有身份重新确认。',
  'Confirm this action with an existing sign-in method.':
    '请使用已有登录方式确认此操作。',
  'Confirm with existing passkey': '使用已有通行密钥确认',
  'Existing wallet {address}': '已有钱包 {address}',
  'Confirm in {wallet}': '在 {wallet} 中确认',
  'Cancel action': '取消操作',
  'The last action may have completed. Read the saved security status before starting another action.':
    '上一次操作可能已完成。开始下一次操作前，请查看已保存的安全状态。',
  'Waiting for your account or authenticator…': '正在等待账户或身份验证器…',
  'Refresh security status': '刷新安全状态',
  'Deposit credited': '充值已到账',
  'Reserved for a request': '已为请求预留',
  'Usage settled': '使用费用已结算',
  'Unused reservation returned': '未使用的预留额度已退回',
  'Refund credited': '退款已到账',
  'Internal test credit · not USDC': '内部测试额度 · 非 USDC',
  'Account records could not be loaded. Refresh to try again.':
    '无法加载账户记录。请刷新后重试。',
  'Additional records could not be loaded. Try again.':
    '无法加载更多记录。请重试。',
  'The receipt could not be downloaded. Blind comparison receipts become available after model names are revealed.':
    '无法下载收据。盲测比较的收据会在模型名称揭晓后开放。',
  'Account Purse': '额度账户',
  Purse: '额度账户',
  'Your available balance, open reservations, and settled usage.':
    '你的可用余额、未结算的预留额度和已结算的使用费用。',
  Refresh: '刷新',
  'Available balance': '可用余额',
  '{amount} USD reserved for open requests.':
    '已为未结算请求预留 {amount} USD。',
  'Sign in to view your account balance.': '登录以查看账户余额。',
  'This account received {amount} USD of internal test credit for local testing. Test credit is not USDC, not a deposit and cannot be withdrawn.':
    '此账户获得了 {amount} USD 内部测试额度，用于本地测试。测试额度不是 USDC，也不是充值资金，不能提现。',
  'Review before you spend': '消费前先确认',
  'Every request shows its maximum reservation before you approve it. Unused funds return to your available balance after settlement.':
    '每个请求都会在你批准前显示最高预留金额。结算后，未使用的资金会退回可用余额。',
  'A displayed balance is prepaid service credit, not a wallet token balance. Deposit availability and saved intents appear below.':
    '显示的余额是预付服务额度，并非钱包代币余额。下方显示充值可用状态和已保存的充值意向。',
  'Account activity': '账户活动',
  Activity: '活动',
  'Account ledger': '账户账本',
  'Date · UTC': '日期 · UTC',
  'Amount · USD': '金额 · USD',
  'Sign in to view activity.': '登录以查看活动。',
  'Loading activity…': '正在加载活动…',
  'No recorded activity yet.': '尚无活动记录。',
  'Load more activity': '加载更多活动',
  'Signed receipts': '已签名收据',
  Receipts: '收据',
  'Signed records': '已签名记录',
  'These receipts have not been anchored on Solana. Verify signatures with a separately trusted signer key; downloading a receipt does not verify its signature.':
    '这些收据尚未锚定到 Solana。请使用另行确认可信的签名者密钥验证签名；下载收据不会验证其签名。',
  'Studio · ': '工作室 · ',
  'Chat · ': '对话 · ',
  'Awaiting hourly batch': '等待每小时批次',
  'Awaiting Solana anchor': '等待 Solana 锚定',
  ' Download receipt': ' 下载收据',
  'Sign in to view receipts.': '登录以查看收据。',
  'Loading receipts…': '正在加载收据…',
  'No signed receipts available. Unrevealed blind comparison receipts stay hidden until you reveal their model names.':
    '暂无已签名收据。未揭晓的盲测比较收据会保持隐藏，直到你揭晓模型名称。',
  'Load more receipts': '加载更多收据',
  'No reviewed model routes have been configured. Your saved projects remain available.':
    '尚未配置已审查的模型路由。你保存的项目仍可访问。',
  'Published terms for each connected model. A reviewed route card documents its limits; it does not establish private or attested execution.':
    '每个已连接模型的公开条款。已审查的路由卡说明其限制，并不证明执行过程具备隐私保障或通过证明。',
  'Connected model routes': '已连接的模型路由',
  Processing: '处理方式',
  'The inference gateway and the upstream model provider receive your request in plaintext.':
    '推理网关和上游模型提供方会以明文接收你的请求。',
  'Upstream providers': '上游提供方',
  'Not disclosed': '未披露',
  Retention: '数据保留',
  'Training use': '训练用途',
  'Input / output per million tokens': '每百万词元的输入／输出价格',
  '{percent}% service markup': '{percent}% 服务加价',
  'Terms version': '条款版本',
  '{version} · expires {date} UTC': '{version} · 到期于 {date} UTC',
  'A request-specific reservation appears before approval. Actual usage is settled afterward; uncertain charges remain visibly pending.':
    '批准前会显示本次请求的预留金额。实际使用费用随后结算；未确定的费用会保持明确的待结算状态。',
  'Account security could not be checked. Refresh the saved account status before continuing.':
    '无法检查账户安全。继续前请刷新已保存的账户状态。',
  'The account response could not be verified. Refresh the saved account status before continuing.':
    '无法验证账户响应。继续前请刷新已保存的账户状态。',
  'Your session changed or expired. Refresh account status to sign in again.':
    '会话已更改或过期。请刷新账户状态以重新登录。',
  'Your account changed. Refresh account status before continuing.':
    '账户已更改。继续前请刷新账户状态。',
  'Keep at least one sign-in identity on this account.':
    '请为此账户保留至少一种登录身份。',
  'Confirm this action again with an existing sign-in identity.':
    '请使用已有登录身份重新确认此操作。',
  'Passkey sign-in is not configured for this service.':
    '此服务尚未配置通行密钥登录。',
  'The account action was not confirmed. Refresh saved account status before trying again.':
    '账户操作未得到确认。重试前请刷新已保存的账户状态。',
  'The account action may have completed. Refresh saved account status before starting another action.':
    '账户操作可能已完成。开始下一次操作前，请刷新已保存的账户状态。',
  'Account status could not be checked. Refresh to try again.':
    '无法检查账户状态。请刷新后重试。',
  'Confirm this action again; the previous approval expired.':
    '请重新确认此操作；之前的授权已过期。',
  'The account service returned an invalid response. Try again.':
    '账户服务返回了无效响应。请重试。',
  'The wallet request did not complete. You can try again when ready.':
    '钱包请求未完成。准备好后可以重试。',
  'The account service could not be reached. Try again.':
    '无法连接账户服务。请重试。',
  'Your sign-in could not be verified. Connect and sign in again.':
    '无法验证你的登录。请重新连接并登录。',
  'Too many sign-in requests. Wait a moment and try again.':
    '登录请求过多。请稍等片刻后重试。',
  'This account request was not allowed. Check the workspace address and try again.':
    '此账户请求未获允许。请检查工作区地址后重试。',
  'Account services are not available for this workspace right now.':
    '此工作区的账户服务目前不可用。',
  'The account request could not be completed. Try again.':
    '无法完成账户请求。请重试。',
  'The server session could not be confirmed. Refresh account status before continuing.':
    '无法确认服务器会话。继续前请刷新账户状态。',
  'This wallet returned an unsupported account list.':
    '此钱包返回了不受支持的账户列表。',
  'Choose a Solana wallet that supports message sign-in.':
    '请选择支持消息签名登录的 Solana 钱包。',
  'The wallet did not share a Solana account. Connect again when ready.':
    '钱包未提供 Solana 账户。准备好后请重新连接。',
  'This wallet cannot sign in with the selected account and method.':
    '此钱包无法使用所选账户和方式登录。',
  'The wallet returned a different account or message format. Nothing was verified.':
    '钱包返回了不同的账户或消息格式。未验证任何内容。',
  'Finish or cancel the current passkey request first.':
    '请先完成或取消当前通行密钥请求。',
  'This passkey request expired. Start again when ready.':
    '此通行密钥请求已过期。准备好后请重新开始。',
  'Return to Conclave before starting a passkey request.':
    '请返回 Conclave 后再发起通行密钥请求。',
  'The passkey request did not complete. You can start again when ready.':
    '通行密钥请求未完成。准备好后可以重新开始。',
  'Confirm adding this passkey again; the previous approval expired.':
    '请重新确认添加此通行密钥；之前的授权已过期。',
  'This identity action may have completed. Refresh saved account status before trying again.':
    '此身份操作可能已完成。重试前请刷新已保存的账户状态。',
  'IDENTITY HIDDEN CONTENT VISIBLE': '隐藏身份，内容可见',
  ZDR: '零数据保留',
  'E2EE TO SEALED': '端到端加密至密封环境',
  Hosted: '托管',
  Private: '私密',
  Sealed: '密封',
  unknown: '未知',
  'not used': '不用于训练',
  'may be used': '可能用于训练',
} satisfies Dictionary;
