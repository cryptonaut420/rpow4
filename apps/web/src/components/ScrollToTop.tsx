import { useEffect, useRef, useState } from 'react';

// Read the current vertical scroll offset across all browser variants.
// html/body/root with height:100% can shift scroll ownership to
// document.documentElement rather than window in some browsers.
function scrollTop(): number {
  return Math.max(
    window.scrollY,
    document.documentElement.scrollTop,
    document.body.scrollTop,
  );
}

function scrollToTop(): void {
  window.scrollTo({ top: 0, behavior: 'smooth' });
  document.documentElement.scrollTo({ top: 0, behavior: 'smooth' });
}

export function ScrollToTop() {
  const [visible, setVisible] = useState(false);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const check = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => setVisible(scrollTop() > 100));
    };
    window.addEventListener('scroll', check, { passive: true });
    document.addEventListener('scroll', check, { passive: true });
    check();
    return () => {
      window.removeEventListener('scroll', check);
      document.removeEventListener('scroll', check);
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <button
      className="scroll-to-top"
      style={{ opacity: visible ? 1 : 0, pointerEvents: visible ? 'auto' : 'none' }}
      onClick={scrollToTop}
      aria-label="scroll to top"
      title="back to top"
    >
      [ ↑ ]
    </button>
  );
}
