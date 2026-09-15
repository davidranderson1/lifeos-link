// LifeOS live tracker API — edge function "lifeos-deck"
// v6 (2026-09-15): summary line cut at a word boundary. v5 (2026-09-15): "money" band — the state action also returns the latest Advisor read for the tracker's owner
//   (bb_advisor_runs metrics + open advice), so the Live Tracker shows net worth, cash cover, cards owing and open advice.
//   The Advisor lives in bbetter (app.bbetter.io/advisor); this function only reads what it wrote. Board item 35.
// v4 (2026-09-15): email-link sign-in (Supabase Auth, same as the bbetter app) accepted alongside the access key.
//   Access is granted when EITHER body.k equals lifeos_config.deck_key
//   OR the Authorization: Bearer <user JWT> belongs to an email listed in lifeos_config.deck_users (comma-separated).
// v3: priority band "Needs David now"
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
};
const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS } });

function periodMs(unit: string, n: number): number {
  const day = 86400000;
  if (unit === "day") return n * day;
  if (unit === "week") return n * 7 * day;
  return Math.round(n * 30.44 * day);
}

async function reconcile() {
  const { data: rows } = await db.from("lifeos_items").select("id,state,repeat_unit,repeat_n,last_done,streak").not("repeat_unit", "is", null);
  const now = Date.now();
  for (const r of rows ?? []) {
    const p = periodMs(r.repeat_unit, r.repeat_n ?? 1);
    const ld = r.last_done ? new Date(r.last_done).getTime() : 0;
    if (r.state === "done" && ld && now - ld >= p) {
      await db.from("lifeos_items").update({ state: "open", completed_at: null, updated_at: new Date().toISOString() }).eq("id", r.id);
    } else if (r.state === "open" && ld && now - ld >= 2 * p && r.streak > 0) {
      await db.from("lifeos_items").update({ streak: 0, updated_at: new Date().toISOString() }).eq("id", r.id);
    }
  }
}

type Who = { ok: true; via: "key" | "email"; email?: string; uid?: string; owner_email?: string } | { ok: false; reason: string };

// Two doorways, checked in order: the access key in the body, then a Supabase Auth session (email link).
async function authorise(req: Request, b: Record<string, unknown>): Promise<Who> {
  const { data: cfgRows } = await db.from("lifeos_config").select("key,value").in("key", ["deck_key", "deck_users"]);
  const cfg: Record<string, string> = {};
  for (const r of cfgRows ?? []) cfg[r.key] = r.value;
  const allowed = String(cfg.deck_users ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

  const k = String(b.k ?? "");
  if (k && cfg.deck_key && k === cfg.deck_key) return { ok: true, via: "key", owner_email: allowed[0] };

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (token) {
    const { data, error } = await db.auth.getUser(token);
    const email = String(data?.user?.email ?? "").trim().toLowerCase();
    if (error || !email) return { ok: false, reason: "sign-in expired — request a new email link" };
    if (allowed.includes(email)) return { ok: true, via: "email", email, uid: data?.user?.id, owner_email: email };
    return { ok: false, reason: "that sign-in is not on the tracker's list" };
  }
  return { ok: false, reason: k ? "invalid key" : "not signed in" };
}

// The bbetter user whose Advisor read the tracker shows: the signed-in member, or (key doorway) the first email on the tracker's list.
async function ownerUid(who: Extract<Who, { ok: true }>): Promise<string | null> {
  if (who.uid) return who.uid;
  if (!who.owner_email) return null;
  const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const u = (data?.users ?? []).find((x) => String(x.email ?? "").toLowerCase() === who.owner_email);
  return u?.id ?? null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : (v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null)));

// First sentence of the Advisor's summary, cut at a word boundary when it runs long.
function firstLine(text: string): string {
  const first = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  if (first.length <= 240) return first;
  const cut = first.slice(0, 240);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 160)).replace(/[,;:\s]+$/, "") + " …";
}

