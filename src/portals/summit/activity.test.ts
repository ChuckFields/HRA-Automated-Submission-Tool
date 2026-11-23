import { describe, expect, it } from 'vitest';
import { parseActivityText, summitConfig } from './config.js';

const SAMPLE = `Transactions
Show Filters
Export
Print
Show Transactions requiring your action
Rows per page:
10
Date
Account
Type
Status
Amount
03/16/2026
MERP
Manual Claim
Approved
$40.00
Transaction Details
Plan Name:
Medical Expense Reimbursement Plan
Claimant:
Example, Sam
Claim Number:
9000001
Payment Method:
ACH
Transaction Amount:
$40.00
Approved Amount:
$40.00
Additional Information
Service Category:
Copays
Service Code:
Copay% reimbursement
Service Start:
03/16/2026
Service End:
03/16/2026
Processed Date:
04/16/2026
03/23/2026
MERP
Manual Claim
Approved
$250.00
Transaction Details
Plan Name:
Medical Expense Reimbursement Plan
Claimant:
Example, Sam
Claim Number:
9000002
Payment Method:
ACH
Transaction Amount:
$250.00
Approved Amount:
$250.00
Additional Information
Service Category:
Copays
Service Code:
Copay% reimbursement
Service Start:
03/23/2026
Service End:
03/23/2026
Processed Date:
04/16/2026
Attached Receipt / EOB
EOB.pdf
Showing 1-2 of 2
Page 1 of 1
My Expenses by Category`;

describe('Summit transactions parser', () => {
  it('parses expanded rows from the live page layout', () => {
    const rows = parseActivityText(SAMPLE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      summit_claim_id: '9000001', claimant_label: 'Example, Sam', service_date: '2026-03-16', amount_cents: 4000, status: 'Approved', posted_date: '2026-04-16',
    });
    expect(rows[0].raw['Service Category']).toBe('Copays');
    expect(rows[1].summit_claim_id).toBe('9000002');
    expect(rows[1].amount_cents).toBe(25000);
    expect(rows[1].raw.Attachment).toBe('EOB.pdf');
    expect(summitConfig.benefitOfCategory(rows[1].raw['Service Category'])).toBe('copay');
  });
});
