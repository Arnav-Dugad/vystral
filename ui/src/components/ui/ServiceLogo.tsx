import { memo, type CSSProperties } from 'react';
import { Activity, BadgePercent, Database, Images, ShieldCheck, Tags, type LucideIcon } from 'lucide-react';
import { opticalSize } from '../../lib/storeMarks';
import { hardwareVendor, SERVICE_MARKS, type GenericIcon, type ServiceId } from '../../lib/serviceMarks';
import { LogoSvg } from './StoreLogo';
import './store-logo.css';

const GENERIC: Record<GenericIcon, LucideIcon> = {
  artwork: Images,
  database: Database,
  price: Tags,
  deal: BadgePercent,
  shield: ShieldCheck,
  pulse: Activity,
};

/**
 * Track R: the mark of a service that isn't a store — a data source, Ollama, a GPU maker, a cloud
 * service. Behaves exactly like `StoreLogo`: monochrome (currentColor) by default, its brand hue on
 * hover/selection or with `brand` (never in High contrast), named (role="img") unless `decorative`,
 * snapped to the 14/16/20/24 optical sizes, and with `motion` it draws itself when its control is
 * hovered or focused. Services without a licensed mark show a plain descriptive icon instead, which
 * only ever takes the accent colour.
 */
export const ServiceLogo = memo(function ServiceLogo({
  service,
  size = 16,
  decorative,
  brand,
  motion,
  className = '',
}: {
  service: ServiceId;
  size?: number;
  decorative?: boolean;
  brand?: boolean;
  motion?: boolean;
  className?: string;
}) {
  const mark = SERVICE_MARKS[service];
  if (!mark) return null;
  const cls = `store-logo service-logo ${className}`;
  if (mark.kind === 'generic') {
    const Icon = GENERIC[mark.icon];
    const optical = opticalSize(size);
    const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': mark.name };
    return (
      <Icon
        className={cls}
        data-service={service}
        data-kind="generic"
        data-brand={brand || undefined}
        size={size}
        // Lucide draws on the same 24-unit grid; a touch lighter at the larger sizes so it sits with filled marks.
        strokeWidth={optical <= 16 ? 2 : 1.75}
        focusable="false"
        style={{ ['--pc' as string]: 'var(--accent-text)' } as CSSProperties}
        {...a11y}
      />
    );
  }
  return (
    <LogoSvg
      mark={mark}
      name={mark.name}
      hue={mark.hue}
      attrs={{ 'data-service': service }}
      size={size}
      decorative={decorative}
      brand={brand}
      motion={motion}
      className={cls}
    />
  );
});

/** A graphics card or processor name with its maker's mark in front — only when the name says who made it. */
export function DeviceName({ name }: { name: string }) {
  const vendor = hardwareVendor(name);
  return (
    <span className="svc-name">
      {vendor && <ServiceLogo service={vendor} size={16} decorative />}
      {name}
    </span>
  );
}
