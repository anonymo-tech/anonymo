import type { StandardWallet } from '../../lib/client/service';

const brands = [
  {
    name: 'Phantom',
    aliases: ['phantom'],
    logo: 'phantom.svg',
    url: 'https://phantom.com/',
  },
  {
    name: 'Solflare',
    aliases: ['solflare'],
    logo: 'solflare.svg',
    url: 'https://www.solflare.com/',
  },
  {
    name: 'Backpack',
    aliases: ['backpack'],
    logo: 'backpack.png',
    url: 'https://backpack.app/',
  },
  {
    name: 'MetaMask',
    aliases: ['metamask'],
    logo: 'metamask.svg',
    url: 'https://metamask.io/',
  },
  {
    name: 'Trust Wallet',
    aliases: ['trust', 'trust wallet'],
    logo: 'trust-wallet.svg',
    url: 'https://trustwallet.com/',
  },
  {
    name: 'OKX Wallet',
    aliases: ['okx', 'okx wallet'],
    logo: 'okx-wallet.png',
    url: 'https://web3.okx.com/',
  },
] as const;

export type WalletChoice = {
  name: string;
  logo: string | null;
  url?: string;
  wallet?: StandardWallet;
};

export function walletChoices(
  wallets: readonly StandardWallet[],
): WalletChoice[] {
  const matched = new Set<StandardWallet>();
  const choices: WalletChoice[] = brands.map((brand) => {
    const wallet = wallets.find((candidate) =>
      brand.aliases.some(
        (alias) => alias === candidate.name.trim().toLowerCase(),
      ),
    );
    if (wallet) matched.add(wallet);
    return {
      name: brand.name,
      logo: `/brand/wallets/${brand.logo}`,
      url: brand.url,
      wallet,
    };
  });
  for (const wallet of wallets) {
    if (matched.has(wallet)) continue;
    choices.push({
      name: wallet.name.slice(0, 80),
      logo: /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/i.test(wallet.icon)
        ? wallet.icon
        : null,
      wallet,
    });
  }
  return choices;
}
