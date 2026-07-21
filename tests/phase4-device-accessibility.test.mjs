import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const loader = fs.readFileSync('14_DeviceAccessibility.gs', 'utf8');
const utils = fs.readFileSync('App_Js_09_Utils.html', 'utf8');
const css = [
  'App_Css_04_DeviceAccessibility.html',
  'App_Css_04_DeviceAccessibility_Fixes.html'
].map(file => fs.readFileSync(file, 'utf8')).join('\n');
const core = fs.readFileSync('App_Js_16_Accessibility_Core.html', 'utf8');
const grid = fs.readFileSync('App_Js_16_Accessibility_Grid.html', 'utf8');
const mobile = fs.readFileSync('App_Js_16_Accessibility_Mobile.html', 'utf8');
const frontend = [core, grid, mobile].join('\n');
const manifest = fs.readFileSync('appsscript.json', 'utf8');

function includesAll(text, values) {
  values.forEach(value => assert.match(text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))));
}

test('Phase 4 assets are delivered after initial page load in a stable order', () => {
  includesAll(loader, [
    'App_Css_04_DeviceAccessibility',
    'App_Css_04_DeviceAccessibility_Fixes',
    'App_Js_16_Accessibility_Core',
    'App_Js_16_Accessibility_Grid',
    'App_Js_16_Accessibility_Mobile'
  ]);
  assert.match(utils, /window\.addEventListener\('load'/);
  assert.match(utils, /getDeviceAccessibilityClientModule/);
  assert.match(utils, /setTimeout\(function \(\) \{[\s\S]*?350\)/);
  assert.match(utils, /replace\(\/<\\\/\?style>\/g, ''\)/);
});

test('mobile viewport reserves safe-area space without covering the app', () => {
  assert.match(css, /height:\s*100dvh/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /height:\s*calc\(100dvh - var\(--p4-mobile-nav-h\) - var\(--p4-safe-bottom\)\)/);
  assert.match(css, /body\.p4-focus-mode #app\s*\{[\s\S]*?height:\s*100dvh/);
});

test('coarse pointer controls meet touch target and zoom-safe input sizing', () => {
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /--p4-control-min:\s*44px/);
  assert.match(css, /font-size:\s*16px !important/);
  assert.match(css, /\.grid-cell\s*\{[\s\S]*?min-height:\s*44px/);
});

test('focus visibility, skip navigation and live announcements are available', () => {
  assert.match(css, /:focus-visible/);
  assert.match(css, /\.p4-skip-link/);
  assert.match(core, /p4InjectSkipLink/);
  assert.match(core, /aria-live', 'polite/);
  assert.match(core, /aria-live', 'assertive/);
  assert.match(core, /function p4Announce/);
});

test('display preferences persist per device and expose five controls', () => {
  assert.match(core, /weeklyP4Preferences/);
  includesAll(core, ['textSize', 'contrast', 'density', 'motion', 'singleDay']);
  assert.match(core, /data-p4-text-size/);
  assert.match(core, /data-p4-contrast/);
  assert.match(core, /data-p4-density/);
  assert.match(core, /data-p4-motion/);
  assert.match(core, /端末表示・アクセシビリティ/);
});

test('contrast, reduced motion and forced-colors modes are implemented', () => {
  assert.match(css, /data-p4-contrast="high"/);
  assert.match(css, /data-p4-motion="reduce"/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /prefers-contrast:\s*more/);
  assert.match(css, /forced-colors:\s*active/);
});

test('weekly plan is exposed as an ARIA grid with row and column semantics', () => {
  assert.match(grid, /setAttribute\('role', 'grid'\)/);
  assert.match(grid, /aria-rowcount/);
  assert.match(grid, /aria-colcount/);
  assert.match(grid, /setAttribute\('role', 'columnheader'\)/);
  assert.match(grid, /setAttribute\('role', 'rowheader'\)/);
  assert.match(grid, /setAttribute\('role', 'gridcell'\)/);
  assert.match(grid, /aria-selected/);
  assert.match(grid, /cell\.tabIndex = selected \? 0 : -1/);
});

test('weekly plan keyboard model supports navigation, editing and context menus', () => {
  includesAll(grid, [
    "case 'ArrowLeft'", "case 'ArrowRight'", "case 'ArrowUp'", "case 'ArrowDown'",
    "case 'Home'", "case 'End'", "case 'Enter'", "case 'F2'", "case 'F10'"
  ]);
  assert.match(grid, /event\.shiftKey/);
  assert.match(grid, /startEditAtSelectedCell/);
  assert.match(grid, /showContextMenu/);
});

test('mobile weekly plan supports single-day tabs, swipe and horizontal-scroll opt-out', () => {
  assert.match(css, /\.p4-day-switcher/);
  assert.match(css, /\.week-grid\.p4-single-day/);
  assert.match(grid, /role', 'tablist/);
  assert.match(grid, /p4SetActiveMobileDay/);
  assert.match(grid, /P4\.prefs\.singleDay !== 'scroll'/);
  assert.match(mobile, /touchstart/);
  assert.match(mobile, /touchend/);
});

test('mobile navigation exposes primary destinations and a focus-trapped more dialog', () => {
  includesAll(mobile, [
    'p4-mobile-nav', 'p4-more-sheet', "data-view=\"plan\"", "data-view=\"task\"",
    "data-view=\"hours\"", "data-view=\"settings\"", 'aria-modal'
  ]);
  assert.match(mobile, /function p4MoreSheetKeydown/);
  assert.match(mobile, /event\.key === 'Tab'/);
  assert.match(mobile, /event\.key === 'Escape'/);
});

test('tablet task panel becomes a non-destructive overlay drawer', () => {
  assert.match(css, /@media \(max-width:\s*1180px\)/);
  assert.match(css, /\.weekly-task-sidebar\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(css, /\.p4-drawer-backdrop/);
  assert.match(mobile, /aria-controls', 'weeklyTaskSidebar/);
  assert.match(mobile, /p4SyncTaskDrawer/);
});

test('custom dialogs, toolbar menus and view shortcuts are keyboard accessible', () => {
  assert.match(core, /function p4TrapCustomModal/);
  assert.match(core, /Alt\+1/);
  assert.match(core, /var map = \{ '1': 'plan'/);
  assert.match(mobile, /p4EnhanceToolbarMenus/);
  assert.match(mobile, /ArrowDown/);
  assert.match(mobile, /ArrowUp/);
});

test('newsletter and visual viewport adapt to small screens and software keyboards', () => {
  assert.match(mobile, /window\.visualViewport/);
  assert.match(mobile, /p4ScaleNewsletter/);
  assert.match(mobile, /transform = 'scale\('/);
  assert.match(css, /\.nw-block-palette\s*\{[\s\S]*?overflow-x:\s*auto/);
});

test('Phase 4 adds no OAuth scope or backend data mutation', () => {
  assert.doesNotMatch(loader, /SpreadsheetApp|DriveApp|PropertiesService|setValue|appendRow|deleteRow/);
  assert.doesNotMatch(manifest, /auth\/drive"/);
  assert.match(manifest, /auth\/drive\.file/);
});
