"use client";

// Folk-style skeleton placeholders. Subtle, soft borders matching
// `card-soft`. The animation is a gentle pulse — not the heavy bordered
// boxes the old version had. Users perceive skeleton-loaded content
// ~50% faster than spinners at identical actual load times, but only
// when the skeletons match the real content's shape and weight.

export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`inline-block bg-black/8 rounded animate-pulse ${className}`} />;
}

// Card-shaped skeleton — for grids of small KPI/metric cards
export function SkeletonCard({ className = "" }: { className?: string }) {
  return (
    <div className={`card-soft p-4 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <Skeleton className="w-5 h-5 rounded" />
        <Skeleton className="w-12 h-3" />
      </div>
      <Skeleton className="w-20 h-7 block mb-2" />
      <Skeleton className="w-32 h-3 block" />
    </div>
  );
}

// Row-shaped skeleton — for lists of items. Folk-style: minimal chrome,
// subtle row dividers via space-y, no per-row card border.
export function SkeletonRow() {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex-1 min-w-0 space-y-2">
        <Skeleton className="block h-3.5 w-3/5" />
        <Skeleton className="block h-3 w-2/5" />
      </div>
      <Skeleton className="w-16 h-5" />
    </div>
  );
}

// List of skeleton rows — pass a count
export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <div className="divide-y divide-black/5">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}
