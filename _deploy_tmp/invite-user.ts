// Invite a teammate to the Research Tracker.
//
// Inviting is a privileged operation: it needs the service role key, which can never ship in
// the browser bundle because the app is a public web page. So it lives here instead, and the
// function decides for itself whether the caller is allowed to invite.
//
// Crucially it does NOT trust anything the client says about who it is. The client sends its
// own Supabase access token; we ask Supabase who that token belongs to, and compare that
// verified email against an INVITE_ADMINS allowlist held in this function's own secrets.
//
// Why an allowlist rather than the app's org-chart admin flag: today's RLS policy lets any
// signed-in account write any row in `items`, so a non-admin could set their own profile's
// admin flag to true. Reading admin status from the database would therefore be self-certified
// and worthless. The allowlist is somewhere users cannot write. If per-row RLS policies are
// added later, this can switch to reading the profile instead.
//
// Actions:
//   (none) / invite — send an invite. Warns about likely duplicates unless `confirm` is set.
//   pending         — list accounts invited but never signed in, plus every known address, so
//                     the app can spot one person holding two invites.
//   resend          — send a fresh code to someone who never finished setting up.
//   cancel          — delete a half-made account that has NEVER signed in.
//
// `cancel` is the one destructive action here, added at Adam's explicit request on 2026-09-02
// (his standing rule is that data is hidden rather than removed, unless he names the deletion —
// he did). It is narrow on purpose: the server re-reads the account and refuses if
// `last_sign_in_at` is set, so it can only ever remove an invite nobody accepted. Such an
// account owns nothing — a profile row, and therefore any task or study involvement, only comes
// into existence at first sign-in — so there is nothing to orphan. The point is to free the
// address for re-invitation, which is impossible while the dormant account holds it.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INVITE_ADMINS = (Deno.env.get("INVITE_ADMINS") ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://rushsportsresearch.netlify.app";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Acct = { id: string; email: string; created_at?: string; last_sign_in_at?: string | null; recovery_sent_at?: string | null };

// listUsers() pages at 50, and this team is already past that once you count the people who
// were invited and never came back — so paging isn't hypothetical. Capped so a runaway can't
// spin here forever.
async function allAccounts(admin: ReturnType<typeof createClient>): Promise<Acct[]> {
  const out: Acct[] = [];
  for (let page = 1; page <= 40; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data?.users ?? [];
    users.forEach((u) => out.push({
      id: u.id,
      email: (u.email ?? "").toLowerCase(),
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at ?? null,
      recovery_sent_at: (u as unknown as Record<string, string>).recovery_sent_at ?? null,
    }));
    if (users.length < 200) break;
  }
  return out.filter((u) => u.email);
}

