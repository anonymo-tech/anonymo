export type StockTokenIssuer = {
  issuer: string;
  programme: string;
  authorities: readonly {
    kind: 'mintAuthority' | 'updateAuthority';
    address: string;
  }[];
  notFor: string;
  termsUrl: string;
};

// The reviewer adds verified entries from each issuer's own terms: issuer name,
// programme, identifying mint/update authority, and who the product isn't for.
// Names and symbols never identify an issuer. No authorities are assumed here.
// Verified on mainnet (2026-10-16) across TSLAx, NVDAx, AAPLx and SPYx, and across TSLAon, NVDAon and SPYon.
// Exclusions are quoted from each issuer's own pages; the linked terms are authoritative.
export const STOCK_TOKEN_ISSUERS: readonly StockTokenIssuer[] = [
  {
    issuer: 'Backed Assets (JE) Limited',
    programme: 'xStocks',
    authorities: [
      { kind: 'mintAuthority', address: '7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj' },
      { kind: 'updateAuthority', address: '5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq' },
    ],
    notFor: 'US persons and UK clients; other restricted countries apply',
    termsUrl: 'https://assets.backed.fi/legal-documentation/restricted-countries',
  },
  {
    issuer: 'Ondo Global Markets',
    programme: 'Ondo tokenized stocks and ETFs',
    authorities: [
      { kind: 'mintAuthority', address: '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD' },
      { kind: 'updateAuthority', address: '9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD' },
    ],
    notFor: 'the United States and US persons; other jurisdiction-based restrictions apply',
    termsUrl: 'https://docs.ondo.finance/ondo-global-markets/eligibility',
  },
];
