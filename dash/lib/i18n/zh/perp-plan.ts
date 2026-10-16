import type { Dictionary } from '../index.ts';
export default {
  'Before you trade': '交易之前',
  'Pre-trade estimate': '交易前估算',
  'Read-only estimate for a new position. Nothing to sign and no order is placed.':
    '新持仓的只读估算。无需签名，不会下单。',
  "An estimate from Hyperliquid's published formula. Fees, funding and price moves change it. Perps can lose your whole collateral fast. Nothing is placed or stored. Not investment advice.":
    '根据 Hyperliquid 公布的公式估算。手续费、资金费和价格变动都会改变结果。永续合约可能迅速损失全部抵押品。不会下单或存储数据。不构成投资建议。',
  'Choose a main-universe coin, long or short, positive USD notional, whole-number leverage within the coin limit, cross or isolated margin, and an optional valid Hyperliquid address.':
    '请选择主市场币种、做多或做空、正数 USD 名义金额、币种上限内的整数杠杆、全仓或逐仓模式；可选填有效的 Hyperliquid 地址。',
  'This estimate supports a new coin only. If this account already holds the coin, adding, reducing or reversing that position needs netting calculations.':
    '若账户已有该币种持仓，本估算不适用。本工具仅支持账户中尚未持有的币种；加仓、减仓或反向持仓需要计算净额。',
  'Snapshot checked {time}. Estimates use the current mark, not an execution price.':
    '快照检查时间：{time}。估算使用当前标记价格，并非成交价格。',
  'Estimated size · coin units': '估算数量 · 币种单位',
  'Chosen leverage and margin mode': '所选杠杆与保证金模式',
  'Initial margin · USD': '初始保证金 · USD',
  'New position maintenance margin · USD': '新持仓维持保证金 · USD',
  'Existing maintenance margin in estimate · USD':
    '估算中现有持仓维持保证金 · USD',
  'Collateral used in estimate · USD': '估算使用的抵押品 · USD',
  'Margin available after maintenance · USD':
    '扣除维持保证金后的可用保证金 · USD',
  'Estimated liquidation price · USD': '估算清算价格 · USD',
  'No positive liquidation level in this model': '该模型未得出正数清算价',
  'Funding over 7 days at the current rate': '按当前费率持有 7 天的资金费',
  'Account effective leverage · now': '账户实际杠杆 · 当前',
  'Account effective leverage · after this trade': '账户实际杠杆 · 此交易后',
  'Collateral does not exceed the estimated maintenance requirement. The estimated liquidation level is at or beyond the mark.':
    '抵押品未超过估算的维持保证金要求。估算清算价已达到或越过标记价格。',
  'A nonpositive model result does not remove liquidation risk or collateral loss.':
    '模型结果为零或负数，并不代表没有清算风险或抵押品损失。',
  'Funding projection = current hourly rate × 168 hours × USD notional, with the side applied. Rates and notional change; this is not a forecast.':
    '资金费估算 = 当前每小时费率 × 168 小时 × USD 名义金额，并按持仓方向计入正负号。费率和名义金额会变化；这不是预测。',
  'Maintenance = notional / (2 × maxLeverage). This simplified formula uses the main universe maximum, without position-size margin tiers, fees or slippage.':
    '维持保证金 = 名义金额 /（2 × maxLeverage）。此简化公式使用主市场最大杠杆，未考虑按持仓规模划分的保证金档位、手续费或滑点。',
  'Isolated estimate uses only this trade’s initial margin, without additional margin.':
    '逐仓估算仅使用此交易的初始保证金，不含追加保证金。',
  'Cross estimate uses reported account value minus maintenance on all reported existing positions and this trade. Other marks are held fixed. No extra collateral is assumed.':
    '全仓估算使用报告的账户价值，减去所有已报告现有持仓及本次交易的维持保证金。其他标记价格视为不变，假设不追加抵押品。',
  'Cross estimate assumes the account holds only this trade’s initial margin and has no existing positions.':
    '全仓估算假设账户仅有此交易的初始保证金，且没有现有持仓。',
  'Effective leverage after = (current total notional + new notional) / current account value. Account value is held fixed; zero or negative value is unavailable. Default perp account only; reads are not atomic.':
    '交易后实际杠杆 =（当前名义金额总额 + 新增名义金额）/ 当前账户价值。账户价值视为不变；为零或负数时不提供结果。仅覆盖默认永续合约账户；各次读取并非同一时刻的快照。',
  'Cool Head': '冷静一下',
  "You've closed {n} losing trades in a row. A pause might help.":
    '你已连续平掉 {n} 笔亏损交易。暂停一下或许有帮助。',
  'Consecutive losing closes in returned fills: {n}.':
    '返回成交记录中的连续亏损平仓数：{n}。',
  'Cool Head counts closing fills, including partial closes and reversals, newest first across coins. Opening and spot fills are skipped; a zero or positive close ends the streak. One 30-day response, {count} fills; older history may be missing. This reminder never blocks.':
    '冷静提醒按时间从新到旧，统计所有币种的平仓成交，包括部分平仓和反向持仓。跳过开仓和现货成交；平仓盈亏为零或正数时中断计数。仅使用一次 30 天历史响应，共 {count} 条成交；可能缺少较早记录。此提醒不会阻止操作。',
  'Fill response reached 2,000 records. Recent closes may be missing, so the streak may be incomplete.':
    '成交响应达到 2,000 条记录上限，可能缺少最近的平仓记录，连续亏损计数可能不完整。',
  'Source: Hyperliquid metaAndAssetCtxs and candleSnapshot; clearinghouseState and userFillsByTime when an address is supplied. USD amounts are approximate.':
    '来源：Hyperliquid metaAndAssetCtxs 和 candleSnapshot；提供地址时还使用 clearinghouseState 和 userFillsByTime。USD 金额为近似值。',
  'Sign in to estimate': '登录以估算',
  Coin: '币种',
  'Choose a coin': '选择币种',
  Side: '方向',
  'Size in USD notional': 'USD 名义金额',
  'Leverage · 1 to {max}×': '杠杆 · 1 至 {max} 倍',
  'Margin mode': '保证金模式',
  'Account address · optional': '账户地址 · 选填',
  '0x followed by 40 hex characters': '0x 后接 40 个十六进制字符',
  'Estimate this trade': '估算此交易',
  'Load main perp universe': '加载主永续合约市场',
  'The estimate could not be verified. Check your inputs, use a coin without an existing position in this account, or try again shortly.':
    '无法验证估算结果。请检查输入，选择此账户尚未持仓的币种，或稍后重试。',
  'Reading estimate inputs…': '正在读取估算数据…',
  'Cross margin: this estimate uses only this trade’s own margin. Your whole account backs a cross position, so the real liquidation price can be far from this one. Hyperliquid shows the exact price once the trade is open.':
    '全仓保证金：此估算仅使用本笔交易自身的保证金。全仓持仓由整个账户提供保证，因此实际强平价可能与此估算相差很大。开仓后，Hyperliquid 会显示准确的强平价。',
  'Too many fills in 30 days to count a recent streak reliably.': '30 天内成交记录过多，无法可靠统计近期连续亏损。',
  'Losing trades in a row, most recent first: {n}.': '从最近一笔起连续亏损的交易：{n} 笔。',
  'Cool Head counts closing orders newest first across coins; fills of one order count as one trade. Opening and spot fills are skipped, and a break-even or winning close ends the streak. One 30-day response, {count} fills; older history may be missing. This reminder never blocks.':
    'Cool Head 按时间从新到旧统计各币种的平仓订单；同一订单的多笔成交计为一笔交易。开仓和现货成交不计入，持平或盈利的平仓会结束连续计数。基于一次 30 天查询，共 {count} 笔成交；更早的记录可能缺失。此提醒不会阻止交易。',
} satisfies Dictionary;
