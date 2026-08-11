import { readFile, writeFile } from 'node:fs/promises';

const input = process.env.LOAD_REPORT_FILE || process.argv[2] || 'scale-report.json';
const output = process.env.CAPACITY_REPORT_FILE || 'capacity-report.md';
const apiPods = Number(process.env.CAPACITY_API_PODS || 3);
const headroom = Number(process.env.CAPACITY_HEADROOM || 0.4);
const report = JSON.parse(await readFile(input, 'utf8'));
const stable = Math.min(report.connectedAtEnd, report.connected);
const observedPerPod = Math.floor(stable / apiPods);
const safePerPod = Math.floor(observedPerPod * (1 - headroom));
const lines = [
  '# WebSocket capacity report',
  '',
  `- Requested connections: ${report.requested}`,
  `- Stable connections: ${stable}`,
  `- Success rate: ${(report.successRate * 100).toFixed(2)}%`,
  `- Connect latency p95: ${report.connectLatencyMs.p95} ms`,
  `- Recovered connections after disruption: ${report.recovered}`,
  `- Observed connections/API pod (${apiPods} pods): ${observedPerPod}`,
  `- Conservative planning limit/API pod (${Math.round(headroom * 100)}% headroom): ${safePerPod}`,
  '',
  'The conservative value is valid only for the tested instance type, message rate, and dependency topology.',
];
await writeFile(output, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
