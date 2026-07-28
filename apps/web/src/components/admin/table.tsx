"use client";

import { useId, type ReactNode } from "react";

import { Card, SectionHeading } from "@/components/layout/card";

/**
 * The console's list chrome: a heading, a search box, a count and a body.
 *
 * The rows themselves are **not** a `<table>`. Every row here carries a
 * multi-line summary and an expanding confirmation dialog, and a dialog inside a
 * `<td>` on a 390 px phone — which is where an admin actually is when they need
 * to lock somebody at 1 a.m. — is a horizontal scrollbar with a form in it. So
 * the rows are a description list in a flex layout that reflows, and the column
 * headings that a table would carry are inline labels instead.
 */
export function AdminTableShell({
  title,
  description,
  search,
  total,
  shown,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly search?: ReactNode;
  readonly total?: number;
  readonly shown?: number;
  readonly children: ReactNode;
}) {
  return (
    <Card>
      <SectionHeading title={title} description={description} />
      {search ? <div className="mt-4">{search}</div> : null}

      {total === undefined || shown === undefined ? null : (
        <p className="mt-3 text-sm text-faint" role="status" aria-live="polite">
          {shown === total
            ? `${total} ${total === 1 ? "row" : "rows"}`
            : `Showing ${shown} of ${total}`}
        </p>
      )}

      <div className="mt-2">{children}</div>
    </Card>
  );
}

export function AdminSearch({
  label,
  placeholder,
  value,
  onChange,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="h-10 w-full max-w-sm rounded-xl border border-line bg-surface px-3.5 text-sm text-ink placeholder:text-faint hover:border-line-strong"
      />
    </div>
  );
}

export function EmptyRow({ children }: { readonly children: ReactNode }) {
  return (
    <p className="py-8 text-center text-sm text-muted" role="status" aria-live="polite">
      {children}
    </p>
  );
}
