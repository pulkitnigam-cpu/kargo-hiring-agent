# Kargo Hiring Agent

CV screening and candidate follow-through for Kargo's PM and SPM roles.
`SPEC.md` is the source of truth; this README tracks what's built.

## Run it

```bash
npm install --legacy-peer-deps
npm run setup      # creates prisma/dev.db, seeds Rubric B + both JDs
npm run dev        # http://localhost:3000
```

Other scripts: `npm test` (unit tests), `npm run backtest [-- 3]` (scores the 8
past hires with the live AI and checks them against §8.4; `3` also runs the
consistency check), `npm run fixtures` (builds `fixtures/test_applications.zip`),
`npm run db:reset` (wipes candidates and stored CVs, then re-seeds).

Scoring uses Google Gemini: set `GEMINI_API_KEY` in `.env` (model: `GEMINI_MODEL`,
default `gemini-3.1-pro-preview`; `GEMINI_CONCURRENCY`, default 2). Restart
`npm run dev` after editing `.env`.

## Status

| Phase | State |
|---|---|
| 0 Setup: schema (§13.2), env, seed, `/rubric` | Done |
| 1 Ingestion: Upload CV, **Bulk upload**, parse, dedupe, Needs manual look | Done |
| 2 Scoring engine: blinding, AI scoring with quote checks, bands, §9 roles, insights | Built; live back-test pending an API key |
| 3 Dashboard: side panel, ↑/↓ moves with reasons, role change, nudges, audit log | Done (tested on stub scores) |
| 4 Emails: drafts, checks, bulk send, 10-min undo, Outbox, 7-day Hold, login | Done (tested end to end in test mode) |
| 5 Rubric v2 (tightened), editor → new version, re-score all, calibration | Done |
| 6 Insights: §16 metrics, overrides, calibration, blind agreement test | Done; the test itself needs Arjun |
| Hosting: Dockerfile + render.yaml, retention cleanup | Ready; needs your Render account |

## Bulk upload: how it behaves

- **Accepts** any mix of PDF, DOCX, zips (including zips inside zips), whole
  folders (picker or drag-and-drop), and an optional CSV.
- **Role tag**, in order of priority: CSV `role` column → a `PM`/`SPM` folder or
  file name (`SPM/karan.pdf`, `priya_pm.docx`) → an "Applying for: …" line in
  the CV → the tag picked for the batch → untagged (assigned by rubric, §9).
- **Applied date**: CSV → date picked for the batch → today.
- **CSV columns**: `filename, role, applied_date, august_contact`. The modal has
  a template download. Dates take `yyyy-mm-dd` or `dd/mm/yyyy`.
- **Duplicates**: the same file (SHA-256) or the same email, within the batch or
  against earlier uploads. The first upload wins; each skip is listed with the
  reason.
