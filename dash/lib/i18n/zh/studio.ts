import type { Dictionary } from '../index.ts';

/** Simplified Chinese, keyed by the exact English source text. See lib/i18n/TRANSLATING.md. */
export default {
  Studio: '工作室',
  'Sample clips · Models not connected': '示例片段 · 模型未连接',
  Compare: '比较',
  Focus: '聚焦',
  'Focus view. Compare all sample clips': '聚焦视图。比较所有示例片段',
  'Loading sample…': '正在加载示例…',
  'Sample clip unavailable': '示例片段不可用',
  'Reload sample': '重新加载示例',
  'Focus on this clip': '聚焦此片段',
  'Return to compare': '返回比较',
  'Download sample': '下载示例',
  'Sample playback': '示例播放',
  'Pause sample clips': '暂停示例片段',
  'Replay sample clips': '重播示例片段',
  'Play sample clips': '播放示例片段',
  'Loading sample clips': '正在加载示例片段',
  Pause: '暂停',
  Play: '播放',
  'Seek sample clips': '调整示例片段进度',
  'Linked sample playback': '示例同步播放',
  'Sample playback is linked': '示例片段同步播放',
  'The sample could not play. Try Play again, or reload the clip from its preview.':
    '示例无法播放。请再次点击播放，或在预览中重新加载片段。',
  'A sample clip could not load. Use Reload sample in its preview to try again.':
    '示例片段加载失败。请在预览中点击“重新加载示例”重试。',
  Frame: '画面比例',
  Length: '时长',
  'Studio aspect ratio': '工作室画面比例',
  'Studio duration': '工作室时长',
  'Prefer 5 seconds': '优先 5 秒',
  'Closest format per model': '各模型最接近的格式',
  'Prefer 8 seconds': '优先 8 秒',
  'Prefer 10 seconds': '优先 10 秒',
  '6 seconds': '6 秒',
  '10 seconds': '10 秒',
  '15 seconds': '15 秒',
  'Exact supported formats appear in the review before approval.':
    '确认前可在审核页面查看具体支持的格式。',
  'For your draft. Sample playback stays 16:9 · 6s.':
    '仅用于草稿。示例播放仍为 16:9 · 6 秒。',
  'Choose a JPEG, PNG, WebP or GIF smaller than 20 MB.':
    '请选择小于 20 MB 的 JPEG、PNG、WebP 或 GIF 文件。',
  'Rename this file to remove secret-like text before attaching it.':
    '请重命名此文件，移除疑似密钥等敏感文字后再添加。',
  'Reference attached to this Studio draft. It stays in this tab and is not uploaded.':
    '参考图已添加到工作室草稿。它仅保留在此标签页中，不会上传。',
  'Remove secret-like text before downloading this draft.':
    '请移除疑似密钥等敏感文字后再下载草稿。',
  'Studio draft downloaded. No request was sent to a model.':
    '工作室草稿已下载。未向模型发送请求。',
  'Video models are not connected yet. Keep this direction as a draft; the sample clips stay unchanged.':
    '视频模型尚未连接。可将此创作方向保留为草稿；示例片段不会改变。',
  Project: '项目',
  Models: '模型',
  Format: '格式',
  'Your local reference': '你的本地参考图',
  'This Studio draft stays in this tab. Download it before refreshing.':
    '此工作室草稿仅保留在此标签页中。请在刷新前下载。',
  'Download draft': '下载草稿',
  'Keep editing': '继续编辑',
  None: '无',
  'Loading your clips…': '正在加载你的片段…',
  'Your video workspace': '你的视频工作区',
  'Saved clips · Generation unavailable': '已保存片段 · 暂无法生成',
  'Studio results': '工作室结果',
  'Recent results': '最近的结果',
  'Loading your saved results…': '正在加载已保存的结果…',
  'Your next idea starts here': '下一个创意，从这里开始',
  'Sign in to save and generate clips.': '登录后即可保存和生成片段。',
  'Describe a video in the bar below. Review each model’s format and cost before generating.':
    '在下方输入栏描述视频。生成前请查看各模型的格式和费用。',
  'Refresh results': '刷新结果',
  'Earlier results': '更早的结果',
  'Playback could not start. Try Play again or refresh your saved results.':
    '无法开始播放。请再次点击播放，或刷新已保存的结果。',
  'Playback unavailable': '暂无法播放',
  'Reload clip': '重新加载片段',
  'Check existing request': '检查现有请求',
  'Request cancellation': '请求取消',
  'Download clip': '下载片段',
  'Delete this saved clip? Its job, charge and receipt remain. This does not issue a refund.':
    '删除此已保存片段？任务、费用和收据仍会保留。此操作不会退款。',
  'Confirm delete clip': '确认删除片段',
  'Keep clip': '保留片段',
  'Delete clip': '删除片段',
  'Saved clip playback': '已保存片段播放',
  'Pause clips': '暂停片段',
  'Play clips': '播放片段',
  'Seek saved clips': '调整已保存片段进度',
  'Linked playback': '同步播放',
  'Playback is linked': '片段同步播放',
  Saved: '已保存',
  'Clip deleted': '片段已删除',
  'Clip could not be prepared': '片段处理失败',
  'Checking generation and charge': '正在核查生成状态及费用',
  'Cancellation requested': '已请求取消',
  'Preparing clip': '正在处理片段',
  'Waiting to start': '等待开始',
  'Starting generation': '正在启动生成',
  Generating: '正在生成',
  'Generation failed': '生成失败',
  Cancelled: '已取消',
  'Checking status': '正在检查状态',
  'A submission was interrupted. Recover its original approval before starting anything else. Accepted jobs are never sent again, and recovery does not start the unsubmitted models.':
    '提交已中断。请先恢复原始授权，再进行其他操作。已接受的任务不会再次提交，恢复操作也不会启动尚未提交的模型。',
  'These jobs are saved. Generation, processing and final billing remain visible in Studio.':
    '这些任务已保存。可在工作室查看生成、处理及最终计费情况。',
  'Review the exact video options and maximum reservation for each model before generation starts.':
    '生成开始前，请查看各模型的具体视频选项和最高预留金额。',
  'Studio request summary': '工作室请求摘要',
  'Video comparison': '视频对比',
  'Draft preference': '草稿偏好',
  'Exact generation options': '具体生成选项',
  'Shown per model below. A draft duration may differ from supported model durations.':
    '下方列出各模型的选项。草稿时长可能与模型支持的时长不同。',
  'Maximum still to reserve': '待预留的最高金额',
  'Quotes required for all remaining models': '其余所有模型均需报价',
  'Already submitted': '已提交',
  'Privacy route': '隐私路由',
  'Standard · The inference gateway and the upstream model provider receive the description in plaintext.':
    '标准 · 推理网关和上游模型提供方会收到明文描述。',
  Submitted: '已提交',
  'Outcome unknown': '结果未知',
  'Submitting…': '正在提交…',
  'Not accepted': '未被接受',
  Quoted: '已报价',
  'Quote needed': '需要报价',
  Model: '模型',
  'Maximum reservation': '最高预留金额',
  'Not quoted': '尚未报价',
  Quote: '报价',
  'Accepted terms retained': '已接受的条款已保留',
  'Original key retained for recovery': '已保留原始请求标识以便恢复',
  'Expired — refresh quotes': '已过期，请刷新报价',
  Retention: '数据保留',
  'Each model creates a separate job and balance hold. A hold is a maximum reservation; confirmed provider cost determines settlement. Cancellation after dispatch may still incur a charge. Provider cancellation is unavailable. Saved media is served only after processing succeeds.':
    '每个模型会创建独立任务并冻结相应余额。冻结金额为最高预留金额，结算以已确认的提供方费用为准。派发后取消仍可能产生费用。目前无法向提供方取消请求。已保存的媒体仅在处理成功后提供。',
  'Close review': '关闭审核',
  'Checking…': '正在检查…',
  'Get current quotes': '获取当前报价',
  'Refresh quotes': '刷新报价',
  'Checking saved requests…': '正在检查已保存的请求…',
  'Recover interrupted approvals': '恢复中断的授权',
  'Compare view. Focus on {name} sample': '比较视图。聚焦 {name} 示例',
  '{name} sample preview': '{name} 示例预览',
  'Prepared sample clip {sample}; {name} is not connected':
    '预制示例片段 {sample}；{name} 未连接',
  'Actions for {name} sample': '{name} 示例操作',
  '{position} of {duration}': '{position}，总时长 {duration}',
  '{name} result': '{name} 结果',
  '{name} generated clip': '{name} 生成的片段',
  'Actions for {name} result': '{name} 结果操作',
  '{amount} USD reserved': '已预留 {amount} USD',
  '{amount} USD settled': '已结算 {amount} USD',
  '{ratio} · {duration} seconds': '{ratio} · {duration} 秒',
  '{name} · Local only': '{name} · 仅限本地',
  '{count} model': '{count} 个模型',
  '{count} models': '{count} 个模型',
  '{count} job · excluded from new submissions':
    '{count} 个任务 · 不会再次提交',
  '{count} jobs · excluded from new submissions':
    '{count} 个任务 · 不会再次提交',
  '{name} generation terms': '{name} 生成条款',
  '{name} generation variant': '{name} 生成规格',
  'Exact {name} variant': '{name} 具体规格',
  'Expires {time} UTC': '于 {time} UTC 过期',
  'Reserve up to {amount} and generate': '预留最多 {amount} 并生成',
  '# Studio draft\n\nProject: {project}\nModels: {models}\nFrame: {ratio}\nDuration: {duration} seconds\nReference: {reference}\n\n## Direction\n\n{prompt}\n\nLocal draft only. No model was called. Reference image is not included.\n':
    '# 工作室草稿\n\n项目：{project}\n模型：{models}\n画面比例：{ratio}\n时长：{duration} 秒\n参考图：{reference}\n\n## 创作方向\n\n{prompt}\n\n仅为本地草稿。未调用任何模型。不包含参考图。\n',
  'Resolve or close the existing review before preparing another request. Accepted jobs will not be resubmitted.':
    '请先处理或关闭现有审核，再准备新请求。已接受的任务不会再次提交。',
  'Live media generation is unavailable. Saved jobs remain readable; no model was called.':
    '暂无法实时生成媒体。已保存的任务仍可查看；未调用任何模型。',
  'The content check blocked this description. Remove detected secrets, or try again if the check is unavailable. Nothing was sent.':
    '内容检查已拦截此描述。请移除检测到的密钥等敏感内容；若检查服务不可用，请重试。未发送任何内容。',
  'Refresh this project before changing a saved job.':
    '请先刷新此项目，再更改已保存的任务。',
  'Choose a saved clip in this project before deleting it.':
    '请先选择此项目中已保存的片段，再执行删除。',
  'Sealed media generation is unavailable. Turn off the sealed route explicitly to review a standard request.':
    '暂不支持密封媒体生成。请主动关闭密封路由，再审核标准请求。',
  'Reference uploads are not supported for live media. Remove the reference explicitly before requesting a quote.':
    '实时媒体生成不支持上传参考图。请主动移除参考图，再请求报价。',
  'Choose between one and three different connected video models.':
    '请选择 1 至 3 个不同的已连接视频模型。',
  'Choose a supported frame and a positive duration preference.':
    '请选择支持的画面比例，并将偏好时长设为正数。',
  'Choose a saved service project before requesting media.':
    '请先选择已保存的服务项目，再请求媒体生成。',
  'Keep the accepted terms while resolving this request.':
    '处理此请求时，请保留已接受的条款。',
  'Choose a currently reviewed variant.': '请选择当前已审核的规格。',
  'Submission was interrupted. Recover the original request before starting another.':
    '提交已中断。请先恢复原始请求，再发起新请求。',
  'Recover the original approvals before requesting new quotes.':
    '请先恢复原始授权，再请求新报价。',
  'The quote model changed. Refresh the reviewed routes.':
    '报价模型已改变。请刷新已审核的路由。',
  'The quote price changed. Refresh the reviewed routes before approving.':
    '报价已改变。请先刷新已审核的路由，再确认授权。',
  'Review every remaining model quote before approving.':
    '请先查看其余所有模型的报价，再确认授权。',
  'The original approval is missing. Read the saved jobs before continuing.':
    '原始授权缺失。请先查看已保存的任务，再继续。',
  'A quote expired. Refresh the remaining quotes before approving.':
    '某项报价已过期。请先刷新其余报价，再确认授权。',
  'The accepted result could not be matched to this approval.':
    '无法将已接受的结果与此授权匹配。',
  'Sign in again to access your Studio.': '请重新登录以访问工作室。',
  'The signed-in account changed. Refresh the Studio.':
    '登录账户已改变。请刷新工作室。',
  'Media generation is not configured. Existing saved work remains available.':
    '尚未配置媒体生成。已有的已保存作品仍可访问。',
  'Media generation needs configured asset storage.':
    '媒体生成需要先配置资源存储。',
  'This media route is unavailable or expired. Refresh the models.':
    '此媒体路由不可用或已过期。请刷新模型。',
  'This model requires a current terms and privacy review.':
    '此模型需要审核最新条款和隐私说明。',
  'Media storage is full. No new job was reserved.':
    '媒体存储已满。未为新任务预留额度。',
  'Finish or reconcile current jobs before starting more.':
    '请先完成当前任务或核对其结果，再启动更多任务。',
  'No safe lookup remains. Operator reconciliation is required; do not resubmit generation.':
    '已无安全查询方式。需要运营方核对结果；请勿重新提交生成请求。',
  'There is not enough available balance to reserve this request.':
    '可用余额不足，无法为此请求预留额度。',
  'This quote expired. Review a new quote before approving.':
    '此报价已过期。请先查看新报价，再确认授权。',
  'Remove or redact detected secrets before requesting a quote.':
    '请先移除或遮蔽检测到的密钥等敏感内容，再请求报价。',
  'This key has different saved terms. Read the saved status before continuing.':
    '此请求标识对应的已保存条款不同。请先查看已保存的状态，再继续。',
  'The approved amount does not match the quote.': '授权金额与报价不符。',
  'Too many requests. Wait a moment before continuing.':
    '请求过于频繁。请稍候再继续。',
  '{model} has no supported live media route. Change the selection before continuing.':
    '{model} 没有支持的实时媒体路由。请先更改所选模型，再继续。',
  'A selected model': '所选的某个模型',
  '{model} has no currently reviewed video route. Refresh the routes or change the model selection.':
    '{model} 当前没有已审核的视频路由。请刷新路由或更改所选模型。',
  '{model} has no reviewed {ratio} option. Change the frame explicitly before continuing.':
    '{model} 没有已审核的 {ratio} 选项。请主动更改画面比例后再继续。',
  '{model} requires a shorter description.': '{model} 需要更简短的描述。',
  '{duration}s · {ratio} · {quality}': '{duration} 秒 · {ratio} · {quality}',
  standard: '标准',
  'The media response could not be verified. Read the saved status or recover the approval with its original request key before starting another request.':
    '无法验证媒体响应。请先查看已保存的状态，或使用原始请求标识恢复授权，再发起新请求。',
  "The media response exceeded this view's limit. Read the saved status or recover the approval with its original request key before starting another request.":
    '媒体响应超出了此视图的大小限制。请先查看已保存的状态，或使用原始请求标识恢复授权，再发起新请求。',
  'The media request did not complete. Read the saved status or recover the approval with its original request key before starting another request.':
    '媒体请求未完成。请先查看已保存的状态，或使用原始请求标识恢复授权，再发起新请求。',
  'The media request timed out. Read the saved status or recover the approval with its original request key before starting another request.':
    '媒体请求已超时。请先查看已保存的状态，或使用原始请求标识恢复授权，再发起新请求。',
  'The media service could not be reached. Read the saved status or recover the approval with its original request key before starting another request.':
    '无法连接媒体服务。请先查看已保存的状态，或使用原始请求标识恢复授权，再发起新请求。',
  'The approval outcome is unknown. Read the saved status or recover the approval with its original request key before starting another request.':
    '授权结果未知。请先查看已保存的状态，或使用原始请求标识恢复授权，再发起新请求。',
} satisfies Dictionary;
