import { useState } from 'react';
import { Button, Toggle } from '../../components/ui/primitives';
import { forgetWords, rememberedWordCount } from '../../lib/textEntry';
import { useStore } from '../../state/store';

/**
 * Settings › Controller & sound (Track S): the docked on-screen keyboard for text fields when
 * desktop mode is driven by a controller, and forgetting the words it remembered for suggestions.
 */
export function OnScreenKeyboardRows() {
  const on = useStore((s) => s.settings?.['controller.onScreenKeyboard'] ?? true);
  const set = useStore((s) => s.setSetting);
  const [count, setCount] = useState(() => rememberedWordCount());
  return (
    <>
      <div className="srow">
        <div className="srow__text">
          <label className="srow__label" htmlFor="controller.onScreenKeyboard">On-screen keyboard when using a controller</label>
          <div className="srow__hint">
            Press A on any text box to type with your controller. It only appears for controller input — never for a mouse or keyboard.
          </div>
        </div>
        <div className="srow__control">
          <Toggle id="controller.onScreenKeyboard" label="On-screen keyboard when using a controller" checked={on} onChange={(v) => void set('controller.onScreenKeyboard', v)} />
        </div>
      </div>
      <div className="srow">
        <div className="srow__text">
          <span className="srow__label">Typed-word suggestions</span>
          <div className="srow__hint">
            {count
              ? `${count.toLocaleString()} ${count === 1 ? 'word' : 'words'} remembered on this PC to suggest as you type. Never from passwords or keys, and never sent anywhere.`
              : 'Words you type with the on-screen keyboard are suggested next time. They stay on this PC; passwords and keys are never remembered.'}
          </div>
        </div>
        <div className="srow__control">
          <Button
            size="sm"
            variant="ghost"
            disabled={!count}
            onClick={() => {
              forgetWords();
              setCount(0);
              useStore.getState().toast({ tone: 'success', title: 'Typed words forgotten' });
            }}
          >
            Forget words
          </Button>
        </div>
      </div>
    </>
  );
}
