const failureReasons = {
  'The program reported insufficient funds for the instruction.':
    '程序报告执行该指令的资金不足。',
  'The network reported insufficient funds to pay the transaction fee.':
    '网络报告支付交易手续费的资金不足。',
  'The network reported insufficient funds for an account’s rent requirement.':
    '网络报告资金不足，无法满足账户的租金要求。',
  'The network could not find a required account.': '网络未找到所需的账户。',
  'The network could not find a required program account.':
    '网络未找到所需的程序账户。',
  'The network reported that an account was already in use.':
    '网络报告某个账户正在使用中。',
  'The program reported that an account was already in use.':
    '程序报告某个账户已被使用。',
  'The program reported that an account was already initialized.':
    '程序报告某个账户已初始化。',
  'The instruction exceeded its compute budget.': '该指令超出了计算预算。',
  'The program did not complete execution.': '程序未完成执行。',
  'The network could not compile the program.': '网络无法编译该程序。',
  'The program reported invalid account data.': '程序报告账户数据无效。',
  'The program reported invalid instruction data.': '程序报告指令数据无效。',
  'The program reported an invalid argument.': '程序报告参数无效。',
  'The instruction referenced an incorrect program ID.':
    '该指令引用了错误的程序 ID。',
  'The program reported a missing required signature.':
    '程序报告缺少必需的签名。',
  'The program reported an account that was not initialized.':
    '程序报告某个账户尚未初始化。',
  'The instruction did not supply enough account keys.':
    '该指令提供的账户公钥不足。',
  'The program reported invalid address seeds.': '程序报告地址种子无效。',
  'An address seed exceeded the permitted length.':
    '某个地址种子超出了允许的长度。',
  'The program reported an invalid account resize.':
    '程序报告账户大小调整无效。',
  'The program reported arithmetic overflow.': '程序报告算术溢出。',
  'The program reported an invalid account owner.': '程序报告账户所有者无效。',
  'The program attempted to change read-only account data.':
    '程序尝试更改只读账户数据。',
  'The program attempted to change a read-only account’s lamports.':
    '程序尝试更改只读账户的 lamports。',
  'An invoked instruction requested privileges it was not granted.':
    '被调用的指令请求了未获授予的权限。',
  'The instruction exceeded the permitted program call depth.':
    '该指令超出了允许的程序调用深度。',
  'The network did not find the transaction’s recent blockhash.':
    '网络未找到该交易的近期区块哈希。',
  'The network reported that this transaction was already processed.':
    '网络报告该交易已处理。',
  'The network could not verify a transaction signature.':
    '网络无法验证交易签名。',
  'The network reported a program that cannot be executed.':
    '网络报告某个程序无法执行。',
  'The transaction included a duplicate instruction that is not permitted.':
    '交易包含不允许重复的指令。',
  'The transaction requested an invalid loaded account data size limit.':
    '交易请求的已加载账户数据大小上限无效。',
  'The transaction exceeded its loaded account data size limit.':
    '交易超出了已加载账户数据大小上限。',
  'The program reported that an account does not meet the rent-exempt minimum.':
    '程序报告某个账户未达到免租最低余额。',
  'The program reported an invalid token mint.': '程序报告代币铸币账户无效。',
  'The program reported that the token mints do not match.':
    '程序报告代币铸币账户不匹配。',
  'The program reported that the account owner does not match.':
    '程序报告账户所有者不匹配。',
  'The program reported that this mint has no minting authority.':
    '程序报告该铸币账户没有铸币权限。',
  'The program reported an invalid number of provided signers.':
    '程序报告提供的签名者数量无效。',
  'The program reported an invalid number of required signers.':
    '程序报告所需的签名者数量无效。',
  'The program reported uninitialized token state.':
    '程序报告代币状态尚未初始化。',
  'The program reported that this operation does not support native SOL accounts.':
    '程序报告该操作不支持原生 SOL 账户。',
  'The program reported that a non-native token account still has a balance.':
    '程序报告非原生代币账户仍有余额。',
  'The program reported an unsupported token instruction.':
    '程序报告代币指令不受支持。',
  'The program reported invalid token account state.':
    '程序报告代币账户状态无效。',
  'The program reported an unsupported authority type.':
    '程序报告权限类型不受支持。',
  'The program reported that this mint cannot freeze accounts.':
    '程序报告该铸币账户无法冻结账户。',
  'The program reported that the token account is frozen.':
    '程序报告代币账户已冻结。',
  'The program reported that the token decimals do not match the mint.':
    '程序报告代币小数位数与铸币账户不匹配。',
  'The program reported that this operation requires a native SOL account.':
    '程序报告该操作需要原生 SOL 账户。',
  'The System program reported insufficient lamports for the operation.':
    'System 程序报告执行该操作的 lamports 不足。',
  'The System program reported an invalid program ID.':
    'System 程序报告程序 ID 无效。',
  'The System program reported an invalid account data length.':
    'System 程序报告账户数据长度无效。',
  'The System program reported that the derived address does not match.':
    'System 程序报告派生地址不匹配。',
  'The System program reported no recent blockhashes for the nonce.':
    'System 程序报告该 nonce 没有可用的近期区块哈希。',
  'The System program reported that the nonce blockhash has not expired.':
    'System 程序报告 nonce 区块哈希尚未过期。',
  'The System program reported an unexpected nonce blockhash.':
    'System 程序报告 nonce 区块哈希与预期不符。',
  'The associated token account program reported an invalid owner.':
    '关联代币账户程序报告所有者无效。',
  'The program reported a missing instruction discriminator.':
    '程序报告缺少指令判别符。',
  'The program reported an unrecognized instruction.':
    '程序报告无法识别该指令。',
  'The program could not deserialize the instruction.':
    '程序无法反序列化该指令。',
  'The program could not serialize the instruction.': '程序无法序列化该指令。',
  'The program reported a failed constraint for account mutability.':
    '程序报告账户可变性约束未通过。',
  'The program reported a failed constraint for an account relationship.':
    '程序报告账户关联关系约束未通过。',
  'The program reported a failed constraint for a required signer.':
    '程序报告必需的签名者约束未通过。',
  'The program reported a failed constraint for a custom account condition.':
    '程序报告自定义账户条件约束未通过。',
  'The program reported a failed constraint for account ownership.':
    '程序报告账户所有权约束未通过。',
  'The program reported a failed constraint for rent exemption.':
    '程序报告免租要求约束未通过。',
  'The program reported a failed constraint for address seeds.':
    '程序报告地址种子约束未通过。',
  'The program reported a failed constraint for an executable account.':
    '程序报告可执行账户约束未通过。',
  'The program reported a failed constraint for account state.':
    '程序报告账户状态约束未通过。',
  'The program reported a failed constraint for an associated account.':
    '程序报告关联账户约束未通过。',
  'The program reported a failed constraint for associated account initialization.':
    '程序报告关联账户初始化约束未通过。',
  'The program reported a failed constraint for account closure.':
    '程序报告账户关闭约束未通过。',
  'The program reported a failed constraint for an account address.':
    '程序报告账户地址约束未通过。',
  'The program reported a failed constraint for a zeroed account discriminator.':
    '程序报告清零的账户判别符约束未通过。',
  'The program reported a failed constraint for a token mint.':
    '程序报告代币铸币账户约束未通过。',
  'The program reported a failed constraint for a token account owner.':
    '程序报告代币账户所有者约束未通过。',
  'The program reported a failed constraint for a mint authority.':
    '程序报告铸币权限约束未通过。',
  'The program reported a failed constraint for a freeze authority.':
    '程序报告冻结权限约束未通过。',
  'The program reported a failed constraint for mint decimals.':
    '程序报告铸币账户小数位数约束未通过。',
  'The program reported a failed constraint for account space.':
    '程序报告账户空间约束未通过。',
  'The program reported a failed constraint for a required optional account.':
    '程序报告必需的可选账户约束未通过。',
  'The program reported that an account discriminator was already set.':
    '程序报告账户判别符已设置。',
  'The program reported that an account discriminator is missing.':
    '程序报告缺少账户判别符。',
  'The program reported that an account discriminator does not match.':
    '程序报告账户判别符不匹配。',
  'The program reported that account data could not be deserialized.':
    '程序报告无法反序列化账户数据。',
  'The program reported that account data could not be serialized.':
    '程序报告无法序列化账户数据。',
  'The program reported that not enough account keys were supplied.':
    '程序报告提供的账户公钥不足。',
  'The program reported that an account was not marked writable.':
    '程序报告某个账户未标记为可写。',
  'The program reported that an account is owned by a different program.':
    '程序报告某个账户属于其他程序。',
  'The program reported that a program ID does not match.':
    '程序报告程序 ID 不匹配。',
  'The program reported that a program account is not executable.':
    '程序报告程序账户不可执行。',
  'The program reported that an account did not sign.':
    '程序报告某个账户未签名。',
  'The program reported that an account is not owned by the System program.':
    '程序报告某个账户不属于 System 程序。',
  'The program reported that an account is not initialized.':
    '程序报告某个账户尚未初始化。',
  'The program reported that an account is not a program-data account.':
    '程序报告某个账户不是程序数据账户。',
  'The program reported that an account is not the expected associated token account.':
    '程序报告某个账户不是预期的关联代币账户。',
  'The program reported that a sysvar account does not match.':
    '程序报告系统变量账户不匹配。',
  'The program reported that an account resize exceeds the permitted limit.':
    '程序报告账户大小调整超出了允许的上限。',
  'The program reported that an account was resized more than once in the instruction.':
    '程序报告某个账户在该指令中被多次调整大小。',
  'The program reported that its declared program ID does not match.':
    '程序报告其声明的程序 ID 不匹配。',
  'The program reported a deprecated operation.': '程序报告该操作已弃用。',
  'The program reported an empty swap route.': '程序报告兑换路由为空。',
  'The program reported that the swap exceeded its slippage tolerance.':
    '程序报告兑换超出了滑点容忍度。',
  'The program reported an incorrect token program ID.':
    '程序报告代币程序 ID 错误。',
  'The program reported that the exact output amount was not matched.':
    '程序报告未达到指定的精确输出数量。',
  'Why it failed': '失败原因',
  'Custom program error {code} ({hex})': '自定义程序错误 {code}（{hex}）',
  'The RPC reported an error without a recognized reason.':
    'RPC 报告了错误，但尚无法识别具体原因。',
  'The RPC did not provide a structured failure reason.':
    'RPC 未提供结构化的失败原因。',
  'Instruction #{n} · {program} · {error}': '指令 #{n} · {program} · {error}',
  'Transaction · {error}': '交易 · {error}',
  'Program unavailable': '程序不可用',
  'The instruction number is zero-based. The program shown is the outer instruction’s program; an invoked program may have returned the error.':
    '指令编号从 0 开始。此处显示的是外层指令的程序；错误可能由被调用的程序返回。',
  'Associated Token Account': '关联代币账户',
  'System program': 'System 程序',
  'Compute Budget': '计算预算',
  'SPL Token': 'SPL Token',
  'Token-2022': 'Token-2022',
  'Jupiter Aggregator v6': 'Jupiter Aggregator v6',
};

export default failureReasons;
