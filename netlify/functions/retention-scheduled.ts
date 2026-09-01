import { retentionSummary, runRetention } from './lib/retention.ts';

export default async function handler(): Promise<void> {
  console.log(retentionSummary(await runRetention()));
}
