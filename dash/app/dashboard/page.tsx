import CanvasWorkspace from '../../components/dashboard/canvas-workspace';
import { featureOn } from '../../components/dashboard/feature-switches';
import '@xyflow/react/dist/style.css';
import './canvas-workspace.css';
import './workspace-pages.css';
import './workspace-tools.css';

export const metadata = {
  title: 'Chat — Conclave',
  description:
    'Ask several AI models at once and compare their answers in one room.',
};

export default function DashboardPage() {
  // Only the public network name crosses into the client; no RPC configuration.
  if (featureOn('explorerLinks') && featureOn('explainer')) {
    const cluster = process.env.CONCLAVE_SOLANA_CLUSTER;
    return <CanvasWorkspace configuredCluster={
      cluster === 'devnet' || cluster === 'mainnet-beta' ? cluster : null
    } />;
  }
  return <CanvasWorkspace />;
}
