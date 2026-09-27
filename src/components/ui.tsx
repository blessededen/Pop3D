import { useEffect, useState, type ReactNode } from 'react';
import { STATUS_LABEL, type PriceStatus } from '../domain/types';

function clamp(n: number, min?: number, max?: number) {
  if (min != null && n < min) return min;
  if (max != null && n > max) return max;
  return n;
}

interface NumProps {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  allowNull?: boolean;
  placeholder?: string;
  className?: string;
  money?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}

/** 입력 중에는 글자를 그대로 두고, 포커스를 잃거나 Enter일 때 한 번만 반영한다. */
export function NumInput({ value, onChange, min, max, allowNull, placeholder, className = '', money, disabled, ariaLabel }: NumProps) {
  const fmt = (v: number | null) => (v == null ? '' : money ? v.toLocaleString('ko-KR') : String(v));
  const [text, setText] = useState(fmt(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focus]);
  const commit = (t: string) => {
    const s = t.replace(/[,\s원]/g, '');
    if (s === '') {
      if (allowNull) onChange(null);
      else setText(fmt(value));
      return;
    }
    const n = Number(s);
    if (!Number.isFinite(n)) {
      setText(fmt(value));
      return;
    }
    const v = clamp(n, min, max);
    if (v !== value) onChange(v);
    setText(fmt(v));
  };
  return (
    <input
      className={`input num ${className}`}
      inputMode="decimal"
      value={focus ? text : fmt(value)}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      onFocus={() => {
        setFocus(true);
        setText(value == null ? '' : String(value));
      }}
      onBlur={(e) => {
        setFocus(false);
        commit(e.target.value);
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(fmt(value));
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  className = '',
  multiline,
  ariaLabel,
  type = 'text',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
  ariaLabel?: string;
  type?: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => text !== value && onChange(text);
  if (multiline) {
    return (
      <textarea className={`input ${className}`} value={text} placeholder={placeholder} aria-label={ariaLabel} onChange={(e) => setText(e.target.value)} onBlur={commit} rows={2} />
    );
  }
  return (
    <input
      className={`input ${className}`}
      type={type}
      value={text}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => {
        setText(e.target.value);
        if (type === 'date') onChange(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function Stepper({ value, onChange, min = 0, max = 99, ariaLabel }: { value: number; onChange: (v: number) => void; min?: number; max?: number; ariaLabel?: string }) {
  return (
    <span className="stepper" aria-label={ariaLabel}>
      <button type="button" onClick={() => onChange(clamp(value - 1, min, max))} aria-label="줄이기">
        −
      </button>
      <input
        value={value}
        inputMode="numeric"
        aria-label={ariaLabel}
        onChange={(e) => {
          const n = Number(e.target.value.replace(/\D/g, ''));
          if (Number.isFinite(n)) onChange(clamp(n, min, max));
        }}
      />
      <button type="button" onClick={() => onChange(clamp(value + 1, min, max))} aria-label="늘리기">
        +
      </button>
    </span>
  );
}

export function StatusChip({ status }: { status: PriceStatus }) {
  return <span className={`chip ${status}`}>{STATUS_LABEL[status]}</span>;
}

export function Field({ label, children, className = '' }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${className}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function manwon(n: number | null | undefined): string {
  if (n == null) return '';
  if (n >= 10000 && n % 10000 === 0) return `${(n / 10000).toLocaleString('ko-KR')}만 원`;
  if (n >= 10000) return `${(n / 10000).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}만 원`;
  return `${n.toLocaleString('ko-KR')}원`;
}
