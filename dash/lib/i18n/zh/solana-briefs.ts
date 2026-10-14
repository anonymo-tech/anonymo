import type { Dictionary } from '../index.ts';

/** Simplified Chinese, keyed by the exact English source text. See lib/i18n/TRANSLATING.md. */
export default {
  'Simulation completed': '模拟已完成',
  'Simulation failed': '模拟失败',
  'Simulation unavailable': '模拟不可用',
  'Simulation was not run': '未运行模拟',
  'The read was cancelled. Your entered transaction is still here.':
    '读取已取消。你输入的交易仍保留在此处。',
  'Inspect a transaction before signing. Decode its instructions and simulate against the configured Solana network, without connecting a wallet or submitting it.':
    '在签名前检查交易。解码交易指令，并在配置的 Solana 网络上进行模拟，无需连接钱包或提交交易。',
  'Sign in through Account to inspect a transaction.':
    '请通过账户页面登录后检查交易。',
  'Serialized transaction (base64)': '序列化交易（base64）',
  'Paste a complete legacy or v0 transaction': '粘贴完整的 legacy 或 v0 交易',
  'The transaction contents will be sent to the configured RPC for simulation. Never enter a private key or recovery phrase. Nothing is signed, sent onchain, or saved by this view.':
    '交易内容将发送到配置的 RPC 进行模拟。切勿输入私钥或助记词。此视图不会签名、向链上发送或保存任何内容。',
  'Inspecting transaction…': '正在检查交易…',
  'Inspect and simulate': '检查并模拟',
  'Cancel inspection': '取消检查',
  'Simulation result and warnings': '模拟结果与警告',
  'Pre-sign inspection · no transaction submitted': '签名前检查 · 未提交交易',
  'The RPC simulated execution successfully. This does not establish that the transaction is safe or matches your intent.':
    'RPC 已成功模拟执行。这不能证明交易安全或符合你的意图。',
  'The RPC reported an execution failure. The decoded instructions still describe requested actions; they have not executed onchain.':
    'RPC 报告执行失败。已解码的指令仍表示请求的操作；这些操作尚未在链上执行。',
  'No simulation outcome is established. Only the available instruction evidence is shown.':
    '尚无法确定模拟结果。仅显示可用的指令证据。',
  'Execution error: {code}{instruction}{programCode}.':
    '执行错误：{code}{instruction}{programCode}。',
  ' at instruction {index}': '，指令 {index}',
  ' (program code {code})': '（程序错误码 {code}）',
  '{severity} · instruction {location}': '{severity} · 指令 {location}',
  Critical: '严重',
  Warning: '警告',
  'Inspection evidence': '检查证据',
  Network: '网络',
  'Devnet · test network': 'Devnet · 测试网络',
  'Mainnet beta': '主网 Beta',
  'Inspected at': '检查时间',
  'Transaction hash (SHA-256)': '交易哈希（SHA-256）',
  'Genesis hash': '创世哈希',
  Reader: '读取器',
  'Version {version} · deterministic instruction decoding':
    '版本 {version} · 确定性指令解码',
  Format: '格式',
  '{format} · {bytes} bytes': '{format} · {bytes} 字节',
  Legacy: '旧版',
  'Version 0': '版本 0',
  'Fee payer': '手续费支付方',
  Signatures: '签名',
  '{present} present / {required} required · not verified':
    '已有 {present} 个 / 需要 {required} 个 · 未验证',
  'Original blockhash': '原始区块哈希',
  'Blockhash policy': '区块哈希策略',
  'RPC replacement requested for simulation only':
    '已请求 RPC 替换，仅用于模拟',
  'Original blockhash retained': '保留原始区块哈希',
  'Durable nonce': '持久 nonce',
  'No recognized nonce advance': '未识别到 nonce 推进指令',
  'Nonce advance recognized; blockhash preserved':
    '已识别 nonce 推进指令；保留区块哈希',
  'Nonce-like instruction is ambiguous; simulation withheld':
    '类似 nonce 的指令存在歧义；未进行模拟',
  'Simulation bank': '模拟 Bank 状态',
  Unavailable: '不可用',
  'Finalized context slot {slot} (not transaction inclusion)':
    '已最终确认的上下文 slot {slot}（不代表交易已上链）',
  'Simulation blockhash': '模拟区块哈希',
  'Last valid block height': '最后有效区块高度',
  'Compute units': '计算单元',
  'Simulated fee (lamports)': '模拟手续费（lamports）',
  'Address tables': '地址查找表',
  'Not required': '无需使用',
  '{count} resolved at slot {slot}': '已在 slot {slot} 解析 {count} 个',
  'Could not resolve': '无法解析',
  'Simulation address binding': '模拟地址绑定',
  'Loaded addresses matched resolved tables': '加载的地址与已解析的查找表一致',
  'No loaded addresses': '无加载的地址',
  Unverified: '未验证',
  'Instruction {location} · {kind}': '指令 {location} · {kind}',
  'Not decoded': '未解码',
  Program: '程序',
  'Accounts · {count}': '账户 · {count}',
  'Account roles come from the transaction message. Signer status does not verify a signature or prove authorization.':
    '账户角色来自交易消息。签名方状态不能验证签名或证明已获授权。',
  Signer: '签名方',
  'Non-signer': '非签名方',
  Writable: '可写',
  'Read only': '只读',
  'Simulated account state · {count} returned':
    '模拟账户状态 · 返回 {count} 个',
  'These are bounded post-simulation snapshots, not balance changes or a complete account of transaction effects. {count} writable accounts were outside the return limit.':
    '这些是范围有限的模拟后快照，并非余额变化或交易影响的完整记录。有 {count} 个可写账户超出返回数量上限。',
  'No checked account snapshots are available.': '没有可用的已检查账户快照。',
  'Simulated account': '模拟账户',
  Address: '地址',
  State: '状态',
  'Present · data {status}': '存在 · 数据{status}',
  'Absent in returned snapshot': '返回的快照中不存在',
  'Program owner': '所属程序',
  Lamports: 'Lamports',
  'Data bytes': '数据字节数',
  Executable: '可执行',
  Yes: '是',
  No: '否',
  'Token mint': '代币铸币地址',
  'Token authority': '代币权限方',
  'Token amount (base units)': '代币数量（基础单位）',
  'Token state': '代币状态',
  Delegate: '受托方',
  None: '无',
  'Delegated amount (base units)': '委托数量（基础单位）',
  'Close authority': '关闭权限方',
  'Token owner': '代币所有者',
  'Native reserve (lamports)': '原生代币储备（lamports）',
  'Not a native token account': '非原生代币账户',
  Source: '来源',
  Destination: '目标',
  Authority: '权限方',
  Owner: '所有者',
  Mint: '铸币地址',
  Account: '账户',
  'Amount in base units': '数量（基础单位）',
  'Amount in lamports': '数量（lamports）',
  'Token decimals': '代币小数位数',
  'Authority type': '权限类型',
  'New authority': '新权限方',
  'Priority price per compute unit (micro-lamports)':
    '每计算单元优先费单价（micro-lamports）',
  'Requested compute unit limit': '请求的计算单元上限',
  'Requested heap bytes': '请求的堆字节数',
  'Requested loaded account bytes': '请求的加载账户字节数',
  'Transfer fee in base units': '转账手续费（基础单位）',
  'Maximum fee in base units': '最高手续费（基础单位）',
  'Compute or fee settings': '计算或手续费设置',
  'SOL transfer': 'SOL 转账',
  'Token transfer': '代币转账',
  'Token transfer with fee': '含手续费的代币转账',
  'Delegate approval': '委托授权',
  'Authority change': '权限变更',
  'Account closure': '账户关闭',
  Memo: '备注',
  'Compute unit price': '计算单元单价',
  'Compute unit limit': '计算单元上限',
  'Heap frame request': '堆帧请求',
  'Loaded account data limit': '加载账户数据上限',
  'Create associated token account': '创建关联代币账户',
  'Create associated token account if absent': '不存在时创建关联代币账户',
  'Recover nested associated tokens': '恢复嵌套关联代币',
  'Initialize permanent delegate': '初始化永久受托方',
  'Initialize transfer hook': '初始化转账钩子',
  'Change transfer hook': '变更转账钩子',
  'Initialize display scaling': '初始化显示缩放',
  'Change display scaling': '变更显示缩放',
  'Initialize pause control': '初始化暂停控制',
  'Pause token operations': '暂停代币操作',
  'Resume token operations': '恢复代币操作',
  'Confidential token transfer': '机密代币转账',
  'Confidential token transfer with fee': '含手续费的机密代币转账',
  'Inspection mode': '检查模式',
  Transaction: '交易',
  'Pre-sign': '签名前',
  'The read was cancelled. Your entered signature is still here.':
    '读取已取消。你输入的签名仍保留在此处。',
  'Inspect an existing Solana transaction through the configured network’s RPC. This deterministic decoder reads transaction data; it does not ask a model, connect a wallet, sign, simulate, or submit a transaction.':
    '通过配置网络的 RPC 检查已有的 Solana 交易。此确定性解码器读取交易数据；不会调用模型、连接钱包、签名、模拟或提交交易。',
  'Sign in through Account to read an existing transaction.':
    '请通过账户页面登录后读取已有交易。',
  'Transaction signature': '交易签名',
  'Paste an existing transaction signature': '粘贴已有交易的签名',
  'Paste only the public transaction signature, never a private key or recovery phrase. The signature will be sent to the configured RPC service.':
    '仅粘贴公开的交易签名，切勿输入私钥或助记词。签名将发送到配置的 RPC 服务。',
  'Reading transaction…': '正在读取交易…',
  'Inspect transaction': '检查交易',
  'Cancel read': '取消读取',
  'Execution and decoder warnings': '执行与解码器警告',
  'Read-only RPC result': '只读 RPC 结果',
  'Transaction failed': '交易失败',
  'Execution outcome unknown': '执行结果未知',
  'Transaction executed': '交易已执行',
  'The recorded instructions describe attempted actions. Their requested state changes did not commit; a network fee may still have been charged.':
    '记录的指令描述的是尝试执行的操作。请求的状态变更未提交；网络手续费仍可能已收取。',
  'The available data does not establish whether execution succeeded. Do not infer that the listed actions completed.':
    '可用数据无法确定执行是否成功。请勿据此推断列出的操作已完成。',
  'The RPC reports successful execution. This is not a determination that the transaction was safe or intended.':
    'RPC 报告执行成功。这并不能判定交易安全或符合预期。',
  'Finalized inclusion is not a safety guarantee. Unknown programs, unsupported instructions, and missing metadata can leave effects unexplained. Mint state, invoked hook behavior, program upgrades, and current permissions have not been inspected.':
    '交易被最终确认收录并不保证安全。未知程序、不支持的指令和缺失的元数据可能导致部分影响无法解释。尚未检查铸币状态、被调用的钩子行为、程序升级及当前权限。',
  'Decoder flags': '解码器提示',
  Information: '信息',
  ' · instruction {instruction}': ' · 指令 {instruction}',
  'The supported decoder did not return a flag. This does not establish that every effect was decoded or that the transaction was safe.':
    '支持的解码器未返回提示。这不能证明所有影响均已解码，也不能证明交易安全。',
  'Transaction evidence': '交易证据',
  'Transaction record': '交易记录',
  Finalized: '已最终确认',
  Signature: '签名',
  Slot: 'Slot',
  Decoder: '解码器',
  'Version {version} · instruction data only': '版本 {version} · 仅指令数据',
  Instructions: '指令',
  '{count} decoded or marked unsupported': '{count} 条已解码或标记为不支持',
  'Unavailable or malformed': '不可用或格式错误',
  'BPF loader v1': 'BPF 加载器 v1',
  'BPF loader v2': 'BPF 加载器 v2',
  'Upgradeable loader v3': '可升级加载器 v3',
  'Loader v4': '加载器 v4',
  'Native runtime loader': '原生运行时加载器',
  'Unrecognized loader': '无法识别的加载器',
  'Account not found': '未找到账户',
  'This address is not a program': '此地址不是程序',
  'Program state not supported': '不支持此程序状态',
  'Program deployed': '程序已部署',
  'Program code retracted': '程序代码已撤回',
  'Code finalized under loader v4': '代码已在加载器 v4 下定稿',
  Deployment: '部署',
  Upgrade: '升级',
  'Deployment or redeployment': '部署或重新部署',
  'The read was cancelled. Your entered address is still here.':
    '读取已取消。你输入的地址仍保留在此处。',
  'Read a Solana program’s loader state and a bounded deployment history through the configured network’s RPC.':
    '通过配置网络的 RPC 读取 Solana 程序的加载器状态及范围有限的部署历史。',
  'Sign in through Account to inspect a program.':
    '请通过账户页面登录后检查程序。',
  'Program address': '程序地址',
  'Paste a Solana program address': '粘贴 Solana 程序地址',
  'Paste only the public program address. It will be sent to the configured RPC service. Never enter a private key or recovery phrase.':
    '仅粘贴公开的程序地址。地址将发送到配置的 RPC 服务。切勿输入私钥或助记词。',
  'Reading program…': '正在读取程序…',
  'Inspect program': '检查程序',
  'Program state and warnings': '程序状态与警告',
  'Finalized RPC snapshot': '已最终确认的 RPC 快照',
  'Program account record': '程序账户记录',
  'Program account': '程序账户',
  Loader: '加载器',
  'Owner program': '所属程序',
  'Finalized context slot': '已最终确认的上下文 slot',
  Upgradeability: '可升级性',
  'Upgradeable under this loader': '在此加载器下可升级',
  'Immutable under this loader’s rules': '按此加载器规则不可更改',
  'Not established': '尚未确定',
  'Current upgrade authority': '当前升级权限方',
  'None in the recognized loader state': '已识别的加载器状态中无此权限方',
  'Latest deployment slot in account state': '账户状态中的最近部署 slot',
  'Not available from this state': '无法从此状态获取',
  'Loader state slot': '加载器状态 slot',
  ' · retracted state, not a deployment date': ' · 撤回状态，并非部署日期',
  'ProgramData account': 'ProgramData 账户',
  'Next version address · not inspected': '下一版本地址 · 未检查',
  'Loader v4 code finalization is a program state. It is separate from the network finality of this RPC snapshot.':
    '加载器 v4 的代码定稿是一种程序状态，与此 RPC 快照在网络上的最终确认状态不同。',
  'Observed program deployment history': '观测到的程序部署历史',
  'Observed deployments and upgrades': '观测到的部署与升级',
  'History was not scanned for this account state.': '未扫描此账户状态的历史。',
  '{signatures} signatures scanned · {transactions} transactions checked · {unavailable} unavailable':
    '已扫描 {signatures} 个签名 · 已检查 {transactions} 笔交易 · {unavailable} 笔不可用',
  'Deployment events were not interpreted because the historical loader version is unverified.':
    '历史加载器版本未经验证，因此未解读部署事件。',
  'No matching deployment or upgrade events were found within these checked records.':
    '在这些已检查记录中未找到匹配的部署或升级事件。',
  '{event} · slot {slot}': '{event} · slot {slot}',
  Time: '时间',
  Instruction: '指令',
  'Awaiting approval': '等待批准',
  Queued: '已排队',
  Generating: '正在生成',
  'Checking billing outcome': '正在核查计费结果',
  'Ready for output validation': '可验证输出',
  'Analysis ready': '分析已就绪',
  'Analysis could not be used': '分析无法使用',
  'Request failed': '请求失败',
  Cancelled: '已取消',
  'Your session changed. Reopen this Brief after signing in.':
    '你的会话已变更。请登录后重新打开此简报。',
  'Generate Brief analysis': '生成简报分析',
  'Generated analysis': '生成的分析',
  'Summarize the {count} saved responses and compare their positions. The saved questions, answers, and source labels are sent; your decision and notes stay separate.':
    '概括 {count} 个已保存的回答并比较其立场。已保存的提问、回答和来源标签将被发送；你的决策和笔记保持独立。',
  'Read saved analysis requests': '读取已保存的分析请求',
  'Read saved requests before creating an analysis.':
    '创建分析前，请先读取已保存的请求。',
  'Generation is unavailable. Previously saved requests and results remain readable.':
    '生成功能不可用。仍可读取之前保存的请求和结果。',
  'Analysis model': '分析模型',
  'No reviewed routes available': '没有可用的已审核路由',
  '{model} · route {route}': '{model} · 路由 {route}',
  'Maximum output tokens': '最大输出 token 数',
  'Standard processing: {disclosure}': '标准处理：{disclosure}',
  'Get an exact quote': '获取准确报价',
  'Review the saved request below before creating another.':
    '创建新请求前，请先查看下方已保存的请求。',
  'Approval may have completed. Keep this saved request and its original approval key.':
    '批准可能已完成。请保留此已保存请求及其原始批准标识。',
  'Read saved approval status': '读取已保存的批准状态',
  'Recover the same approval': '恢复同一次批准',
  'Analysis maximum': '分析费用上限',
  'Analysis charge': '分析费用',
  'Not settled': '未结算',
  Route: '路由',
  Created: '创建时间',
  'This charge is separate from the original responses.':
    '此费用与原始回答的费用分开计算。',
  'Quote expires {expires}. Maximum {tokens} output tokens. Your saved source evidence is fixed for this request.':
    '报价于 {expires} 到期。最多输出 {tokens} 个 token。此请求使用的已保存来源证据保持固定。',
  'Approve up to {amount}': '批准最高 {amount}',
  'Validate saved output · no new model request':
    '验证已保存输出 · 不发起新模型请求',
  'Request cancellation': '请求取消',
  'The output could not be used as a sourced analysis. Any confirmed provider charge is retained; no automatic replacement is requested.':
    '此输出无法用作有来源支持的分析。已确认的提供方费用仍会收取；不会自动请求替代结果。',
  'Included in this Brief': '已纳入此简报',
  'Use this analysis in the Brief': '在简报中使用此分析',
  'Remove generated analysis from the Brief': '从简报中移除生成的分析',
  'Analysis request history ({count})': '分析请求历史（{count}）',
  'Load older requests': '加载更早的请求',
  'Name each agreement topic, or remove any unused rows.':
    '请为每个共识主题命名，或移除未使用的行。',
  'Remove secret-like text before saving.': '保存前请移除疑似包含敏感凭据的文本。',
  'The save was not confirmed. Refresh the workspace to check its saved revision before trying again. Your draft remains here.':
    '保存尚未确认。请刷新工作区，核查已保存的版本后再重试。你的草稿仍保留在此处。',
  'Your assessment. The original responses and their provenance stay unchanged.':
    '你的评估。原始回答及其来源记录保持不变。',
  'This Brief has a newer saved revision. Copy any unsaved notes before closing and reopening the editor.':
    '此简报已有更新的保存版本。请在关闭并重新打开编辑器前，复制尚未保存的笔记。',
  Title: '标题',
  'Your decision': '你的决策',
  'Your summary · {model}': '你的摘要 · {model}',
  'Agreement matrix · {count} topics': '共识矩阵 · {count} 个主题',
  'Record how you read each response. These labels are your assessment.':
    '记录你对每个回答的理解。这些标签代表你的评估。',
  'Topic {number}': '主题 {number}',
  Topic: '主题',
  'Assessment for {model}': '对 {model} 的评估',
  Agrees: '同意',
  Disagrees: '不同意',
  'Unclear / not addressed': '不明确 / 未涉及',
  'Remove topic {number}': '移除主题 {number}',
  'Add a topic': '添加主题',
  'Saving…': '正在保存…',
  'Save assessment': '保存评估',
  'Close editor': '关闭编辑器',
  'Selected generated analysis': '已选用的生成分析',
  'Analysis charge not settled': '分析费用未结算',
  '{amount} analysis charge': '{amount} 分析费用',
  '. This immutable analysis is separate from your assessment.':
    '。此分析不可更改，与你的评估保持独立。',
  'Analysis provenance': '分析来源记录',
  Run: '运行',
  Call: '调用',
  'Output SHA-256': '输出 SHA-256',
  'Add your decision and notes with Edit assessment.':
    '通过“编辑评估”添加你的决策和笔记。',
  'Your agreement assessment': '你的共识评估',
  'Cost pending at save': '保存时费用待定',
  '{amount} at save': '保存时为 {amount}',
  'Original question and response': '原始提问与回答',
  Provenance: '来源记录',
  'Saved {time}. Owner assessments are separate from the original responses. A snapshot hash is not an onchain proof.':
    '保存于 {time}。所有者的评估与原始回答保持独立。快照哈希并非链上证明。',
  'Evidence SHA-256': '证据 SHA-256',
  'Call {id}': '调用 {id}',
  'Comparison {id}': '对比 {id}',
  'Route {id}': '路由 {id}',
  'Response SHA-256 {hash}': '回答 SHA-256 {hash}',
  'Response {number} · {model}': '回答 {number} · {model}',
  'One model’s interpretation of the saved responses. Supporting quotes match the original text; they do not verify the interpretation or establish external consensus.':
    '这是一个模型对已保存回答的解读。支持性引文与原文一致，但不能验证解读，也不能证明外部存在共识。',
  'Supporting quotes': '支持性引文',
  'Source call {id}': '来源调用 {id}',
  'Generated agreement matrix': '生成的共识矩阵',
  'Source quote': '来源引文',
  'The inspection response could not be checked consistently. No result is shown.':
    '无法一致核验检查响应。不显示结果。',
  'Paste one complete Solana legacy or v0 transaction encoded as base64. Do not enter a private key or recovery phrase.':
    '请粘贴一笔完整的 base64 编码 Solana legacy 或 v0 交易。切勿输入私钥或助记词。',
  'The inspection did not complete. Nothing was signed or submitted.':
    '检查未完成。未签名或提交任何内容。',
  'A Solana RPC network is not configured for this workspace.':
    '此工作区未配置 Solana RPC 网络。',
  'The configured RPC could not complete this inspection. Nothing was signed or submitted.':
    '配置的 RPC 无法完成此检查。未签名或提交任何内容。',
  'The RPC inspection timed out. Nothing was signed or submitted.':
    'RPC 检查超时。未签名或提交任何内容。',
  'The RPC reported a different network than the configured cluster. No result is shown.':
    'RPC 报告的网络与配置的集群不同。不显示结果。',
  'The Solana reader is not configured correctly.': 'Solana 读取器配置有误。',
  'The RPC response could not be checked consistently. No result is shown.':
    '无法一致核验 RPC 响应。不显示结果。',
  'This transaction format is not supported. Only legacy and v0 transactions can be inspected.':
    '不支持此交易格式。仅可检查 legacy 和 v0 交易。',
  'The transaction encoding or wire structure is invalid. Paste the complete base64 transaction.':
    '交易编码或传输结构无效。请粘贴完整的 base64 交易。',
  'Required address-table or simulation evidence was unavailable. No complete result is shown.':
    '所需的地址查找表或模拟证据不可用。不显示完整结果。',
  'Secret-like material was detected in the transaction payload. Remove it before inspection; it was not sent to the RPC.':
    '交易载荷中检测到疑似包含敏感凭据的内容。请在检查前移除；该内容未发送到 RPC。',
  'Sign in to inspect a transaction.': '请登录后检查交易。',
  'The inspection could not start.': '无法开始检查。',
  'Your account session changed or expired. Sign in again before inspecting a transaction.':
    '你的账户会话已变更或过期。请重新登录后再检查交易。',
  'The inspection response exceeded this view’s read limit. No result is shown.':
    '检查响应超出此视图的读取上限。不显示结果。',
  'Too many inspection requests. Wait a moment before trying again.':
    '检查请求过多。请稍后重试。',
  'The inspection timed out. Nothing was signed or submitted.':
    '检查超时。未签名或提交任何内容。',
  'The program response could not be checked consistently. No result is shown.':
    '无法一致核验程序响应。不显示结果。',
  'Enter one Solana program address in base58 format, not a URL, private key, or recovery phrase.':
    '请输入一个 base58 格式的 Solana 程序地址，不要输入 URL、私钥或助记词。',
  'The program read did not complete. Your entered address is still here.':
    '程序读取未完成。你输入的地址仍保留在此处。',
  'A Solana RPC network is not configured for this workspace. Your entered address is still here.':
    '此工作区未配置 Solana RPC 网络。你输入的地址仍保留在此处。',
  'The configured RPC could not complete this read. Your entered address is still here; try again later.':
    '配置的 RPC 无法完成此次读取。你输入的地址仍保留在此处；请稍后重试。',
  'The RPC read timed out. No transaction was sent. You can try reading this address again.':
    'RPC 读取超时。未发送任何交易。你可以再次读取此地址。',
  'The RPC reported a different network than the configured cluster. No program result is shown.':
    'RPC 报告的网络与配置的集群不同。不显示程序结果。',
  'The Solana reader is not configured correctly. No program result is available.':
    'Solana 读取器配置有误。无法提供程序结果。',
  'The RPC response could not be checked consistently. No program result is shown.':
    '无法一致核验 RPC 响应。不显示程序结果。',
  'Sign in to inspect a program.': '请登录后检查程序。',
  'The program read could not start.': '无法开始读取程序。',
  'Your account session changed or expired. Sign in again before reading a program.':
    '你的账户会话已变更或过期。请重新登录后再读取程序。',
  'The program response exceeded this view’s read limit. No result is shown.':
    '程序响应超出此视图的读取上限。不显示结果。',
  'Too many program reads. Wait a moment before trying again.':
    '程序读取次数过多。请稍后重试。',
  'The program read timed out. Your entered address is still here.':
    '程序读取超时。你输入的地址仍保留在此处。',
  'A Solana RPC network is not configured for this workspace. Your entered signature is still here.':
    '此工作区未配置 Solana RPC 网络。你输入的签名仍保留在此处。',
  'The configured Solana RPC could not complete this read. Your entered signature is still here; try again later.':
    '配置的 Solana RPC 无法完成此次读取。你输入的签名仍保留在此处；请稍后重试。',
  'The Solana RPC read timed out. No transaction was sent. You can try reading this signature again.':
    'Solana RPC 读取超时。未发送任何交易。你可以再次读取此签名。',
  'This signature was not found as finalized on the configured network. It may be pending, unavailable in the RPC history, or from another network.':
    '在配置的网络上未找到此签名的最终确认记录。交易可能尚在处理中、RPC 历史记录中不可用，或来自其他网络。',
  'The RPC reported a different network than the configured cluster. No explanation is shown.':
    'RPC 报告的网络与配置的集群不同。不显示解读。',
  'The Solana reader is not configured correctly. No explanation is available.':
    'Solana 读取器配置有误。无法提供解读。',
  'This transaction version is not supported by the current decoder. No complete explanation is available.':
    '当前解码器不支持此交易版本。无法提供完整解读。',
  'The decoder does not support one or more instructions in this transaction.':
    '解码器不支持此交易中的一条或多条指令。',
  'The RPC response could not be checked consistently. No explanation is shown.':
    '无法一致核验 RPC 响应。不显示解读。',
  'Required transaction metadata was unavailable. No complete explanation is available.':
    '所需的交易元数据不可用。无法提供完整解读。',
  'The transaction failed. This response did not include a complete explanation of its attempted instructions.':
    '交易失败。此响应未包含对其尝试执行的指令的完整解读。',
  'Enter one existing Solana transaction signature in base58 format.':
    '请输入一笔已有 Solana 交易的 base58 格式签名。',
  'The transaction explanation could not be checked. No result is shown.':
    '无法核验交易解读。不显示结果。',
  'Enter one existing Solana transaction signature in base58 format, not a wallet address or transaction URL.':
    '请输入一笔已有 Solana 交易的 base58 格式签名，不要输入钱包地址或交易 URL。',
  'The transaction read did not complete. Your entered signature is still here.':
    '交易读取未完成。你输入的签名仍保留在此处。',
  'The transaction read could not start.': '无法开始读取交易。',
  'Your account session changed or expired. Sign in again before reading a transaction.':
    '你的账户会话已变更或过期。请重新登录后再读取交易。',
  'The transaction explanation exceeded this view’s read limit. No result is shown.':
    '交易解读超出此视图的读取上限。不显示结果。',
  'Too many transaction reads. Wait a moment before trying again.':
    '交易读取次数过多。请稍后重试。',
  'The transaction read timed out. Your entered signature is still here.':
    '交易读取超时。你输入的签名仍保留在此处。',
  'Analysis status could not be checked. Read the saved request before continuing.':
    '无法核查分析状态。请读取已保存的请求后再继续。',
  'The analysis response could not be verified. Read the saved request before continuing.':
    '无法验证分析响应。请读取已保存的请求后再继续。',
  'There is not enough available balance for this analysis.':
    '可用余额不足以支付此次分析。',
  'This quote expired. No new request was approved.':
    '此报价已过期。未批准新请求。',
  'This Brief changed elsewhere. Refresh it before changing the selected analysis.':
    '此简报已在别处更改。请刷新后再更换选用的分析。',
  'Saved evidence contains secret-like text and cannot be sent for analysis.':
    '已保存的证据含有疑似包含敏感凭据的文本，无法发送用于分析。',
  'Analysis generation is not configured. Saved results remain available.':
    '尚未配置分析生成功能。已保存的结果仍可查看。',
  'The source evidence changed. Reopen the saved Brief before continuing.':
    '来源证据已变更。请重新打开已保存的简报后再继续。',
  'This Brief is too large for analysis. Save fewer or shorter responses.':
    '此简报过大，无法分析。请减少保存的回答数量或长度。',
  'This saved source contains unsupported control characters.':
    '此已保存来源含有不支持的控制字符。',
  'Choose an output limit within this route’s reviewed maximum.':
    '请选择不超过此路由已审核上限的输出限额。',
  'This saved analysis is temporarily unavailable. Read its status again later.':
    '此已保存分析暂时不可用。请稍后重新读取其状态。',
  'Your session changed. Sign in again to read this Brief.':
    '你的会话已变更。请重新登录后读取此简报。',
  'The analysis request was not confirmed. Read its saved status before continuing.':
    '分析请求尚未确认。请读取其已保存状态后再继续。',
  'The request may have completed. Read its saved status before continuing.':
    '请求可能已完成。请读取其已保存状态后再继续。',
  'Analysis status could not be checked. Refresh to try again.':
    '无法核查分析状态。请刷新后重试。',
  'Approval may have completed. Recover this saved request using its original key.':
    '批准可能已完成。请使用原始请求标识恢复此已保存请求。',
  'This instruction has not been decoded.': '此指令尚未解码。',
  'Unknown program. Its permissions and effects require separate review.':
    '未知程序。其权限与影响需要单独审查。',
  'This instruction could not be decoded without ambiguity.':
    '无法无歧义地解码此指令。',
  'Required instruction fields are missing, unsupported or outside exact integer bounds.':
    '必需的指令字段缺失、不受支持或超出精确整数范围。',
  'Parsed transaction data alone does not establish finality or safety.':
    '仅凭已解析的交易数据无法确定最终确认状态或安全性。',
  'Execution metadata is unavailable.': '执行元数据不可用。',
  'Execution success or failure is not recorded.': '未记录执行成功或失败。',
  'The transaction failed; its instructions did not commit their requested changes.':
    '交易失败；其指令请求的变更未提交。',
  'Inner-instruction records are unavailable; this explanation may omit invoked programs.':
    '内部指令记录不可用；此解读可能遗漏被调用的程序。',
  'No instructions were supplied for explanation.': '未提供可供解读的指令。',
  'This instruction requests movement of SOL. The amount is shown in lamports; execution and balances are not inferred.':
    '此指令请求转移 SOL。数量以 lamports 显示；不据此推断执行情况或余额。',
  'This instruction requests account creation or initialization; current account existence and rent funding are not checked.':
    '此指令请求创建或初始化账户；未检查账户当前是否存在及租金资金。',
  'This instruction requests account data allocation. Current account state and required funding are not checked.':
    '此指令请求分配账户数据空间。未检查当前账户状态及所需资金。',
  'This instruction requests a change to account ownership, authority, or withdrawal controls.':
    '此指令请求变更账户归属、权限或提款控制。',
  'This instruction changes a durable nonce account or its funds. Nonce state and authorization are not independently checked.':
    '此指令更改持久 nonce 账户或其资金。未独立核查 nonce 状态及授权。',
  'This instruction requests a stake operation. Activation, lockup, validator performance, and current stake state are not checked.':
    '此指令请求质押操作。未检查激活状态、锁定条件、验证者表现及当前质押状态。',
  'This instruction changes an address lookup table. Its current contents, authority, and activation state are not checked.':
    '此指令更改地址查找表。未检查其当前内容、权限方及激活状态。',
  'This instruction requests account closure; destination accounts and resulting balances need separate review.':
    '此指令请求关闭账户；目标账户及最终余额需要单独审查。',
  'This instruction requests movement of tokens; mint state and actual received amounts are not inferred.':
    '此指令请求转移代币；不据此推断铸币状态或实际到账数量。',
  'Review this instruction separately.': '请单独审查此指令。',
  'Requests a native SOL transfer.': '请求原生 SOL 转账。',
  'Requests a native SOL transfer from an address derived with a seed.':
    '请求从种子派生的地址转出原生 SOL。',
  'Requests funding, allocation, and assignment of a new account to its owner program.':
    '请求为新账户注入资金、分配空间并指定所属程序。',
  'Requests creation of an account derived with a seed, with the specified owner program.':
    '请求创建种子派生的账户，并指定所属程序。',
  'Requests account creation allowing an already prefunded account.':
    '请求创建账户，允许该账户已预先获得资金。',
  'Requests assignment of an account to a different owner program.':
    '请求将账户指定给另一个所属程序。',
  'Requests assignment of an account derived with a seed to an owner program.':
    '请求将种子派生的账户指定给某个所属程序。',
  'Requests allocation of account data space, measured in bytes.':
    '请求分配账户数据空间，以字节计。',
  'Requests account data allocation and owner assignment using a seed.':
    '请求使用种子分配账户数据空间并指定所属程序。',
  'Requests advancement of a durable nonce.': '请求推进持久 nonce。',
  'Requests withdrawal of lamports from a durable nonce account.':
    '请求从持久 nonce 账户提取 lamports。',
  'Requests durable nonce initialization with the specified authority.':
    '请求以指定权限方初始化持久 nonce。',
  'Requests replacement of the authority controlling a durable nonce.':
    '请求更换控制持久 nonce 的权限方。',
  'Requests an upgrade to the durable nonce account format.':
    '请求升级持久 nonce 账户格式。',
  'This System program variant or raw encoding is not supported.':
    '不支持此 System 程序变体或原始编码。',
  'Requests stake account initialization with staker, withdrawer, and lockup authorities.':
    '请求以质押方、提款方及锁定权限方初始化质押账户。',
  'Requests stake account initialization with the listed staker and withdrawer.':
    '请求以列出的质押方和提款方初始化质押账户。',
  'Requests replacement of a stake authority.': '请求更换质押权限方。',
  'Requests replacement of a stake authority with new-authority signature checking by the program.':
    '请求更换质押权限方，程序会核查新权限方的签名。',
  'Requests replacement of a stake authority using an authority derived with a seed.':
    '请求使用种子派生的权限方更换质押权限方。',
  'Requests replacement of a stake authority using a seed and new-authority signature checking by the program.':
    '请求使用种子更换质押权限方，程序会核查新权限方的签名。',
  'Requests delegation of stake to the specified validator vote account.':
    '请求将质押委托给指定的验证者投票账户。',
  'Requests splitting lamports and stake into another stake account.':
    '请求将 lamports 和质押拆分到另一个质押账户。',
  'Requests withdrawal of lamports from a stake account to the destination.':
    '请求从质押账户向目标提取 lamports。',
  'Requests deactivation of stake; this does not establish that it is immediately withdrawable.':
    '请求停用质押；这不能证明资金可立即提取。',
  'Requests changes to stake withdrawal lockup conditions or the lockup custodian.':
    '请求更改质押提款的锁定条件或锁定托管方。',
  'Requests changes to stake withdrawal lockup conditions with custodian signature checking by the program.':
    '请求更改质押提款的锁定条件，程序会核查托管方签名。',
  'Requests merging stake accounts, draining and closing the source on successful execution.':
    '请求合并质押账户，执行成功后转出来源账户的全部资金并关闭该账户。',
  'Requests deactivation of delinquent stake using the supplied vote accounts; delinquency is not checked here.':
    '请求使用提供的投票账户停用失职验证者的质押；此处未核查失职情况。',
  'Requests the deprecated redelegation operation; current runtime support is not established.':
    '请求执行已弃用的重新委托操作；尚未确定当前运行时是否支持。',
  'Requests movement of lamports and active stake between stake accounts.':
    '请求在质押账户间转移 lamports 和活跃质押。',
  'Requests movement of unstaked lamports between stake accounts.':
    '请求在质押账户间转移未质押的 lamports。',
  'Requests the minimum stake delegation value as program return data; the returned amount is not decoded here.':
    '请求将最低质押委托数量作为程序返回数据；此处未解码返回数量。',
  'This Stake program variant or raw encoding is not supported.':
    '不支持此 Stake 程序变体或原始编码。',
  'This deprecated instruction is identified, but support by the selected runtime is not established.':
    '已识别此弃用指令，但尚未确定所选运行时是否支持。',
  'These are requested compute settings, not measured consumption or a calculation of the total transaction fee.':
    '这些是请求的计算设置，并非测得的消耗量或交易总手续费计算结果。',
  'Only the exact binary Compute Budget encoding is supported.':
    '仅支持精确的二进制 Compute Budget 编码。',
  'Requests a heap frame size in bytes.': '请求堆帧大小，以字节计。',
  'Requests a compute unit limit.': '请求计算单元上限。',
  'Requests a priority price in micro-lamports per compute unit.':
    '请求每计算单元的优先费单价，以 micro-lamports 计。',
  'Requests a loaded account data size limit in bytes.':
    '请求加载账户数据大小上限，以字节计。',
  'This Compute Budget discriminator is deprecated or unsupported.':
    '此 Compute Budget 判别码已弃用或不受支持。',
  'Requests transfer of nested account tokens to the destination and closure of the nested account, returning its lamports to the wallet.':
    '请求将嵌套账户的代币转移到目标并关闭嵌套账户，将其 lamports 退回钱包。',
  'Requests creation of an associated token account. Its address derivation and current existence are not checked.':
    '请求创建关联代币账户。未核查其地址派生及当前是否存在。',
  'Requests creation of an associated token account if absent. Its address derivation and existing state are not checked.':
    '请求在不存在时创建关联代币账户。未核查其地址派生及现有状态。',
  'Token-2022 account and mint extensions are not inspected by this instruction decode.':
    '此指令解码未检查 Token-2022 账户及铸币扩展。',
  'The supplied token program is not one of the supported SPL Token programs.':
    '提供的代币程序不属于支持的 SPL Token 程序。',
  'This address lookup table variant or raw encoding is not supported.':
    '不支持此地址查找表变体或原始编码。',
  'Requests creation of an address lookup table. Its derived address is not independently verified.':
    '请求创建地址查找表。未独立验证其派生地址。',
  'Requests permanent freezing of an address lookup table, removing the ability to extend or close it.':
    '请求永久冻结地址查找表，移除扩展或关闭它的能力。',
  'The requested address list exceeds the display bound; addresses are omitted. Review the full instruction independently.':
    '请求的地址列表超出显示上限；部分地址已省略。请独立审查完整指令。',
  'Requests appending the listed addresses to an address lookup table; existing contents are not fetched.':
    '请求将列出的地址追加到地址查找表；未获取现有内容。',
  'Requests deactivation of an address lookup table; eligibility for closure is not established here.':
    '请求停用地址查找表；此处未确定是否符合关闭条件。',
  'Requests closure of an address lookup table and transfer of its remaining lamports to the recipient.':
    '请求关闭地址查找表，并将剩余 lamports 转移给接收方。',
  'Memo text is public transaction data. It is not proof of payment, signer identity, or authenticity of its claims.':
    '备注文本是公开的交易数据，不能证明付款、签名方身份或其中主张的真实性。',
  'This memo exceeds the display bound; its text is omitted rather than truncated.':
    '此备注超出显示上限；文本已省略，未作截断显示。',
  'This memo exceeds the quoted display bound; its text is omitted rather than truncated.':
    '此备注超出引文显示上限；文本已省略，未作截断显示。',
  'Contains a UTF-8 memo. Signer authorization is not independently checked.':
    '包含 UTF-8 备注。未独立核查签名方授权。',
  'Active mint and account extension state was not inspected. Transfer fees, hooks, delegates, confidential balances, scaling or pause controls may affect this instruction.':
    '未检查当前铸币及账户扩展状态。转账手续费、钩子、受托方、机密余额、缩放或暂停控制可能影响此指令。',
  'The RPC did not provide a supported parsed token instruction.':
    'RPC 未提供支持的已解析代币指令。',
  'Approves a delegate to transfer or burn tokens later, up to the requested allowance.':
    '授权受托方以后转移或销毁代币，数量不超过请求的授权额度。',
  'Changes or removes control of a mint or token account. Some authority removals cannot be reversed.':
    '更改或移除铸币或代币账户的控制权。部分权限移除不可撤销。',
  'Requests token-account closure and sends its remaining SOL, including wrapped SOL where applicable, to the destination.':
    '请求关闭代币账户，并将剩余 SOL（适用时包括封装 SOL）发送到目标。',
  'Requests token destruction and a reduction of mint supply.':
    '请求销毁代币并减少铸币供应量。',
  'Requests creation of additional tokens under the mint authority.':
    '请求在铸币权限下增发代币。',
  'Changes whether this token account can move tokens.':
    '更改此代币账户是否能够转移代币。',
  'Requests token configuration or control changes; this instruction does not establish the current configuration.':
    '请求更改代币配置或控制；此指令不能确定当前配置。',
  'Configures a mint-level delegate that can transfer or burn tokens from accounts for this mint without per-account approval.':
    '配置铸币级受托方，可在无需各账户单独授权的情况下，从此铸币的账户转移或销毁代币。',
  'Configures an external transfer-hook program. Its code and additional effects are not inspected here.':
    '配置外部转账钩子程序。此处未检查其代码及额外影响。',
  'Configures or changes mint pause controls affecting minting, burning and transfers.':
    '配置或更改影响铸造、销毁及转账的铸币暂停控制。',
  'Changes display scaling. Displayed token amounts can change without changing raw token units.':
    '更改显示缩放。显示的代币数量可以变化，而以基础单位计的原始代币数量保持不变。',
  'Confidential balances or proofs are involved. Encrypted amounts and cryptographic proof validity are not verified by this explanation.':
    '涉及机密余额或证明。此解读未验证加密数量及密码学证明的有效性。',
  'Only the first five source accounts are displayed; the remaining source-account count is shown.':
    '仅显示前五个来源账户；其余来源账户以数量显示。',
  'Requests a token transfer. The signing authority may be an owner or previously approved delegate.':
    '请求代币转账。签名权限方可能是所有者或先前已获授权的受托方。',
  'Transfers tokens between token accounts.': '在代币账户间转移代币。',
  'Grants a delegate allowance over tokens in this account.':
    '为受托方授予此账户代币的使用额度。',
  'Mints tokens into the destination token account.':
    '向目标代币账户铸造代币。',
  'Burns tokens from the account.': '销毁账户中的代币。',
  'Revokes this account’s ordinary token delegate; mint-level Token-2022 delegates are separate.':
    '撤销此账户的普通代币受托方；铸币级 Token-2022 受托方保持独立。',
  'Revokes an ordinary token-account delegate allowance.':
    '撤销普通代币账户的委托额度。',
  'Changes a mint-level authority able to transfer or burn tokens from all accounts for this mint.':
    '更改可从此铸币所有账户转移或销毁代币的铸币级权限方。',
  'Changes authority over the mint’s external transfer-hook configuration.':
    '更改铸币外部转账钩子配置的权限方。',
  'Changes the authority that can pause token activity.':
    '更改可暂停代币活动的权限方。',
  'Changes or removes a token-account or mint authority.':
    '更改或移除代币账户或铸币权限方。',
  'Closes a token account and returns its remaining SOL to the destination.':
    '关闭代币账户，并将剩余 SOL 退回目标。',
  'Requests freezing a token account.': '请求冻结代币账户。',
  'Requests thawing a frozen token account.': '请求解冻已冻结的代币账户。',
  'Initializes a token mint with the specified mint and optional freeze authorities.':
    '以指定的铸币权限方及可选的冻结权限方初始化代币铸币。',
  'Initializes a token account for the specified mint and owner.':
    '为指定铸币及所有者初始化代币账户。',
  'Initializes a token-program multisignature authority and its signer threshold.':
    '初始化代币程序的多签权限方及其签名方门槛。',
  'Updates a wrapped-SOL token balance to reflect SOL already in this account; this instruction alone does not transfer SOL.':
    '更新封装 SOL 的代币余额，以反映此账户中已有的 SOL；此指令本身不转移 SOL。',
  'The instruction specifies an expected withheld transfer fee; current mint fee settings were not inspected.':
    '指令指定了预期扣留的转账手续费；未检查当前铸币手续费设置。',
  'Requests a token transfer with an explicitly expected fee.':
    '请求包含明确预期手续费的代币转账。',
  'Transfers tokens while checking the specified withheld fee.':
    '转移代币，同时核查指定的扣留手续费。',
  'Configures basis-point transfer fees and a maximum withheld amount; the effective current fee was not inspected.':
    '配置以基点计的转账手续费及最高扣留数量；未检查当前实际生效的手续费。',
  'Configures transfer-fee parameters for this mint.':
    '配置此铸币的转账手续费参数。',
  'Moves previously withheld fees; the actual balances were not inspected.':
    '转移先前扣留的手续费；未检查实际余额。',
  'Harvests withheld transfer fees from token accounts into the mint.':
    '从代币账户收集扣留的转账手续费至铸币。',
  'Withdraws withheld transfer fees to the specified token account.':
    '将扣留的转账手续费提取到指定代币账户。',
  'Initializes, replaces or removes a transfer-hook program reference.':
    '初始化、更换或移除转账钩子程序引用。',
  'Initializes a mint-level permanent delegate.': '初始化铸币级永久受托方。',
  'Sets the optional authority allowed to close this mint when program conditions permit.':
    '设置在程序条件允许时可关闭此铸币的可选权限方。',
  'Initializes the non-transferable mint extension.':
    '初始化不可转让铸币扩展。',
  'Initializes Token-2022 immutable ownership for this token account.':
    '为此代币账户初始化 Token-2022 不可变所有权。',
  'Changes whether newly created token accounts begin frozen.':
    '更改新建代币账户是否初始即被冻结。',
  'Configures the default state for new token accounts.':
    '配置新代币账户的默认状态。',
  'Changes account restrictions on privileged token operations invoked by other programs.':
    '更改其他程序调用特权代币操作时的账户限制。',
  'Changes whether incoming transfers require an accompanying memo.':
    '更改转入交易是否必须附带备注。',
  'Configures a multiplier for UI display amounts, without converting or asserting current raw balances.':
    '配置界面显示数量的乘数，不转换原始余额，也不据此断言当前原始余额。',
  'Initializes the mint pause authority.': '初始化铸币暂停权限方。',
  'Requests pausing minting, burning and token transfers.':
    '请求暂停铸造、销毁及代币转账。',
  'Requests resuming minting, burning and token transfers.':
    '请求恢复铸造、销毁及代币转账。',
  'Configures confidential-account approval and optional auditor settings.':
    '配置机密账户批准及可选的审计方设置。',
  'Approves a token account for confidential-transfer use; this is not an ordinary delegate allowance.':
    '批准代币账户使用机密转账；这不是普通的委托额度。',
  'Configures confidential account data using a registry reference that is not inspected here.':
    '使用注册表引用配置机密账户数据，此处未检查该引用。',
  'Configures confidential balances with referenced proofs that were not verified.':
    '使用未验证的引用证明配置机密余额。',
  'Requests clearing an empty confidential account balance using a referenced proof.':
    '请求使用引用证明清除空的机密账户余额。',
  'Moves confidential balance into the public balance of the same token account.':
    '将机密余额转入同一代币账户的公开余额。',
  'Moves public token balance into the pending confidential balance of the same token account.':
    '将公开代币余额转入同一代币账户的待处理机密余额。',
  'A confidential transfer fee is involved; its amount is not decoded.':
    '涉及机密转账手续费；其数量未解码。',
  'Requests a confidential token transfer; encrypted amounts and proof validity are not established here.':
    '请求机密代币转账；此处未确定加密数量及证明有效性。',
  'Applies pending confidential credits to this account’s available confidential balance.':
    '将待处理的机密入账应用到此账户的可用机密余额。',
  'Changes whether this account accepts the specified class of incoming token credits.':
    '更改此账户是否接受指定类别的代币转入。',
  'The binary operation requests this sensitive change; malformed or unsupported fields do not remove the warning.':
    '此二进制操作请求进行这项敏感变更；字段格式错误或不受支持并不会消除警告。',
  'This System binary variant is not supported.':
    '不支持此 System 二进制变体。',
  'Token-2022 mint and account extensions are not inspected by this instruction decode.':
    '此指令解码未检查 Token-2022 铸币及账户扩展。',
  'This Token-2022 extension binary payload is not decoded; review its full controls and effects independently.':
    '此 Token-2022 扩展二进制载荷未解码；请独立审查其全部控制与影响。',
  'This token binary instruction is not supported.': '不支持此代币二进制指令。',
  'This Stake binary variant is not supported; authority and stake warnings remain.':
    '不支持此 Stake 二进制变体；权限和质押警告仍然适用。',
  'This requested operation is not decoded. Execution is not established.':
    '此请求的操作未解码。尚未确定执行情况。',
  'This program is not supported. Its requested effects are not interpreted.':
    '不支持此程序。未解读其请求的影响。',
  'The binary instruction or account layout could not be decoded completely. Sensitive-operation warnings remain; do not treat this as approval.':
    '无法完整解码二进制指令或账户布局。敏感操作警告仍然适用；请勿视为批准。',
  'Malformed or unsupported binary fields prevent a complete deterministic explanation.':
    '二进制字段格式错误或不受支持，无法提供完整的确定性解读。',
  'This program instruction is not supported by the deterministic decoder.':
    '确定性解码器不支持此程序指令。',
  'Executable code and verified-build provenance were not fetched or checked. Loader metadata is not a safety assessment.':
    '未获取或核查可执行代码及已验证构建的来源记录。加载器元数据并非安全评估。',
  'No account was present at the finalized snapshot slot.':
    '最终确认快照的 slot 上不存在此账户。',
  'This account is not an executable program under a supported loader state.':
    '在支持的加载器状态下，此账户不是可执行程序。',
  'This account owner is not a supported deployable loader. Native programs are controlled by runtime releases; mutability is not inferred.':
    '此账户的所属程序不是支持的可部署加载器。原生程序受运行时版本控制；不据此推断可更改性。',
  'The loader account state is not supported. Upgrade authority and mutability are unknown.':
    '不支持此加载器账户状态。升级权限方及可更改性未知。',
  'A program-management authority is present and can change this program under the loader rules.':
    '存在程序管理权限方，可按加载器规则更改此程序。',
  'Loader-v4 marks this program as retracted. The account executable flag alone does not establish that it can run.':
    '加载器 v4 将此程序标记为已撤回。仅凭账户的可执行标记不能确定它能够运行。',
  'The finalized loader-v4 state contains a next-version reference. That account and its code were not inspected.':
    '已最终确认的加载器 v4 状态含有下一版本引用。未检查该账户及其代码。',
  'The historical loader-v4 version was not established. Version-specific references and deployment events are not interpreted.':
    '尚未确定历史加载器 v4 的版本。不解读版本特有的引用和部署事件。',
  'Only up to eight recent address signatures were scanned. This is not a complete upgrade history, even when no matching events are observed.':
    '最多仅扫描八个近期地址签名。这并非完整的升级历史，即使未观测到匹配事件也是如此。',
  'Some recent transaction evidence was unavailable, unsupported, outside the snapshot, or lacked complete successful invocation evidence.':
    '部分近期交易证据不可用、不受支持、超出快照范围，或缺乏完整的成功调用证据。',
  'Recent signature or transaction status history was unavailable. No conclusion about the absence of upgrades can be drawn.':
    '近期签名或交易状态历史不可用。无法据此断定未发生升级。',
  'Signature presence is counted, but signatures are not verified. This inspection never signs or submits the transaction.':
    '已统计签名数量，但未验证签名。此检查绝不会签名或提交交易。',
  'Simulation is a temporary execution against a finalized bank, not transaction inclusion or a safety assessment. State and outcomes can change.':
    '模拟是在已最终确认的 Bank 状态上临时执行，并非交易上链或安全评估。状态和结果可能变化。',
  'Returned account values are selected simulated post-state, not balance changes or a complete account-effects report.':
    '返回的账户值是选定的模拟后状态，并非余额变化或完整的账户影响报告。',
  'Simulation requested a fresh blockhash. It does not establish validity of the original blockhash or signatures.':
    '模拟请求了新的区块哈希。这不能证明原始区块哈希或签名有效。',
  'A durable nonce instruction was detected. The original blockhash is preserved for simulation.':
    '检测到持久 nonce 指令。模拟保留原始区块哈希。',
  'Nonce handling could not be established safely. Simulation was not attempted and the original blockhash was preserved.':
    '无法安全确定 nonce 处理方式。未尝试模拟，保留了原始区块哈希。',
  'Lookup tables could not be resolved under the supported finalized activation policy. Deactivating tables are not interpreted.':
    '无法按支持的最终确认激活策略解析查找表。不解读正在停用的表。',
  'Simulation did not establish the exact resolved lookup addresses. Its outcome and account state are withheld.':
    '模拟未确定精确的已解析查找地址。不显示其结果及账户状态。',
  'Simulation evidence was unavailable or could not be validated. No outcome is inferred.':
    '模拟证据不可用或无法验证。不据此推断结果。',
  'Simulation reported an execution failure. Only a fixed error category is shown; provider logs and arbitrary error text are omitted.':
    '模拟报告执行失败。仅显示固定的错误类别；提供方日志及任意错误文本已省略。',
  'At most eight writable post-accounts are inspected. Other accounts, program effects and unsupported data remain uninspected.':
    '最多检查八个可写账户的模拟后状态。其他账户、程序影响及不支持的数据仍未检查。',
  'Simulation inner instructions and program logs are not decoded. The instruction list describes only the submitted top-level instructions.':
    '未解码模拟内部指令及程序日志。指令列表仅描述提交的顶层指令。',
  'Token-2022 post-account extensions are not interpreted. Transfer fees, hooks and other extension effects remain unknown.':
    '未解读 Token-2022 模拟后账户扩展。转账手续费、钩子及其他扩展影响仍未知。',
  'System Transfer': 'System 转账',
  'System Transfer With Seed': 'System 种子地址转账',
  'System Create Account': 'System 创建账户',
  'System Create Account With Seed': 'System 创建种子派生账户',
  'System Create Account Allow Prefund': 'System 创建可预先注资的账户',
  'System Assign': 'System 指定所属程序',
  'System Assign With Seed': 'System 指定种子账户所属程序',
  'System Allocate': 'System 分配空间',
  'System Allocate With Seed': 'System 为种子账户分配空间',
  'System Advance Nonce': 'System 推进 nonce',
  'System Withdraw From Nonce': 'System 从 nonce 账户提款',
  'System Initialize Nonce': 'System 初始化 nonce',
  'System Authorize Nonce': 'System 更换 nonce 权限方',
  'System Upgrade Nonce': 'System 升级 nonce',
  'Source Base': '来源基地址',
  'Source Owner': '来源所属程序',
  'Source Seed': '来源种子',
  'New Account': '新账户',
  Space: '空间',
  Base: '基地址',
  Seed: '种子',
  'Nonce Account': 'nonce 账户',
  'Recent Blockhashes Sysvar': '近期区块哈希系统变量',
  'Nonce Authority': 'nonce 权限方',
  'Rent Sysvar': '租金系统变量',
  'New Authorized': '新授权方',
  'Stake Initialize': '初始化质押',
  'Stake Initialize Checked': '初始化质押并检查签名',
  'Stake Authorize': '更换质押权限方',
  'Stake Authorize Checked': '更换质押权限方并检查签名',
  'Stake Authorize With Seed': '通过种子更换质押权限方',
  'Stake Authorize Checked With Seed': '通过种子更换质押权限方并检查签名',
  'Stake Delegate': '委托质押',
  'Stake Split': '拆分质押',
  'Stake Withdraw': '提取质押',
  'Stake Deactivate': '停用质押',
  'Stake Set Lockup': '设置质押锁定',
  'Stake Set Lockup Checked': '设置质押锁定并检查签名',
  'Stake Merge': '合并质押',
  'Stake Deactivate Delinquent': '停用失职验证者的质押',
  'Stake Redelegate': '重新委托质押',
  'Stake Move Stake': '转移质押',
  'Stake Move Lamports': '转移质押账户的 lamports',
  'Stake Account': '质押账户',
  Staker: '质押方',
  Withdrawer: '提款方',
  'New Authority': '新权限方',
  'Authority Base': '权限方基地址',
  'Authority Owner': '权限方所属程序',
  'Authority Seed': '权限方种子',
  'Vote Account': '投票账户',
  'Stake Authority': '质押权限方',
  'New Split Account': '新拆分账户',
  'Withdraw Authority': '提款权限方',
  Custodian: '托管方',
  'Reference Vote Account': '参考投票账户',
  'New Stake Account': '新质押账户',
  'Stake Config Account': '质押配置账户',
  'Clock Sysvar': '时钟系统变量',
  'Stake History Sysvar': '质押历史系统变量',
  'Authority Type': '权限类型',
  'Nested Source': '嵌套来源',
  'Nested Mint': '嵌套铸币地址',
  'Nested Owner': '嵌套所有者',
  'Owner Mint': '所有者铸币地址',
  Wallet: '钱包',
  'Token Program': '代币程序',
  'System Program': 'System 程序',
  'Lookup Table Account': '地址查找表账户',
  'Lookup Table Authority': '地址查找表权限方',
  'Payer Account': '付款方账户',
  'Recent Slot': '近期 slot',
  'Bump Seed': 'Bump 种子',
  'New Address Count': '新地址数量',
  Recipient: '接收方',
  'Signer Count': '签名方数量',
  'Amount Raw': '数量（基础单位）',
  Decimals: '小数位数',
  'Source Account Count': '来源账户数量',
  'Source Accounts Preview': '来源账户预览',
  'Additional Source Accounts': '其他来源账户',
  Transfer: '转账',
  'Transfer Checked': '转账并检查',
  Approve: '授权',
  'Approve Checked': '授权并检查',
  'Mint To': '铸造代币',
  'Mint To Checked': '铸造代币并检查',
  Burn: '销毁',
  'Burn Checked': '销毁并检查',
  Revoke: '撤销授权',
  'Multisig Owner': '多签所有者',
  'Set Authority': '设置权限',
  'Multisig Authority': '多签权限方',
  'Close Account': '关闭账户',
  'Freeze Account': '冻结账户',
  'Thaw Account': '解冻账户',
  'Freeze Authority': '冻结权限方',
  'Multisig Freeze Authority': '多签冻结权限方',
  'Initialize Mint': '初始化铸币',
  'Initialize Mint2': '初始化铸币 2',
  'Mint Authority': '铸币权限方',
  'Initialize Account': '初始化账户',
  'Initialize Account2': '初始化账户 2',
  'Initialize Account3': '初始化账户 3',
  'Initialize Multisig': '初始化多签',
  'Initialize Multisig2': '初始化多签 2',
  Multisig: '多签',
  'Required Signatures': '所需签名数量',
  'Sync Native': '同步原生代币',
  'Transfer Checked With Fee': '含手续费的转账并检查',
  'Fee Amount Raw': '手续费数量（基础单位）',
  'Initialize Transfer Fee Config': '初始化转账手续费配置',
  'Set Transfer Fee': '设置转账手续费',
  'Transfer Fee Basis Points': '转账手续费基点',
  'Maximum Fee Raw': '最高手续费（基础单位）',
  'Transfer Fee Config Authority': '转账手续费配置权限方',
  'Withdraw Withheld Authority': '扣留费用提款权限方',
  'Withdraw Withheld Tokens From Mint': '从铸币提取扣留代币',
  'Withdraw Withheld Tokens From Accounts': '从账户提取扣留代币',
  'Harvest Withheld Tokens To Mint': '收集扣留代币至铸币',
  'Fee Recipient': '手续费接收方',
  'Multisig Withdraw Withheld Authority': '多签扣留费用提款权限方',
  'Initialize Transfer Hook': '初始化转账钩子',
  'Update Transfer Hook': '更新转账钩子',
  'Program Id': '程序 ID',
  'Initialize Permanent Delegate': '初始化永久受托方',
  'Initialize Mint Close Authority': '初始化铸币关闭权限方',
  'Initialize Non Transferable Mint': '初始化不可转让铸币',
  'Initialize Immutable Owner': '初始化不可变所有者',
  'Initialize Default Account State': '初始化默认账户状态',
  'Update Default Account State': '更新默认账户状态',
  'Account State': '账户状态',
  'Enable Cpi Guard': '启用 CPI 防护',
  'Disable Cpi Guard': '停用 CPI 防护',
  'Enable Required Memo Transfers': '启用转账必附备注',
  'Disable Required Memo Transfers': '停用转账必附备注',
  'Initialize Scaled Ui Amount Config': '初始化界面数量缩放配置',
  'Update Multiplier': '更新乘数',
  'New Multiplier': '新乘数',
  'New Multiplier Timestamp': '新乘数时间戳',
  Multiplier: '乘数',
  'Initialize Pausable Config': '初始化暂停配置',
  Pause: '暂停',
  Resume: '恢复',
  'Initialize Confidential Transfer Mint': '初始化机密转账铸币',
  'Update Confidential Transfer Mint': '更新机密转账铸币',
  'Confidential Transfer Mint Authority': '机密转账铸币权限方',
  'Auto Approve New Accounts': '自动批准新账户',
  'Auditor Key Configured': '已配置审计方密钥',
  'Approve Confidential Transfer Account': '批准机密转账账户',
  'Configure Confidential Account With Registry': '通过注册表配置机密账户',
  'Configure Confidential Transfer Account': '配置机密转账账户',
  'Empty Confidential Transfer Account': '清空机密转账账户',
  'Maximum Pending Balance Credit Counter': '待处理余额入账计数上限',
  'Deposit Confidential Transfer': '存入机密转账余额',
  'Withdraw Confidential Transfer': '提取机密转账余额',
  'Confidential Transfer': '机密转账',
  'Confidential Transfer With Fee': '含手续费的机密转账',
  Amount: '数量',
  'Apply Pending Confidential Transfer Balance': '应用待处理机密转账余额',
  'Expected Pending Balance Credit Counter': '预期待处理余额入账计数',
  'Enable Confidential Transfer Confidential Credits': '启用机密转账的机密入账',
  'Disable Confidential Transfer Confidential Credits':
    '停用机密转账的机密入账',
  'Enable Confidential Transfer Non Confidential Credits':
    '启用机密转账的非机密入账',
  'Disable Confidential Transfer Non Confidential Credits':
    '停用机密转账的非机密入账',
  'Multisig Mint Authority': '多签铸币权限方',
  'Lockup Unix Timestamp': '锁定 Unix 时间戳',
  'Lockup Epoch': '锁定 epoch',
  'Lockup Custodian': '锁定托管方',
  'Stake Get Minimum Delegation': '获取最低质押委托量',
  'Lookup Table Create': '创建地址查找表',
  'Lookup Table Freeze': '冻结地址查找表',
  'Lookup Table Extend': '扩展地址查找表',
  'Lookup Table Deactivate': '停用地址查找表',
  'Lookup Table Close': '关闭地址查找表',
  Info: '信息',
  Malformed: '格式错误',
  'New Addresses1': '新地址 1',
  'New Addresses2': '新地址 2',
  'New Addresses3': '新地址 3',
  'New Addresses4': '新地址 4',
  'New Addresses5': '新地址 5',
  'New Addresses6': '新地址 6',
  'New Addresses7': '新地址 7',
  'New Addresses8': '新地址 8',
  'New Addresses9': '新地址 9',
  'New Addresses10': '新地址 10',
  Signers1to1: '签名方 1 至 1',
  Signers1to2: '签名方 1 至 2',
  Signers1to3: '签名方 1 至 3',
  Signers1to4: '签名方 1 至 4',
  Signers1to5: '签名方 1 至 5',
  Signers6to6: '签名方 6 至 6',
  Signers6to7: '签名方 6 至 7',
  Signers6to8: '签名方 6 至 8',
  Signers6to9: '签名方 6 至 9',
  Signers6to10: '签名方 6 至 10',
  Signers11to11: '签名方 11 至 11',
  'Micro Lamports Per Compute Unit': '每计算单元 micro-lamports',
  'Compute Units': '计算单元',
  'Heap Bytes': '堆字节数',
  'Loaded Account Bytes': '加载账户字节数',
  'Compute Budget': '计算预算',
  'Compute Set Unit Price': '设置计算单元单价',
  'Compute Set Unit Limit': '设置计算单元上限',
  'Compute Request Heap Frame': '请求计算堆帧',
  'Compute Set Loaded Accounts Data Size Limit': '设置加载账户数据大小上限',
  'Associated Token Create': '创建关联代币账户',
  'Associated Token Create Idempotent': '幂等创建关联代币账户',
  'Associated Token Recover Nested': '恢复嵌套关联代币',
  'Time unavailable': '时间不可用',
  empty: '为空',
  decoded: '已解码',
  unsupported: '不支持',
  'too-large': '过大',
  initialized: '已初始化',
  frozen: '已冻结',
  agrees: '同意',
  disagrees: '不同意',
  unclear: '不明确',
  'Multisigtransfer Fee Config Authority': '多签转账手续费配置权限方',
  'Confidential Transfer Auditor Authority': '机密转账审计权限方',
  Registry: '注册表',
  none: '无',
  yes: '是',
  no: '否',
  true: '是',
  false: '否',
  mintTokens: '铸币',
  freezeAccount: '冻结账户',
  accountOwner: '账户所有者',
  closeAccount: '关闭账户',
  transferFeeConfig: '转账手续费配置',
  withheldWithdraw: '扣留费用提款',
  closeMint: '关闭铸币',
  interestRate: '利率',
  permanentDelegate: '永久受托方',
  confidentialTransferMint: '机密转账铸币',
  transferHookProgramId: '转账钩子程序 ID',
  confidentialTransferFeeConfig: '机密转账手续费配置',
  metadataPointer: '元数据指针',
  groupPointer: '组指针',
  groupMemberPointer: '组成员指针',
  scaledUiAmount: '界面数量缩放',
  pause: '暂停',
  permissionedBurn: '授权销毁',
  'confidential; not decoded': '机密；未解码',
  '{severity}:': '{severity}：',
} satisfies Dictionary;
