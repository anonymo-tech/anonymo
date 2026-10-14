import type { Dictionary } from '../index.ts';

/** Simplified Chinese, keyed by the exact English source text. See lib/i18n/TRANSLATING.md. */
export default {
  Model: '模型',
  'Model A': '模型 A',
  'Model B': '模型 B',
  'Model C': '模型 C',
  'Model D': '模型 D',
  'You: ': '你：',
  'Model responses, comparing all. Choose a model to focus.':
    '正在对比所有模型的回答。选择一个模型可单独查看。',
  'Model responses': '模型回答',
  '{name}, selected for Brief': '{name}，已选入简报',
  'Stop all {count} model responses': '停止全部 {count} 个模型的回答',
  'Stop the {name} response': '停止 {name} 的回答',
  'Stop all': '全部停止',
  Stop: '停止',
  'Measuring usage already dispatched for an exact charge.':
    '正在核算已发出的请求用量，以准确计费。',
  'Stopping…': '正在停止…',
  'Focus on {name}': '单独查看 {name}',
  'Compare all {count} responses': '比较全部 {count} 个回答',
  Focus: '单独查看',
  Compare: '比较',
  'Comparing {count} perspectives': '正在比较 {count} 个视角',
  'Deselect {name} answer': '取消选择 {name} 的回答',
  'Select {name} answer': '选择 {name} 的回答',
  'Remove from selection': '取消选择',
  'Select for a Brief': '选入简报',
  Selected: '已选择',
  Select: '选择',
  'Copy {name} answer': '复制 {name} 的回答',
  'Copy answer': '复制回答',
  Copy: '复制',
  '{name} answer': '{name} 的回答',
  '{name} sample answer': '{name} 的示例回答',
  'Load full answer ({count} characters)': '加载完整回答（{count} 个字符）',
  'Stopped. The provider did not confirm usage in time, so the final cost is being reconciled. Reserved funds remain held until then.':
    '已停止。提供方未及时确认用量，最终费用正在核对。在此之前，预留资金将继续冻结。',
  'The final cost is being reconciled. Reserved funds remain held.':
    '最终费用正在核对，预留资金仍处于冻结状态。',
  'Stopping. Usage already dispatched is being measured for an exact charge.':
    '正在停止。正在核算已发出的请求用量，以准确计费。',
  'Cost after reveal': '揭晓后显示费用',
  'Stopped · Cost pending': '已停止 · 费用待确认',
  'Cost pending': '费用待确认',
  'Generating…': '正在生成…',
  Queued: '排队中',
  'Stopped · {cost}': '已停止 · {cost}',
  Stopped: '已停止',
  Failed: '失败',
  'More actions for {name} answer': '{name} 回答的更多操作',
  'More actions': '更多操作',
  'Stop this request': '停止此请求',
  'Stop all models': '停止所有模型',
  'Prefer this answer & reveal': '选此回答并揭晓',
  'Reveal model names': '揭晓模型名称',
  'Follow up': '追问',
  'Inspect route': '查看路由',

  'How should I launch my notes app in two weeks?':
    '我该如何在两周内推出我的笔记应用？',
  'Turn this into a two-week checklist.': '把这份计划整理成两周的任务清单。',
  'Turn that into a 14-day checklist.': '把那份计划整理成 14 天的任务清单。',
  'Give me a two-week checklist.': '给我一份两周的任务清单。',
  'Make it a checklist.': '把它整理成任务清单。',
  'Make it a checklist': '把它整理成任务清单',
  'What should I check before approving a Solana transaction?':
    '批准 Solana 交易前，我应该检查哪些内容？',
  'How can I make my website clearer without a full redesign?':
    '如何在不全面重新设计的情况下，让我的网站更清晰易懂？',
  'Test the core loop first.': '先测试核心使用流程。',
  'Invite five people to save a note and find it again. Fix what stops them.':
    '邀请 5 个人保存一条笔记，再找回它。解决阻碍他们完成操作的问题。',
  'Spend week two inviting a small beta group.':
    '第二周邀请一小批用户参与测试。',
  'Choose a narrow audience.': '选定一个具体的目标群体。',
  'Pick one group with a shared problem. Build a 30-second demo around their workflow.':
    '选择一个面临共同问题的群体，围绕他们的使用流程制作一段 30 秒的演示。',
  'Use week two to recruit your first ten users.':
    '用第二周招募首批 10 位用户。',
  'Prove the loop, then invite people.': '先验证使用流程，再邀请用户。',
  'Days 1–3: ask five people to save a note, close the app, and find it again. Record the points where they get stuck.':
    '第 1–3 天：请 5 个人保存一条笔记，关闭应用后再找回它。记录他们遇到困难的环节。',
  'Days 4–7: fix the biggest obstacles. Check onboarding, search, and recovery before adding features.':
    '第 4–7 天：解决主要障碍。添加功能前，先检查新用户引导、搜索和恢复流程。',
  'Days 8–14: invite a small beta group, collect feedback, and check whether people return to their notes.':
    '第 8–14 天：邀请一小批用户参与测试，收集反馈，并观察他们是否会回来查看笔记。',
  'Keep one audience in view.': '始终聚焦一个目标群体。',
  'Days 1–3: choose one audience and describe the note-taking problem you are solving for them.':
    '第 1–3 天：选择一个目标群体，明确你要为他们解决的记笔记问题。',
  'Days 4–7: make a 30-second demonstration and a simple invitation page around that workflow.':
    '第 4–7 天：围绕这一使用流程制作一段 30 秒的演示和一个简单的邀请页面。',
  'Days 8–14: recruit ten people, help them try the app, and compare what they need with what you built.':
    '第 8–14 天：招募 10 个人，帮助他们试用应用，并对照他们的需求检查你已做出的功能。',
  'Read what the transaction can change.': '查看这笔交易可能改变什么。',
  'For this example, inspect the program, accounts, recipient, amount, and any change of authority. An approval can grant permission even when it transfers nothing immediately.':
    '在此示例中，请检查程序、账户、接收方、金额，以及任何权限变更。即使没有立即转移资产，批准操作也可能授予权限。',
  'This workspace has not decoded or simulated a transaction. Keep your wallet closed until you can verify the request in a trusted, read-only inspector.':
    '此工作区尚未解码或模拟任何交易。在能通过可信的只读检查工具验证请求之前，请保持钱包关闭。',
  'Check permissions and expected balance changes.':
    '检查权限和预期的余额变化。',
  'Compare the requested action with the program and accounts shown by your wallet. Look for unexpected delegates, authority changes, and writable accounts.':
    '将请求的操作与钱包显示的程序和账户进行对照。留意意外的受托方、权限变更和可写账户。',
  'A simulation is supporting evidence, not a guarantee. This is a sample checklist only: no RPC request, wallet connection, signature, or transaction has been made.':
    '模拟结果可作为参考证据，但不能提供保证。这仅是一份示例清单：未发出 RPC 请求，未连接钱包，也未进行签名或交易。',
  'Give each page one clear job.': '让每个页面都有一个明确的任务。',
  'Start with the first screen: say who the product helps, what it helps them do, and what they can try next.':
    '从首屏开始：说明产品帮助谁、帮他们完成什么，以及接下来可以尝试什么。',
  'Keep the main action visible. Remove repeated claims and move supporting detail below the essentials.':
    '让主要操作保持醒目。删去重复的宣传语，将补充细节放在核心信息之后。',
  'Test the path before changing the look.': '改外观前，先测试操作路径。',
  'Ask a few people to find the product explanation and the next step. Observe where they hesitate without coaching them.':
    '请几个人找到产品介绍和下一步操作。不作提示，观察他们在哪些地方犹豫。',
  'Improve labels, page order, and mobile readability first. Retest the same tasks after each small change.':
    '先改进标签、页面顺序和移动端可读性。每次小改动后，都重新测试相同任务。',
  'No live model result.': '暂无实时模型回答。',
  'This preview is not connected to a model. Your question stays in this browser, and no answer has been generated for it.':
    '此预览未连接模型。你的提问仅保留在此浏览器中，尚未生成回答。',
  'Use a prepared example to explore the comparison, or keep this question in your project for later.':
    '使用预设示例体验对比，或将这条提问留在项目中，稍后处理。',
  'Stopping response': '正在停止回答',
  'Stopped · settlement under review': '已停止 · 结算审核中',
  'Waiting to begin': '等待开始',
  'Generating response': '正在生成回答',
  'Request cancelled': '请求已取消',
  'Settlement under review': '结算审核中',
  'Request did not complete': '请求未完成',
  'No text returned': '未返回文本',

  'Welcome back': '欢迎回来',
  'Create an account': '创建账户',
  'Use your passkey': '使用你的通行密钥',
  'Create a passkey': '创建通行密钥',
  'Choose a wallet': '选择钱包',
  'Continue with {name}': '使用 {name} 继续',
  wallet: '钱包',
  'Sign in': '登录',
  Back: '返回',
  'Continue with passkey': '使用通行密钥继续',
  'Continue with wallet': '使用钱包继续',
  'New to Conclave?': '首次使用 Conclave？',
  'Have an account?': '已有账户？',
  'Sign up': '注册',
  'Use Face ID, Touch ID, or your device PIN.':
    '使用 Face ID、Touch ID 或设备 PIN 码。',
  'Passkey sign-in is not available yet.': '通行密钥登录尚未开放。',
  'Keep access to your passkey. There is no email reset if all linked sign-in methods are lost.':
    '请妥善保管通行密钥。若所有关联的登录方式都丢失，将无法通过电子邮件重置。',
  'Waiting for your device…': '等待设备响应…',
  Continue: '继续',
  'Choose an account': '选择账户',
  'Use account {address}': '使用账户 {address}',
  'Approve a sign-in message in your wallet. No transaction is sent.':
    '在钱包中批准登录消息。此操作不会发送交易。',
  'Waiting for your wallet…': '等待钱包响应…',
  'Wallet sign-in is not available yet.': '钱包登录尚未开放。',
  'Try again': '重试',
  'Open {name} in this browser, then return here.':
    '在此浏览器中打开 {name}，然后返回这里。',
  'Get {name}': '获取 {name}',
  'Checking account…': '正在检查账户…',
  'Refresh account status': '刷新账户状态',

  '{count} answered by a different model': '{count} 条由其他模型回答',
  '{count} reply still generating': '{count} 条回答仍在生成',
  '{count} replies still generating': '{count} 条回答仍在生成',
  '{count} stopped reply not yet settled': '{count} 条已停止的回答尚未结算',
  '{count} stopped replies not yet settled': '{count} 条已停止的回答尚未结算',
  '{count} reply whose cost is not yet settled': '{count} 条回答的费用尚未结算',
  '{count} replies whose cost is not yet settled':
    '{count} 条回答的费用尚未结算',
  '{count} reply that did not complete': '{count} 条回答未完成',
  '{count} replies that did not complete': '{count} 条回答未完成',
  '{count} reply not fully loaded': '{count} 条回答尚未完整加载',
  '{count} replies not fully loaded': '{count} 条回答尚未完整加载',
  '{count} unrevealed blind comparison': '{count} 次盲测对比尚未揭晓',
  '{count} unrevealed blind comparisons': '{count} 次盲测对比尚未揭晓',
  '{count} beyond the context size limit': '{count} 条超出上下文大小限制',
  ' ({reasons})': '（{reasons}）',
  ', ': '，',
  '.': '。',
  ' · your available balance': ' · 你的可用余额',
  'The last submission was interrupted. Recover this same request using its original request key; this will not create a second comparison.':
    '上次提交已中断。请使用原请求标识恢复同一请求；此操作不会创建第二次对比。',
  'Review where this question goes and the maximum amount reserved before the model runs.':
    '模型运行前，请确认提问的发送对象和最高预留金额。',
  'Review where this question goes and the maximum amount reserved before any model runs.':
    '任何模型运行前，请确认提问的发送对象和最高预留金额。',
  'Request summary': '请求概览',
  'Blind comparison': '盲测对比',
  'Your question': '你的提问',
  'Model comparison': '模型对比',
  '{count} model': '{count} 个模型',
  '{count} models': '{count} 个模型',
  'The question below and the included prior exchanges are sent. Attached files are not included.':
    '将发送下方提问及纳入的历史对话，不包含附件。',
  'The question below and each model’s included prior exchanges are sent. Attached files are not included. Context counts are listed per model.':
    '将发送下方提问及各模型纳入的历史对话，不包含附件。上下文数量按模型列出。',
  'Maximum reservation': '最高预留金额',
  'Platform fee': '平台费',
  'Includes up to {fee} platform fee · {reserve} to the platform-token burn reserve':
    '包含最高 {fee} 的平台费 · {reserve} 计入平台代币销毁储备',
  'Privacy route': '隐私路由',
  'Standard · The inference gateway and the model provider receive the question in plaintext.':
    '标准 · 推理网关和模型提供方会收到明文提问。',
  Quote: '报价',
  'Original request retained for recovery': '已保留原请求，可用于恢复',
  'Expired — request a new quote': '已过期，请重新获取报价',
  'Expires {time} UTC': '于 {time} UTC 过期',
  'Automatic routing decision': '自动路由决策',
  'Auto · {task}': '自动 · {task}',
  'Lowest maximum quoted cost among {count} reviewed, compatible supplied candidates for {task}. Each price includes its full supplied conversation context; this is not a model quality ranking.':
    '在所提供的 {count} 条已审核且兼容“{task}”任务的候选路由中，所选路由的最高报价最低。每项报价均包含所提供的完整对话上下文；这并非模型质量排名。',
  'Reservation budget': '预留预算',
  'Output ceiling': '输出上限',
  '{count} tokens': '{count} 个 token',
  'Model mentions: {mentions}.': '指定模型：{mentions}。',
  ' These choices override Auto’s route choice for this question; its reservation budget still applies.':
    '这些选择将覆盖此提问的自动路由选择，但预留预算仍然适用。',
  ' These choices override the picker for this question.':
    '这些选择将覆盖模型选择器对此提问的设置。',
  'Routing markers are removed from the question shown above.':
    '上方显示的提问已移除路由标记。',
  ' Reservation budget: {budget}.': '预留预算：{budget}。',
  '{model}: {count} previous exchange included':
    '{model}：已纳入 {count} 轮历史对话',
  '{model}: {count} previous exchanges included':
    '{model}：已纳入 {count} 轮历史对话',
  '; {count} loaded project turn left out{reasons}':
    '；已排除项目中加载的 {count} 轮对话{reasons}',
  '; {count} loaded project turns left out{reasons}':
    '；已排除项目中加载的 {count} 轮对话{reasons}',
  ' Additional older history has not been loaded and is not included.':
    '更早的其他历史记录尚未加载，也未纳入。',
  '{model} · maximum {amount}': '{model} · 最高 {amount}',
  'Route level': '路由级别',
  Retention: '数据保留',
  'Training use': '训练用途',
  unverified: '未经验证',
  unknown: '未知',
  'not used': '不用于训练',
  'may be used': '可能用于训练',
  'Pricing markup': '价格加成',
  '{percent}% included in the maximum': '最高金额已包含 {percent}% 的加成',
  'Evidence checked': '证据核查日期',
  'Task review': '任务审核',
  'Read task review evidence': '查看任务审核证据',
  'Read route evidence': '查看路由证据',
  ' (opens in a new tab)': '（在新标签页打开）',
  'The reserved maximum is a hold against your balance. Verified usage determines settlement. Cancellation may still incur usage already dispatched; an uncertain provider result can remain held for review.':
    '最高预留金额将从余额中冻结，结算金额由核实后的用量决定。取消后，已发出的请求仍可能产生费用；若提供方的结果不确定，资金可能继续冻结以待审核。',
  Dismiss: '关闭',
  'Checking saved request…': '正在检查已保存的请求…',
  'Recover this request': '恢复此请求',
  'Reserve up to {amount} and send': '预留最高 {amount} 并发送',

  'Auto route this question': '自动路由此提问',
  'Choose one reviewed route for your task and budget.':
    '根据任务和预算，选择一条已审核的路由。',
  Task: '任务',
  'General questions': '一般提问',
  Code: '代码',
  Reasoning: '推理',
  Writing: '写作',
  'Long context': '长上下文',
  'general questions': '一般提问',
  code: '代码',
  reasoning: '推理',
  writing: '写作',
  'long context': '长上下文',
  'Maximum reservation (USD)': '最高预留金额（USD）',
  'Maximum automatic route reservation in US dollars':
    '自动路由的最高预留金额（美元）',
  'Up to {amount} · your balance': '最高 {amount} · 你的余额',
  '10.00 service limit': '服务上限 10.00',
  'Auto compares the reviewed routes supplied for this task. Review the exact model and cost before sending. Vision and attachments are not supported.':
    '自动模式会比较为此任务提供的已审核路由。发送前，请确认具体模型和费用。不支持图像理解和附件。',
  'Current requests include at most 32 KiB of loaded context. The review lists any omitted exchanges.':
    '当前请求最多包含 32 KiB 的已加载上下文。确认页面会列出所有被排除的对话。',
  'Mention a model with @claude or {mention} to choose it for one question. Mentions override Auto; choosing a model below returns to Manual.':
    '使用 @claude 或 {mention} 可为单次提问指定模型。指定模型会覆盖自动路由；在下方选择模型会切回手动模式。',

  'Your wallet changed. Sign in again before accessing private data.':
    '你的钱包已变更。访问私密数据前，请重新登录。',
  'Your wallet accounts or permissions changed. Connect and sign in again to confirm the account.':
    '你的钱包账户或权限已变更。请重新连接并登录，以确认账户。',
  'Wallet discovery is unavailable. Refresh account status to try again.':
    '暂时无法检测钱包。请刷新账户状态后重试。',
  'Signed in. Your identity was verified by the server.':
    '已登录。服务器已验证你的身份。',
  'Signed in with your passkey.': '已使用通行密钥登录。',
  'The sign-in may have completed. Refresh account status before trying again.':
    '登录可能已完成。重试前，请刷新账户状态。',
  'Signed out of Conclave. Your wallet connection is managed by your wallet.':
    '已退出 Conclave。钱包连接由你的钱包管理。',
  'Sign in to verify the selected account.': '请登录以验证所选账户。',
  'Choose another wallet to connect.': '请选择另一个钱包进行连接。',
  'The account service returned an invalid response. Try again.':
    '账户服务返回了无效响应，请重试。',
  'The wallet request did not complete. You can try again when ready.':
    '钱包请求未完成。准备好后可以重试。',
  'The account service could not be reached. Try again.':
    '无法连接账户服务，请重试。',
  'Your sign-in could not be verified. Connect and sign in again.':
    '无法验证你的登录。请重新连接并登录。',
  'Too many sign-in requests. Wait a moment and try again.':
    '登录请求过多，请稍后重试。',
  'This account request was not allowed. Check the workspace address and try again.':
    '此账户请求未获允许。请检查工作区地址后重试。',
  'Account services are not available for this workspace right now.':
    '此工作区的账户服务当前不可用。',
  'The account request could not be completed. Try again.':
    '账户请求无法完成，请重试。',
  'The server session could not be confirmed. Refresh account status before continuing.':
    '无法确认服务器会话。继续前，请刷新账户状态。',
  'This wallet returned an unsupported account list.':
    '此钱包返回了不受支持的账户列表。',
  'Choose a Solana wallet that supports message sign-in.':
    '请选择支持通过消息签名登录的 Solana 钱包。',
  'The wallet did not share a Solana account. Connect again when ready.':
    '钱包未提供 Solana 账户。准备好后，请重新连接。',
  'This wallet cannot sign in with the selected account and method.':
    '此钱包无法使用所选账户和方式登录。',
  'The wallet returned a different account or message format. Nothing was verified.':
    '钱包返回了不同的账户或消息格式，尚未完成任何验证。',
  'Account security could not be checked. Refresh the saved account status before continuing.':
    '无法检查账户安全状态。继续前，请刷新已保存的账户状态。',
  'The account response could not be verified. Refresh the saved account status before continuing.':
    '无法验证账户响应。继续前，请刷新已保存的账户状态。',
  'Your session changed or expired. Refresh account status to sign in again.':
    '你的会话已变更或过期。请刷新账户状态后重新登录。',
  'Your account changed. Refresh account status before continuing.':
    '你的账户已变更。继续前，请刷新账户状态。',
  'Keep at least one sign-in identity on this account.':
    '请为此账户保留至少一种登录身份。',
  'Confirm this action again with an existing sign-in identity.':
    '请使用现有登录身份再次确认此操作。',
  'Passkey sign-in is not configured for this service.':
    '此服务尚未配置通行密钥登录。',
  'The account action was not confirmed. Refresh saved account status before trying again.':
    '账户操作未获确认。重试前，请刷新已保存的账户状态。',
  'The account action may have completed. Refresh saved account status before starting another action.':
    '账户操作可能已完成。开始其他操作前，请刷新已保存的账户状态。',
  'Account status could not be checked. Refresh to try again.':
    '无法检查账户状态，请刷新后重试。',
  'Confirm this action again; the previous approval expired.':
    '请再次确认此操作，之前的批准已过期。',
  'Finish or cancel the current passkey request first.':
    '请先完成或取消当前的通行密钥请求。',
  'This passkey request expired. Start again when ready.':
    '此通行密钥请求已过期。准备好后，请重新发起。',
  'Return to Conclave before starting a passkey request.':
    '发起通行密钥请求前，请先返回 Conclave。',
  'The passkey request did not complete. You can start again when ready.':
    '通行密钥请求未完成。准备好后可以重新发起。',
  'Confirm adding this passkey again; the previous approval expired.':
    '请再次确认添加此通行密钥，之前的批准已过期。',
  'This identity action may have completed. Refresh saved account status before trying again.':
    '此身份操作可能已完成。重试前，请刷新已保存的账户状态。',

  'Enter a positive USD budget with up to six decimal places, no greater than 10.':
    '请输入不超过 10 USD 的正数预算，最多保留六位小数。',
  'Choose a reservation budget between 0.000001 and 10 USD.':
    '请选择 0.000001 至 10 USD 的预留预算。',
  'The selected models exceed this reservation budget. Increase it explicitly or choose fewer models.':
    '所选模型超出此预留预算。请明确提高预算或减少模型数量。',
  'Reviewed route versions changed. Refresh the model list before requesting Auto again.':
    '已审核的路由版本发生了变更。再次请求自动路由前，请刷新模型列表。',
  'No supplied route has a current task review. Choose Manual or refresh the model list.':
    '提供的路由均缺少有效的任务审核。请选择手动模式或刷新模型列表。',
  'No reviewed compatible route fits this reservation budget. Increase it explicitly or choose Manual.':
    '没有已审核且兼容的路由符合此预留预算。请明确提高预算或选择手动模式。',
  'No reviewed route accepts the complete supplied context and output limit.':
    '没有已审核的路由支持所提供的完整上下文和输出上限。',
  'The candidates did not share the same question, output limit and privacy. Review the request again.':
    '候选路由的提问、输出上限或隐私设置不一致。请重新确认请求。',
  'Choose a positive reservation budget no greater than 10 USD.':
    '请选择不超过 10 USD 的正数预留预算。',
  'Remove or redact the detected secret before requesting a quote.':
    '获取报价前，请移除或遮盖检测到的秘密信息。',
  'There is not enough available balance to reserve this request.':
    '可用余额不足，无法为此请求预留资金。',
  'This quote has expired. Review a new quote before sending.':
    '此报价已过期。发送前，请确认新的报价。',
  'This quote is no longer available. Review a new quote before sending.':
    '此报价已不可用。发送前，请确认新的报价。',
  'This item changed elsewhere. Refresh before saving again.':
    '此内容已在其他地方变更。再次保存前，请刷新。',
  'A selected model route is unavailable. Refresh the model list.':
    '所选模型的一条路由不可用，请刷新模型列表。',
  'Live model requests are not configured. Projects remain available.':
    '尚未配置实时模型请求。项目仍可使用。',
  'This route needs a current privacy and pricing review.':
    '此路由需要有效的隐私和定价审核。',
  'This request exceeds the selected route’s input limit.':
    '此请求超出所选路由的输入限制。',
  'The requested privacy route is unavailable.': '请求的隐私路由不可用。',
  'This request key belongs to a different request. Refresh to inspect your history.':
    '此请求标识属于另一个请求。请刷新后查看历史记录。',
  'The service returned an invalid or unsupported response. Refresh to read the saved state.':
    '服务返回了无效或不受支持的响应。请刷新以读取已保存的状态。',
  'The workspace request did not complete. Refresh to read the saved state.':
    '工作区请求未完成。请刷新以读取已保存的状态。',
  'This saved result is too large to load in this view. No saved data was changed.':
    '已保存的结果过大，无法在此视图中加载。已保存的数据未发生变更。',
  'The service could not be reached. An interrupted submission can be retried with its original request key.':
    '无法连接服务。中断的提交可使用原请求标识重试。',
  'Sign in again to access your workspace.': '请重新登录以访问工作区。',
  'Too many requests. Wait a moment, then try again.': '请求过多，请稍后重试。',
  'The request did not complete. Refresh to read the saved state before trying again.':
    '请求未完成。重试前，请刷新以读取已保存的状态。',
  'This question exceeds a selected route’s input limit.':
    '此提问超出所选路由的输入限制。',
  'More than sixteen reviewed routes match this task. Choose models manually rather than omitting candidates.':
    '有超过 16 条已审核路由符合此任务。请手动选择模型，以免遗漏候选路由。',
  'No reviewed route supports this task and input with the current output limit. Choose Manual or refresh the model list.':
    '在当前输出上限下，没有已审核的路由支持此任务和输入。请选择手动模式或刷新模型列表。',
  'Choose one to four available models.': '请选择 1 至 4 个可用模型。',
  'The recommended route did not match the reviewed candidates.':
    '推荐路由与已审核的候选路由不匹配。',
  'A quoted route did not match the selected model.':
    '报价中的路由与所选模型不匹配。',
  'This quote has expired. Dismiss it and request a new quote.':
    '此报价已过期。请关闭后重新获取报价。',
  'The submission outcome is uncertain. Retry this same request to recover its saved status before dismissing.':
    '提交结果尚不确定。关闭前，请重试同一请求以恢复其已保存的状态。',

  'These questions and responses exceed the 24,000-character Brief limit. Select fewer or shorter responses.':
    '这些提问和回答超出简报 24,000 个字符的限制。请选择更少或更短的回答。',
  'Wait for each selected response to finish before saving a Brief.':
    '保存简报前，请等待所有所选回答完成。',
  'A selected response is unavailable. Refresh the project and choose its completed responses.':
    '所选回答不可用。请刷新项目并选择已完成的回答。',
  'Choose between one and four different completed responses.':
    '请选择 1 至 4 条不同的已完成回答。',
  'Reveal the model names before saving their provenance.':
    '保存回答的来源信息前，请先揭晓模型名称。',
  'This Brief was already removed. Start a new selection to save another.':
    '此简报已被移除。请重新选择回答以保存新的简报。',
  'Check your decision, notes and agreement topics before saving.':
    '保存前，请检查决策、笔记和共识主题。',
  'The live connection was interrupted. Saved requests can be reloaded.':
    '实时连接已中断，可以重新加载已保存的请求。',
  'This Brief could not be loaded.': '无法加载此简报。',
  'The Brief response did not match the saved project.':
    '返回的简报与已保存的项目不匹配。',
  'Sign in to access your private workspace.': '请登录以访问你的私密工作区。',
  'Your wallet account changed. Confirm sign-in again in Account before accessing private data.':
    '你的钱包账户已变更。访问私密数据前，请在账户页面再次确认登录。',
  'Model routes could not be loaded. Your projects remain available.':
    '无法加载模型路由。你的项目仍可使用。',
  'The current balance could not be loaded. Refresh it before approving a paid request.':
    '无法加载当前余额。批准付费请求前，请刷新余额。',
  'Saved conversation history could not be loaded. No saved data was changed.':
    '无法加载已保存的对话历史。已保存的数据未发生变更。',
  'Saved Brief contents could not be loaded. No saved data was changed.':
    '无法加载已保存的简报内容。已保存的数据未发生变更。',
  'Your session changed. Sign in again to access this workspace.':
    '你的会话已变更。请重新登录以访问此工作区。',
  'Give the project a name of 1–80 characters.':
    '请为项目输入 1–80 个字符的名称。',
  'Resolve or dismiss this project’s request review before archiving.':
    '归档前，请先处理或关闭此项目的请求确认。',
  'Finish the current request review before preparing another.':
    '准备其他请求前，请先完成当前请求的确认。',
  'Use a title of up to 160 characters and a body of up to 24,000 characters.':
    '标题最多可含 160 个字符，正文最多可含 24,000 个字符。',
  'The blind response included information that should remain hidden until reveal.':
    '盲测回答包含了应在揭晓前保持隐藏的信息。',
  'The live connection was interrupted. Reconnecting to this saved request; no new request will be sent.':
    '实时连接已中断。正在重新连接此已保存的请求，不会发送新请求。',
  'Live model requests are not configured. Your signed-in projects remain available.':
    '尚未配置实时模型请求。登录账户中的项目仍可使用。',
} satisfies Dictionary;
