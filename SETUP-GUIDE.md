# Research Tracker — Setup Guide

No coding required for any of this.

## 1. Try it right now (2 minutes)

1. Open `research-tracker.html` by double-clicking it — it opens in your browser.
2. Go to **Settings → Load Sample Data** to see how it works.
3. **Settings → Erase All Data** when you're ready to enter real studies.

Data is saved automatically on whatever device/browser you use it in.

## 2. Get it on your iPhone (5 minutes)

The file needs to live at a web address so phones can open it. Free options:

**Easiest — Netlify Drop:**
1. On your computer, go to **app.netlify.com/drop** (create a free account).
2. Drag the `research-tracker.html` file onto the page. Rename it `index.html` first.
3. You get a link like `https://something.netlify.app` — open it on your iPhone.
4. In Safari: tap **Share → Add to Home Screen**. It now looks and launches like a real app.

Send the link to your team — they do the same Add to Home Screen step.

> Note: until you set up Team Sync (step 3), each person's data is separate, stored on their own device.

## 3. Team Sync — everyone sees the same data (10 minutes, optional)

Uses Supabase, a free cloud database.

1. Go to **supabase.com** → sign up free → **New Project** (any name, e.g. "research-tracker"; choose a strong database password and save it somewhere).
2. Wait ~2 minutes for the project to be created.
3. In the left sidebar, open **SQL Editor**, paste this, and click **Run**:

```sql
create table items (
  id uuid primary key,
  kind text not null,
  data jsonb not null,
  updated_at timestamptz default now()
);
alter table items enable row level security;
create policy "team access" on items for all using (true) with check (true);
```

4. In the left sidebar: **Project Settings → API Keys**. Copy two things:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon / public key** (long string of letters)
5. In the app: **Settings → Team Sync**, paste both, tap **Connect Team Sync**.
   Your existing data uploads automatically.
6. Have each team member do step 5 with the same URL and key (just text them the two values).

Now everyone shares one live workspace. The app refreshes whenever you reopen it.

**Team features once synced:** add your lab members under Settings → Team Members (used for task assignment suggestions), and have each person set "Your name" in Settings — that powers the "Mine" task filter and stamps document uploads. Manuscript files uploaded on a study (up to 8 MB each) and abstract submission histories are shared with the whole team — no extra Supabase setup needed. Without sync, files stay on your own device (max 2.5 MB each).

**Security note:** anyone who has the URL + key can read/write the data, so only share within your team. Since the app stores no patient identifiers (study-level info only), this is appropriate for its purpose — but don't put PHI in notes fields.

## 4. Abstract deadline board

The dashboard shows a live countdown to upcoming abstract deadlines across orthopedic societies (AAOS, AANA, AOSSM, IPSG, ICRS). Days-to-deadline recalculate every time you open the app, and past deadlines drop off automatically.

The dashboard has two boards: **Abstract Deadlines** and **Grant & Funding Deadlines**, each with live countdowns.

Verified deadlines currently seeded (checked June 2026):
- **AAOS** abstracts due **June 8, 2026** (2027 Las Vegas meeting).
- **AANA** abstracts due **August 10, 2026** (AANA27, Hollywood FL).
- **OREF grants:** Mentored Clinician Scientist & Resident Research Project (June 24), Clinical Research Award (July 1), ORS/OREF Distinguished Investigator (Sept 11).
- **AOSSM grants:** AF Hip Osteoarthritis full proposal (June 26), Sandy Kirkley (July 31), JRF Ortho Allograft (Aug 1), Arnoczky Young Investigator full proposal (Sept 20).
- **AOSSM abstracts** 2026 cycle is closed; **AANA grant** cycle is closed (both noted, no active date).
- **ICRS** Summit (Oct 2026) and World Congress (May 2027) have no published abstract deadline yet; **IPSG** is members-only; **AAOS grants** run through OREF — these stay flagged ⚠︎ until confirmed.

**Study lifecycle & initiation.** Studies start at **Concept**, then **Initiation**, then the data phase (Enrolling / Data Extraction / Experiments depending on design). While a study is in Initiation, its page shows a checklist — Sports study submission completed, IRB approved, CA approved, PIQ project built — and a final **Study Ready for Enrollment** gate. Checking that gate automatically moves the study into Enrolling. (Older IRB/Protocol phases from earlier data are folded into Initiation automatically.)

**Enrollment.** Each study has Enrolled / Target fields (set them in the study form). Enrolling and Initiation studies show a progress bar and an at-a-glance "62/150 enrolled" on their card.

**Linking deadlines from a study.** On a study's page, the Grant & Submission Deadlines section has a dropdown of every grant and abstract deadline from the dashboard — pick one to link it — plus a free-text row to add a custom deadline (it also appears on the dashboard board). Linked items show on both the study and the deadline's dashboard row.

Tap any deadline on the dashboard to expand it. **Grants** show a one-sentence aim, the eligibility/criteria to apply, and the 3 most recently funded study titles (where verified — Sandy Kirkley's are filled in; others link out to the society's recipients page until confirmed). Every deadline (grant or abstract) also lists its **Linked Projects** — tap "Link a project" to associate your studies. Linked items appear at a glance on the dashboard row (e.g. "2 projects") and in each study's own **Grant & Submission Deadlines** section, where you can also link from the study side. Associations sync to your team; the auto-refresh never disturbs them.

Add or edit any entry via **+ → New Deadline** (pick Abstract or Grant; grant fields for aim/criteria/funded appear when you choose Grant). With Team Sync on, the list is shared with your lab; show/hide by society (now including OREF) under Settings → Society Subscriptions is personal to each device.

These dates are accurate as of June 2026.

**Auto-refresh (biweekly):** A scheduled task runs on the 1st and 15th of each month, opens each society's site in the browser, and rewrites `deadlines.json` (which lives next to the app file) with any confirmed dates. The app fetches that file on launch, so refreshed deadlines flow to every team device automatically. Two things to know:
- For this to reach your team, host `deadlines.json` in the **same folder** as the app (re-drag both files to Netlify together). Opened as a plain local file, the app falls back to its built-in seeds.
- The scheduled task runs only while the Claude desktop app is open, and the first run will ask you to approve the browser tools — click **Run now** on the task once (Scheduled section in the sidebar) to pre-approve, so future runs don't pause. It won't overwrite a date you set manually unless it confirms a genuinely newer one from the official source.

## 5. Backups

**Settings → Export Data** downloads a JSON backup file. Do this occasionally; **Import Data** restores it.

## 6. Want changes?

Just ask in this project — e.g., "add an enrollment counter to studies," "add a funding/grant field," "change the phases." I'll update the file; re-drag it to Netlify to redeploy.
