import { useEffect, useRef, useState } from 'react';

interface Props {
  text: string;
  label?: string;
  copiedLabel?: string;
  title?: string;
  className?: string;
}

/**
 * Copy `text` to the clipboard with brief visual feedback. Falls back to
 * a synthetic textarea selection when navigator.clipboard is unavailable
 * (e.g. http://localhost over Safari, or older browsers).
 */
export function CopyButton({
  text,
  label = 'copy',
  copiedLabel = 'copied!',
  title = 'copy to clipboard',
  className,
}: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  async function copy() {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop — leave the user to manually copy */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={className}
      title={title}
      style={{ padding: '1px 8px', fontSize: 12 }}
    >
      [ {copied ? copiedLabel : label} ]
    </button>
  );
}
