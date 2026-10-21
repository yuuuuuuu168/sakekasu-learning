import { Check, X } from 'lucide-react';
import { correctLabels } from '../../lib/answer';

export function ResultBanner({
  correct,
  answers,
  displayOrder,
}: {
  correct: boolean;
  answers: number[];
  displayOrder: number[];
}) {
  return (
    <div className={`flex items-center gap-3 rounded-2xl p-4 ${correct ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
      <span className={`flex size-9 items-center justify-center rounded-full text-on-fill ${correct ? 'bg-success' : 'bg-danger'}`}>
        {correct ? <Check className="size-5" /> : <X className="size-5" />}
      </span>
      <div>
        <p className="font-bold">{correct ? '正解！' : '不正解'}</p>
        <p className="text-sm">正解は {correctLabels(answers, displayOrder)}</p>
      </div>
    </div>
  );
}
