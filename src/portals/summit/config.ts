/**
 * Everything the Alera "Summit" (DataPath Consumer Portal, v26.11) adapter knows about the site lives here.
 * Verified against the live portal on 2026-11-10. When the portal changes, this is the file to fix.
 */
import type { Page } from 'playwright-core';
import { parseMoney } from '../../util/money.js';
import { toIsoDate } from '../../util/dates.js';
import type { Benefit, PlanOption } from '../../types.js';

export const summitConfig = {
  /** Paths relative to the summit_base_url setting. */
  paths: {
    home: '/',
    login: '/login',
    claimForm: '/Transactions/EnterClaim',
    activity: '/Transactions',
  },

  /** The portal's JSON back end; the transactions list is read from here when the page loads it. */
  api: {
    transactions: /\/api\/ppservice\/GetTransactions/i,
  },

  login: {
    /** Single-step form: username + password + "Login". */
    username: 'input[placeholder="Enter your username"], input[name*="user" i], input[id*="user" i]',
    password: 'input[type="password"]',
    submit: 'button:has-text("Login"), button[type="submit"]',
    error: '[role="alert"], .error, .alert-danger, .text-danger, .validation-summary-errors, .invalid-feedback',
    /**
     * After the password, Summit asks whether to email or text a verification code, then for the code.
     * Any of these visible means it's the user's turn.
     */
    mfa:
      'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i], input[placeholder*="code" i], ' +
      'input[name*="otp" i], input[type="radio"][value*="email" i], input[type="radio"][value*="sms" i], input[type="radio"][value*="text" i], ' +
      ':text-matches("verification code|send (?:me )?(?:a|the) code|email me|text me|one-time", "i")',
  },

  /** Inside the portal the main nav is present and no password box is. */
  loggedIn: { selector: 'a[href="/Transactions"], button:has-text("Profile")' },

  /**
   * Claim form, from the live page. Labels are not associated with their controls, so fields are found as
   * "the first <tag> after the <label> whose text starts with X".
   */
  form: {
    fileInput: 'input[type="file"]',
    labels: {
      claimant: { label: 'Claimant', tag: 'select' },
      serviceStart: { label: 'Service Start', tag: 'input' },
      serviceEnd: { label: 'Service End', tag: 'input' },
      amount: { label: 'Amount', tag: 'input' },
      provider: { label: 'Provider/Merchant', tag: 'input' },
      category: { label: 'Service Category', tag: 'select' },
      code: { label: 'Service Code', tag: 'select' },
      description: { label: 'Service Description', tag: 'textarea' },
      account: { label: 'Requested Account', tag: 'select' },
      notes: { label: 'Notes', tag: 'textarea' },
    },
    terms: 'input[type="checkbox"]',
    /** We never click this; it only tells us the form has rendered. */
    submitButton: 'button[type="submit"]:has-text("Submit Claim"), button:has-text("Submit Claim")',
  },

  /**
   * Service Category and Service Code option VALUES for each MERP benefit, from the live dropdowns.
   * The Requested Account dropdown fills itself in from the category once the dates are entered
   * (Deductible -> the HRA account, Copays -> the "Additional CoPay Reimb" account).
   */
  benefits: {
    deductible: { categoryValue: '7', categoryLabel: 'Deductible', defaultCodeValue: '22', defaultCodeLabel: 'Medical Service' },
    copay: { categoryValue: '11', categoryLabel: 'Copays', defaultCodeValue: '44', defaultCodeLabel: 'copay% reimbursement' },
  } satisfies Record<Benefit, { categoryValue: string; categoryLabel: string; defaultCodeValue: string; defaultCodeLabel: string }>,

  /** Pharmacy claims use this code under either category (seen in both dropdowns). */
  rxCode: { value: '18', label: 'RX/Pharmacy' },

  /**
   * The home page names the HRA account after the MERP option, e.g. "Option 2 - 3750/7500".
   * Option 1 is the Gold $2,500 plan, Option 2 the Silver $4,750 plan.
   */
  planOptionFromText(text: string): PlanOption | null {
    if (/option\s*2\b|3750\s*\/\s*7500/i.test(text)) return 'silver';
    if (/option\s*1\b|1500\s*\/\s*3000/i.test(text)) return 'gold';
    return null;
  },

  /** Map a Summit transaction's Service Category text to our benefit. */
  benefitOfCategory(category: string | null): Benefit | null {
    const c = (category ?? '').toLowerCase();
    if (c.includes('copay')) return 'copay';
    if (c.includes('deductible')) return 'deductible';
    return null;
  },

  /**
   * After the user clicks Submit: the form page goes away or the portal shows a success message.
   * Returns the Summit claim number when visible, '' when confirmed without one, null when not confirmed.
   */
  async detectConfirmation(page: Page, formUrlPart = '/Transactions/EnterClaim'): Promise<string | null> {
    const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
    const m = text.match(/claim (?:number|#)\s*:?\s*(\d{5,})/i);
    if (/submitted successfully|has been submitted|successfully submitted|thank you for (?:submitting|your submission)/i.test(text)) {
      return m ? m[1] : '';
    }
    if (!page.url().toLowerCase().includes(formUrlPart.toLowerCase()) && /claim/i.test(text)) return m ? m[1] : '';
    return null;
  },
};

export interface SummitActivityRow {
  summit_claim_id: string | null;
  claimant_label: string | null;
  service_date: string | null;
  amount_cents: number | null;
  status: string | null;
  posted_date: string | null;
  raw: Record<string, string>;
}

/**
 * Read the Transactions table. The page is a React app whose rows expand to a "Transaction Details" block;
 * we expand everything and parse the plain text, which looks like:
 *   03/16/2026 / MERP / Manual Claim / Approved / $40.00 / Transaction Details / Plan Name: / ... / Processed Date: / 04/16/2026
 */
export async function scrapeActivity(page: Page, log: (l: string) => void): Promise<SummitActivityRow[]> {
  const rowsPerPage = page.locator('xpath=//label[contains(normalize-space(.), "Rows per page")]/following::select[1]').first();
  if (await rowsPerPage.isVisible().catch(() => false)) {
    await rowsPerPage.selectOption('100').catch(() => undefined);
    await page.waitForTimeout(1500);
  }
  const expandAll = page.getByRole('button', { name: /expand all details/i }).first();
  if (await expandAll.isVisible().catch(() => false)) {
    await expandAll.click().catch(() => undefined);
    await page.waitForTimeout(1500);
  }
  const text = await page.locator('main').innerText();
  const rows = parseActivityText(text);
  log(`Parsed ${rows.length} transaction rows from the Summit page`);
  return rows;
}

/** Exported for tests. */
export function parseActivityText(text: string): SummitActivityRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows: SummitActivityRow[] = [];
  const isDate = (s: string) => /^\d{2}\/\d{2}\/\d{4}$/.test(s);
  let i = 0;
  while (i < lines.length) {
    // A row header: date, account, type, status, amount (five consecutive lines).
    if (isDate(lines[i]) && i + 4 < lines.length && /^\$/.test(lines[i + 4])) {
      const raw: Record<string, string> = {
        Date: lines[i], Account: lines[i + 1], Type: lines[i + 2], Status: lines[i + 3], Amount: lines[i + 4],
      };
      i += 5;
      // Details follow until the next row header or the end of the table.
      while (i < lines.length && !(isDate(lines[i]) && i + 4 < lines.length && /^\$/.test(lines[i + 4]))) {
        const l = lines[i];
        if (/^(Showing|Page \d|Rows per page|My Expenses)/i.test(l)) break;
        if (l.endsWith(':') && i + 1 < lines.length) {
          raw[l.slice(0, -1).trim()] = lines[i + 1];
          i += 2;
          continue;
        }
        if (/^Attached Receipt/i.test(l) && i + 1 < lines.length) {
          raw.Attachment = lines[i + 1];
          i += 2;
          continue;
        }
        i += 1;
      }
      rows.push({
        summit_claim_id: raw['Claim Number'] ?? null,
        claimant_label: raw.Claimant ?? null,
        service_date: toIsoDate(raw['Service Start'] ?? raw.Date),
        amount_cents: raw['Transaction Amount'] || raw.Amount ? parseMoney(raw['Transaction Amount'] ?? raw.Amount) : null,
        status: raw.Status ?? null,
        posted_date: toIsoDate(raw['Processed Date'] ?? raw.Date),
        raw,
      });
      continue;
    }
    i += 1;
  }
  return rows;
}
