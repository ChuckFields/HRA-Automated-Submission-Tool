/**
 * Everything the IBX member-portal adapter knows about the site lives here.
 * Verified against the live portal (member.ibx.com "consumeribx" app) on 2026-11-10. When IBX changes, fix it here.
 *
 * The portal is a single-page app that talks to JSON services under https://member.ibx.com/mdx/ with a bearer token
 * the ForgeRock SDK keeps in sessionStorage. We call those services from inside the logged-in page, so the token,
 * cookies and headers are exactly what the real app sends.
 */
import type { BrowserContext, Page } from 'playwright-core';
import type { ClaimStatus, ClaimType, NetworkStatus, NormalizedClaim, PlanOption } from '../../types.js';
import { parseMoney } from '../../util/money.js';
import { toIsoDate } from '../../util/dates.js';

export const ibxConfig = {
  /** Public login page; the member portal itself lives on member.ibx.com. */
  loginUrl: 'https://www.ibx.com/login',

  /** member.ibx.com/mdx/csportal/ bounces to this ForgeRock login page when there is no session. */
  login: {
    /** Textbox labelled "User Name" (placeholder/aria-label; ids look like idToken1). */
    username: 'input[placeholder="User Name"], input[aria-label="User Name"], input[id^="idToken"][type="text"], input[name="callback_0"], input[name="username"], input#username',
    password: 'input[type="password"]',
    submit: 'button[type="submit"]:has-text("Log in"), button[type="submit"], button:has-text("Log in")',
    /** Visible after a bad password. */
    error: '[role="alert"], .error, .alert-danger, .login-error, .text-danger, #callback_errors, [id*="error" i]',
    /** On www.ibx.com/login, the members' "Log in" button. */
    memberLoginLink: 'a[href*="member.ibx.com/mdx/csportal"], a[href*="member.ibx.com"]:not([href*="portalreg"])',
    /** Accessible names, used when the CSS guesses above fail. */
    usernameRole: /user ?name/i,
  },

  /** Inside the portal: on member.ibx.com (not auth.ibx.com) and no password box in sight. */
  loggedIn: {
    urlPattern: /^https:\/\/member\.ibx\.com\/mdx\/(?!csmdxportalreg)/i,
    selector: 'a:has-text("Log out"), a:has-text("Logout"), a:has-text("Sign out"), button:has-text("Log out"), [aria-label*="log out" i]',
  },

  /** Multi-factor prompt (code entry, or the choose-how-to-get-a-code screen). */
  mfa: {
    selector:
      'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="otp" i], input[name*="otp" i], input[placeholder*="code" i], ' +
      ':text-matches("verification code|security code|one-time|send (?:me )?(?:a|the) code|text message", "i")',
  },

  claims: {
    configured: true,
    appId: 'consumeribx',
    /** sessionStorage key holding {"accessToken": ...} once logged in. */
    tokenStorageKey: 'forgerock-sdk-member_desktop_ibx_login',
    api: {
      base: 'https://member.ibx.com/mdx',
      eligibility: '/mdxmemberservices/imp-eligibility',
      planInfo: '/mdxbenefits/v2/plan-info',
      summary: '/claims/api/v3/summary',
      details: '/claims/api/v2/details',
      /** Despite the name, this is the document service: reportid "EOB" returns the PDF as base64. */
      eob: '/mdxreports/reports/getTaxYearReport',
    },
    /** The summary endpoint is asked for at most this many days at a time (the app itself uses 6 months). */
    maxRangeDays: 183,
  },
};

export interface IbxFetchContext {
  context: BrowserContext;
  page: Page;
  year: number;
  /** The portal login name; the APIs echo it back as userId. */
  username: string;
  log: (line: string) => void;
}

export interface IbxPerson {
  memberId: string;
  peId: string;
  firstName: string;
  lastName: string;
  dependentId: string;
  relationship: 'self' | 'spouse' | 'child' | 'unknown';
  agreementId: string;
}

