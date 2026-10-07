import { useCallback, useState } from 'react';
import { PLAN } from '../../lib/subs';
import { saveSubscriptions } from '../../state/subs';
import { useStore } from '../../state/store';
import { Toggle } from '../../components/ui/primitives';
import { SubsPicker, type SubsAnswer } from '../../components/subs/SubsPicker';

export interface SubsStepState {
  answer: SubsAnswer;
  setAnswer: (a: SubsAnswer) => void;
  lists: boolean;
  setLists: (v: boolean) => void;
  save: () => Promise<void>;
}

/** The onboarding step's answer lives in the dialog, so Back/Continue keep it; Continue saves it. */
export function useSubsStep(): SubsStepState {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const [answer, setAnswer] = useState<SubsAnswer>(() => ({
    plans: [],
    gfn: settings?.['cloud.gfnPlan'] ?? 'none',
    none: false,
  }));
  const [lists, setLists] = useState(true);
  const save = useCallback(async () => {
    if (answer.plans.some((p) => PLAN[p].hasList)) await setSetting('subs.catalog', lists);
    await saveSubscriptions(answer.plans, answer.gfn);
  }, [answer, lists, setSetting]);
  return { answer, setAnswer, lists, setLists, save };
}

/** Track V: "Which subscriptions do you have?" during first run. Optional like every step. */
export function SubsStep({ state }: { state: SubsStepState }) {
  const withList = state.answer.plans.some((p) => PLAN[p].hasList);
  return (
    <>
      <h2 className="onb__h2">Your subscriptions</h2>
      <p className="onb__p">Pick the ones you have and VYSTRAL tailors itself to them. Not sure? Skip it; Settings can change it any time.</p>
      <SubsPicker value={state.answer} onChange={state.setAnswer} compact />
      {withList && (
        <div className="onb__row">
          <div>
            <div className="srow__label">Show what my plans include</div>
            <div className="srow__hint">Downloads Microsoft’s public Game Pass lists once a day, so games your plans include get a badge. Only your region is sent.</div>
          </div>
          <Toggle label="Show what my plans include" checked={state.lists} onChange={state.setLists} />
        </div>
      )}
    </>
  );
}
