export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-5 py-6 sm:px-8 lg:px-10">
      <div className="relative h-32 overflow-hidden rounded-xl border border-white/10 bg-white/[0.055]">
        <div className="absolute inset-y-0 -left-1/2 w-1/2 animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
      </div>
      <div className="grid gap-4 md:grid-cols-4">
        {[0, 1, 2, 3].map(item => (
          <div key={item} className="relative h-32 overflow-hidden rounded-lg border border-white/10 bg-white/[0.045]">
            <div className="absolute inset-y-0 -left-1/2 w-1/2 animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map(item => (
          <div key={item} className="relative h-80 overflow-hidden rounded-xl border border-white/10 bg-white/[0.045]">
            <div className="absolute inset-y-0 -left-1/2 w-1/2 animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          </div>
        ))}
      </div>
    </div>
  );
}
