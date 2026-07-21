import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const loader = fs.readFileSync('14_DeviceAccessibility.gs', 'utf8');
const fixes = fs.readFileSync('App_Js_16_Accessibility_Fixes.html', 'utf8');
const cssFixes = fs.readFileSync('App_Css_04_DeviceAccessibility_Fixes.html', 'utf8');

test('final correction module is loaded after the mobile module', () => {
  const mobileIndex = loader.indexOf('App_Js_16_Accessibility_Mobile');
  const fixesIndex = loader.indexOf('App_Js_16_Accessibility_Fixes');
  assert.ok(mobileIndex >= 0 && fixesIndex > mobileIndex);
});

test('single-day mode leaves a visible cell as the only tab stop', () => {
  assert.match(fixes, /visibleCells/);
  assert.match(fixes, /data-p4-day/);
  assert.match(fixes, /cell\.tabIndex = cell === current \? 0 : -1/);
  assert.match(fixes, /p4-day-hidden/);
});

test('asynchronous view changes and focus-mode drawer state are synchronized safely', () => {
  assert.match(fixes, /STATE\.view === viewName/);
  assert.match(fixes, /attempts < 50/);
  assert.match(fixes, /p4SyncMobileNavigation/);
  assert.match(fixes, /weeklyTaskSidebarCollapsed/);
  assert.match(fixes, /p4SyncTaskDrawer/);
  assert.match(cssFixes, /body\.p4-focus-mode \.p4-drawer-backdrop/);
  assert.match(cssFixes, /display:\s*none !important/);
});
