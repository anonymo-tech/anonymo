import { PresetsView } from '@/components/presets-view';
import { PublicPage } from '@/components/site-chrome';

export const metadata = {
  title: 'Presets — Anonymo',
  description: 'One-paste Anonymo setups for JanitorAI, SillyTavern, Chub, Agnai, Open WebUI, LibreChat and TypingMind.',
};

export default function PresetsPage() {
  return (
    <PublicPage>
      <div className="page-title">
        <h1>Plug Anonymo into what you already use</h1>
        <p>
          Anonymo speaks the OpenAI API, so any frontend that takes a custom endpoint works. Pick yours, copy the setup, paste
          your key. anonymo-1 is the default for chat and roleplay alike.
        </p>
      </div>
      <PresetsView />
    </PublicPage>
  );
}
