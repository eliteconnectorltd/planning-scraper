# Phase 9 Architecture

## Persistence Flow

```mermaid
flowchart LR
  Planit[Planit API] --> Scraper[src/index.js]
  Scraper --> Adapter[Portal adapters]
  Adapter --> Downloads[Download manager]
  Downloads --> Intelligence[Intelligence pipeline]
  Scraper --> JSON[JSON outputs]
  Downloads --> JSON
  Intelligence --> JSON
  Scraper --> Supabase[(Supabase Postgres)]
  Downloads --> Supabase
  Intelligence --> Supabase
  Platform[src/platform] --> Supabase
  Dashboard[Next dashboard APIs] --> Supabase
  Dashboard --> JSONFallback[JSON fallback]
```

## Worker Topology

```mermaid
flowchart TB
  Queue[(Redis / BullMQ)]
  Scheduler[retryWorker] --> Queue
  Queue --> Scrape[scrapeWorker]
  Queue --> Download[downloadWorker]
  Queue --> Intel[intelligenceWorker]
  Scrape --> Supabase[(Supabase)]
  Download --> Supabase
  Intel --> Supabase
  Scrape --> DLQ[dead-letter queue]
  Download --> DLQ
  Intel --> DLQ
```

## Compatibility Contract

- JSON outputs remain enabled.
- Supabase writes are best-effort unless `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are present.
- Redis workers are optional and can run independently from the local MVP pipeline.
- Browser challenge handling classifies blocks and preserves diagnostics; it does not attempt to bypass protected systems.
