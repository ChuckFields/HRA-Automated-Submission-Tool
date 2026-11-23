import { beforeEach, describe, expect, it } from 'vitest';
import { useInMemoryDb } from '../db/db.js';
import { listMembers, upsertMember } from '../db/repo.js';
import { autoMapClaimants, mapSummitStatus } from './syncSummit.js';

describe('Summit sync helpers', () => {
  beforeEach(() => {
    useInMemoryDb();
  });

  it('pairs members with Summit claimants, giving the lower id to the employee when names repeat', () => {
    upsertMember({ ibx_member_id: 'A', display_name: 'Pat Example', relationship: 'self' });
    upsertMember({ ibx_member_id: 'B', display_name: 'Sam Example', relationship: 'spouse' });
    upsertMember({ ibx_member_id: 'C', display_name: 'Pat Example', relationship: 'child' });
    const log = autoMapClaimants(
      [
        { value: '100001', label: 'Pat Example' },
        { value: '100002', label: 'Sam Example' },
        { value: '100003', label: 'Pat Example' },
      ],
      listMembers(),
    );
    expect(log).toHaveLength(3);
    const byId = Object.fromEntries(listMembers().map((m) => [m.ibx_member_id, m.summit_claimant_label]));
    expect(byId).toEqual({ A: '100001', B: '100002', C: '100003' });
  });

  it('maps Summit status words', () => {
    expect(mapSummitStatus('Approved')).toBe('approved');
    expect(mapSummitStatus('Pending')).toBe('pending');
    expect(mapSummitStatus('Denied')).toBe('denied');
    expect(mapSummitStatus(null)).toBe('unknown');
  });
});