// Two addresses for one person is the thing worth catching, and it shows up in the local part:
// "carla.edwards@rush.edu" and "cedwards@rushortho.com" are the same Carla. Compare the letters
// of the local part only, ignoring dots, digits and separators, and treat a shared surname or a
// containment either way as worth a question. Deliberately advisory — it asks, never refuses,
// because two people really can be a.smith and asmith.
const localOf = (e: string) => e.split("@")[0].toLowerCase().replace(/[^a-z]/g, "");
function looksLikeSamePerson(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  const la = localOf(a), lb = localOf(b);
  if (!la || !lb) return false;
  if (la === lb) return true;
  // Containment: "cedwards" inside "carlaedwards", "alee" inside "adamlee". Needs a decent run
  // of letters, or every three-letter address matches half the directory.
  const [short, long] = la.length <= lb.length ? [la, lb] : [lb, la];
  if (short.length >= 5 && long.indexOf(short) >= 0) return true;
  const parts = (e: string) => e.split("@")[0].toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const pa = parts(a), pb = parts(b);
  if (pa.length && pb.length) {
    // Same surname, distinctive enough to mean something: "a.yanke" vs "adam.yanke".
    const surA = pa[pa.length - 1], surB = pb[pb.length - 1];
    if (surA.length >= 4 && surA === surB) return true;
    // Same first AND last name, with anything in between — a middle initial is the common case,
    // and it's what made "william_k_lee" and "william.lee" look unrelated to the checks above.
    if (pa.length > 1 && pb.length > 1 && pa[0] === pb[0] && surA === surB && pa[0].length >= 3) return true;
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  try {
    // 1. Who is actually calling? The token is verified by Supabase, not parsed by us.
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Not signed in" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: caller, error: callerErr } = await admin.auth.getUser(token);
    if (callerErr || !caller?.user?.email) return json({ error: "Could not verify who you are" }, 401);

    const callerEmail = caller.user.email.toLowerCase();
    // Admin status comes from app_admins, which only an existing admin can change (enforced by
    // RLS plus the profile trigger), so this is self-maintaining: approve someone as an admin
    // and they can invite, with no secret to edit by hand. INVITE_ADMINS remains a break-glass
    // fallback from before app_admins existed.
    const { data: adminRow } = await admin.from("app_admins").select("user_id").eq("user_id", caller.user.id).maybeSingle();
    if (!adminRow && !INVITE_ADMINS.includes(callerEmail)) {
      return json({ error: "Only admins can invite people" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "invite");

    // ---------- pending: who was invited and never came back ----------
    // The app can't work this out for itself. A profile row only appears once someone signs in,
    // so an unfinished invite is invisible from the browser — which is exactly how people ended
    // up invited twice at two addresses with nobody noticing.
    if (action === "pending") {
      const accounts = await allAccounts(admin);
      const { data: profRows } = await admin.from("items").select("id, data").eq("kind", "profile");
      const nameById: Record<string, string> = {};
      (profRows ?? []).forEach((r) => {
        const n = ((r.data as Record<string, unknown>)?.name as string) || "";
        if (n) nameById[r.id as string] = n;
      });
      return json({
        ok: true,
        pending: accounts.filter((u) => !u.last_sign_in_at).map((u) => ({
          id: u.id, email: u.email, invitedAt: u.created_at ?? null, codeSentAt: u.recovery_sent_at ?? null,
        })),
        active: accounts.filter((u) => u.last_sign_in_at).map((u) => ({
          id: u.id, email: u.email, name: nameById[u.id] || "", lastSignInAt: u.last_sign_in_at,
        })),
      });
    }

    // ---------- resend: a fresh code for someone stuck part-way ----------
    if (action === "resend") {
      const target = String(body?.email ?? "").trim().toLowerCase();
      if (!target) return json({ error: "Which address?" }, 400);
      const accounts = await allAccounts(admin);
      const acct = accounts.find((u) => u.email === target);
      if (!acct) return json({ error: `No account for ${target}` }, 404);
      if (acct.last_sign_in_at) return json({ ok: false, alreadyActive: true, message: `${target} has already signed in — nothing to resend.` });
      const { error: reErr } = await admin.auth.resetPasswordForEmail(target, { redirectTo: SITE_URL });
      if (reErr) throw reErr;
      console.log(`invite code resent to ${target} by ${callerEmail}`);
      return json({ ok: true, resent: true, message: `Fresh code on its way to ${target}.` });
    }

    // ---------- cancel: bin an invite nobody accepted ----------
    if (action === "cancel") {
      const target = String(body?.email ?? "").trim().toLowerCase();
      if (!target) return json({ error: "Which address?" }, 400);
      const accounts = await allAccounts(admin);
      const acct = accounts.find((u) => u.email === target);
      // Already gone counts as success: the button may have been tapped twice, and the end state
      // the caller wanted is the end state they have.
      if (!acct) return json({ ok: true, message: `${target} is already gone.` });
      // The guard that makes this action safe. Checked against a fresh read rather than anything
      // the browser sent, so a stale page can't talk the server into deleting a live colleague.
      if (acct.last_sign_in_at) {
        return json({ error: `${target} has already signed in, so this won't delete them. Use the org chart if they've left.` }, 409);
      }
      if (acct.id === callerId) return json({ error: "That's your own account." }, 400);
      const { error: delErr } = await admin.auth.admin.deleteUser(acct.id);
      if (delErr) throw delErr;
      console.log(`unaccepted invite for ${target} deleted by ${callerEmail}`);
      return json({ ok: true, deleted: true, message: `Invite for ${target} deleted — that address is free to invite again.` });
    }

    // 2. Validate the address before spending an invite on it.
    const email = String(body?.email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "That doesn't look like an email address" }, 400);

    const accounts = await allAccounts(admin);

    // 3. Already got an account? Send a password reset instead of a second invite — inviting an
    //    existing user fails, and "they already have one" is rarely the answer people want.
    const already = accounts.find((u) => u.email === email);
    if (already) {
      if (already.last_sign_in_at) {
        return json({ ok: false, alreadyActive: true, message: `${email} already has an active account.` });
      }
      const { error: linkErr } = await admin.auth.resetPasswordForEmail(email, { redirectTo: SITE_URL });
      if (linkErr) throw linkErr;
      return json({ ok: true, resent: true, message: `${email} was already invited but never finished setting up — sent them a fresh sign-in code.` });
    }

    // 3b. Does this look like somebody who's already here under another address? Ask once. The
    //     app resends with confirm:true if Adam says go ahead, so this costs one round trip and
    //     only when there's something to say.
    if (body?.confirm !== true) {
      const similar = accounts.filter((u) => looksLikeSamePerson(u.email, email));
      if (similar.length) {
        const { data: profRows } = await admin.from("items").select("id, data").eq("kind", "profile");
        const nameById: Record<string, string> = {};
        (profRows ?? []).forEach((r) => {
          const n = ((r.data as Record<string, unknown>)?.name as string) || "";
          if (n) nameById[r.id as string] = n;
        });
        return json({
          ok: false,
          needsConfirm: true,
          similar: similar.map((u) => ({
            email: u.email,
            name: nameById[u.id] || "",
            signedIn: !!u.last_sign_in_at,
          })),
          message: `${email} looks like someone who's already been invited.`,
        });
      }
    }

    // Deliberately NOT inviteUserByEmail: Rush's mail security opens links to vet them and spends
    // the one-time token, so a link-based invite arrives dead. Create the account here and send
    // the recovery email, which carries a typed code instead.
    //
    // This did once mail a brand-new colleague an email headed "Reset your password" for a
    // password they had never set — Carla got exactly that on 2026-09-01. The fix was the
    // TEMPLATE, not this call: the recovery template now reads "Set your Research Tracker
    // password", carries a link to the site so people know where to go, and explicitly covers
    // both cases. Both templates also share one subject line, so the recipient can't tell which
    // path sent it. Don't switch this back to inviteUserByEmail without a reason — it would mean
    // two templates to keep in step for no visible gain.
    //
    // email_confirm: true because an admin vouching for the address is the point of an invite;
    // the person still can't get in until they receive the code and choose a password.
    const { error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (createErr) throw createErr;

    const { error: codeErr } = await admin.auth.resetPasswordForEmail(email, { redirectTo: SITE_URL });
    if (codeErr) throw codeErr;

    console.log(`invite (code) sent to ${email} by ${callerEmail}`);
    return json({ ok: true, message: `Invite sent to ${email} — they'll get a code to set their password.` });
  } catch (e) {
    console.error("invite failed:", e);
    return json({ error: (e as Error)?.message || "Invite failed" }, 500);
  }
});