- **Needs manual look** (never dropped): corrupt or password-protected files,
  `.doc` and other formats, CVs with under 200 characters of text (scanned
  images), and CVs with no email address (they can't be contacted).
- **Silently skipped**: OS clutter only (`.DS_Store`, `__MACOSX`, `~$` Word lock
  files, `Thumbs.db`).
- Originals are kept in `storage/cvs/` and served at `/api/cv/:candidateId`.

## Scoring: how it behaves

- Starts by itself after every upload, and after Arjun approves the rubric on
  `/rubric` (nothing is scored before approval). A **Score now** button covers
  anything left waiting.
- The AI sees a **blinded** CV: no name, contact line, home city, education
  section, college names, age, family or gendered words.
- One AI call per CV scores all nine criteria 0–4 with a verbatim quote. The
  system computes both the PM and SPM totals from the same scores (as the §8.4
  back-test does), so changing a role later is a recalculation.
- A quote not found in the blinded CV (≥90% token match) caps that score at 1,
  flags it, and marks the row ⚠ (to be excluded from bulk send in Phase 4).
- Bands: **75+ Selected · 60–74 Hold · under 60 Rejected**, after rounding
  half up (74.6 → 75).
- Roles (§9): tagged CVs keep their tag, with a flag if the other role scores
  15+ higher. Untagged CVs by years of PM experience: under 4 → PM, 4–5 grey
  zone (higher score, with "Arjun to confirm" when within 5), over 5 → SPM.
  Years outside the JD's range are flagged, not rejected.
- If the AI output is invalid 3 times, or the AI declines, the CV moves to
  Needs manual look. API or credential problems stop the run with a message on
  the dashboard; nothing is lost.

## Reviewing: how it behaves

- Click a name to open the side panel (§11.3) next to the ranked list; on a
  phone it fills the screen. `/candidates/:id` is the same view as a page.
- **Move** with ↑/↓ on a row, or the Selected / Hold / Rejected buttons in the
  panel. Each move asks for an optional one-line reason. The score never
  changes; the row gets "Moved by Arjun" when the decision differs from the
  rubric's band. After an email has gone out (Phase 4), the move warns first.
- **Change role** re-weights the stored criterion scores (no AI call), shows
  the new score and band before confirming, and re-proposes the band from it.
- **Details** in the panel: applied date, the August "let's chat" flag, and a
  missing email (adding one sends a readable CV on to scoring).
- Opening a ⚠ candidate marks them reviewed, which Phase 4 needs before they
  can go in a bulk send.
- `/audit` lists every upload, score, move, role change and edit, with the
  reason and rubric version.
- Nudges: rubric not approved, CVs needing a manual look, flagged candidates not
  yet opened, roles to confirm, August candidates not yet contacted, 15+ Selected.
  Set `ROLES_OPENED_AT=yyyy-mm-dd` in `.env` to show days open per role.

## Emails: how they behave

- **Drafts** are written when a candidate's panel opens, or for everyone at
  once by the bulk buttons. The fixed wording comes straight from §12; Gemini
  (`GEMINI_EMAIL_MODEL`, default `gemini-3.8-flash`) writes only the personal
  sentences, from the CV quotes. The system picks the type: Selected → invite,
  Hold → hold note, Rejected → regret (close call if the score was 60+ or they
  had a hold note, clear no otherwise). The reason line is the largest weighted
  gap, or the experience line when the range rule fired.
- **Post-checks** (§13.4) block sending: scores, banned words (rubric, rank,
  criteria, AI, algorithm, other candidates), over 150 words, wrong first name,
  missing reason line, unfilled placeholders, and personal lines that don't
  trace to the CV. Arjun can edit any draft; his edit counts as approved.
- **Sending:** "Send to all selected / Send hold notes / Send regrets" on each
  tab, or ✉ Send in the panel. One confirmation, then each email waits
  `UNDO_MINUTES` (10) in the **Outbox** with a countdown and Undo. Flagged ⚠
  candidates stay out of bulk send until opened. One email per candidate per
  status; "Send again" is explicit.
- **After sending:** Selected → Invited, Hold → Hold note sent (decide within
  7 days), Rejected → Regret sent. On day 7 the dashboard nudges and offers
  close-call regrets for holds that are due. Moving a candidate or changing
  their role cancels any unsent or queued email for the old decision.
- **Test mode** (`TEST_MODE=true`, the default) sends every email to
  `TEST_RECIPIENT` with the real candidate in the subject. Real sending needs
  Kargo's domain verified in Resend and `FROM_EMAIL` set to Arjun's address.
- **Delivery status** (delivered/bounced) is read from Resend every minute,
  which needs a *Full access* key; a *Sending access* key sends but can't read
  status (the Outbox says so).

## Rubric versions

- **v1** is Rubric B as written in the spec. **v2** keeps the same criteria and
  weights but defines every level 0–4 with observable tests, rules on the edge
  cases that made scores swing, and adds a tie-break ("pick the lower level").
- **Edit (creates vN)** on `/rubric` saves a new, unapproved version; scoring
  keeps using the newest *approved* one. After approving, **Re-score all**
  recalculates everyone: Arjun's moves, role choices and anything already
  emailed keep his decision; old scores stay on record under their version.

## Insights (`/insights`)

- §16 success metrics, with the > 30% override nudge.
- Every override: score, rubric band, Arjun's band, his reason.
- **Calibration**: scores the 8 past hires (`data/hires`, ratings in
  `ratings.json`) with the current rubric and shows which criteria separate
  Exceeds from Meets/Below.
- **Agreement test** (§15.3): 10 scored CVs spread across the bands, shown one
  at a time with no score; Arjun makes his call; the result is compared with
  the rubric (target 8 of 10).

## Data retention

Daily, candidates whose regret went out more than `RETENTION_DAYS` (180) ago
are deleted with their CV files; their audit entries keep no personal data.
Candidates still waiting to hear back are never deleted.

## Hosting (Render)

1. Push this folder to a GitHub repo (`.env`, the database and CVs are
   git-ignored and never leave your machine).
2. In Render: **New → Blueprint** → pick the repo. `render.yaml` creates a
   Docker web service with a 1 GB disk at `/data` (database + CVs).
3. Enter the secrets it asks for: `DASHBOARD_PASSWORD`, `GEMINI_API_KEY`,
   `RESEND_API_KEY`, `TEST_RECIPIENT`, optionally `CAL_LINK` and
   `REPLY_TO_EMAIL`.
4. Open the URL, sign in, approve the rubric, upload the CVs.

Real (non-test) sending: verify Kargo's domain in Resend, set `FROM_EMAIL` to
Arjun's address on it, and `TEST_MODE=false`.

## Login

Set `DASHBOARD_PASSWORD` to require a password on every page and API route
(one shared login, 14-day session). Locally it's optional; in production the
app refuses to serve without one.

## Decisions taken where the spec was open

- The dedupe rule "file hash + email" is read as **either** match.
- Applying for both roles with one email counts as a duplicate, and the first
  upload wins. Arjun can switch the role later (§9.3).
- Rubric v1 is seeded unapproved; approval is a button on `/rubric`.
- One AI call per CV instead of one per role (§13.3): the anchors don't depend
  on the role, and it keeps the two totals consistent.
- **AI provider is Google Gemini**, not the Anthropic SDK in §13.1 (the spec
  allows swapping the stack).
- `temperature: 0` (§13.1) is not used: Google advises keeping Gemini 3 at its
  default 1.0. `npm run backtest -- 3` measures consistency against the
  ≤3-point target.
- Quotes are checked against the blinded text the AI saw, not the raw CV.
- Low confidence keeps the candidate in their band with a ⚠ flag (§10.4)
  instead of moving them to Needs manual look (§6.4 said both).
- The Vikram SPM total in §8.4 is 32; the formula gives 32.5, which rounds to 33.
- A role change re-proposes the band from the new score, replacing any earlier
  move (the popover says so before confirming).
- The AI writes only the personal sentences of each email; the system
  assembles the rest from §12's fixed text (safer than letting it write the
  whole email and checking afterwards).
- Consistency: each CV is scored twice, with a third run when they disagree,
  and the median kept. With rubric v2's tighter anchors, the 3-pass back-test
  gave spreads of 0 for Sunita, Aditya, Preetham and Meghna (Aditya and
  Preetham swung 13–15 points under v1), 3 for Vikram and 5 for Rohan;
  Lavanya 95 (Selected), Vikram 28 (Rejected). Runs that still disagree by 2+
  points on a criterion get an "unstable" ⚠ flag for Arjun.
- "FMS" is not treated as a college name (in logistics CVs it means Freight
  Management System).

## Notes

- Scripts are plain `.cjs`, and tests run on Node's built-in TypeScript
  stripping (`node --experimental-strip-types`), because esbuild (tsx/vitest)
  couldn't run on the build machine.
- The project must live outside Windows' virtualized app folders (e.g. `C:\dev`).
  Otherwise Prisma's engine binary can't be launched.
