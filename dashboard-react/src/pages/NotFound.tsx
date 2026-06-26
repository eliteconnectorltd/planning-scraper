import { Link } from "react-router-dom";

// Replaces the App Router's notFound() / built-in 404.
export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col px-6 py-6">
      <div className="card-surface flex min-h-[360px] flex-col items-center justify-center p-10 text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Page not found</h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          The page or application record you requested doesn&apos;t exist or is no longer available.
        </p>
        <Link
          to="/"
          className="mt-5 inline-flex items-center rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:border-border-strong hover:bg-secondary"
        >
          Back to overview
        </Link>
      </div>
    </div>
  );
}
