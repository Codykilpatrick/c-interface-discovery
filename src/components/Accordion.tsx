import { useState, useEffect } from 'react';

interface AccordionProps {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  /** When this flips to true, force the accordion open (e.g. when a prefill arrives). */
  forceOpen?: boolean;
  children: React.ReactNode;
}

export default function Accordion({ title, count, defaultOpen = false, forceOpen, children }: AccordionProps) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  return (
    <div className="border border-gray-800 rounded-lg mb-2">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-medium text-gray-300 hover:bg-gray-800/50"
        onClick={() => setOpen((o) => !o)}
      >
        <span>{title}{count !== undefined ? ` (${count})` : ''}</span>
        <span className="text-gray-500">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}
