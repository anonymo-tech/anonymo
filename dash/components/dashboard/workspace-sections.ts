// The workspace's map: the few tools in the sidebar, the folded extras, and the two grouped areas (Account and
// Settings) whose pages share a tab row. Every page keeps its own address; this file only decides where it is listed.
import {
  Archive,
  AudioLines,
  BarChart3,
  BookOpen,
  Columns3,
  Coins,
  Compass,
  Code2,
  Dices,
  Drama,
  Hammer,
  Headphones,
  HeartHandshake,
  IdCard,
  ImageIcon,
  Images,
  KeyRound,
  Link2,
  ListTree,
  MessageSquare,
  PackageOpen,
  Phone,
  Plug,
  ReceiptText,
  FileSearch,
  Rocket,
  Settings,
  ShieldCheck,
  Ticket,
  Trophy,
  Video,
  Vote,
  Wallet,
} from 'lucide-react';
import { updateOn, type UpdateId } from '@/lib/anonymo/updates';

export type Destination = {
  href: string;
  label: string;
  icon: typeof MessageSquare;
  feature?: UpdateId;
  /** Shown when any of these is on (in addition to `feature`). */
  anyOf?: UpdateId[];
  detail?: string;
};

export const chat: Destination = { href: '/dashboard/chat', label: 'Chat', icon: MessageSquare };
export const characters: Destination = { href: '/dashboard/characters', label: 'Characters', icon: Drama };

/** The everyday tools, always open at the top of the sidebar. */
export const tools: Destination[] = [
  chat,
  characters,
  { href: '/dashboard/images', label: 'Images', icon: ImageIcon, feature: 'images', anyOf: ['studio'] },
  { href: '/dashboard/video', label: 'Video', icon: Video, feature: 'video', anyOf: ['studio'] },
  { href: '/dashboard/story', label: 'Stories', icon: BookOpen, feature: 'story' },
  { href: '/dashboard/build', label: 'Build', icon: Hammer, feature: 'build' },
  { href: '/dashboard/research', label: 'Research', icon: FileSearch, feature: 'research' },
];

/** Everything else people can do, folded under More. */
export const extras: Destination[] = [
  { href: '/dashboard/call', label: 'Voice call', icon: Headphones, feature: 'voice' },
  { href: '/dashboard/mo-voice', label: 'Mo Voice', icon: Phone, feature: 'movoice' },
  { href: '/dashboard/voices', label: 'Voices', icon: AudioLines, feature: 'movoice' },
  { href: '/dashboard/side-by-side', label: 'Side by side', icon: Columns3, feature: 'sidebyside' },
  { href: '/dashboard/party', label: 'Party', icon: Dices, feature: 'party' },
  { href: '/dashboard/discover', label: 'Discover', icon: Compass, feature: 'creators' },
  { href: '/dashboard/creators', label: 'Creator Cut', icon: HeartHandshake, feature: 'creators' },
  { href: '/dashboard/votes', label: 'Votes', icon: Vote, feature: 'creators' },
  { href: '/dashboard/nymo', label: '$NYMO', icon: Coins, feature: 'stake' },
  { href: '/dashboard/tickets', label: 'Tickets', icon: Ticket, feature: 'tickets' },
  { href: '/dashboard/ventures', label: 'Ventures', icon: Rocket, feature: 'ventures' },
];

export const accountTabs: Destination[] = [
  { href: '/dashboard/funds', label: 'Balance', icon: Wallet },
  { href: '/dashboard/key', label: 'Key', icon: KeyRound },
  { href: '/dashboard/receipts', label: 'History', icon: ReceiptText },
  { href: '/dashboard/usage', label: 'Usage & limits', icon: BarChart3, feature: 'usage' },
];

export const developerLinks: Destination[] = [
  { href: '/dashboard/presets', label: 'Frontend presets', icon: Plug, detail: 'Connect a chat app you already use.' },
  { href: '/dashboard/connect', label: 'Pair a coding tool', icon: Link2, feature: 'connect', detail: 'Use your key from a coding assistant.' },
  { href: '/dashboard/wallet-review', label: 'Wallet request', icon: ShieldCheck, feature: 'walletreview', detail: 'Read a wallet request before you sign it.' },
  { href: '/manifest', label: 'Model manifest', icon: ListTree, detail: 'Which models and routes are available.' },
  { href: '/leaderboard', label: 'Leaderboard', icon: Trophy, detail: 'How often each model refuses.' },
  { href: '/docs', label: 'Docs', icon: BookOpen, detail: 'The API, receipts and proofs.' },
  { href: '/status', label: 'Service status', icon: AudioLines, feature: 'status', detail: 'Whether every route is up.' },
];

export const settingsTabs: Destination[] = [
  { href: '/dashboard/settings', label: 'Privacy & data', icon: Settings },
  { href: '/dashboard/memory', label: 'Memory', icon: Archive, feature: 'vaultsync', detail: 'What your characters remember, encrypted on this device.' },
  { href: '/dashboard/about-you', label: 'About you', icon: IdCard, feature: 'aboutyou', detail: 'A short profile carried into your chats.' },
  { href: '/dashboard/library', label: 'Library', icon: Images, feature: 'vault', detail: 'Images and clips saved in this browser.' },
  { href: '/dashboard/move-in', label: 'Import chats', icon: PackageOpen, feature: 'movein', detail: 'Bring characters and chats from another app.' },
  { href: '/dashboard/developers', label: 'Developers', icon: Code2, detail: 'Presets, coding tools, models and docs.' },
];

export const account: Destination = { href: '/dashboard/funds', label: 'Account', icon: Wallet };
export const settings: Destination = { href: '/dashboard/settings', label: 'Settings', icon: Settings };

/** The links this build and tab can use, with Import pointing at Lifeboat when that is on. */
export function available(links: Destination[], demo: boolean): Destination[] {
  return links
    .filter((item) => !item.feature || updateOn(item.feature, demo) || !!item.anyOf?.some((id) => updateOn(id, demo)))
    .map((item) => (item.href === '/dashboard/move-in' && updateOn('lifeboat', demo) ? { ...item, href: '/dashboard/lifeboat' } : item));
}

const under = (path: string, href: string) => path === href || path.startsWith(href + '/');
const accountPaths = accountTabs.map((tab) => tab.href);
const settingsPaths = [...settingsTabs.map((tab) => tab.href), '/dashboard/lifeboat', ...developerLinks.map((link) => link.href).filter((href) => href.startsWith('/dashboard/'))];

export function area(path: string): 'account' | 'settings' | null {
  if (accountPaths.some((href) => under(path, href))) return 'account';
  if (settingsPaths.some((href) => under(path, href))) return 'settings';
  return null;
}

/** Whether a sidebar link stands for the page at `path`: Account and Settings cover every page in their area. */
export function sidebarCurrent(path: string, href: string) {
  if (href === account.href) return area(path) === 'account';
  if (href === settings.href) return area(path) === 'settings';
  return under(path, href);
}

/** Whether a tab stands for the page at `path`. */
export function tabCurrent(path: string, href: string) {
  if (href === '/dashboard/developers') return developerLinks.some((link) => under(path, link.href)) || under(path, href);
  if (href === '/dashboard/lifeboat') return path === '/dashboard/move-in' || under(path, href);
  return under(path, href);
}
