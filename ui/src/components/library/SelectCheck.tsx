import { Check } from 'lucide-react';

/**
 * Track D1: the round checkbox on a Library card or row. Shown on hover/focus and while selecting. It's a mouse
 * target (keyboard users press Space on the card or row; controller users press X), so it isn't a tab stop.
 */
export function SelectCheck({ title, checked, onToggle, onRange }: { title: string; checked: boolean; onToggle: () => void; onRange: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      className="sel-check"
      aria-checked={checked}
      aria-label={`Select ${title}`}
      tabIndex={-1}
      data-select-check
      onMouseDown={(e) => e.preventDefault() /* keep focus where it is */}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) onRange();
        else onToggle();
      }}
    >
      <Check size={16} strokeWidth={3} aria-hidden />
    </button>
  );
}
