# Tracker test suite

~70 jsdom tests plus a runner. They boot the whole app in a headless DOM against an in-memory
stand-in for Supabase, so they never touch the live database.

    node tests/run-all.js          # everything
    node tests/run-all.js 2/3      # one slice, to fit a short command timeout
    node tests/run-all.js --quick  # skip the slowest files

In this repo the app is `index.html`; in Adam's working folder the same file is
`research-tracker.html`, which is the name the tests look for. CI copies one to the other.

Six tests read the Supabase edge-function sources, which are kept out of this public repo. The
runner detects their absence and skips them rather than failing — a red run should always mean
something is actually broken.
