# Translating the site (English → Simplified Chinese)

English stays in the source code. Each user-facing English string is wrapped
where it is shown, and its Simplified Chinese lives in a dictionary under
`lib/i18n/zh/`, keyed by the exact English text. English is the default; the
EN / 中文 switch in each page's top bar turns Chinese on.

## The API (`lib/i18n/index.ts`)

```tsx
import { useT } from '@/lib/i18n';            // in .tsx files under components/ or app/

function Example({ count, name }: { count: number; name: string }) {
  const t = useT();                           // a hook: call it at the top of the component
  return (
    <section aria-label={t('Model picker')}>
      <h2>{t('Compare up to four answers')}</h2>
      <p>{t('{count} models answered', { count })}</p>
      <p>{t.rich('Signed in as {name}.', { name: <strong>{name}</strong> })}</p>
      <input placeholder={t('Ask anything…')} />
    </section>
  );
}
```

- `t(text, vars?)` returns the Chinese for `text` when 中文 is on, else `text`
  unchanged. `{name}` placeholders are filled from `vars` in both languages.
- `t.rich(text, nodes)` is the same, but each `{name}` becomes a React node.
  Use it when a sentence contains markup (`<strong>`, `<a>`, `<code>`, an
  icon), so the Chinese can put that markup where Chinese word order needs it.
- `t.locale` is `'en'` or `'zh'`.
- `translate(text, vars?)` is the non-hook form, for event handlers, callbacks
  and plain functions that run in the browser. It reads the current choice at
  call time. Do not call it at module top level (that runs once, in English).
- `useLocale()` returns just the locale.
- If a file already uses a variable named `t` (for example `turns.map((t) => …)`),
  name the translator `tr` there instead of shadowing it.

## What to translate

Every piece of English a visitor can see or hear on the page:
JSX text, headings, buttons, labels, menu items, empty states, notices,
errors, toasts, tooltips, confirmation dialogs, and these attributes:
`aria-label`, `aria-description`, `title`, `placeholder`, `alt`, `label`.
Also English that is drawn on a canvas or animated letter by letter: pass the
translated string into the drawing or animation code.

Data arrays and constants declared at module level (FAQ lists, topic lists,
menu definitions) stay in English. Wrap the value at the place it renders:
`{t(item.title)}`. Do not move constants into components just to translate them.

Plurals: English often builds them by hand. Use one key per form:
`count === 1 ? t('{count} model', { count }) : t('{count} models', { count })`.
Both map to the same Chinese (`'{count} 个模型'`).

Strings built from pieces (`'Ask ' + name + ' again'`, template literals) become
one key with placeholders (`t('Ask {name} again', { name })`), so the whole
sentence can be reordered in Chinese.

## What not to translate or change

- Brand, product and model names: Conclave, Claude, GPT, Gemini, Grok, DeepSeek,
  Qwen, Llama, Solana, USDC, SOL, Phantom, Solflare, Backpack,
  MetaMask, Trust, OKX, Sanctum, the CA/token address.
- Anything the user typed or a model wrote (prompts, answers, project names the
  user chose), wallet addresses, signatures, hashes, transaction ids, amounts,
  code, URLs, file names, keyboard keys, error codes such as `SIGN_IN_REQUIRED`.
- String values the code compares, stores, sends to the server or uses as keys,
  ids, CSS classes, `data-*` values, routes or local-storage values. Only wrap
  the copy at the moment it is displayed. When unsure, leave logic alone.
- The exact text a wallet is asked to sign. It is verified on the server.
- Do not add imports to these files, because Node tests load them directly:
  `components/dashboard/data.ts`, `components/dashboard/canvas-state.ts`,
  `components/dashboard/use-live-workspace.ts`,
  `components/dashboard/wallet-options.ts`, and anything under `lib/` or
  `server/`. Translate the strings they produce at the component that shows
  them, for example `{t(model.description)}` or `{t(error.message)}`, and add
  those English strings to your dictionary.
- Never write the words localStorage, sessionStorage or indexedDB into
  `components/dashboard/live-deposit-payment.tsx`; a test forbids them there.

## Dictionary files

Each area has one file in `lib/i18n/zh/`. Add entries only to your own area's
file. Keys are the exact English text passed to `t()` (same punctuation,
spacing, capitalisation and placeholders); values are the Chinese with the
same placeholders. Sort is not required; keep related strings together.

```ts
export default {
  'Compare up to four answers': '最多并排比较四个回答',
  '{count} models answered': '{count} 个模型已回答',
  'Signed in as {name}.': '已登录为 {name}。',
} satisfies Dictionary;
```

Every string you wrap must have an entry, and every entry must match a string
that is actually wrapped.

## Chinese style

- Simplified Chinese (zh-CN), natural product-UI register: concise, clear,
  confident, never machine-literal. Marketing copy may be adapted for rhythm and
  meaning rather than translated word for word; keep the meaning and the claims
  exactly as strong or as hedged as the English (planned stays 计划中, never
  implied as available).
- Full-width Chinese punctuation inside Chinese sentences (，。：；！？“”（）),
  with `…` kept as `…`. A half-width space between Chinese and Latin words or
  numbers: `支持 7 个模型`, `使用 Solana 钱包登录`.
- All-caps English labels (eyebrows, mono tags like `THE COUNCIL ROOM`) become
  short Chinese labels; keep brand words inside them in capitals.
- Keep length close to the English where layout is tight (buttons, tabs, chips).

### Glossary (use these consistently)

| English | Chinese |
| --- | --- |
| model / models | 模型 |
| workspace | 工作区 |
| Chat (the product page) / conversation | 对话 |
| project / projects | 项目 |
| room / council room | 议事厅 |
| perspective | 视角 |
| answer / response | 回答 |
| compare / comparison | 比较 / 对比 |
| follow-up / Ask a follow-up | 追问 / 继续追问 |
| prompt (the user's question) | 提问 |
| Auto (routing) | 自动 |
| route / Route Card | 路由 / 路由卡 |
| provider / inference provider | 提供方 / 推理服务提供方 |
| guard / guards | 防护 |
| privacy / retention | 隐私 / 数据保留 |
| Strict mode | 严格模式 |
| sign in / sign out | 登录 / 退出登录 |
| account | 账户 |
| wallet | 钱包 |
| passkey | 通行密钥 |
| credits / balance | 额度 / 余额 |
| quote | 报价 |
| platform fee | 平台费 |
| settle / settlement | 结算 |
| deposit | 充值 |
| receipt / usage record | 收据 / 使用记录 |
| Purse | 额度账户 |
| Cross-Check | 交叉核查 |
| Brief / Briefs | 简报 |
| Synthesis | 综合 |
| Explainer | 交易解读 |
| Chapters | 章节 |
| Studio | 工作室 |
| Agents | 智能体 |
| Connections | 连接 |
| Library | 资料库 |
| Decisions | 决策 |
| Canvas | 画布 |
| Settings / Help | 设置 / 帮助 |
| Field guide | 使用指南 |
| transaction | 交易 |
| sign (a transaction or message) | 签名 |
| request key / approval key (a request identifier, not a secret) | 请求标识 / 批准标识 |
| delegate (a token or account delegate, who receives authority) | 受托方 |
| secret-like text | 疑似敏感凭据的文本 |
| planned / not yet available | 计划中 / 尚未开放 |
| preview / sample data | 预览 / 示例数据 |

## Checking your work

- `npx tsc --noEmit` must report no errors in the files you changed (other
  areas may be mid-edit at the same time; ignore errors outside your files).
- `npx oxlint <your files>` must stay clean.
- Search your files once more for unwrapped English that a visitor can see.
