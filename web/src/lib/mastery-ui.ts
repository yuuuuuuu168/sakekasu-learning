import type { Mastery } from '../../../shared/mastery';

export const MASTERY_UI: Record<Mastery, { label: string; description: string; dot: string; bar: string; chip: string }> = {
  mastered: {
    label: 'バッチリ',
    description: '直近2回連続で正解',
    dot: 'bg-success',
    bar: 'bg-success',
    chip: 'bg-success/10 text-success ring-success/30',
  },
  shaky: {
    label: 'あいまい',
    description: '直近2回で正解と不正解が混在、または1回だけ正解',
    dot: 'bg-warning',
    bar: 'bg-warning',
    chip: 'bg-warning/10 text-warning ring-warning/30',
  },
  weak: {
    label: '苦手',
    description: '直近2回連続で不正解、または1回だけ回答して不正解',
    dot: 'bg-danger',
    bar: 'bg-danger',
    chip: 'bg-danger/10 text-danger ring-danger/30',
  },
  unanswered: {
    label: '未回答',
    description: 'まだ回答していない',
    dot: 'bg-grid',
    bar: 'bg-surface-2',
    chip: 'bg-plane text-ink-2 ring-grid',
  },
};