// Latest Advisor read for the owner — null when the Advisor has never run for them.
async function money(uid: string | null) {
  if (!uid) return null;
  const { data: run } = await db.from("bb_advisor_runs").select("id,status,model,summary,metrics,created_at")
    .eq("user_id", uid).in("status", ["ok", "rules_only"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!run) return null;
  const m = (run.metrics ?? {}) as Record<string, any>;
  const t = m.totals ?? {}, f = m.flow ?? {}, l30 = f.last30 ?? {}, d = m.data ?? {};
  const { data: advice } = await db.from("bb_advice").select("title,severity,kind,lane").eq("user_id", uid).eq("status", "new")
    .order("severity", { ascending: true }).order("updated_at", { ascending: false }).limit(50);
  const rank: Record<string, number> = { urgent: 0, attention: 1, info: 2 };
  const open = (advice ?? []).slice().sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
  const summary = String(run.summary ?? "").trim();
  return {
    as_of: run.created_at, status: run.status, model: run.model ?? null,
    net_worth: num(t.net_worth), net_worth_personal: num(t.net_worth_personal), net_worth_business: num(t.net_worth_business),
    cash: num(t.cash), credit_owed: num(t.credit_owed), credit_cards_owing: num(t.credit_cards_owing),
    accounts_total: num(t.accounts_total), accounts_without_balance: num(t.accounts_without_balance),
    balances_oldest_days: num(t.balances_oldest_days),
    spend_30d: num(l30.spend), income_30d: num(l30.income), net_30d: num(l30.net),
    spend_change_pct: num(f.spend_change_pct), runway_months: num(f.runway_months), monthly_spend_avg: num(f.monthly_spend_avg),
    last_transaction: d.last_transaction ?? null, days_since_last_transaction: num(d.days_since_last_transaction),
    open_advice: open.length,
    top_advice: open.slice(0, 3).map((a) => ({ title: a.title, severity: a.severity, kind: a.kind })),
    summary_line: summary ? firstLine(summary) : null,
    advisor_url: "https://app.bbetter.io/advisor",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return j({ ok: false, reason: "POST only" }, 405);
  const b = await req.json().catch(() => ({}));
  const who = await authorise(req, b);
  if (!who.ok) return j({ ok: false, reason: who.reason }, 401);
  const action = String(b.action ?? "");

  if (action === "state") {
    await reconcile();
    const [{ data: items }, uid] = await Promise.all([
      db.from("lifeos_items").select("*").order("created_at", { ascending: true }),
      ownerUid(who).catch(() => null),
    ]);
    const now = Date.now();
    const out = (items ?? []).map((r: Record<string, unknown>) => {
      let due_now = false;
      if (r.repeat_unit) {
        const p = periodMs(r.repeat_unit as string, (r.repeat_n as number) ?? 1);
        const ld = r.last_done ? new Date(r.last_done as string).getTime() : 0;
        due_now = r.state !== "done" && (!ld || now - ld >= p);
      }
      return { ...r, due_now };
    });
    // priority band: rows Claude flagged as needing David now, oldest first
    const needs_now = out.filter((r: Record<string, unknown>) => r.priority === "now" && r.state !== "done")
      .sort((a: Record<string, unknown>, b2: Record<string, unknown>) => String(a.priority_set_at ?? "") < String(b2.priority_set_at ?? "") ? -1 : 1);
    const mny = await money(uid).catch(() => null);
    return j({ ok: true, items: out, needs_now, money: mny, now: new Date().toISOString(), who: { via: who.via, email: who.email ?? null } });
  }

  if (action === "complete" || action === "reopen" || action === "set_state" || action === "set_priority") {
    const id = String(b.id ?? "");
    const { data: it } = await db.from("lifeos_items").select("*").eq("id", id).maybeSingle();
    if (!it) return j({ ok: false, reason: "item not found" }, 404);
    const nowIso = new Date().toISOString();
    let patch: Record<string, unknown> = { updated_at: nowIso };
    if (action === "complete") {
      if (it.repeat_unit) {
        const p = periodMs(it.repeat_unit, it.repeat_n ?? 1);
        const ld = it.last_done ? new Date(it.last_done).getTime() : 0;
        const streak = ld && Date.now() - ld <= 2 * p ? (it.streak ?? 0) + 1 : 1;
        patch = { ...patch, state: "done", completed_at: nowIso, last_done: nowIso, completions: (it.completions ?? 0) + 1, streak, best: Math.max(it.best ?? 0, streak) };
      } else {
        patch = { ...patch, state: "done", completed_at: nowIso, priority: null };
      }
    } else if (action === "reopen") {
      patch = { ...patch, state: "open", completed_at: null };
    } else if (action === "set_priority") {
      const pr = b.priority === "now" ? "now" : null;
      patch = { ...patch, priority: pr, priority_set_at: pr ? nowIso : null };
    } else {
      const st = String(b.state ?? "");
      if (!["open", "waiting", "scheduled", "parked", "done"].includes(st)) return j({ ok: false, reason: "bad state" }, 400);
      patch = { ...patch, state: st, completed_at: st === "done" ? nowIso : null };
      if (st === "done") patch.priority = null;
    }
    const { data: updated, error } = await db.from("lifeos_items").update(patch).eq("id", id).select().maybeSingle();
    if (error) return j({ ok: false, reason: "update failed" }, 500);
    return j({ ok: true, item: updated });
  }

  if (action === "add_item") {
    const domain = ["personal", "ventures", "fluidseal"].includes(String(b.domain)) ? String(b.domain) : "personal";
    const lane = ["Health", "Wealth", "Happiness", "Operations"].includes(String(b.lane)) ? String(b.lane) : "Operations";
    const title = String(b.title ?? "").trim().slice(0, 600);
    if (!title) return j({ ok: false, reason: "title required" }, 400);
    const pr = b.priority === "now" ? "now" : null;
    const row: Record<string, unknown> = {
      domain, lane, title, state: "open",
      owner: String(b.owner ?? "David").slice(0, 120),
      next_step: String(b.next_step ?? "").slice(0, 600) || null,
      due_text: String(b.due_text ?? "").slice(0, 120) || null,
      reference_url: String(b.reference_url ?? "").slice(0, 600) || null,
      reference_label: String(b.reference_label ?? "").slice(0, 200) || null,
      source: String(b.source ?? "live tracker").slice(0, 200),
      priority: pr, priority_set_at: pr ? new Date().toISOString() : null,
    };
    const { data: created, error } = await db.from("lifeos_items").insert(row).select().maybeSingle();
    if (error) return j({ ok: false, reason: "insert failed" }, 500);
    return j({ ok: true, item: created });
  }

  return j({ ok: false, reason: "unknown action" }, 400);
});
