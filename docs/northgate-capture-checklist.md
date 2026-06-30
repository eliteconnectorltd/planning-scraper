# Northgate Documents — DevTools / HAR Capture Checklist

Purpose: capture the real network traffic behind the Northgate "Documents" view so
the `NEEDS-CAPTURE` gaps in `platform-network-analysis.md` become hard evidence.
Two councils: **Wandsworth 2024/4298** and **one decided Birmingham app**.

---

## 0. One-time browser setup (do this before every capture)

1. Use **Chrome (or Edge)**, a **fresh Incognito window** (so the session/cookies
   captured are exactly the ones the page creates — nothing from your normal profile).
2. `F12` → **Network** tab. Then set:
   - ✅ **Preserve log** (so navigation between hosts doesn't clear the log)
   - ✅ **Disable cache** (checkbox in the Network tab)
   - Filter row: start on **All** (we want the navigation docs too), you'll switch
     to **Fetch/XHR** when looking for the list call.
3. Leave DevTools open and docked to the side for the whole flow.

---

## 1. Wandsworth — 2024/4298

Known from Phase 1 probe (already confirmed, no need to re-capture):
- Detail page (internal id `PARAM0=1174186`):
  `https://planning.wandsworth.gov.uk/Northgate/PlanningExplorer/Generic/StdDetails.aspx?…PARAM0=1174186&XSLT=…/PLDetails.xslt…`
- Documents subsystem link (uses the **reference**, not PARAM0):
  `https://planning2.wandsworth.gov.uk/planningcase/comments.aspx?case=2024/4298`

**Capture steps:**

1. Clear the Network log (🚫 icon). Navigate to:
   `https://planning2.wandsworth.gov.uk/planningcase/comments.aspx?case=2024/4298`
2. **Wait for the document list to fully render on screen** (the rows under
   "List documents" / "Document type"). The request that fills that list is the
   prize — it fires *after* the initial HTML.
3. Switch the filter to **Fetch/XHR**. Look for the request whose **Response**
   (Preview tab) contains the document rows. Also check **Doc** filter in case it's
   a full-page `__doPostBack` re-render instead of an XHR.
4. Click that request → record from these DevTools tabs:
   - **Headers** tab → *General* (Request URL, Request Method), *Request Headers*
     (all — especially `Content-Type`, `Cookie`, any `X-*`), *Response Headers*
     (`Content-Type`).
   - **Payload** tab → the full request body **verbatim** (if POST: the
     `__VIEWSTATE`, `__EVENTTARGET`, `__EVENTARGUMENT`, or JSON — paste it all,
     even if huge; `__VIEWSTATE` can be truncated to first/last 100 chars + note its length).
   - **Response** tab → first ~40 lines (enough to see how one document row is
     structured: id/name/date/type/url fields).
5. Now **click a single document to download it.** In the Network log, find the
   request that returns the file (Content-Type `application/pdf` or an attachment).
   Record its **Request URL, Request Method, Request Headers (incl. Cookie),** and
   **Response Headers** (`Content-Type`, `Content-Disposition`).
6. **HAR export:** right-click anywhere in the Network request list →
   **Save all as HAR with content** → name it `wandsworth-2024-4298.har`.

---

## 2. Birmingham — one decided application (last 3–6 months, documents visible)

Find a target first (don't assume the host/ref — confirm it live):

1. Go to Birmingham's planning search and open a **decided/approved** application
   from the last 3–6 months that shows documents. (Birmingham runs Northgate
   Planning Explorer; confirm the actual host from the address bar — the documents
   subsystem may be a different host than the search host, exactly like Wandsworth's
   `planning.` vs `planning2.`.)
2. Note both: the **detail page URL** (look for `PARAM0=` / internal id) and the
   **Documents link URL** (look for whether it uses the human **reference** or the
   internal id — this is the two-ID question).

**Then run the identical capture flow as Wandsworth steps 1–6**, saving the HAR as
`birmingham-{ref}.har`.

The reason for a second council: it tells us whether the Northgate documents call
is **the same shape across councils** (→ one adapter, pattern-transform the IDs) or
**per-council bespoke** (→ per-council config like Salesforce). That single fact
drives the entire Phase 2 effort/coverage estimate for Northgate.

---

## 3. What to paste back (minimum viable evidence)

Best: attach/paste the two **HAR files** (they contain everything below).

If HAR is awkward, paste this per council instead — for **both** the list call and
the download call:

```
COUNCIL / REF:
--- DOCUMENT LIST CALL ---
Method + URL:
Request headers (esp. Content-Type, Cookie names, any X-*):
Request body (verbatim; __VIEWSTATE may be length-noted + truncated):
Response Content-Type:
Response body (first ~40 lines — enough to see one document row's fields):
--- DOCUMENT DOWNLOAD CALL ---
Method + URL:
Request headers (esp. Cookie):
Response Content-Type + Content-Disposition:
Does the download URL 200 when pasted into a fresh Incognito tab? (yes/no)
```

That last line (download URL in a fresh tab) is the cheapest test of whether
downloads are **direct/tokenised** (works alone) vs **session-bound** (needs cookies).

---

## 4. Privacy / safety notes

- These are **public registers — no login**, so any cookies captured are anonymous
  session cookies, not credentials. We *need* the cookie **names** (they answer the
  auth question), but you may redact their **values** if you prefer — just keep the
  names and note which request first `Set-Cookie`'d them.
- Don't redact `__VIEWSTATE`/`__EVENTTARGET` — those are the load-bearing postback
  fields we're trying to understand (they're not secret, just bulky).

---

## 5. What I'll do with it (analysis targets a–d)

On paste-back I'll determine:
- **(a)** Is the document list a clean replayable JSON/XML call, or a full-page
  `__doPostBack` re-render we'd have to drive with form state?
- **(b)** Direct vs tokenised download URLs (the fresh-tab test settles this).
- **(c)** Exact auth state: cookies (which, set by which request), headers, and any
  postback/CSRF token continuity.
- **(d)** The **two-ID mismatch** — whether `ref` ⇄ `PARAM0` is a pure pattern
  transform (cheap) or needs a per-application lookup request (a search call before
  the docs call). Comparing Wandsworth vs Birmingham answers whether the shape
  generalises to one adapter or needs per-council config.

Then → Phase 2 with hard Northgate evidence.
