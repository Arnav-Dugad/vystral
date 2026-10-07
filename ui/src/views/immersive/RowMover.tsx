import { motion } from 'motion/react';
import { ArrowDownUp } from 'lucide-react';
import { pick, spring } from '../../lib/motion';
import { useReducedMotion } from '../../state/store';
import type { Row } from './rows';

/** Height of one line in the order list, in rem (kept in sync with immersive-z.css). */
const LINE_REM = 2.05;

/**
 * Track Z: while a row is picked up, the info area becomes the row order — every Home row by name,
 * numbered, with the lifted one raised in the palette colour. D-pad up/down moves it and the
 * others slide past; the list keeps the lifted row in the middle of the space.
 */
export function RowOrderList({ rows, liftedId }: { rows: Row[]; liftedId: string }) {
  const reduce = useReducedMotion();
  const at = Math.max(0, rows.findIndex((r) => r.id === liftedId));
  const lifted = rows[at];
  return (
    <div className="imm-move" role="group" aria-label={`Moving ${lifted?.title ?? 'row'}: row ${at + 1} of ${rows.length}`}>
      <div className="imm-move__head">
        <span className="imm-move__eyebrow">
          <ArrowDownUp size="1em" aria-hidden /> Move row
        </span>
        <span className="imm-move__where num">
          {at + 1} of {rows.length}
        </span>
      </div>
      <div className="imm-move__window" aria-hidden>
        <motion.ol
          className="imm-move__list"
          initial={false}
          animate={{ y: `${-at * LINE_REM}rem` }}
          transition={pick(reduce, spring.focus)}
        >
          {rows.map((r, i) => (
            <motion.li
              key={r.id}
              className="imm-move__item"
              data-lifted={r.id === liftedId || undefined}
              initial={false}
              animate={{ y: `${i * LINE_REM}rem`, opacity: Math.abs(i - at) > 3 ? 0 : 1 - Math.abs(i - at) * 0.16 }}
              transition={pick(reduce, spring.focus)}
            >
              <span className="imm-move__n num">{i + 1}</span>
              <span className="imm-move__name">{r.title}</span>
            </motion.li>
          ))}
        </motion.ol>
      </div>
    </div>
  );
}
