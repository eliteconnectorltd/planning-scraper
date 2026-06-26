// Calm flat skeleton shown while a page's TanStack Query is loading.
// (Replaces the old shimmer-sweep skeleton — plain pulse, no decorative motion.)
export function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-6 py-6">
      <div className="h-16 animate-pulse rounded-lg bg-secondary" />
      <div className="grid gap-4 md:grid-cols-4">
        {[0, 1, 2, 3].map(item => (
          <div key={item} className="h-24 animate-pulse rounded-lg bg-secondary" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {[0, 1].map(item => (
          <div key={item} className="h-72 animate-pulse rounded-lg bg-secondary first:lg:col-span-2" />
        ))}
      </div>
    </div>
  );
}
