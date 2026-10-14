import type { Dictionary } from '../index.ts';

/** Simplified Chinese, keyed by the exact English source text. See lib/i18n/TRANSLATING.md. */
export default {
  Projects: '项目',
  Chat: '对话',
  Canvas: '画布',
  Studio: '工作室',
  Agents: '智能体',
  Library: '资料库',
  Decisions: '决策',
  Connections: '连接',
  Purse: '额度账户',
  Chapters: '章节',
  'Model routes': '模型路由',
  'Solana Explainer': 'Solana 交易解读',
  'Cross-Check': '交叉核查',
  'Workspace settings': '工作区设置',
  'Your account': '你的账户',
  'Explore your workspace': '探索工作区',
  'Create a Brief': '创建简报',
  'Rename project': '重命名项目',
  'Delete this project?': '删除此项目？',
  'Reset this local workspace?': '重置此本地工作区？',
  'Your Studio draft': '你的工作室草稿',
  'Give the project a name of 1–{count} characters.':
    '项目名称须为 1–{count} 个字符。',
  'This local preview holds up to {count} projects. Remove a project to make space.':
    '此本地预览最多保存 {count} 个项目。请删除一个项目以腾出空间。',
  'Compare up to {count} models at a time.': '每次最多比较 {count} 个模型。',
  'Keep your question within {count} characters.':
    '提问请控制在 {count} 个字符以内。',
  'Launch plan': '发布计划',
  'Solana research': 'Solana 研究',
  'Website refresh': '网站更新',
  'New project': '新建项目',
  'Close dialog': '关闭对话框',
  'Another tab changed the saved workspace. Your work stays in this tab. Open Settings to download it before reloading the saved version.':
    '另一个标签页更改了已保存的工作区。你的内容仍在此标签页中。请先打开设置下载内容，再重新加载已保存的版本。',
  'This action is not available for an account project yet. Your saved project is unchanged.':
    '账户项目尚不支持此操作。已保存的项目未作更改。',
  'Your saved workspace is still loading. Try again in a moment.':
    '已保存的工作区仍在加载中。请稍后重试。',
  'This change exceeds the local workspace limits. Existing projects, drafts, and saved data are unchanged.':
    '此更改超出本地工作区限制。现有项目、草稿和已保存的数据未作更改。',
  'This change cannot be saved. Remove secret-like text or reduce the saved content; previous data is unchanged.':
    '无法保存此更改。请移除疑似机密文本或减少保存内容；原有数据未作更改。',
  'Saved data could not be loaded safely. It has been kept untouched; use Settings to reset it.':
    '无法安全加载已保存的数据。数据已保留且未作更改；可在设置中重置。',
  'Browser storage is unavailable. This session will not be saved.':
    '浏览器存储不可用。本次会话不会保存。',
  'The workspace could not be saved safely. Your previous saved data has been kept untouched.':
    '无法安全保存工作区。此前保存的数据已保留且未作更改。',
  'Storage is full or unavailable. New changes remain in this session.':
    '存储已满或不可用。新更改仅保留在本次会话中。',
  'Browser storage is unavailable. Your work stays in this tab.':
    '浏览器存储不可用。你的内容仍保留在此标签页中。',
  'Your current draft is too long to add this question. Your text has been kept unchanged.':
    '当前草稿过长，无法添加此提问。文本未作更改。',
  'Keep at least one model selected.': '请至少选择一个模型。',
  'Checking workspace availability. Try again in a moment.':
    '正在检查工作区是否可用。请稍后重试。',
  'No verified private route is available. This request has not been sent.':
    '暂无经过验证的私密路由。此请求尚未发送。',
  'Attachments are not supported by the connected text routes yet. Remove them before sending.':
    '已连接的文本路由尚不支持附件。请移除附件后再发送。',
  'Finishing the previous action. Send again in a moment.':
    '正在完成上一个操作。请稍后再次发送。',
  'Your draft or project changed during the content check. Review it and send again.':
    '内容检查期间，草稿或项目发生了更改。请检查后重新发送。',
  'Video models are not connected. Turn off the verified-route requirement to review a local draft.':
    '视频模型尚未连接。请关闭“要求经过验证的路由”，以查看本地草稿。',
  'No connected, verified route meets this policy. Turn off the verified-route requirement to explore sample answers.':
    '没有已连接且经过验证的路由符合此策略。请关闭“要求经过验证的路由”，以查看示例回答。',
  'This project has reached the local preview limit. Start a new project to continue.':
    '此项目已达到本地预览上限。请新建项目以继续。',
  'Sample answers added. No prompt was sent to a model.':
    '已添加示例回答。未向任何模型发送提问。',
  'Load the full answer before copying it.': '请先加载完整回答，再复制。',
  'Answer copied.': '回答已复制。',
  'Clipboard access is unavailable. Select the answer text to copy it.':
    '无法访问剪贴板。请选中回答文本进行复制。',
  'Load the full answer before creating a follow-up.':
    '请先加载完整回答，再创建追问。',
  'Your current draft is too long to add this follow-up. Your text has been kept unchanged.':
    '当前草稿过长，无法添加此追问。文本未作更改。',
  'Follow-up draft ready for this model.': '此模型的追问草稿已准备好。',
  'Load the full, completed answers before saving this Brief.':
    '请先加载已完成的完整回答，再保存此简报。',
  'Choose between one and four completed answers for a Brief.':
    '请选择 1 至 4 个已完成的回答创建简报。',
  'These questions and responses exceed the 24,000-character Brief limit. Select fewer or shorter responses.':
    '这些提问和回答超出简报的 24,000 字符上限。请选择更少或更短的回答。',
  'Reveal the model names before saving their provenance.':
    '请先揭晓模型名称，再保存其来源信息。',
  'Select fewer answers from this project to fit them in a Brief.':
    '请减少所选回答，以便将其纳入一份简报。',
  'Remove a saved Brief before adding another.':
    '请先删除一份已保存的简报，再添加新简报。',
  'Brief added to this session’s Library. Changes are not being saved in this tab.':
    '简报已添加到本次会话的资料库。此标签页中的更改不会保存。',
  'Brief saved to your Library.': '简报已保存到资料库。',
  'Load the full answers before exporting this conversation.':
    '请先加载完整回答，再导出此对话。',
  'Conclave account project': 'Conclave 账户项目',
  'Conclave account project · Loaded history only; earlier conversations are not included':
    'Conclave 账户项目 · 仅含已加载的历史记录；不包含更早的对话',
  'Local preview · Sample responses': '本地预览 · 示例回答',
  Model: '模型',
  'Loaded account records downloaded. Answer excerpts remain marked as partial; older unloaded history is not included.':
    '已下载加载的账户记录。回答摘录仍标为不完整；不包含尚未加载的更早历史记录。',
  'The workspace cannot be downloaded safely. Your current work is unchanged.':
    '无法安全下载工作区。当前内容未作更改。',
  'Projects, safe drafts, and Briefs downloaded. Secret-like drafts were excluded.':
    '已下载项目、安全草稿和简报。疑似含有机密的草稿已排除。',
  'Workspace navigation': '工作区导航',
  'More tools': '更多工具',
  More: '更多',
  'YOUR WORKSPACE': '你的工作区',
  'Use redacted text': '使用已脱敏的文本',
  'Dismiss guard message': '关闭防护提示',
  'Local only · not read by sample models': '仅保存在本地 · 示例模型不会读取',
  'Add files to this project': '向此项目添加文件',
  'Add files locally': '在本地添加文件',
  'Message to selected models': '发送给所选模型的消息',
  'Describe your next scene…': '描述下一个场景…',
  'Ask a follow-up…': '继续追问…',
  'Ask anything…': '尽管提问…',
  'Choose models': '选择模型',
  'One direction. Different takes.': '同一方向，不同演绎。',
  'A few different perspectives.': '几个不同的视角。',
  'Choose reviewed video routes. Formats and costs appear before approval.':
    '选择经过审核的视频路由。确认前可查看格式和费用。',
  'Choose up to four video models for your draft.':
    '为草稿选择最多 4 个视频模型。',
  'Choose up to {count} connected models.': '最多选择 {count} 个已连接的模型。',
  'Choose up to {count} sample models.': '最多选择 {count} 个示例模型。',
  'Find a model': '查找模型',
  'Find a model…': '查找模型…',
  'Reviewed video route': '已审核的视频路由',
  'No available video route': '暂无可用的视频路由',
  'Open model · hosted route': '开放模型 · 托管路由',
  'Writing & considered reasoning': '写作与深入推理',
  'General reasoning & code': '通用推理与编程',
  'Long context & analysis': '长上下文与分析',
  'Fast reasoning & current events': '快速推理与时事',
  'Code & structured thinking': '编程与结构化思考',
  'Open model · Sanctum sample': '开放模型 · Sanctum 示例',
  'Runway video · Not connected': 'Runway 视频 · 未连接',
  'Google video · Not connected': 'Google 视频 · 未连接',
  'OpenAI video · Not connected': 'OpenAI 视频 · 未连接',
  'Kling video · Not connected': 'Kling 视频 · 未连接',
  'Blind comparison': '匿名对比',
  'Hide reply labels until you vote or reveal.': '投票或揭晓前隐藏回答标签。',
  'Require sealed execution': '要求密封执行',
  'Require a verified route': '要求经过验证的路由',
  'Only attested routes. No fallback.':
    '仅使用通过证明验证的路由，不启用备用路由。',
  'Unverified routes will be blocked.': '未经验证的路由将被拦截。',
  'Inspect model routes': '查看模型路由',
  'Review video generation': '确认视频生成请求',
  'Review Studio draft': '查看工作室草稿',
  'Review model request': '确认模型请求',
  'Send sample prompt': '发送示例提问',
  'Review generation · Enter': '确认生成请求 · Enter',
  'Review draft · Enter': '查看草稿 · Enter',
  'Send · Enter': '发送 · Enter',
  'Skip to workspace': '跳转到工作区',
  'Conclave home': 'Conclave 首页',
  Personal: '个人',
  'YOUR PROJECTS': '你的项目',
  'Export conversation': '导出对话',
  'Create Brief…': '创建简报…',
  'All projects': '所有项目',
  'Sign in': '登录',
  'Account menu': '账户菜单',
  'AVAILABLE BALANCE': '可用余额',
  '{available} USD available · {reserved} USD reserved for open requests. Select to refresh.':
    '可用余额 {available} USD · 进行中的请求预留 {reserved} USD。点击刷新。',
  '{amount} reserved for open requests': '进行中的请求预留 {amount}',
  'Refresh balance': '刷新余额',
  'Internal test credit · not USDC': '内部测试额度 · 非 USDC',
  'Unavailable · Refresh': '不可用 · 刷新',
  'Checking…': '检查中…',
  'Sign in to view': '登录后查看',
  'Not connected': '未连接',
  'ACCOUNT WORKSPACE': '账户工作区',
  'LOCAL WORKSPACE': '本地工作区',
  'Account & wallet': '账户与钱包',
  Settings: '设置',
  'Help & shortcuts': '帮助与快捷键',
  'Field guide': '使用指南',
  'Loading your account workspace…': '正在加载账户工作区…',
  'Your account workspace is unavailable.': '账户工作区暂不可用。',
  'Sign in to continue with your account projects.':
    '请登录以继续使用账户项目。',
  'Open account': '打开账户',
  'Load earlier conversations': '加载更早的对话',
  'Load more Briefs': '加载更多简报',
  'Load more projects': '加载更多项目',
  '{count} selected': '已选择 {count} 项',
  'Create Brief': '创建简报',
  'Clear selection': '清除选择',
  'A NEW PROJECT': '新项目',
  'What are we thinking about?': '今天想聊什么？',
  'One question. A few different perspectives.': '一个提问，几个不同的视角。',
  'Plan a launch': '规划发布',
  'Explore Solana': '探索 Solana',
  'Choose your models and review the cost before sending.':
    '选择模型，并在发送前确认费用。',
  'Sign in to open your account projects.': '请登录以打开账户项目。',
  'Local preview · Sample answers, no connected models.':
    '本地预览 · 示例回答，尚未连接模型。',
  'Opening your canvas…': '正在打开画布…',
  'Search projects': '搜索项目',
  'Search library': '搜索资料库',
  'Find a project…': '查找项目…',
  'Find something you saved…': '查找已保存的内容…',
  'Search this workspace…': '搜索此工作区…',
  'Clear search': '清除搜索',
  'Account workspace{status}': '账户工作区{status}',
  ' · {status}': ' · {status}',
  'Private session': '私密会话',
  'Local preview{sample}': '本地预览{sample}',
  ' · Sample data': ' · 示例数据',
  'Files are attached locally. Sample models do not read or upload them.':
    '文件已在本地附加。示例模型不会读取或上传这些文件。',
  'Dismiss notification': '关闭通知',
  'Choose up to four completed responses. Your Brief preserves their original text, provenance, and usage at save.':
    '最多选择 4 个已完成的回答。简报会保留其原文、来源信息以及保存时的使用记录。',
  'Choose the perspectives worth keeping. Your Brief saves their sample answers together.':
    '选择值得保留的视角。简报会将这些示例回答一并保存。',
  'Save Brief to Library': '将简报保存到资料库',
  'Project name': '项目名称',
  'Save name': '保存名称',
  'This project will be archived. Existing requests and accounting records are retained.':
    '此项目将被归档。现有请求和账目记录会保留。',
  'The project and its saved Briefs will be removed from this browser.':
    '此项目及其已保存的简报将从此浏览器中删除。',
  'Project removed.': '项目已删除。',
  'Archive project': '归档项目',
  'Delete project': '删除项目',
  'This removes this preview’s projects and Briefs from this browser. Export anything you want to keep first.':
    '这会从此浏览器中删除本次预览的项目和简报。请先导出需要保留的内容。',
  'Local workspace reset.': '本地工作区已重置。',
  'Session reset. Browser storage is unavailable, so saved data could not be removed.':
    '会话已重置。浏览器存储不可用，因此无法删除已保存的数据。',
  'Reset local workspace': '重置本地工作区',
  'Another tab changed the saved workspace. This tab has stopped saving. Download your projects and Briefs before reloading the saved version.':
    '另一个标签页更改了已保存的工作区。此标签页已停止保存。请先下载项目和简报，再重新加载已保存的版本。',
  'Storage is unavailable or contains data this version cannot read. Download your current projects and Briefs to keep them.':
    '存储不可用，或包含此版本无法读取的数据。请下载当前项目和简报以保留内容。',
  'Download projects & Briefs': '下载项目与简报',
  'Reload saved workspace': '重新加载已保存的工作区',
  'Secret-like drafts are excluded from the download. Download Studio, Agent, and Chapter plans from their pages.':
    '下载内容不包含疑似含有机密的草稿。请前往各自页面下载工作室、智能体和章节计划。',
  'Prompt: {prompt}': '提问：{prompt}',
  '{model} response': '{model} 的回答',
  'Conversation canvas. Drag answer footers to move them; drag the background to pan.':
    '对话画布。拖动回答底部可移动回答；拖动背景可平移画布。',
  'Reset canvas view': '重置画布视图',
  'Fit all answers': '显示所有回答',
  'This question exceeds a selected route’s input limit.':
    '此提问超出所选路由的输入上限。',
  'More than sixteen reviewed routes match this task. Choose models manually rather than omitting candidates.':
    '超过 16 条已审核路由符合此任务。请手动选择模型，以免遗漏候选路由。',
  'No reviewed route supports this task and input with the current output limit. Choose Manual or refresh the model list.':
    '在当前输出上限下，没有已审核路由支持此任务和输入。请选择手动模式或刷新模型列表。',
  'Choose one to four available models.': '请选择 1 至 4 个可用模型。',
  'A selected model route is unavailable. Refresh the model list.':
    '所选模型的路由不可用。请刷新模型列表。',
  'Stopping response': '正在停止回答',
  'Stopped · settlement under review': '已停止 · 结算审核中',
  'Waiting to begin': '等待开始',
  'Generating response': '正在生成回答',
  'Request cancelled': '请求已取消',
  'Settlement under review': '结算审核中',
  'Request did not complete': '请求未完成',
  'No text returned': '未返回文本',
  'This Brief could not be loaded.': '无法加载此简报。',
  'The Brief response did not match the saved project.':
    '返回的简报与已保存的项目不匹配。',
  'Sign in to access your private workspace.': '请登录以访问私密工作区。',
  'Your wallet account changed. Confirm sign-in again in Account before accessing private data.':
    '钱包账户已更改。请在账户中重新确认登录，再访问私密数据。',
  'Model routes could not be loaded. Your projects remain available.':
    '无法加载模型路由。你的项目仍可使用。',
  'The current balance could not be loaded. Refresh it before approving a paid request.':
    '无法加载当前余额。请先刷新余额，再确认付费请求。',
  'Saved conversation history could not be loaded. No saved data was changed.':
    '无法加载已保存的对话历史。已保存的数据未作更改。',
  'Saved Brief contents could not be loaded. No saved data was changed.':
    '无法加载已保存的简报内容。已保存的数据未作更改。',
  'Your session changed. Sign in again to access this workspace.':
    '会话已更改。请重新登录以访问此工作区。',
  'Resolve or dismiss this project’s request review before archiving.':
    '请先完成或关闭此项目的请求确认，再归档。',
  'Finish the current request review before preparing another.':
    '请先完成当前请求的确认，再准备下一个请求。',
  'The recommended route did not match the reviewed candidates.':
    '推荐路由与已审核的候选路由不匹配。',
  'A quoted route did not match the selected model.':
    '报价中的路由与所选模型不匹配。',
  'This quote has expired. Dismiss it and request a new quote.':
    '此报价已过期。请关闭并获取新报价。',
  'The submission outcome is uncertain. Retry this same request to recover its saved status before dismissing.':
    '提交结果尚不确定。请重试同一请求以获取其已保存的状态，再关闭。',
  'Use a title of up to 160 characters and a body of up to 24,000 characters.':
    '标题最多 160 个字符，正文最多 24,000 个字符。',
  'The blind response included information that should remain hidden until reveal.':
    '匿名回答包含了应在揭晓前保持隐藏的信息。',
  'The live connection was interrupted. Reconnecting to this saved request; no new request will be sent.':
    '实时连接已中断。正在重新连接此已保存的请求；不会发送新请求。',
  'Live model requests are not configured. Your signed-in projects remain available.':
    '尚未配置实时模型请求。登录后的项目仍可使用。',
  'Enter a positive USD budget with up to six decimal places, no greater than 10.':
    '请输入大于 0 且不超过 10 USD 的预算，最多保留 6 位小数。',
  'Choose a reservation budget between 0.000001 and 10 USD.':
    '请选择 0.000001 至 10 USD 的预留预算。',
  'The selected models exceed this reservation budget. Increase it explicitly or choose fewer models.':
    '所选模型超出此预留预算。请主动提高预算或减少所选模型。',
  'Reviewed route versions changed. Refresh the model list before requesting Auto again.':
    '已审核的路由版本发生了更改。请先刷新模型列表，再使用自动模式。',
  'No supplied route has a current task review. Choose Manual or refresh the model list.':
    '提供的路由均无有效的任务审核。请选择手动模式或刷新模型列表。',
  'No reviewed compatible route fits this reservation budget. Increase it explicitly or choose Manual.':
    '没有符合此预留预算的已审核兼容路由。请主动提高预算或选择手动模式。',
  'No reviewed route accepts the complete supplied context and output limit.':
    '没有已审核路由支持所提供的完整上下文和输出上限。',
  'The candidates did not share the same question, output limit and privacy. Review the request again.':
    '候选路由的提问、输出上限和隐私设置不一致。请重新确认请求。',
  'Choose a positive reservation budget no greater than 10 USD.':
    '请选择大于 0 且不超过 10 USD 的预留预算。',
  'Wait for each selected response to finish before saving a Brief.':
    '请等待所有所选回答完成后，再保存简报。',
  'A selected response is unavailable. Refresh the project and choose its completed responses.':
    '所选回答不可用。请刷新项目并选择已完成的回答。',
  'Choose between one and four different completed responses.':
    '请选择 1 至 4 个不同的已完成回答。',
  'This Brief was already removed. Start a new selection to save another.':
    '此简报已被删除。请重新选择回答以保存新简报。',
  'Check your decision, notes and agreement topics before saving.':
    '保存前请检查决策、笔记和共识主题。',
  'Remove or redact the detected secret before requesting a quote.':
    '请移除检测到的机密内容或进行脱敏，再获取报价。',
  'There is not enough available balance to reserve this request.':
    '可用余额不足，无法为此请求预留费用。',
  'This quote has expired. Review a new quote before sending.':
    '此报价已过期。请先确认新报价，再发送。',
  'This quote is no longer available. Review a new quote before sending.':
    '此报价已不可用。请先确认新报价，再发送。',
  'This item changed elsewhere. Refresh before saving again.':
    '此条目已在其他位置更改。请刷新后再保存。',
  'Live model requests are not configured. Projects remain available.':
    '尚未配置实时模型请求。项目仍可使用。',
  'This route needs a current privacy and pricing review.':
    '此路由需要有效的隐私与定价审核。',
  'This request exceeds the selected route’s input limit.':
    '此请求超出所选路由的输入上限。',
  'The requested privacy route is unavailable.': '所请求的隐私路由不可用。',
  'This request key belongs to a different request. Refresh to inspect your history.':
    '此请求标识属于另一个请求。请刷新以查看历史记录。',
  'The service returned an invalid or unsupported response. Refresh to read the saved state.':
    '服务返回了无效或不受支持的响应。请刷新以读取已保存的状态。',
  'The workspace request did not complete. Refresh to read the saved state.':
    '工作区请求未完成。请刷新以读取已保存的状态。',
  'This saved result is too large to load in this view. No saved data was changed.':
    '已保存的结果过大，无法在此视图中加载。已保存的数据未作更改。',
  'The service could not be reached. An interrupted submission can be retried with its original request key.':
    '无法连接服务。中断的提交可使用原始请求标识重试。',
  'Sign in again to access your workspace.': '请重新登录以访问工作区。',
  'Too many requests. Wait a moment, then try again.':
    '请求过多。请稍等片刻再重试。',
  'The request did not complete. Refresh to read the saved state before trying again.':
    '请求未完成。请先刷新以读取已保存的状态，再重试。',
  'The live connection was interrupted. Saved requests can be reloaded.':
    '实时连接已中断。可重新加载已保存的请求。',
  'Enter a question of 1–6,000 characters.': '请输入 1–6,000 个字符的提问。',
  'Use @{exact-model-id} for a specific model.':
    '使用 @{exact-model-id} 指定具体模型。',
  'A mentioned model is unavailable. Choose a connected model or remove its mention.':
    '提及的模型不可用。请选择已连接的模型或移除该提及。',
  'This model has more than one connected route. Remove the mention and choose a route manually.':
    '此模型有多条已连接的路由。请移除提及并手动选择路由。',
  'This mention matches more than one route. Choose a specific model with @{exact-model-id}.':
    '此提及匹配多条路由。请使用 @{exact-model-id} 选择具体模型。',
  'Mention up to four different models.': '最多可提及 4 个不同模型。',
  'Add a question after choosing your models.': '选择模型后，请输入提问。',
  'Secret-like material detected. Remove it before sending.':
    '检测到疑似机密内容。请移除后再发送。',
  'Instruction-like content detected. Treat it as untrusted data; this warning does not establish safety.':
    '检测到疑似指令内容。请将其视为不可信数据；此警告并不表示内容安全。',
  'The text could not be checked safely. Do not send it.':
    '无法安全检查此文本。请勿发送。',
  'The content check is unavailable. Nothing has been sent. Try again.':
    '内容检查暂不可用。尚未发送任何内容。请重试。',
  'This looks like a private key or recovery phrase. Nothing was sent. Remove it before continuing.':
    '此内容疑似私钥或助记词。尚未发送任何内容。请移除后再继续。',
  'A secret-like pattern was found. Nothing was sent. Remove it, or replace the matched text locally.':
    '发现疑似机密的内容。尚未发送任何内容。请移除，或在本地替换匹配的文本。',
  'Instruction-like pasted content detected. Treat this text as quoted data. Review and remove the instruction before continuing.':
    '检测到粘贴内容中含有疑似指令。请将此文本视为引用数据。检查并移除指令后再继续。',
  'Choose a JPEG, PNG, WebP or GIF smaller than 20 MB.':
    '请选择小于 20 MB 的 JPEG、PNG、WebP 或 GIF 文件。',
  'Rename this file to remove secret-like text before attaching it.':
    '请先重命名文件以移除疑似机密文本，再添加附件。',
  'Reference attached to this Studio draft. It stays in this tab and is not uploaded.':
    '参考文件已附加到此工作室草稿。文件仅保留在此标签页中，不会上传。',
  'Model {label}': '模型 {label}',
  'Press enter or space to select a node. Press delete to remove it and escape to cancel.':
    '按 enter 或 space 选择节点。按 delete 删除，按 escape 取消。',
  'Press enter or space to select a node. You can then use the arrow keys to move the node around. Press delete to remove it and escape to cancel.':
    '按 enter 或 space 选择节点，再用方向键移动节点。按 delete 删除，按 escape 取消。',
  'Press enter or space to select an edge. You can then press delete to remove it or escape to cancel.':
    '按 enter 或 space 选择连线，再按 delete 删除，或按 escape 取消。',
  Handle: '连接点',
  'Moved selected node {direction}. New position, x: {x}, y: {y}':
    '已将所选节点向{direction}移动。新位置：x：{x}，y：{y}',
  left: '左',
  right: '右',
  up: '上',
  down: '下',
  LANGUAGE: '语言',
} satisfies Dictionary;
