import type { Dictionary } from '../index.ts';

export default {
  'Perp Check': '永续合约检查',
  Unavailable: '暂不可用',
  'None reported': '未报告',
  'Paid {amount}': '支付 {amount}',
  'Received {amount}': '收到 {amount}',
  'No net payment': '净支付为零',
  Long: '多头',
  Short: '空头',
  Size: '持仓数量',
  'Position notional · USD': '持仓名义价值 · USD',
  'Entry price · USD': '开仓价格 · USD',
  'Mark price · USD': '标记价格 · USD',
  'Liquidation price · Hyperliquid': '强平价格 · Hyperliquid',
  'Move from mark to liquidation': '从标记价到强平价的变动幅度',
  '{percent}%': '{percent}%',
  'Liquidation distance in daily σ': '距强平价的每日 σ 倍数',
  '{value} σ': '{value} σ',
  'Daily σ · log returns': '每日 σ · 对数收益率',
  'The σ multiple divides the absolute percentage distance by daily log-return σ; this comparison is approximate. Zero or insufficient σ is shown as unavailable.':
    'σ 倍数为价格距离百分比的绝对值除以每日对数收益率 σ，此比较为近似值。σ 为零或数据不足时显示为暂不可用。',
  'The reported mark is at or beyond the reported liquidation level. These reads are not atomic; recheck Hyperliquid.':
    '报告的标记价已达到或越过报告的强平价。各次读取并非同一时刻的快照，请到 Hyperliquid 复核。',
  'Price moved this far within a day on {n} of the last 30 days.':
    '过去 30 天中，有 {n} 天的日内价格波动达到这一幅度。',
  'Price moved this far within a day on {n} of {days} available days in the last 30 days.':
    '过去 30 天中有数据的 {days} 天里，有 {n} 天的日内价格波动达到这一幅度。',
  'Last 30 completed UTC days: {days} candles, {returns} consecutive daily log returns. Sample σ uses close-to-close returns; the day count uses (high − low) / open.':
    '最近 30 个完整 UTC 日：{days} 根日 K 线，{returns} 个连续日对数收益率。样本 σ 根据收盘价之间的收益率计算；天数统计使用（最高价 − 最低价）/ 开盘价。',
  'Candle call limit reached: only the first 10 open positions get candles.':
    '已达到 K 线请求上限：仅获取前 10 个未平仓持仓的 K 线。',
  'Daily candle evidence is unavailable for this position.':
    '此持仓的日 K 线数据暂不可用。',
  'Overnight and weekend gaps can be larger than σ suggests.':
    '隔夜和周末跳空可能大于 σ 所反映的幅度。',
  'Funding · USD cash flow': '资金费 · USD 现金流',
  'Last 7 days': '过去 7 天',
  'Last 30 days': '过去 30 天',
  'Current hourly funding rate': '当前每小时资金费率',
  'Projected funding over 7 more days': '按当前费率推算再持有 7 天的资金费',
  'Projection = hourly rate × 24 × 7 × reported position notional, with the position side applied. Rates and notional change; this is not a forecast.':
    '推算值 = 每小时费率 × 24 × 7 × 报告的持仓名义价值，并按持仓方向确定正负。费率和名义价值会变化，此数值不是预测。',
  'P&L after fees and funding · mixed windows':
    '扣除手续费和资金费后的盈亏 · 不同时间范围',
  'Unrealized P&L · current': '未实现盈亏 · 当前',
  'Realized closed P&L · last 30 days': '平仓已实现盈亏 · 过去 30 天',
  'Fill fees · last 30 days': '成交手续费 · 过去 30 天',
  'Funding cash flow · since open': '资金费现金流 · 自开仓以来',
  'Combined P&L · included items only': '合计盈亏 · 仅含所列项目',
  'Position leverage setting': '持仓杠杆设置',
  '{value}× · {mode}': '{value}× · {mode}',
  '{value}×': '{value}×',
  Cross: '全仓',
  Isolated: '逐仓',
  'Combined = current unrealized P&L + last-30-day fill closedPnl − those fill fees − Hyperliquid cumFunding.sinceOpen. Funding since open can extend beyond 30 days; this is not a complete account return.':
    '合计 = 当前未实现盈亏 + 过去 30 天成交的 closedPnl − 这些成交的手续费 − Hyperliquid 的 cumFunding.sinceOpen。自开仓以来的资金费可能覆盖超过 30 天；这不是完整的账户回报。',
  'Source: Hyperliquid clearinghouseState, metaAndAssetCtxs, userFunding, userFillsByTime and candleSnapshot. Prices and P&L are approximate USD values; payments use reported USDC amounts.':
    '来源：Hyperliquid 的 clearinghouseState、metaAndAssetCtxs、userFunding、userFillsByTime 和 candleSnapshot。价格和盈亏为近似 USD 数值；支付金额采用报告的 USDC 数额。',
  'Perps can lose your whole collateral fast. Liquidation prices come from Hyperliquid and move with funding, fees and margin changes. σ is historical and gaps can be larger. Nothing here is stored. Not investment advice.':
    '永续合约可能迅速损失全部抵押资金。强平价格来自 Hyperliquid，会随资金费、手续费和保证金变化而变动。σ 基于历史数据，跳空幅度可能更大。此处不存储任何数据。不构成投资建议。',
  'Enter a Hyperliquid address: 0x followed by 40 hex characters.':
    '请输入 Hyperliquid 地址：0x 后接 40 个十六进制字符。',
  'Paste a Hyperliquid account address…': '粘贴 Hyperliquid 账户地址…',
  'Check perps': '检查永续合约',
  'Paste a public Hyperliquid account address in the composer. Read-only research. No signature or API key needed.':
    '在输入框中粘贴公开的 Hyperliquid 账户地址。仅供只读研究，无需签名或 API 密钥。',
  'Perp Check could not verify the data. Check your sign-in and address, then try again shortly.':
    '永续合约检查未能验证数据。请确认登录状态和地址，稍后重试。',
  'Reading Hyperliquid account data…': '正在读取 Hyperliquid 账户数据…',
  'Account summary': '账户概览',
  'Source: Hyperliquid /info': '来源：Hyperliquid /info',
  'Copy address': '复制地址',
  'Copied.': '已复制。',
  'Copy is unavailable in this browser.': '此浏览器无法复制。',
  'Checked {time}. History window: {start} to {end}.':
    '检查时间：{time}。历史数据范围：{start} 至 {end}。',
  'Account value · USD': '账户价值 · USD',
  'Withdrawable · USD': '可提取金额 · USD',
  'Total position notional · USD': '持仓名义价值总额 · USD',
  'Account effective leverage': '账户实际杠杆',
  'Funding cash flow · last 30 days': '资金费现金流 · 过去 30 天',
  'Effective leverage = marginSummary.totalNtlPos / marginSummary.accountValue. Unavailable when account value is zero or negative. This is a current snapshot, not a historical median.':
    '实际杠杆 = marginSummary.totalNtlPos / marginSummary.accountValue。账户价值为零或负数时不提供此值。这是当前快照，并非历史中位数。',
  'Default perp account scope only. Separate builder DEX accounts, spot balances and other subaccounts are not enumerated. Reads are not atomic; missing market context is shown as unavailable.':
    '仅覆盖默认永续合约账户。未枚举独立的构建者 DEX 账户、现货余额及其他子账户。各次读取并非同一时刻的快照；缺少的市场数据会显示为暂不可用。',
  'One response per history request; no pagination. {fills} fills and {payments} funding records returned. The 30-day history may be incomplete. Positive funding cash flow is received; negative is paid.':
    '每项历史请求仅读取一次响应，不翻页。返回 {fills} 条成交和 {payments} 条资金费记录。30 天历史可能不完整。资金费现金流为正表示收到，为负表示支付。',
  'Fill response reached 2,000 records. The 30-day fill totals are capped and may omit later activity.':
    '成交响应达到 2,000 条记录上限。30 天成交合计受此限制，可能遗漏较晚的活动。',
  'Funding response contains at least 500 records and may be capped. Funding totals may be incomplete.':
    '资金费响应至少包含 500 条记录，可能受到条数限制。资金费合计可能不完整。',
  'No open perp positions.': '没有未平仓的永续合约持仓。',
  'Spot fills are excluded from P&L totals. Unsupported fee currencies on perp fills make the check unavailable.':
    '盈亏合计不含现货成交。若永续合约成交的手续费使用不支持的币种，本次检查将无法完成。',
} satisfies Dictionary;
