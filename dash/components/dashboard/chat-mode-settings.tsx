'use client';

import { Columns3, ImageIcon, Mic } from 'lucide-react';
import { imageCounts, shapeOf, type ChatMode, type ModePrefs, type PictureSettings } from '@/lib/anonymo/chat-modes';
import { setSlot } from '@/lib/anonymo/sidebyside';
import type { MediaImageModel, ModelInfo } from '@/lib/anonymo/types';

export const MODE_LABELS = {
  picture: { label: 'Picture', icon: ImageIcon, placeholder: 'Describe the picture…', verb: 'Make picture' },
  three: { label: 'Ask 3 AIs', icon: Columns3, placeholder: 'Ask three models the same thing…', verb: 'Ask 3' },
  talk: { label: 'Talk', icon: Mic, placeholder: 'Hold the button to talk, or type…', verb: 'Hold to talk' },
};

export function ChatModeSettings({ mode, settings, images, models, voices, canMerge, onChange, studio }: {
  mode: ChatMode;
  settings: ModePrefs;
  images: readonly MediaImageModel[];
  models: readonly ModelInfo[];
  voices: readonly string[];
  canMerge: boolean;
  onChange: <K extends ChatMode>(mode: K, next: ModePrefs[K]) => void;
  studio: () => void;
}) {
  const { picture, three, talk } = settings;
  const image = images.find((model) => model.id === picture.model);
  const pictureChange = (patch: Partial<PictureSettings>) => onChange('picture', { ...picture, ...patch });
  return (
    <div className="mode-options">
      {mode === 'picture' && image && (
        <>
          <label>
            Model
            <select aria-label="Picture model" value={picture.model} onChange={(e) => pictureChange({ model: e.target.value })}>
              {images.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </label>
          <label>
            Shape
            <select aria-label="Shape" value={picture.size} onChange={(e) => pictureChange({ size: e.target.value })}>
              {image.sizes.map((size) => <option key={size} value={size}>{shapeOf(size)} · {size}</option>)}
            </select>
          </label>
          <label>
            How many
            <select aria-label="How many" value={picture.n} onChange={(e) => pictureChange({ n: Number(e.target.value) })}>
              {imageCounts(image).map((n) => <option key={n}>{n}</option>)}
            </select>
          </label>
          <button type="button" className="link-button" onClick={studio}>More options</button>
        </>
      )}
      {mode === 'three' && (
        <>
          {three.models.map((value, index) => (
            <label key={index}>
              {['First', 'Second', 'Third'][index]}
              <select aria-label={`${['First', 'Second', 'Third'][index]} model`} value={value} onChange={(e) => onChange('three', { ...three, models: setSlot(three.models, index, e.target.value) })}>
                {models.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
              </select>
            </label>
          ))}
          <label>
            Answers
            <select aria-label="Answers" value={three.merged ? 'merged' : 'side'} onChange={(e) => onChange('three', { ...three, merged: e.target.value === 'merged' })}>
              <option value="merged" disabled={!canMerge}>Merged</option>
              <option value="side">Side by side</option>
            </select>
          </label>
        </>
      )}
      {mode === 'talk' && (
        <>
          <label>
            Voice
            <select aria-label="Voice" value={talk.voice} onChange={(e) => onChange('talk', { ...talk, voice: e.target.value })}>
              {voices.map((voice) => <option key={voice}>{voice}</option>)}
            </select>
          </label>
          <label>
            Replies
            <select aria-label="Replies" value={talk.aloud ? 'aloud' : 'text'} onChange={(e) => onChange('talk', { ...talk, aloud: e.target.value === 'aloud' })}>
              <option value="aloud">Read aloud</option>
              <option value="text">Text only</option>
            </select>
          </label>
        </>
      )}
    </div>
  );
}
