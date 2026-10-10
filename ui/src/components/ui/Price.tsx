import type { CSSProperties } from 'react';
import { moneyLabel, type MoneyOptions } from '../../lib/money';
import { useMoney } from '../../state/money';
import './price.css';

/**
 * Track D6: one price, in the currency chosen in Settings. Exact when the store already priced it in that currency;
 * otherwise "≈ ₹1,299" with "converted from $14.99" as its tooltip and spoken text. Use `minor` for Steam's hundredths.
 */
export function Price({ amount, currency, minor, digits, className = '', style, strike }: {
  amount: number;
  currency: string | null | undefined;
  minor?: boolean;
  digits?: MoneyOptions['digits'];
  className?: string;
  style?: CSSProperties;
  /** Shown struck through (a regular price next to a sale price). */
  strike?: boolean;
}) {
  const m = useMoney();
  const v = m.of(amount, currency, { minor, digits });
  const Tag = strike ? 's' : 'span';
  const spoken = `${strike ? 'was ' : ''}${moneyLabel(v)}`;
  const plain = !v.approx && !strike;
  return (
    <Tag
      className={`price num ${v.approx ? 'price--approx' : ''} ${className}`}
      data-approx={v.approx || undefined}
      data-currency={v.currency ?? undefined}
      title={v.note ?? undefined}
      style={style}
    >
      {plain ? v.text : (
        <>
          <span aria-hidden>{v.text}</span>
          <span className="visually-hidden">{spoken}</span>
        </>
      )}
    </Tag>
  );
}
