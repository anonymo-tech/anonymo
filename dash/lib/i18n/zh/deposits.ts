import type { Dictionary } from '../index.ts';

/** Simplified Chinese, keyed by the exact English source text. See lib/i18n/TRANSLATING.md. */
export default {
  Network: '网络',
  'Exact amount': '确切金额',
  'Source wallet': '付款钱包',
  'USDC mint': 'USDC 铸币地址',
  'Treasury wallet': '资金库钱包',
  'Treasury token account': '资金库代币账户',
  'Required reference': '必需的参考标识',
  Created: '创建时间',
  'Payment window ends': '支付窗口结束时间',
  'Intent ID': '充值意向 ID',
  'USDC deposits': 'USDC 充值',
  'Refresh deposit records': '刷新充值记录',
  'Deposits add prepaid service credit. The balance shown in Purse is not your wallet’s token balance. Wallet payment is available only when its network and treasury checks are enabled.':
    '充值可增加预付服务额度。额度账户显示的余额并非钱包中的代币余额。只有启用网络和资金库检查后，才能使用钱包支付。',
  'Sign in through Account to view or recover owned deposit intents.':
    '请在账户页面登录，以查看或恢复你的充值意向。',
  'Reading deposit configuration and account records…':
    '正在读取充值配置和账户记录…',
  'New deposits are disabled or missing operator configuration.':
    '新增充值已停用，或运营方尚未完成配置。',
  'Existing intents may still allow signature recovery.':
    '现有意向可能仍支持通过签名恢复。',
  'Deposit recovery is also unavailable until the operator enables it for the configured network.':
    '运营方为所配置的网络启用充值恢复后，才能使用此功能。',
  'Devnet is a test network. Do not use real funds.':
    'Devnet 是测试网络。请勿使用真实资金。',
  'Mainnet configuration is present.': '已有主网配置。',
  'Configuration alone is not a live RPC or treasury verification. Transfers are verified against the saved intent during reconciliation.':
    '配置就绪并不代表已实时验证 RPC 或资金库。对账时会根据已保存的意向验证转账。',
  'Prepare a deposit intent': '准备充值意向',
  'Creating an intent records the exact amount, verified source wallet, network, and a 15-minute payment window. It does not move funds or open your wallet.':
    '创建意向会记录确切金额、已验证的付款钱包、网络和 15 分钟支付窗口。此操作不会转移资金或打开钱包。',
  'Sign in through Account with the source Solana wallet before preparing an intent.':
    '准备意向前，请在账户页面使用付款 Solana 钱包登录。',
  'Verified source wallet': '已验证的付款钱包',
  'Exact amount · USDC': '确切金额 · USDC',
  'Up to {amount} USDC per intent on {network}.':
    '在 {network} 上，每个意向最多充值 {amount} USDC。',
  'Review intent': '核对意向',
  'Deposit intent confirmation': '确认充值意向',
  'Recover the original intent': '恢复原充值意向',
  'Confirm the intent details': '确认意向详情',
  'The previous response did not establish whether the intent was saved. Recovery uses the same request key and exact terms. After closing this page, check recent intents before creating another.':
    '上次响应未能确认意向是否已保存。恢复时会使用相同的请求标识和原始条款。关闭此页面后，请先检查近期意向，再创建新意向。',
  'The reference and expiry will be assigned when the service saves this intent. This action does not transfer USDC.':
    '服务保存此意向时会分配参考标识和到期时间。此操作不会转移 USDC。',
  'Back to amount': '返回金额输入',
  'Checking intent…': '正在检查意向…',
  'Recover same intent request': '恢复原意向请求',
  'Create intent · no transfer': '创建意向 · 不转账',
  'Selected deposit intent': '所选充值意向',
  'Devnet test intent. Do not send real funds.':
    'Devnet 测试意向。请勿转入真实资金。',
  'The payment window has closed. An already-submitted transfer can still be checked if it landed within the original window.':
    '支付窗口已关闭。如果已提交的转账在原支付窗口内上链，仍可进行检查。',
  'This is an unpaid intent, not proof that a transfer was submitted.':
    '此意向尚未支付，不能证明已提交转账。',
  'A generic wallet send without the exact reference and supported transfer format may not be accepted.':
    '普通钱包转账若未包含准确的参考标识或未采用支持的转账格式，可能无法被接受。',
  'New payments are unavailable for this saved intent under the current configuration. Its details remain available for recovery.':
    '当前配置下，此已保存意向不支持新增支付。仍可使用其详情进行恢复。',
  'Saved intent details': '已保存的意向详情',
  'Recorded settlement': '已记录的结算',
  'Transaction signature': '交易签名',
  'Finalized slot': '最终确认的槽位',
  'Block time': '区块时间',
  Verified: '验证时间',
  'Ledger transaction': '账本交易',
  'Signature recovery is unavailable for this saved intent’s network and treasury configuration. Keep its ID and the original transaction signature.':
    '此已保存意向的网络和资金库配置不支持通过签名恢复。请保留其 ID 和原交易签名。',
  'Recover an existing transfer': '恢复现有转账',
  'Provide a transaction already submitted for this exact intent. The server reads the configured network and verifies finality, amount, wallet, recipient, reference, and original time window before crediting.':
    '请提供已为此意向提交的交易。服务器会读取所配置的网络，验证最终确认状态、金额、钱包、收款方、参考标识和原支付窗口后，再计入额度。',
  'Existing base58 transaction signature': '现有交易的 base58 签名',
  'Review signature check': '核对签名检查',
  'Confirm a read and ledger reconciliation for this signature. No wallet transaction will be signed or sent.':
    '确认读取此签名并进行账本对账。不会签名或发送任何钱包交易。',
  'Signature to verify': '待验证签名',
  'Verification outcome is uncertain. Read saved status or check this same signature again; do not send another transfer.':
    '验证结果尚不确定。请读取已保存状态，或再次检查同一签名；请勿再次转账。',
  'Verifying transfer…': '正在验证转账…',
  'Check the same signature again': '再次检查同一签名',
  'Confirm signature verification': '确认验证签名',
  'Edit signature': '编辑签名',
  'Read saved intent status': '读取已保存意向状态',
  'Back to recent intents': '返回近期意向',
  'Recent deposit intents': '近期充值意向',
  'No intents were returned on this page.': '本页未返回任何意向。',
  'Read earlier intents': '读取更早的意向',
  'Wallet deposit payment': '钱包充值支付',
  'Payment verified': '支付已验证',
  'Review wallet transfer': '核对钱包转账',
  'Pay from your wallet': '使用钱包支付',
  'Conclave requests a signature for the exact transfer below, then submits it to the network. Your wallet must have USDC and SOL for the network fee. A network submission alone does not add service credit.':
    'Conclave 会请求你为下方的确切转账签名，然后将其提交到网络。钱包中须有 USDC 和用于网络手续费的 SOL。仅提交到网络不会增加服务额度。',
  'Read saved payment': '读取已保存支付',
  'Review wallet payment · no transfer yet': '核对钱包支付 · 尚未转账',
  'Wallet payment is unavailable for this intent. Existing transfers can still be checked when recovery is enabled.':
    '此意向不支持钱包支付。启用恢复功能后，仍可检查现有转账。',
  'Solana Mainnet': 'Solana 主网',
  'Solana Devnet · test tokens': 'Solana Devnet · 测试代币',
  'Recipient treasury': '收款资金库',
  'Recipient USDC account': '收款 USDC 账户',
  'Estimated network fee': '预估网络手续费',
  'Review expires': '核对期限',
  'Saved transfer': '已保存的转账',
  'Submitted · finalization not yet verified': '已提交 · 尚未验证最终确认状态',
  Wallet: '钱包',
  'Choose a wallet': '选择钱包',
  'No compatible mainnet wallet was detected. Open this page in a browser with your source wallet available.':
    '未检测到兼容的主网钱包。请在可使用付款钱包的浏览器中打开此页面。',
  'Continue in wallet · {amount} USDC': '在钱包中继续 · {amount} USDC',
  'The last submission outcome is unknown. Recover this saved transfer before considering another deposit.':
    '上次提交结果未知。请先恢复此已保存转账，再考虑再次充值。',
  'This attempt is for recovery only once submitted or expired. It cannot be replaced with a new blockhash here.':
    '此次支付一旦提交或过期，便只能进行恢复。无法在此使用新的区块哈希替换。',
  'Read saved payment status': '读取已保存支付状态',
  'Recover the same signed submission': '恢复原签名提交',
  'This sends only the original signed transaction again while it remains valid. It does not ask for a new wallet signature or create another transfer.':
    '此操作只会在原签名交易仍有效时重新发送该交易。不会请求新的钱包签名或创建另一笔转账。',
  'Resubmit the same signed transfer': '重新提交原签名转账',
  'Submit the saved signed transfer': '提交已保存的签名转账',
  'Check finalized payment': '检查最终确认支付',
  'Check next recovery page': '检查下一页恢复结果',
  'Recovery reads the original reference and verifies finalized transfers. It never signs or sends a transaction.':
    '恢复时会读取原参考标识并验证已最终确认的转账。此操作不会签名或发送交易。',
  'Check explicit claims against text you provide. Independent reviewers see the same source snapshots without one another’s answers. Exact quote checks verify text presence; agreement is not proof that a claim is true.':
    '根据你提供的文本核查明确的论断。独立评审模型会看到相同的来源快照，但看不到彼此的回答。精确引文检查只能验证文本是否存在；意见一致不能证明论断为真。',
  'Sign in through Account to prepare or read a Cross-Check.':
    '请在账户页面登录，以准备或读取交叉核查。',
  'Loading reviewed rosters and your projects…':
    '正在加载已审核的评审名单和你的项目…',
  'Live reviews unavailable': '实时评审不可用',
  'The operator must configure a current reviewed roster before model reviews can run.':
    '运营方须先配置当前有效且已审核的评审名单，才能运行模型评审。',
  'The operator has not enabled and configured Cross-Check execution. Saving a source or preparing a plan does not run models.':
    '运营方尚未启用并配置交叉核查执行。保存来源或准备计划不会运行模型。',
  '{warning} This text is treated as source data, not an instruction to the reviewer.':
    '{warning} 此文本将作为来源数据处理，而非给评审模型的指令。',
  'Create an account project in Projects, then reopen Cross-Check.':
    '请先在项目页面创建账户项目，然后重新打开交叉核查。',
  Project: '项目',
  'Load more projects': '加载更多项目',
  'Independent reviewer roster': '独立评审名单',
  'No reviewed roster available': '暂无已审核的评审名单',
  '{roster} · {count} families': '{roster} · {count} 个模型家族',
  '{reviewers}. Up to {count} claims for this roster.':
    '{reviewers}。此名单最多支持 {count} 条论断。',
  'Claim {number}': '论断 {number}',
  'One specific claim that these sources can support or contradict':
    '一条可由这些来源支持或反驳的具体论断',
  'Remove claim {number}': '移除论断 {number}',
  'Add claim': '添加论断',
  'Source snapshots · choose up to 8': '来源快照 · 最多选 8 个',
  '{title} · {bytes} bytes · provided text':
    '{title} · {bytes} 字节 · 提供的文本',
  'Save a source excerpt below to begin. URLs are references; this panel does not retrieve web pages.':
    '请先在下方保存来源摘录。URL 仅供参考；此面板不会抓取网页。',
  'Load more sources': '加载更多来源',
  'Selected source text: {bytes} / 131,072 bytes. Individual reviewer routes may accept less. All selected text is included; oversized inputs are refused.':
    '所选来源文本：{bytes} / 131,072 字节。各评审路由可能有更低的限制。所有所选文本都会包含在内；超出限制的输入会被拒绝。',
  'Preparing…': '正在准备…',
  'Prepare and review cost': '准备并核对费用',
  'Save unreviewed plan': '保存未评审计划',
  'Add a provided source snapshot': '添加所提供的来源快照',
  'This saves an immutable excerpt in your account project after a local content check. No web page is fetched and no model is called.':
    '通过本地内容检查后，将在你的账户项目中保存不可修改的摘录。不会抓取网页或调用模型。',
  'Source title': '来源标题',
  'Reference URL (optional)': '参考 URL（可选）',
  'Exact source excerpt': '原文来源摘录',
  '{bytes} / 65,536 bytes. Remove secrets before saving. Pattern checks do not catch every secret.':
    '{bytes} / 65,536 字节。保存前请移除敏感信息。模式检查无法发现所有敏感信息。',
  'Check and save source': '检查并保存来源',
  'Saved Cross-Checks': '已保存的交叉核查',
  Reviewed: '已评审',
  Prepared: '已准备',
  'Load earlier checks': '加载更早的核查',
  'Reused completed review · no new model calls started':
    '复用已完成评审 · 未启动新的模型调用',
  'Completed review': '评审已完成',
  'Prepared · not reviewed': '已准备 · 尚未评审',
  'Execution · {state}': '执行 · {state}',
  'Review against provided sources': '根据所提供的来源评审',
  'Some reviews or settlement need attention. This is not a complete consensus result. Reading status will not retry or rebill model calls.':
    '部分评审或结算需要处理。此结果并非完整的共识结果。读取状态不会重试模型调用或再次计费。',
  Claims: '论断',
  'Reviewer families': '评审模型家族',
  'Source snapshots': '来源快照',
  '{count} · provided text only': '{count} · 仅使用提供的文本',
  'Cached result': '缓存结果',
  'Eligible for reuse in this project within its recorded window':
    '可在记录的有效期内于此项目中复用',
  'Historical result · reuse window expired or unavailable':
    '历史结果 · 复用窗口已过期或不可用',
  'No completed result': '暂无已完成结果',
  'Approved maximum': '已批准的费用上限',
  'Settled usage': '已结算用量',
  'Not fully settled': '尚未全部结算',
  'Claims, source snapshots and reviewer roster': '论断、来源快照和评审名单',
  '{title} · provided text': '{title} · 提供的文本',
  Captured: '采集时间',
  Reference: '参考链接',
  'No reference URL supplied': '未提供参考 URL',
  'Snapshot hash': '快照哈希',
  'Paid review approval': '批准付费评审',
  'Recover the original request': '恢复原请求',
  'Review the maximum reservation': '核对预留额度上限',
  'The approval outcome is uncertain. Recovery uses the same request key and quoted amount; it does not request a new execution.':
    '批准结果尚不确定。恢复时会使用相同的请求标识和报价金额；不会请求新的执行。',
  '{count} independent reviewer calls. The inference gateway and each upstream provider receive these claims and sources in plaintext.':
    '将进行 {count} 次独立评审调用。推理网关及各上游提供方会以明文接收这些论断和来源。',
  'Total maximum': '总费用上限',
  Quote: '报价',
  'Original approval retained': '已保留原批准',
  'Expired — dismiss and request another quote': '已过期 — 请关闭并请求新报价',
  'Expires {time} UTC': '于 {time} UTC 到期',
  '{model} · claim {number} · maximum {amount}':
    '{model} · 论断 {number} · 上限 {amount}',
  'Markup {percent}% included. Evidence date: {date}.':
    '已含 {percent}% 加价。证据日期：{date}。',
  'Cancellation may still incur usage already dispatched. Uncertain settlement can remain held for review. No free recheck entitlement is implied.':
    '取消后，已发出的调用仍可能产生费用。结算尚不确定时，额度可能继续冻结，等待核查。此功能不承诺免费复核。',
  'Dismiss quote': '关闭报价',
  'Checking…': '正在检查…',
  'Recover same request': '恢复原请求',
  'Reserve up to {amount} and run reviews': '预留最多 {amount} 并运行评审',
  'Claim {number} · {valid} / {total} valid reviews':
    '论断 {number} · {valid} / {total} 个有效评审',
  'Valid reviewers disagree. Dissent is preserved below.':
    '有效评审意见存在分歧。不同意见保留如下。',
  'Uncertainty: {reasons}.': '不确定因素：{reasons}。',
  'Review discarded': '评审已弃用',
  'Not counted: {reason}.': '未计入：{reason}。',
  '{title} · exact normalized match': '{title} · 规范化后精确匹配',
  'Source snapshot {hash}': '来源快照 {hash}',
  'Reviewer delivery and settlement': '评审调用与结算',
  '{model} · claim {number}: {state} · {billing}':
    '{model} · 论断 {number}：{state} · {billing}',
  'Sources are supplied snapshots, not independently retrieved or verified publications. Consensus can be wrong.':
    '来源是所提供的快照，并非独立获取或验证的出版物。共识也可能出错。',
  'Read saved status': '读取已保存状态',
  'Request current quote': '请求当前报价',
  'Request cancellation': '请求取消',
  'Back to draft and saved checks': '返回草稿和已保存核查',
  Credited: '已计入额度',
  'Expired · recovery only': '已过期 · 仅可恢复',
  'Awaiting payment': '等待支付',
  'The saved intent terms changed unexpectedly. No payment instructions are available.':
    '已保存的意向条款发生意外变化。暂无可用的支付指引。',
  'The amount exceeds the configured deposit limit.':
    '金额超出所配置的充值限额。',
  'The original intent was recovered. No transfer was sent by this interface.':
    '已恢复原充值意向。此界面未发送任何转账。',
  'Intent saved. No transfer was sent by this interface.':
    '意向已保存。此界面未发送任何转账。',
  'This intent is credited in the service ledger.':
    '此意向已计入服务账本额度。',
  'This intent is credited. Refresh Purse to read the current balance.':
    '此意向已计入额度。请刷新额度账户以读取当前余额。',
  'The saved intent is not credited. Reading status does not search for or send a transaction.':
    '已保存的意向尚未计入额度。读取状态不会搜索或发送交易。',
  'This transaction was already credited once. No duplicate credit was created.':
    '此交易已计入过额度，未重复入账。',
  'Finalized transfer verified and credited in the service ledger.':
    '已最终确认的转账已通过验证，并计入服务账本额度。',
  'Deposit credited. Refresh Purse to read the current balance.':
    '充值已计入额度。请刷新额度账户以读取当前余额。',
  'The saved payment changed unexpectedly. Do not sign another transfer.':
    '已保存的支付发生意外变化。请勿为另一笔转账签名。',
  'Reading saved payment…': '正在读取已保存支付…',
  'The wallet accounts or permissions changed. Read saved payment status before continuing.':
    '钱包账户或权限已变更。继续前请读取已保存支付状态。',
  'Wallet discovery is unavailable. Reload before connecting a wallet.':
    '无法发现钱包。请重新加载页面后再连接钱包。',
  'Saved status refreshed. A submitted transfer is not credit until finalized verification succeeds.':
    '已刷新保存的状态。已提交转账须通过最终确认验证后，才会计入额度。',
  'Preparing exact transfer…': '正在准备确切转账…',
  'Checking the saved transfer…': '正在检查已保存转账…',
  'This payment can no longer be signed. Check its saved status.':
    '此支付已无法签名。请检查其已保存状态。',
  'Connecting the exact source wallet…': '正在连接指定的付款钱包…',
  'Wallet connected. Return here and continue in your wallet when ready.':
    '钱包已连接。准备好后请返回此处，并在钱包中继续。',
  'Review and confirm in your wallet…': '请在钱包中核对并确认…',
  'The review window closed while your wallet was open. Conclave did not submit this transfer. Only recovery of an existing transfer is available.':
    '钱包打开期间，核对窗口已关闭。Conclave 未提交此转账。现在仅可恢复现有转账。',
  'Your checked signature is held in page memory. Return here and explicitly submit this same signed transfer.':
    '已检查的签名暂存于页面内存中。请返回此处，主动提交同一笔已签名转账。',
  'Submitting the signed transfer…': '正在提交已签名转账…',
  'The network accepted this transfer for processing. Check finalized payment before expecting service credit.':
    '网络已受理此转账。在预期服务额度入账前，请检查支付是否已最终确认。',
  'The signed transfer is saved. Its network acceptance is not established; check status and recover this same transfer.':
    '已保存签名转账，但尚未确认网络是否已接受。请检查状态并恢复同一笔转账。',
  'Checking the same transfer…': '正在检查原转账…',
  'The signing window is closed. Only finalized-payment recovery is available.':
    '签名窗口已关闭。现在仅可恢复已最终确认的支付。',
  'The same signed transfer was checked for submission. No new wallet signature or payment was created. Check finalization before expecting credit.':
    '已检查原签名转账的提交情况。未创建新的钱包签名或支付。请先检查最终确认状态，再确认额度是否入账。',
  'Checking finalized payment…': '正在检查最终确认支付…',
  'Finalized payment verified and credited once.':
    '已最终确认的支付已通过验证，并计入一次额度。',
  'The network check was incomplete. Continue this recovery check; this does not prove that no payment exists.':
    '网络检查未完成。请继续此次恢复检查；这并不能证明支付不存在。',
  'No matching finalized payment was found on this page. This does not prove that no payment exists.':
    '本页未找到匹配的最终确认支付。这并不能证明支付不存在。',
  'Holds against these sources': '这些来源支持该论断',
  'Does not hold against these sources': '根据这些来源，该论断不成立',
  'No consensus': '未达成共识',
  'Partly supported': '部分得到支持',
  'Give the source a title and provide up to 64 KiB of text.':
    '请填写来源标题，并提供不超过 64 KiB 的文本。',
  'Choose a project, reviewed roster, one to eight sources, and explicit claims within this roster’s limit.':
    '请选择项目、已审核的评审名单、1 至 8 个来源，并在名单规定的上限内填写明确论断。',
  'Cancellation requested. Already-dispatched usage may still be charged.':
    '已请求取消。已发出的调用仍可能计费。',
  'The deposit response could not be checked. Read the saved intent before continuing.':
    '无法检查充值响应。继续前请读取已保存的意向。',
  'Enter a positive USDC amount with at most six decimal places, such as 5 or 0.500001.':
    '请输入大于零且最多保留 6 位小数的 USDC 金额，例如 5 或 0.500001。',
  'The amount is outside the supported range.': '金额超出支持的范围。',
  'Enter one existing Solana transaction signature in base58 format, not a wallet address or a transaction URL.':
    '请输入一个现有 Solana 交易的 base58 签名，请勿填写钱包地址或交易 URL。',
  'New deposits are disabled or missing operator configuration. No transfer is initiated by this interface.':
    '新增充值已停用，或运营方尚未完成配置。此界面不会发起转账。',
  'Deposit recovery is not enabled for this network. Keep the original intent and transaction signature.':
    '此网络尚未启用充值恢复。请保留原意向和交易签名。',
  'The original intent’s network and treasury are not configured for recovery. Keep its ID and original transaction signature.':
    '原意向的网络和资金库尚未配置恢复功能。请保留其 ID 和原交易签名。',
  'This account already has the maximum number of active intents. Open an existing intent or wait for its payment window to close.':
    '此账户的有效意向数量已达上限。请打开现有意向，或等待其支付窗口关闭。',
  'Use your verified source wallet, distinct from the treasury and token accounts.':
    '请使用已验证的付款钱包，且须与资金库和代币账户不同。',
  'This deposit intent is unavailable to the current account.':
    '当前账户无法访问此充值意向。',
  'This intent is no longer awaiting payment. Read its saved status.':
    '此意向已不处于等待支付状态。请读取其已保存状态。',
  'This intent or transaction was already credited. Read the saved intent and account activity.':
    '此意向或交易已计入额度。请读取已保存意向和账户活动。',
  'Sign in through Account with this source wallet before creating its deposit intent.':
    '创建充值意向前，请在账户页面使用此付款钱包登录。',
  'Enter a positive USDC amount with at most six decimal places within the configured limit.':
    '请输入所配置限额内、大于零且最多保留 6 位小数的 USDC 金额。',
  'This request key has different saved terms. Read recent intents before creating another.':
    '此请求标识对应的已保存条款不同。创建新意向前，请读取近期意向。',
  'Recovery for this intent’s network is not configured. The original signature is retained here.':
    '此意向的网络尚未配置恢复功能。原签名已保留在此处。',
  'The configured Solana reader could not complete verification. Keep the original signature and read the saved intent before trying again.':
    '所配置的 Solana 读取服务无法完成验证。请保留原签名，并在重试前读取已保存意向。',
  'Verification timed out. Keep the original signature and read saved status before checking again.':
    '验证超时。请保留原签名，并在再次检查前读取已保存状态。',
  'This transaction is not available as finalized on the intent’s network. It may be pending, unavailable in RPC history, or from another network.':
    '此交易在意向指定的网络上尚无可用的最终确认记录。它可能仍在处理中、未包含在 RPC 历史记录中，或来自另一网络。',
  'The configured RPC reported a different network. This response did not verify the deposit.':
    '所配置的 RPC 返回了不同的网络。此次响应未能验证充值。',
  'The submitted transaction failed on chain and does not verify a deposit.':
    '所提交的交易在链上失败，无法据此验证充值。',
  'This transaction version is not supported by the deposit verifier.':
    '充值验证器不支持此交易版本。',
  'This transaction contains an unsupported instruction. Ordinary wallet sends without the required deposit reference may not be accepted.':
    '此交易包含不支持的指令。普通钱包转账若未包含必需的充值参考标识，可能无法被接受。',
  'This transaction contains ambiguous transfer evidence and was not accepted as this deposit.':
    '此交易的转账证据不明确，未被接受为此次充值。',
  'The transaction does not match this intent’s amount, source wallet, recipient, reference, or original time window.':
    '此交易与意向的金额、付款钱包、收款方、参考标识或原支付窗口不符。',
  'The network response could not be verified. Read saved status before checking the original signature again.':
    '无法验证网络响应。再次检查原签名前，请读取已保存状态。',
  'The required transaction evidence is incomplete. The deposit has not been verified by this response.':
    '所需交易证据不完整。此次响应未能验证充值。',
  'The deposit request did not complete. Read saved status before trying again.':
    '充值请求未完成。重试前请读取已保存状态。',
  'Your account session changed or expired. Sign in again before accessing deposits.':
    '账户会话已变更或过期。访问充值前请重新登录。',
  'The response exceeded the read limit. Read saved status; an interrupted request may still have completed.':
    '响应超出读取限制。请读取已保存状态；中断的请求仍可能已完成。',
  'Too many deposit requests. Wait a moment before trying again.':
    '充值请求过多。请稍后重试。',
  'The request timed out. Read saved status; recover a new intent with its original request key or check the original transaction signature again.':
    '请求超时。请读取已保存状态；使用原请求标识恢复新意向，或再次检查原交易签名。',
  'The deposit service could not be reached. Read saved status before retrying the same request.':
    '无法连接充值服务。重试同一请求前，请读取已保存状态。',
  'The saved payment could not be verified. Read its status before continuing.':
    '无法验证已保存支付。继续前请读取其状态。',
  'The payment request did not finish. Read the saved payment status before continuing.':
    '支付请求未完成。继续前请读取已保存支付状态。',
  'Choose a Solana mainnet wallet that supports signing a legacy transaction.':
    '请选择支持签名传统格式交易的 Solana 主网钱包。',
  'Connect the exact source wallet saved in this intent.':
    '请连接此意向中保存的指定付款钱包。',
  'The account or view changed. No new payment will be submitted. Read saved status.':
    '账户或视图已变更。不会提交新的支付。请读取已保存状态。',
  'The wallet or account no longer matches this mainnet payment.':
    '钱包或账户已不再与此次主网支付匹配。',
  'This payment is no longer available for signing. Check the existing transfer instead.':
    '此支付已无法签名。请检查现有转账。',
  'The wallet did not return a signed transfer. No transaction was submitted by Conclave.':
    '钱包未返回已签名转账。Conclave 未提交任何交易。',
  'The wallet returned a changed or invalid transfer. Conclave did not submit it.':
    '钱包返回的转账已被修改或无效。Conclave 未提交该转账。',
  'Your account changed or expired. Sign in again before accessing this payment.':
    '账户已变更或过期。访问此支付前请重新登录。',
  'Wallet payment is unavailable. Read the saved payment and recover the same transfer. Do not create another payment.':
    '钱包支付不可用。请读取已保存支付，并恢复同一笔转账。请勿创建另一笔支付。',
  'Too many requests. Wait before reading saved payment status again.':
    '请求过多。请稍后再读取已保存支付状态。',
  'The payment request was not completed. Read the saved payment and recover the same transfer. Do not create another payment.':
    '支付请求未完成。请读取已保存支付，并恢复同一笔转账。请勿创建另一笔支付。',
  'The response was interrupted. Read the saved payment and recover the same transfer. Do not create another payment.':
    '响应已中断。请读取已保存支付，并恢复同一笔转账。请勿创建另一笔支付。',
  'The submission outcome is not established by this response. Read the saved payment and recover the same transfer. Do not create another payment.':
    '此次响应无法确认提交结果。请读取已保存支付，并恢复同一笔转账。请勿创建另一笔支付。',
  'The resubmission outcome is not established. Read the saved payment and recover the same transfer. Do not create another payment.':
    '无法确认重新提交的结果。请读取已保存支付，并恢复同一笔转账。请勿创建另一笔支付。',
  'The Cross-Check response could not be checked. Read the saved request again before continuing.':
    '无法检查交叉核查响应。继续前请重新读取已保存请求。',
  'The content check blocked this text. Remove secrets or unsupported input before saving or sending. Nothing from this action was sent.':
    '内容检查已拦截此文本。保存或发送前，请移除敏感信息或不支持的输入。此次操作未发送任何内容。',
  'Remove or redact secret-like content before saving or sending.':
    '保存或发送前，请移除或遮盖疑似敏感信息。',
  'Cross-Check execution is not enabled by the operator. Prepared plans are not model reviews.':
    '运营方尚未启用交叉核查执行。已准备的计划不等于模型评审。',
  'A current reviewed roster of independent model families is required.':
    '需要当前有效且已审核的独立模型家族评审名单。',
  'This plan already has an execution. Read its saved status; do not start another request.':
    '此计划已有执行记录。请读取其已保存状态；请勿发起另一请求。',
  'The quote expired. Read the plan, then request a new quote if no execution exists.':
    '报价已过期。请读取计划；如尚无执行记录，再请求新报价。',
  'The approved amount does not match the quote. No new approval was accepted.':
    '批准金额与报价不符。未接受新的批准。',
  'This project reached its source or Cross-Check storage limit.':
    '此项目已达到来源或交叉核查的存储上限。',
  'Choose fewer claims for this roster. One execution supports at most 24 reviews.':
    '请为此名单减少论断数量。一次执行最多支持 24 个评审。',
  'This review exceeds the current maximum group reservation.':
    '此次评审超出当前的组预留额度上限。',
  'There is not enough available balance to reserve these reviews.':
    '可用余额不足，无法为这些评审预留额度。',
  'These claims and source snapshots exceed a reviewer route’s input limit. Choose shorter source excerpts.':
    '这些论断和来源快照超出评审路由的输入限制。请选择更短的来源摘录。',
  'Check the claim text, source sizes, and source reference fields.':
    '请检查论断文本、来源大小和来源参考字段。',
  'The saved Cross-Check could not be verified. No result is shown.':
    '无法验证已保存的交叉核查。未显示结果。',
  'This request key belongs to another execution. Read the saved status before continuing.':
    '此请求标识属于另一执行。继续前请读取已保存状态。',
  'The Cross-Check request did not complete. Read its saved status before trying again.':
    '交叉核查请求未完成。重试前请读取其已保存状态。',
  'The service could not be reached. An interrupted approval must be recovered with the original request key.':
    '无法连接服务。中断的批准须使用原请求标识恢复。',
  'Your account session changed or expired. Sign in again.':
    '账户会话已变更或过期。请重新登录。',
  'The response exceeds this view’s read limit. Read saved status; recover an interrupted approval with its original request key.':
    '响应超出此视图的读取限制。请读取已保存状态；使用原请求标识恢复中断的批准。',
  'Too many requests. Wait a moment before trying again.':
    '请求过多。请稍后重试。',
  'The Cross-Check request did not complete. Read the saved status before trying again.':
    '交叉核查请求未完成。重试前请读取已保存状态。',
  'The request timed out. An interrupted approval must be recovered with the original request key.':
    '请求超时。中断的批准须使用原请求标识恢复。',
  'Instruction-like content detected. Treat it as untrusted data; this warning does not establish safety.':
    '检测到疑似指令的内容。请将其视为不可信数据；此警告并不代表内容安全。',
  'Model agreement can be wrong. Quote checks establish text presence, not whether the passage proves a claim.':
    '模型意见一致也可能出错。引文检查只能确认文本存在，无法确认该段文字是否能证明论断。',
  proprietary: '专有模型',
  'open-weight': '开放权重模型',
  unverified: '未经验证',
  prepared: '已准备',
  finalized: '已最终确认',
  failed: '失败',
  expired: '已过期',
  queued: '排队中',
  running: '运行中',
  'awaiting evaluation': '等待评估',
  incomplete: '未完成',
  reviewed: '已评审',
  unavailable: '不可用',
  succeeded: '成功',
  cancelled: '已取消',
  'reconciliation pending': '等待对账',
  held: '已冻结',
  captured: '已扣款',
  released: '已释放',
  supported: '有证据支持',
  contradicted: '有证据反驳',
  'insufficient evidence': '证据不足',
  'missing valid review': '缺少有效评审',
  disagreement: '存在分歧',
  'missing review': '缺少评审',
  'duplicate review': '重复评审',
  'invalid json': 'JSON 无效',
  'invalid shape': '格式无效',
  'missing evidence': '缺少证据',
  'unknown source': '未知来源',
  'source hash mismatch': '来源哈希不匹配',
  'quote not found': '未找到引文',
} satisfies Dictionary;
