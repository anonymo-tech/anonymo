import { PublicPage } from '@/components/site-chrome';
import { ManifestView } from '@/components/trust-views';

export const metadata = {
  title: 'Model manifest — Anonymo',
  description: 'Every route behind each Anonymo model ID: upstream, family, quantization, weights hash and attestation.',
};

export default function ManifestPage() {
  return (
    <PublicPage wide>
      <div className="page-title">
        <h1>Model manifest</h1>
        <p>
          What runs behind each model ID: the upstream, model family, quantization, the hash of the served weights where we can
          publish it, and whether the route is hardware-attested. Only attested routes can serve anonymo-sealed.
        </p>
      </div>
      <ManifestView />
    </PublicPage>
  );
}
