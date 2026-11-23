# HRA Automated Submission Tool

A small local app for Flexible Informatics employees on the MERP (HRA) plan. It pulls your Explanation of Benefits
(EOBs) from the IBX member portal, works out which ones qualify for HRA reimbursement and how much to expect, and
prefills the claim form in Alera's Summit portal so all you have to do is check it and click Submit.

Everything stays on your computer: the database, the EOB PDFs, your encrypted logins and the browser sessions.

## Using the packaged app (no install)

1. Double-click `HRA-Submission-Tool.exe`. Your browser opens the dashboard at `http://127.0.0.1:3210`.
2. On the **Setup** tab enter your IBX and Summit logins. They save as you type.
3. Click **Fetch claims from IBX**. An Edge window opens; if IBX asks for a verification code, type it there.
4. Click **Sync Summit submissions**. Enter the emailed or texted code when asked. This also detects your plan.
5. The **Claims** tab unlocks. For each eligible EOB click **Prefill**, check the filled-in form in the browser
   window, and click Summit's **Submit Claim** button yourself. The app never submits for you.

Data lives in `%LOCALAPPDATA%\HRA-Submission-Tool`. Delete that folder to start over.

## Developing

```
npm install
npm run dev            # http://127.0.0.1:3210, reloads on change
npm test               # eligibility engine tests
npm run discover:ibx   # record the IBX portal's network traffic while you browse (see src/portals/ibx/config.ts)
npm run discover:summit
npm run build          # dist/HRA-Submission-Tool.exe
```

Portal-specific selectors and endpoints live only in `src/portals/ibx/config.ts` and `src/portals/summit/config.ts`.
