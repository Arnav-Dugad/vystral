import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Star } from 'lucide-react';
import { spring } from '../../lib/motion';
import { useReducedMotion } from '../../state/store';
import type { PlatformKey } from '../../bridge/types';
import { PLATFORM_NAMES } from '../../lib/format';
import './ui.css';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  icon?: ReactNode;
  loading?: boolean;
  block?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, block, children, className = '', disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`btn btn--${variant} ${size !== 'md' ? `btn--${size}` : ''} ${block ? 'btn--block' : ''} ${className}`}
      data-loading={loading || undefined}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {icon}
      {children && <span>{children}</span>}
      {loading && (
        <span className="btn__spinner">
          <span className="spinner" />
        </span>
      )}
    </button>
  );
});

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md'; pressed?: boolean };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', pressed, children, className = '', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`icon-btn ${size === 'sm' ? 'icon-btn--sm' : ''} ${className}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      {...rest}
    >
      {children}
    </button>
  );
});

export function Toggle({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  const reduce = useReducedMotion();
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="toggle"
      onClick={() => onChange(!checked)}
    >
      <motion.span className="toggle__knob" animate={{ x: checked ? 18 : 0 }} transition={reduce ? { duration: 0 } : spring.micro} />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; icon?: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const id = useId();
  const reduce = useReducedMotion();
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className="segmented__item"
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            const i = options.findIndex((x) => x.value === value);
            if (e.key === 'ArrowRight') onChange(options[(i + 1) % options.length].value);
            if (e.key === 'ArrowLeft') onChange(options[(i - 1 + options.length) % options.length].value);
          }}
        >
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="segmented__pill" transition={reduce ? { duration: 0 } : spring.focus} />}
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({ value, min, max, step, onChange, label }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string }) {
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <input
      className="slider"
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ ['--fill' as string]: fill }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

export function Tabs<T extends string>({ value, tabs, onChange, label }: { value: T; tabs: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  const id = useId();
  const reduce = useReducedMotion();
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={t.value === value}
          tabIndex={t.value === value ? 0 : -1}
          className="tab"
          onClick={() => onChange(t.value)}
          onKeyDown={(e) => {
            const i = tabs.findIndex((x) => x.value === value);
            if (e.key === 'ArrowRight') onChange(tabs[(i + 1) % tabs.length].value);
            if (e.key === 'ArrowLeft') onChange(tabs[(i - 1 + tabs.length) % tabs.length].value);
          }}
        >
          {t.label}
          {t.value === value && <motion.span layoutId={`tab-${id}`} className="tab__indicator" transition={reduce ? { duration: 0 } : spring.focus} />}
        </button>
      ))}
    </div>
  );
}

export function Badge({ tone, children, icon }: { tone?: 'accent' | 'ok' | 'warn' | 'danger' | 'glass'; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className={`badge ${tone ? `badge--${tone}` : ''}`}>
      {icon}
      {children}
    </span>
  );
}

export function PlatformBadge({ platform, compact }: { platform: PlatformKey; compact?: boolean }) {
  return (
    <span className="platform-badge" style={{ ['--pc' as string]: `var(--p-${platform})` }}>
      <span className="platform-badge__dot" aria-hidden />
      {compact ? <span className="visually-hidden">{PLATFORM_NAMES[platform]}</span> : PLATFORM_NAMES[platform]}
    </span>
  );
}

export function ProgressBar({ value, label, indeterminate }: { value?: number; label: string; indeterminate?: boolean }) {
  return (
    <div
      className={`progress ${indeterminate ? 'progress--indeterminate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(value ?? 0)}
    >
      <div className="progress__fill" style={indeterminate ? undefined : { transform: `scaleX(${Math.max(0, Math.min(100, value ?? 0)) / 100})`, transition: 'transform 200ms var(--ease-out)' }} />
    </div>
  );
}

export function Skeleton({ width, height, radius, className = '' }: { width?: number | string; height?: number | string; radius?: number; className?: string }) {
  return <div className={`skeleton ${className}`} style={{ width, height, borderRadius: radius }} aria-hidden />;
}

export function EmptyState({ icon, title, body, actions }: { icon: ReactNode; title: string; body: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__art">{icon}</div>
      <h2 className="empty__title">{title}</h2>
      <p className="empty__body">{body}</p>
      {actions && <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', justifyContent: 'center' }}>{actions}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function PadGlyph({ button }: { button: 'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'Menu' | 'View' }) {
  const bumper = button.length > 1;
  return (
    <span className={`pad-glyph ${bumper ? 'pad-glyph--bumper' : `pad-glyph--${button}`}`} aria-label={`${button} button`}>
      {button === 'Menu' ? '≡' : button === 'View' ? '⧉' : button}
    </span>
  );
}

export function SectionHead({ title, meta, action }: { title: ReactNode; meta?: ReactNode; action?: ReactNode }) {
  return (
    <div className="section-head">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h2 className="section-head__title">{title}</h2>
        {meta && <span className="section-head__meta">{meta}</span>}
      </div>
      {action}
    </div>
  );
}

export function Stars({ value, onChange, label }: { value: number | null; onChange: (v: number | null) => void; label: string }) {
  return (
    <div className="stars" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          data-on={value != null && n <= value}
          onClick={() => onChange(value === n ? null : n)}
        >
          <Star size={16} fill={value != null && n <= value ? 'currentColor' : 'none'} />
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <div className="field__hint">{hint}</div>}
    </div>
  );
}
