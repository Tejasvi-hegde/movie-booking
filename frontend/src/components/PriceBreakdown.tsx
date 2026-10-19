import { rupees } from '../lib/format';
import type { PriceBreakdown as Breakdown } from '../lib/types';

export function PriceBreakdown({ breakdown }: { breakdown: Breakdown }) {
  return (
    <dl className="breakdown">
      {breakdown.items.map((item) => (
        <div key={item.code} className={`breakdown__row breakdown__row--${item.kind.toLowerCase()}`}>
          <dt>{item.label}</dt>
          <dd>{item.amount < 0 ? `− ${rupees(-item.amount)}` : rupees(item.amount)}</dd>
        </div>
      ))}
      <div className="breakdown__row breakdown__row--total">
        <dt>Total</dt>
        <dd>{rupees(breakdown.total)}</dd>
      </div>
    </dl>
  );
}
