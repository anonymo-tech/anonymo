import PageFrame from '../../components/PageFrame';
import Agents from './Agents';

export const metadata = { title: 'Agents — Anonymo', description: 'Give your agent a budget and a rulebook. Enforced by Anonymo’s router for requests through Anonymo.' };

export default function AgentsPage() {
  return <PageFrame><main id="content" className="page-main">
    <div className="page-title"><span className="eyebrow">AGENT RULEBOOKS</span><h1>Give your agent a budget and a rulebook.</h1><p>Enforced by Anonymo's router for requests through Anonymo.</p></div>
    <Agents/>
  </main></PageFrame>;
}
