import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';
import type { BookingStatus } from '../lib/types';

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="loading__bulbs" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorNote({ error, action }: { error: unknown; action?: ReactNode }) {
  const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div className="note note--error" role="alert">
      <p>{message}</p>
      {action}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

const STATUS_TEXT: Record<BookingStatus, string> = {
  PENDING: 'Awaiting payment',
  CONFIRMED: 'Confirmed',
  FAILED: 'Not completed',
  EXPIRED: 'Hold expired',
  CANCELLED: 'Cancelled',
};

export function StatusPill({ status }: { status: BookingStatus }) {
  return <span className={`pill pill--${status.toLowerCase()}`}>{STATUS_TEXT[status]}</span>;
}
