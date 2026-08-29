'use client';

/**
 * Generate → read → copy (spec §29, §30).
 *
 * "The important button is: COPY CONTEXT FOR CHATGPT." So the copy button is
 * the primary action and the pack itself is shown in full above it - the user
 * should be able to read exactly what they are about to hand over.
 */
import { useState, useTransition } from 'react';
import { generateAndStoreContextPack } from '@/app/actions/context';
import type { ContextPack } from '@/lib/context/generate';

export function ContextPanel({ initialPack }: { initialPack: string | null }) {
  const [pack, setPack] = useState<ContextPack | null>(null);
  const [body, setBody] = useState<string | null>(initialPack);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleGenerate() {
    setMessage(null);
    setCopied(false);
    startTransition(async () => {
      const result = await generateAndStoreContextPack();
      setMessage(result.message);
      if (result.pack) {
        setPack(result.pack);
        setBody(result.pack.body);
      }
    });
  }

  async function handleCopy() {
    if (!body) return;
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setMessage('Could not reach the clipboard. Select the text below and copy it.');
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={pending}
          className="rounded border border-line-strong px-4 py-2 text-sm transition-colors hover:border-accent disabled:opacity-40"
        >
          {pending ? 'Generating…' : 'Generate context'}
        </button>

        <button
          type="button"
          onClick={handleCopy}
          disabled={!body}
          className="rounded border border-accent bg-accent/10 px-4 py-2 text-sm text-accent transition-colors hover:bg-accent/20 disabled:opacity-30"
        >
          {copied ? 'Copied' : 'Copy context for ChatGPT'}
        </button>

        {pack && (
          <span className="text-[11px] text-ink-faint">
            v{pack.version} · analytics {pack.analyticsVersion} ·{' '}
            {pack.dataQualityScore === null
              ? 'data quality not computable'
              : `data quality ${Math.round(pack.dataQualityScore)}/100`}
          </span>
        )}
      </div>

      {message && (
        <p role="status" className="text-xs text-ink-muted">
          {message}
        </p>
      )}

      {body ? (
        <pre className="max-h-[70vh] overflow-auto rounded-lg border border-line bg-surface p-5 font-mono text-[11px] leading-relaxed text-ink-muted">
          {body}
        </pre>
      ) : (
        <p className="rounded-lg border border-line bg-surface p-5 text-sm text-ink-faint">
          No context pack yet. Generate one to see exactly what would be handed to
          ChatGPT.
        </p>
      )}
    </div>
  );
}
