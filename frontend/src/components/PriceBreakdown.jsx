import { rupees } from '../lib/format';

export function PriceBreakdown({ breakdown }) {
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
