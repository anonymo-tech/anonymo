import type { Dictionary } from '../index.ts';

export default {
  'Stock tokens': '股票代币',
  'Paste a Solana mint or token link…': '粘贴 Solana 铸币地址或代币链接…',
  'Check stock token': '检查股票代币',
  'Inspect a mint’s on-chain controls. Names and symbols are supplied by the token and can be copied.':
    '查看铸币账户的链上控制权限。名称和代码由代币自行声明，可能被仿冒。',
  'Reading finalized Solana mint state…':
    '正在读取 Solana 已最终确认的铸币状态…',
  'Paste a Solana token mint into the composer to begin.':
    '在输入框中粘贴 Solana 代币铸币地址以开始。',
  'Name and symbol as stated by the token': '代币自行声明的名称和代码',
  'Name unavailable': '名称不可用',
  'Copy mint address': '复制铸币地址',
  'Copied.': '已复制。',
  'Copy is unavailable in this browser.': '此浏览器无法复制。',
  'View mint on Solana Explorer': '在 Solana Explorer 查看铸币账户',
  'Issuer-controlled': '由发行方控制',
  'Controller powers found': '发现控制权限',
  'Common for issuer-backed stock tokens. It means the issuer can freeze yours or take them.':
    '这在发行方支持的股票代币中很常见，意味着发行方可以冻结或转走您持有的代币。',
  "This token's controller can freeze or move holders' tokens.":
    '此代币的控制方可以冻结或转移持有者的代币。',
  'No pause, permanent delegate, freeze authority or transfer hook found.':
    '未发现暂停、永久受托方、冻结权限或转账钩子。',
  'Issuer: {issuer} · Programme: {programme}':
    '发行方：{issuer} · 产品计划：{programme}',
  'Who it is not for: {restriction}': '不适用人群：{restriction}',
  'Issuer terms': '发行方条款',
  'No verified issuer authority match. This check does not establish that this is a stock token.':
    '未匹配到已核实的发行方权限地址。此检查无法确认它是股票代币。',
  'Mint powers and supply': '铸币权限和供应量',
  'None found': '未发现',
  Pause: '暂停',
  'Paused at this snapshot': '此快照中已暂停',
  'Not paused at this snapshot': '此快照中未暂停',
  Authority: '权限地址',
  'Permanent delegate': '永久受托方',
  'Transfer hook': '转账钩子',
  Program: '程序',
  'Freeze authority': '冻结权限',
  'Mint authority': '铸币权限',
  Multiplier: '乘数',
  '1 token = {multiplier} shares': '1 枚代币 = {multiplier} 股',
  'Token UI multiplier only; share backing is not verified.':
    '这仅为代币显示乘数；未核实对应股份的支持情况。',
  'Pending: {multiplier}, effective {time}':
    '待生效乘数：{multiplier}，生效时间：{time}',
  'Unix seconds: {timestamp}': 'Unix 秒数：{timestamp}',
  'No scaled UI multiplier found; share conversion is unknown.':
    '未发现缩放显示乘数；股份换算关系未知。',
  Decimals: '小数位数',
  'Supply (raw base units)': '供应量（原始最小单位）',
  'Metadata update authority': '元数据更新权限',
  'Metadata URI (not fetched)': '元数据 URI（未读取）',
  'Extensions listed by name only; their behavior is not checked: {extensions}':
    '以下扩展仅列出名称，未检查其行为：{extensions}',
  'Source: configured Solana mainnet RPC, finalized slot {slot}. Retrieved {time}.':
    '来源：已配置的 Solana 主网 RPC，已最终确认的槽位 {slot}。读取时间：{time}。',
  'This is a snapshot. RPC parser coverage may vary; hook code, future authority actions, backing and issuer eligibility are not verified.':
    '这是一份状态快照。RPC 解析器的覆盖范围可能不同；未核实钩子代码、未来权限操作、资产支持或发行方准入条件。',
  "Stock tokens are issuer products: no shareholder rights, and dividends follow the issuer's method. Who may hold it is set by the issuer's terms.":
    '股票代币是发行方提供的产品：不赋予股东权利，股息按发行方的方式处理。持有资格由发行方条款规定。',
  "Liquidity and value aren't checked here.": '此处不检查流动性和价值。',
  'Not investment advice.': '不构成投资建议。',
  'Paste a Solana mint or a supported Solscan, Solana Explorer or Jupiter token link.':
    '请粘贴 Solana 铸币地址或支持的 Solscan、Solana Explorer、Jupiter 代币链接。',
  'The RPC did not return a supported initialized mint with valid parsed fields.':
    'RPC 未返回受支持且已初始化、解析字段有效的铸币账户。',
  'Stock-token RPC is not configured for Solana mainnet.':
    '尚未为股票代币配置 Solana 主网 RPC。',
  'Stock-token mint data is unavailable, malformed or unsupported. Try again shortly.':
    '股票代币铸币数据不可用、格式有误或不受支持。请稍后重试。',
  'Too many requests. Try again shortly.': '请求过多。请稍后重试。',
  'Sign in to use this tool.': '登录后即可使用此工具。',
  'Sign in to run this check.': '登录后即可运行此检查。',
  'You’ve reached the request limit. Try again shortly.':
    '已达到请求次数上限。请稍后重试。',
  'Check the address or request format and try again.':
    '请检查地址或请求格式后重试。',
  'The service could not finish this request. Its outcome may be unknown. Refresh saved status before starting another check.':
    '服务未能完成此请求，结果可能未知。再次检查前请刷新已保存的状态。',
  'The request could not be completed. Please try again.':
    '无法完成请求。请重试。',
  'The request could not be completed. Try again.': '无法完成请求。请重试。',
  'The service response could not be verified.': '无法验证服务返回的数据。',
  'The service returned an unreadable response.': '服务返回的数据无法读取。',
  'The response was empty.': '返回的数据为空。',
  'The response was too large.': '返回的数据过大。',
  'The check could not reach the service. Its outcome may be unknown. Refresh saved status before trying again.':
    '检查无法连接服务，结果可能未知。重试前请刷新已保存的状态。',
  'This request timed out. Its outcome may be unknown. Refresh saved status before trying again.':
    '请求超时，结果可能未知。重试前请刷新已保存的状态。',
  'This record is no longer available.': '此记录已不可用。',
  'This request changed or expired. Review it again.':
    '此请求已变更或过期。请重新查看。',
  'Your usage balance is too low for this check.':
    '您的使用余额不足，无法运行此检查。',
  "This mint's authorities match the issuer's keys. Confirm the mint on the issuer's own list before relying on it.":
    '此铸币地址的权限与发行方的密钥一致。依赖它之前，请在发行方自己的列表中确认该铸币地址。',
  'US persons and UK clients; other restricted countries apply':
    '美国人士和英国客户；其他受限国家/地区同样适用',
  'the United States and US persons; other jurisdiction-based restrictions apply':
    '美国及美国人士；其他司法辖区限制同样适用',
  'Common for issuer-backed stock tokens. It means the issuer can freeze or pause yours.':
    '这在发行方支持的股票代币中很常见。这意味着发行方可以冻结或暂停你持有的代币。',
  "This token's controller can move holders' tokens.": '此代币的控制方可以转移持有人的代币。',
  "This token's controller can freeze holders' tokens.": '此代币的控制方可以冻结持有人的代币。',
  "This token's controller can change how transfers work.": '此代币的控制方可以更改转账规则。',
} satisfies Dictionary;
