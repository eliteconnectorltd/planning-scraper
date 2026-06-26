# Conversion Log — Next.js → React + Vite

Migration of the Planning Intelligence Dashboard from Next.js 16 (App Router)
to a plain React + Vite SPA. Source app left **untouched** at `../dashboard/`.

- **Auth model:** true SPA — browser Supabase client with the **anon/publishable
  key** + read-only RLS (see `supabase-rls.DRAFT.sql`). Service-role key is never
  shipped to the browser.
- **Data fetching:** TanStack Query (`staleTime: 60_000`, `retry: 1`).
- **Routing:** React Router v6.
- **Hosting:** host-agnostic static build (`base: "./"`), target decided later.
- **Build status:** ✅ `npm install` + `npm run build` succeed. `tsc -b` passes
  with zero type errors; `shadcn/tailwind.css` resolves under Vite (CSS bundle
  builds). Toolchain validated.

> ⚠️ The app returns **zero data** until the owner (1) applies
> `supabase-rls.DRAFT.sql` to Supabase and (2) fills `.env.local` from
> `.env.local.example`. Both are owner responsibilities per the approval terms.

---

## Per-page status

| Page | Route | Source file | Status | Notes |
|---|---|---|---|---|
| Analytics | `/analytics` | `pages/Analytics.tsx` | ✅ Ported | Already a client component. Swapped `useEffect`+`fetch("/api/dataset")` for `useQuery(['analytics-dataset'])` → direct Supabase. All four Recharts charts + `useMemo` aggregation preserved verbatim. |
| Changes | `/changes` | `pages/Changes.tsx` | ✅ Ported | Server `await getChangeFeed` → `useQuery(['changes'])`. `next/link`→RR `Link`. Empty-state + timeline markup unchanged. |
| Overview | `/` | `pages/Overview.tsx` | ✅ Ported | Server `await Promise.all([...])` → one `useQuery(['overview'])` returning `{records,count,changeLog}`. KPIs, Sparkline, feed unchanged. `next/link`→`Link`. |
| Applications | `/applications` | `pages/Applications.tsx` | ✅ Ported | `await searchParams` → `useSearchParams`. Native `<form>` GET → `onSubmit` → `setSearchParams` (stays in-SPA, no reload). Server filters in `queryKey ['applications',{q,council,decision}]`; client filters (minDocs/from/to) unchanged. |
| Application detail | `/applications/:id` | `pages/ApplicationDetail.tsx` | ✅ Ported | `await params` → `useParams`. `notFound()` → render `<NotFound/>`. Tabs, SourceActions, signed-URL document links unchanged. Most complex page. |
| Not found | `*` | `pages/NotFound.tsx` | ✅ New | Replaces Next's built-in 404 (no custom original existed). Minimal on-brand page. |

### Shared / infrastructure
- `lib/supabase.ts` — browser anon client (replaces server service-role client).
- `lib/planning-api.ts` — port of old `supabase-api.ts`; exact select/join,
  pagination, filters, date parsing, timeline building, and **3600s signed-URL
  TTL with `download` filename** all preserved. JSON fallback removed.
- `lib/types.ts` — `ApplicationRecord` & sibling types lifted from old `api.ts`.
- `lib/utils.ts` — `cn()` verbatim.
- `components/app-shell.tsx` — `usePathname`→`useLocation`, `next/link`→`Link`,
  root `<body>`→`<div>` (body lives in `index.html`), stats fetched via
  `useQuery(['layout-stats'])` instead of server props.
- `components/source-actions.tsx`, `components/loading.tsx`,
  `components/ui/*` — ported verbatim (Next-only `"use client"` directive
  removed where present; it has no meaning under Vite).

---

## Divergences from the original (deliberate)

1. **JSON disk fallback removed (capability removal).** Old `lib/api.ts`,
   `lib/search.ts`, and `api/files/route.ts` read `../output/*.json` and local
   PDFs via Node `fs`. These cannot run in a browser. The SPA is now **100%
   Supabase-driven**. If Supabase is unreachable, pages show empty/error states
   instead of stale local JSON. (Confirmed correct by owner: the old fallback
   was "stale data masquerading as live data.")

2. **Server-render → client-fetch.** The four pages that were async Server
   Components now fetch on the client and show a loading skeleton first. Same
   data, same final UI; the difference is initial render is a skeleton rather
   than fully-formed HTML.

3. **6 API routes deleted, not ported.** All were thin service-role wrappers
   (or the Node-only `files` route). Their logic now runs client-side against
   Supabase with the anon key. Per owner: external callers of
   `/api/search` (redundant) or `/api/analytics` (dead) would 404 after
   cutover — owner is checking on their end.

4. **Form submission mechanism (Applications).** Native GET form → controlled
   `onSubmit` + `setSearchParams`. URL-query-driven filtering behavior is
   preserved; the page no longer does a full reload on search.

5. **`"use client"` directives dropped** from ported components — Next-only, inert
   under Vite.

---

## Followups (NOT done — separate task, per "convert, don't improve")

- **Bundle size.** Single JS chunk ~1.14 MB (~335 KB gzip) — Recharts +
  framer-motion + supabase-js. Vite warns >500 KB. Could code-split (lazy-load
  Analytics/Recharts) or set `manualChunks`. Left as-is to preserve behavior.
- **Duplicate 100-row fetch.** `AppShell` (`['layout-stats']`) and `Overview`
  (`['overview']`) each fetch the first 100 applications under different
  queryKeys → two network calls of the same rows on the home page. Could share
  a key/hook. Left as-is to honor the exact per-page queryKeys specified.
- **Routing under a sub-path.** Uses `BrowserRouter` (clean URLs). The host must
  provide SPA fallback (`try_files $uri /index.html` on nginx, or equivalent).
  If deployed under a sub-path, set Vite `base` and Router `basename`, or switch
  to `HashRouter` for zero server config. Decide at hosting time.
- **`api/search` / `api/analytics` redundancy & dead `lib/search.ts`/minisearch**
  existed in the original; not carried over. `minisearch` dropped from deps.
- **Leaked service-role key** in old `dashboard/.env.local` — owner is rotating
  independently (security task, not migration).
- **`VITE_SUPABASE_DOCUMENTS_BUCKET`** is included for parity but unused by the
  read path (documents carry their own `storage_bucket` per row).

---

## Open assumption flagged for the owner

`supabase-rls.DRAFT.sql` assumes **one SELECT policy on `storage.objects`** is
enough for the anon role to mint signed URLs on the private `planning-documents`
bucket. This could not be verified without applying the migration against the
live project. If document links fail to sign after the migration is applied
(UI would fall back to each doc's original `source_url`), the storage policy may
need adjustment — surface it rather than guessing. (Per Phase 3 stop-condition.)
