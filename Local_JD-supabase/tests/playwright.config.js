// End-to-end tests for the JD Blossom maintenance tracker.
// Runs the real index.html against a local Supabase stand-in (mock-supabase.mjs:
// the real migration SQL inside PGlite + an emulation of the jdb-files Edge
// Function), across desktop, laptop, iPhone, Android and iPad screen profiles.
//
//   cd tests && npm install && npx playwright install chromium webkit && npm test
//
// Set WEBKIT=1 to additionally run the phone/tablet profiles in real WebKit
// (Safari's engine) — needs `npx playwright install webkit` on your machine.
import { defineConfig, devices } from '@playwright/test';

const launchOptions = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const chromium = (name, device) => ({
  name,
  use: { ...device, browserName: 'chromium', defaultBrowserType: 'chromium', launchOptions },
});
const webkit = (name, device) => ({ name, use: { ...device, browserName: 'webkit' } });

const profiles = [
  ['desktop-1920', { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }],
  ['laptop-1366', { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 }],
  ['laptop-1280', devices['Desktop Chrome']],
  ['iphone-se', devices['iPhone SE']],
  ['iphone-14', devices['iPhone 14']],
  ['iphone-15-pro-max', devices['iPhone 15 Pro Max']],
  ['pixel-7', devices['Pixel 7']],
  ['galaxy-s9plus', devices['Galaxy S9+']],
  ['ipad-mini', devices['iPad Mini']],
];

const projects = profiles.map(([n, d]) => chromium(n, d));
if (process.env.WEBKIT) {
  for (const [n, d] of profiles) if (/iphone|ipad/.test(n)) projects.push(webkit(`${n}-webkit`, d));
}

export default defineConfig({
  testDir: './specs',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // one shared database
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }], ['json', { outputFile: 'report/results.json' }]],
  use: {
    baseURL: 'http://localhost:54321',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    timezoneId: 'Asia/Kolkata',
    locale: 'en-IN',
  },
  webServer: {
    command: 'node mock-supabase.mjs',
    url: 'http://localhost:54321/__files',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects,
});