export interface IbxProfile {
  clientId: string;
  alternateCustomerId: string;
  brand: string;
  rollupBrand: string;
  groupNumber: string;
  persons: IbxPerson[];
  subscriber: IbxPerson;
  planName: string | null;
}

type Json = Record<string, unknown>;

/** Call one of the portal's JSON services from inside the page, exactly as the app would. */
async function apiCall(ctx: IbxFetchContext, path: string, payload: unknown, selected?: { memberId: string; peId: string; clientId: string; brand: string }): Promise<Json> {
  const c = ibxConfig.claims;
  const url = c.api.base + path;
  const headers: Record<string, string> = { appid: c.appId, contenttype: 'application/json', 'selected-status': 'Active' };
  if (selected) {
    headers['selected-member-id'] = selected.memberId;
    headers['selected-peid'] = selected.peId;
    headers['selected-client-id'] = selected.clientId;
    headers['selected-brand'] = selected.brand;
    headers['rollupbrand'] = selected.brand;
  }
  const body = { payload, appId: c.appId, userId: ctx.username };
  const result = await ctx.page.evaluate(
    async ({ url, body, headers, tokenKey }) => {
      // The token can appear a few seconds after the page loads (and is refreshed in place); give it 20 s.
      let token = '';
      for (let i = 0; i < 20 && !token; i++) {
        try {
          token = JSON.parse(sessionStorage.getItem(tokenKey) || '{}').accessToken || '';
        } catch {
          /* no token yet */
        }
        if (!token) await new Promise((r) => setTimeout(r, 1000));
      }
      if (!token) return { status: 0, text: 'no access token in sessionStorage (session expired?)' };
      const r = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return { status: r.status, text: await r.text() };
    },
    { url, body, headers, tokenKey: c.tokenStorageKey },
  );
  if (result.status !== 200) throw new Error(`IBX ${path} returned HTTP ${result.status}: ${result.text.slice(0, 200)}`);
  let json: Json;
  try {
    json = JSON.parse(result.text) as Json;
  } catch {
    throw new Error(`IBX ${path} did not return JSON: ${result.text.slice(0, 200)}`);
  }
  const errorMessage = String(json.errorMessage ?? '');
  if (json.errorCode && json.errorCode !== '' && json.errorCode !== 0 && json.errorCode !== '0') {
    throw new Error(`IBX ${path} error ${String(json.errorCode)}: ${errorMessage}`);
  }
  return json;
}

function relationshipOf(code: string, desc: string): IbxPerson['relationship'] {
  const d = (desc || '').toUpperCase();
  if (code === '1' || (d.includes('INSURED') && !d.includes('OF INSURED')) || d === 'SELF' || d === 'SUBSCRIBER') return 'self';
  if (d.includes('SPOUSE')) return 'spouse';
  if (d.includes('CHILD') || d.includes('DEPENDENT')) return 'child';
  return 'unknown';
}

