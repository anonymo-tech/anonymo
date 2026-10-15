'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import Image from 'next/image';
import { X, ArrowUpRight, Copy, LoaderCircle } from 'lucide-react';
import {
  secondLookRequest,
  secondLookError,
  type SecondLookOptions,
} from '../../lib/client/second-look';
import { safeEvidenceUrl } from '../../lib/client/second-look-contracts';
import type { Turn } from '../dashboard/canvas-state';
import { tokenIdentity } from './presentation';

export type ComposerControl = { submit: (value: string) => Promise<void> };
export type ComposerState = {
  placeholder: string;
  label: string;
  busy: boolean;
};
/** Host hooks for running one prompt on up to four chosen models through the normal quote and approval flow. */
export type AnalysisHost = {
  /** Models the person may pick, in picker order. */
  models: readonly { id: string; name: string; family: string }[];
  /** The models selected by default, at most four. */
  defaultModelIds: readonly string[];
  /** Whether live model calls are configured for this account. */
  available: boolean;
  /** Starts the reviewed multi-model request. The host shows the quote before anything is charged. */
  analyze: (request: {
    title: string;
    prompt: string;
    modelIds: string[];
    subjectId: string;
  }) => Promise<boolean>;
  resultSubjectId?: string;
  results?: ReactNode;
  /** Actual persisted/streaming turns for the four-model popup. */
  turns?: readonly Turn[];
};
export type PanelProps = {
  accountId: string | null;
  controlRef: RefObject<ComposerControl | null>;
  onComposer: (state: ComposerState) => void;
  onDraft: (value: string) => void;
  onSignIn: () => void;
  onToast: (value: string) => void;
  analysis?: AnalysisHost;
};
type Requester = <T>(
  path: string,
  options: Omit<
    Parameters<typeof secondLookRequest<T>>[1],
    keyof SecondLookOptions
  >,
) => Promise<T>;
export function useSecondLookApi(accountId: string | null) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
    },
    [accountId],
  );
  const run = useCallback(
    async (operation: (request: Requester) => Promise<void>) => {
      if (!accountId) {
        setError('Sign in to use this tool.');
        return;
      }
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setBusy(true);
      setError('');
      const request: Requester = async (path, options) => {
        const result = await secondLookRequest(path, {
          ...options,
          accountId,
          signal: controller.signal,
        });
        if (controller.signal.aborted)
          throw new DOMException('Cancelled', 'AbortError');
        return result;
      };
      try {
        await operation(request);
      } catch (error) {
        if (!controller.signal.aborted) setError(secondLookError(error));
      } finally {
        if (pending.current === controller && !controller.signal.aborted) {
          setBusy(false);
          pending.current = null;
        }
      }
    },
    [accountId],
  );
  return { run, busy, error, setError };
}
export function ErrorNotice({ message }: { message: string }) {
  return message ? (
    <p className="sl-notice sl-error" role="alert">
      {message}
    </p>
  ) : null;
}
export function Busy({ label = 'Checking sources' }: { label?: string }) {
  return (
    <output className="sl-busy">
      <LoaderCircle size={14} />
      {label}
    </output>
  );
}
export function TokenAvatar({
  mint,
  size = 36,
}: {
  mint: string;
  size?: number;
}) {
  const token = tokenIdentity(mint);
  return token.image ? (
    <Image
      className="sl-avatar"
      src={token.image}
      width={size}
      height={size}
      alt=""
    />
  ) : (
    <span
      className="sl-avatar sl-avatar-fallback"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {token.symbol.slice(0, 2)}
    </span>
  );
}
export function CopyButton({
  value,
  onToast,
  label = 'Copy address',
}: {
  value: string;
  onToast: (v: string) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      className="sl-icon-button"
      aria-label={label}
      title={label}
      onClick={() =>
        void navigator.clipboard.writeText(value).then(
          () => onToast('Copied.'),
          () => onToast('Copy is unavailable in this browser.'),
        )
      }
    >
      <Copy size={13} />
    </button>
  );
}
export function EvidenceLink({
  href,
  children,
}: {
  href: string | null | undefined;
  children: ReactNode;
}) {
  const safe = safeEvidenceUrl(href);
  return safe ? (
    <a
      className="sl-evidence"
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
    >
      {children}
      <ArrowUpRight size={12} />
    </a>
  ) : (
    <span>{children}</span>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="sl-modal sl-evidence-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="sl-modal-inner">
        <header>
          <h2>{title}</h2>
          <button
            className="sl-icon-button"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
