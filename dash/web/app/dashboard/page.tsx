import CanvasWorkspace from '../../components/dashboard/canvas-workspace';
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
  return <CanvasWorkspace />;
}