/** Who is on the plan, plus the ids every other call needs. */
export async function loadProfile(ctx: IbxFetchContext): Promise<IbxProfile> {
  const elig = await apiCall(ctx, ibxConfig.claims.api.eligibility, JSON.stringify({ isAudit: 'Y' }));
  const clients = ((elig.payload as Json)?.profile as Json)?.clients as Json[] | undefined;
  const client = clients?.[0];
  if (!client) throw new Error('IBX eligibility response had no client/profile data');
  const rawPersons = (client.persons as Json[]) ?? [];
  const persons: IbxPerson[] = rawPersons.map((p) => ({
    memberId: String(p.memberId ?? ''),
    peId: String(p.personEnterpriseId ?? ''),
    firstName: String(p.firstName ?? ''),
    lastName: String(p.lastName ?? ''),
    dependentId: String(p.dependentId ?? ''),
    relationship: relationshipOf(String(p.relationToInsCd ?? ''), String(p.relationToInsDsc ?? '')),
    agreementId: String(p.agreementId ?? ''),
  }));
  const subscriber = persons.find((p) => p.relationship === 'self') ?? persons[0];
  if (!subscriber) throw new Error('IBX eligibility response listed no people');
  const subscriberRaw = rawPersons[persons.indexOf(subscriber)] ?? {};
  const coverages = (subscriberRaw.coverages as Json[]) ?? [];
  const medical = coverages.find((c) => c.coverageCategoryCd === 'ME') ?? coverages[0] ?? {};
  const brand = String(subscriberRaw.brand ?? client.brand ?? 'IBC');

  let planName: string | null = null;
  try {
    const plan = await apiCall(ctx, ibxConfig.claims.api.planInfo, {}, { memberId: subscriber.memberId, peId: subscriber.peId, clientId: String(client.clientId ?? ''), brand });
    const plans = ((plan.payload as Json)?.benefitPlans as Json[]) ?? [];
    const med = plans.find((p) => String(p.type).toUpperCase().startsWith('ME')) ?? plans[0];
    planName = String(((med?.details as Json)?.planName as string) ?? '') || null;
  } catch (err) {
    ctx.log(`Could not read plan info: ${(err as Error).message}`);
  }

  return {
    clientId: String(client.clientId ?? ''),
    alternateCustomerId: String(client.alternateCustomerId ?? ''),
    brand,
    rollupBrand: String(client.rollupBrand ?? brand),
    groupNumber: String(medical.grpNbr ?? ''),
    persons,
    subscriber,
    planName,
  };
}

/** "Personal Choice PPO Silver Secure $4,750/..." -> silver; "Gold Classic" -> gold. */
export function planOptionFromName(name: string | null): PlanOption | null {
  if (!name) return null;
  if (/silver/i.test(name)) return 'silver';
  if (/gold/i.test(name)) return 'gold';
  return null;
}

function statusOf(display: string, raw: string): ClaimStatus {
  const s = `${display} ${raw}`.toLowerCase();
  if (/adjust/.test(s)) return 'adjusted';
  if (/pend|in process|received|review/.test(s)) return 'pending';
  if (/deni|reject/.test(s)) return 'denied';
  if (/approv|paid|final/.test(s)) return 'processed';
  return 'unknown';
}

function typeOf(category: string): ClaimType {
  const c = (category || '').toLowerCase();
  if (c.startsWith('med')) return 'medical';
  if (c.startsWith('pres') || c.startsWith('pharm') || c === 'rx') return 'rx';
  if (c.startsWith('dent')) return 'dental';
  if (c.startsWith('vis')) return 'vision';
  return 'unknown';
}

function selectedOf(profile: IbxProfile) {
  return { memberId: profile.subscriber.memberId, peId: profile.subscriber.peId, clientId: profile.clientId, brand: profile.brand };
}

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every claim for the plan year, for every covered person. Medical claims get a second call for the
 * line-by-line deductible / copay / coinsurance split; pharmacy claims carry their copay in the list itself.
 */
