import { updateOn, type UpdateId } from './updates.ts';

export type FeatureTip = {
  title: string;
  text: string;
  href: string;
  update?: UpdateId;
};

const catalog: FeatureTip[] = [
  {
    title: 'Signed receipts',
    text: 'Wonder what a reply cost? Its signed receipt shows the routes, token count, and price.',
    href: '/dashboard/receipts',
  },
  {
    title: 'Paper Trail',
    text: 'Have a question about a PDF? Attach a text PDF in chat and ask for an answer with page citations.',
    href: '/dashboard/chat',
  },
  {
    title: 'Character cards',
    text: 'Bring a favorite character into chat. Import a character card, then start a conversation with it.',
    href: '/dashboard/characters',
  },
  {
    title: 'Frontend presets',
    text: 'Already use SillyTavern or Open WebUI? Grab the settings to connect it to Anonymo.',
    href: '/presets',
  },
  {
    title: 'Refusal Catch',
    text: 'If a provider refuses an eligible request, Refusal Catch can try another route. The refused attempt costs zero.',
    href: '/docs#chat',
  },
  {
    title: 'Refusal leaderboard',
    text: 'See how often each route refused eligible requests over the last 30 days.',
    href: '/leaderboard',
  },
  {
    title: 'Chat exports',
    text: 'Want a copy of a conversation you kept on this device? Open Chats and export it as Markdown or JSON.',
    href: '/dashboard/chat',
    update: 'history',
  },
  {
    title: 'Catch me up',
    text: 'When a thread gets long, use Catch me up to start a fresh chat with a recap.',
    href: '/dashboard/chat',
    update: 'catchup',
  },
  {
    title: 'Spending limits',
    text: 'Give your key a budget. Set a daily, monthly, or lifetime spending limit in Usage & limits.',
    href: '/dashboard/usage',
    update: 'usage',
  },
];

export const availableFeatureTips = (demo: boolean) =>
  catalog.filter((tip) => !tip.update || updateOn(tip.update, demo));