export async function listClaims(ctx: IbxFetchContext, profile?: IbxProfile): Promise<NormalizedClaim[]> {
  const prof = profile ?? (await loadProfile(ctx));
  const selected = selectedOf(prof);
  const peIds = prof.persons.map((p) => p.peId).filter(Boolean);
  const byMemberId = new Map(prof.persons.map((p) => [p.memberId, p]));

  // Ask for the year in chunks the service is comfortable with, ending today at the latest.
  const today = new Date().toISOString().slice(0, 10);
  const yearEnd = `${ctx.year}-12-31`;
  const end = today < yearEnd ? today : yearEnd;
  const ranges: Array<[string, string]> = [];
  let from = new Date(`${ctx.year}-01-01T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  while (from <= endDate) {
    const to = new Date(from.getTime() + (ibxConfig.claims.maxRangeDays - 1) * 86_400_000);
    const toClamped = to > endDate ? endDate : to;
    ranges.push([from.toISOString().slice(0, 10), toClamped.toISOString().slice(0, 10)]);
    from = new Date(toClamped.getTime() + 86_400_000);
  }

  const seen = new Map<string, Json>();
  for (const [fromDate, toDate] of ranges) {
    const res = await apiCall(ctx, ibxConfig.claims.api.summary, { peIds, fromDate, toDate }, selected);
    const claims = ((res.payload as Json)?.claims as Json[]) ?? [];
    ctx.log(`IBX claims ${fromDate} to ${toDate}: ${claims.length}`);
    for (const c of claims) seen.set(String(c.claimNumber), c);
  }

  const out: NormalizedClaim[] = [];
  for (const s of seen.values()) {
    const person = byMemberId.get(String(s.memberId));
    const claimType = typeOf(String(s.claimCategory ?? ''));
    const serviceStart = toIsoDate(s.bvndProviderServiceFromDate) ?? toIsoDate(s.claimPaidDate) ?? `${ctx.year}-01-01`;
    const serviceEnd = toIsoDate(s.bvndProviderServiceToDate) ?? serviceStart;
    const base = {
      claim_number: String(s.claimNumber),
      member_ibx_id: String(s.memberId),
      member_name: person ? titleCase(`${person.firstName} ${person.lastName}`) : titleCase(String(s.memberFullName ?? '')),
      relationship: person?.relationship ?? relationshipOf('', String(s.relationship ?? '')),
      service_start: serviceStart,
      service_end: serviceEnd,
      provider_name: titleCase(String(s.bvndProviderOrgName ?? s.drugName ?? '')) || null,
      provider_phone: null,
      claim_type: claimType,
      claim_status: statusOf(String(s.displayStatus ?? ''), String(s.claimStatus ?? '')),
      processed_date: toIsoDate(s.claimPaidDate) ?? toIsoDate(s.lastUpdatedDate) ?? null,
    };

    if (claimType === 'rx' || !s.bvndProviderId) {
      // Pharmacy: amounts are on the list row. IBX has no EOB for these, but it does issue a "Proof of Claim"
      // document (reportid POC) from the same document service, which is what gets attached in Summit.
      out.push({
        ...base,
        network_status: 'in',
        billed_cents: parseMoney(s.bvndTotalCharge),
        allowed_cents: parseMoney(s.bvndTotalCharge),
        deductible_cents: parseMoney(s.drugDeductibleAmount),
        copay_cents: parseMoney(s.copayAmount ?? s.patientPayAmount),
        coinsurance_cents: 0,
        plan_paid_cents: parseMoney(s.planPayAmount),
        patient_resp_cents: parseMoney(s.patientPayAmount ?? s.bvndProviderTotalMbrLiableAmount),
        raw: { summary: s },
        eob_ref: {
          memberId: String(s.memberId),
          claimNumber: String(s.claimNumber),
          claimBrand: String(s.claimCoverageBrand ?? s.brand ?? prof.brand),
          reportid: 'POC',
          peIds: [person?.peId ?? String(s.personEnterpriseId ?? '')],
          serviceFromDate: serviceStart,
          serviceToDate: serviceEnd,
          migrated: true,
          isNative: 'Y',
          clientId: prof.clientId,
          groupNumber: String(s.groupNumber || prof.groupNumber),
          market: '',
          lob: 'PPO',
          groupSize: 'Group',
          alternateCustomerId: prof.alternateCustomerId,
          rollupBrand: prof.rollupBrand,
        },
      });
      continue;
    }

    let lines: Json[] = [];
    let totals: Json = {};
    try {
      const det = await apiCall(
        ctx,
        ibxConfig.claims.api.details,
        {
          claimNumber: String(s.claimNumber),
          serviceFromDate: serviceStart,
          serviceToDate: serviceEnd,
          memberId: String(s.memberId),
          providerId: String(s.bvndProviderId ?? ''),
          contractId: person?.agreementId ?? prof.subscriber.agreementId,
          claimBrand: String(s.claimCoverageBrand ?? s.brand ?? prof.brand),
          claimType: String(s.claimCategory ?? 'Medical'),
        },
        selected,
      );
      totals = ((det.payload as Json)?.details as Json) ?? {};
      lines = (totals.serviceLines as Json[]) ?? [];
    } catch (err) {
      ctx.log(`Could not read details for claim ${String(s.claimNumber)}: ${(err as Error).message}`);
    }

    const sum = (key: string) => lines.reduce((acc, l) => acc + parseMoney(l[key]), 0);
    const deductible = sum('deductible');
    const copay = totals.totalCopay !== undefined ? parseMoney(totals.totalCopay) : sum('coPayment');
    const coinsurance = sum('coinsuranceAmount');
    const discount = sum('insuranceDiscount');
    const inNet = String(s.isInNetwork ?? '').toUpperCase();
    const network: NetworkStatus = inNet.startsWith('Y') || inNet === 'I' || inNet === 'IN' ? 'in' : inNet.startsWith('N') || inNet.startsWith('O') ? 'out' : discount > 0 || parseMoney(s.planPayAmount) > 0 ? 'in' : 'unknown';

    out.push({
      ...base,
      network_status: network,
      billed_cents: totals.totalCharges !== undefined ? parseMoney(totals.totalCharges) : parseMoney(s.bvndTotalCharge),
      allowed_cents: lines.length ? sum('allowedCharge') : parseMoney(s.bvndTotalCharge),
      deductible_cents: deductible,
      copay_cents: copay,
      coinsurance_cents: coinsurance,
      plan_paid_cents: totals.totalHealthPlanPaid !== undefined ? parseMoney(totals.totalHealthPlanPaid) : parseMoney(s.planPayAmount),
      patient_resp_cents: totals.totalMemberCost !== undefined ? parseMoney(totals.totalMemberCost) : parseMoney(s.bvndProviderTotalMbrLiableAmount),
      raw: {
        summary: s,
        totals: { ...totals, serviceLines: undefined },
        lines: lines.map((l) => ({ procedureCode: l.procedureCode, deductible: l.deductible, coPayment: l.coPayment, coinsuranceAmount: l.coinsuranceAmount, allowedCharge: l.allowedCharge, paidAmount: l.paidAmount, insuranceDiscount: l.insuranceDiscount, status: l.status })),
      },
      eob_ref: {
        claimNumber: String(s.claimNumber),
        claimBrand: String(s.claimCoverageBrand ?? s.brand ?? prof.brand),
        providerId: String(s.bvndProviderId ?? ''),
        memberPlatform: String(s.memberPlatform ?? 'CFI'),
        reportid: 'EOB',
        contractId: person?.agreementId ?? prof.subscriber.agreementId,
        sourceSystem: 'IMP',
        memberId: String(s.memberId),
        serviceFromDate: serviceStart,
        serviceToDate: serviceEnd,
        firstName: String(s.firstName ?? person?.firstName ?? ''),
        lastName: String(s.lastName ?? person?.lastName ?? ''),
        migrated: true,
        providerName: String(s.bvndProviderOrgName ?? ''),
        isNative: 'Y',
        clientId: prof.clientId,
        groupNumber: String(s.groupNumber || prof.groupNumber),
        market: '',
        lob: 'PPO',
        groupSize: 'Group',
        alternateCustomerId: prof.alternateCustomerId,
        rollupBrand: prof.rollupBrand,
      },
    });
  }
  out.sort((a, b) => (a.service_start < b.service_start ? -1 : a.service_start > b.service_start ? 1 : 0));
  return out;
}

/** Fetch the claim document: the EOB for medical claims, the Proof of Claim for pharmacy claims. */
export async function downloadEob(ctx: IbxFetchContext, claim: NormalizedClaim, profile?: IbxProfile): Promise<Buffer> {
  if (!claim.eob_ref) throw new Error('This claim type has no document on IBX');
  const prof = profile ?? (await loadProfile(ctx));
  const res = await apiCall(ctx, ibxConfig.claims.api.eob, claim.eob_ref, selectedOf(prof));
  const b64 = String(((res.payload as Json)?.pdf as string) ?? '');
  if (!b64) throw new Error(`IBX returned no PDF for claim ${claim.claim_number}`);
  return Buffer.from(b64, 'base64');
}
