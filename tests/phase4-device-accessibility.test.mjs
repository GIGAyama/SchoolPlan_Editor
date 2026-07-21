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
const manifest = fs.readFileSync('appsscript.json', 'utf8');

function includesAll(text, values) {
  values.forEach(value => assert.ok(text.includes(value), `missing implementation contract: ${value}`));
}

test('Phase 4 assets are delivered after initial page load in a stable order', () => {
  includesAll(loader, [
    'App_Css_04_DeviceAccessibility',
    'App_Css_04_DeviceAccessibility_Fixes',
    'App_Js_16_Accessibility_Core',
    'App_Js_16_Accessibility_Grid',
    'App_Js_16_Accessibility_Mobile',
    'App_Js_16_Accessibility_Fixes'
  ]);
  includesAll(utils, [
    "window.addEventListener('load'",
    'getDeviceAccessibilityClientModule',
    '}, 350);',
    "replace(/<\\/?style>/g, '')"
  ]);
});

test('mobile viewport reserves safe-area space without covering the app', () => {
  includesAll(css, [
    'height: 100dvh;',
    'env(safe-area-inset-bottom, 0px)',
    'height: calc(100dvh - var(--p4-mobile-nav-h) - var(--p4-safe-bottom));',
    'body.p4-focus-mode #app'
  ]);
});

test('coarse pointer controls meet touch target and zoom-safe input sizing', () => {
  includesAll(css, [
    '@media (pointer: coarse)',
    '--p4-control-min: 44px;',
    'font-size: 16px !important;',
    'min-height: 44px;'
  ]);
});

test('focus visibility, skip navigation and live announcements are available', () => {
  includesAll(css, [':focus-visible', '.p4-skip-link']);
  includesAll(core, [
    'p4InjectSkipLink',
    "setAttribute('aria-live', 'polite')",
    "setAttribute('aria-live', 'assertive')",
    'function p4Announce'
  ]);
});

test('display preferences persist per device and expose five controls', () => {
  includesAll(core, [
    'weeklyP4Preferences',
    'textSize', 'contrast', 'density', 'motion', 'singleDay',
    'data-p4-text-size', 'data-p4-contrast', 'data-p4-density', 'data-p4-motion',
    '端末表示・アクセシビリティ'
  ]);
});

test('contrast, reduced motion and forced-colors modes are implemented', () => {
  includesAll(css, [
    'data-p4-contrast="high"',
    'data-p4-motion="reduce"',
    'prefers-reduced-motion: reduce',
    'prefers-contrast: more',
    'forced-colors: active'
  ]);
});

test('weekly plan is exposed as an ARIA grid with row and column semantics', () => {
  includesAll(grid, [
    "grid.setAttribute('role', 'grid')",
    "setAttribute('role', 'columnheader')",
    "setAttribute('role', 'rowheader')",
    "cell.setAttribute('role', 'gridcell')",
    'aria-rowcount', 'aria-colcount', 'aria-selected',
    'cell.tabIndex = selected ? 0 : -1'
  ]);
});

test('weekly plan keyboard model supports navigation, editing and context menus', () => {
  includesAll(grid, [
    "case 'ArrowLeft'", "case 'ArrowRight'", "case 'ArrowUp'", "case 'ArrowDown'",
    "case 'Home'", "case 'End'", "case 'Enter'", "case 'F2'", "case 'F10'",
    'event.shiftKey', 'startEditAtSelectedCell', 'showContextMenu'
  ]);
});

test('mobile weekly plan supports single-day tabs, swipe and horizontal-scroll opt-out', () => {
  includesAll(css, ['.p4-day-switcher', '.week-grid.p4-single-day']);
  includesAll(grid, [
    "setAttribute('role', 'tablist')",
    'p4SetActiveMobileDay',
    "P4.prefs.singleDay !== 'scroll'"
  ]);
  includesAll(mobile, ["addEventListener('touchstart'", "addEventListener('touchend'"]);
});

test('mobile navigation exposes primary destinations and a focus-trapped more dialog', () => {
  includesAll(mobile, [
    'p4-mobile-nav', 'p4-more-sheet',
    'data-view="plan"', 'data-view="task"', 'data-view="hours"', 'data-view="settings"',
    "setAttribute('aria-modal', 'true')",
    'function p4MoreSheetKeydown',
    "event.key === 'Tab'", "event.key === 'Escape'"
  ]);
});

test('tablet task panel becomes a non-destructive overlay drawer', () => {
  includesAll(css, [
    '@media (max-width: 1180px)',
    '.weekly-task-sidebar',
    'position: fixed;',
    '.p4-drawer-backdrop'
  ]);
  includesAll(mobile, [
    "setAttribute('aria-controls', 'weeklyTaskSidebar')",
    'p4SyncTaskDrawer'
  ]);
});

test('custom dialogs, toolbar menus and view shortcuts are keyboard accessible', () => {
  includesAll(core, [
    'function p4TrapCustomModal',
    'event.altKey',
    "var map = { '1': 'plan', '2': 'task', '3': 'events', '4': 'hours', '5': 'settings' }"
  ]);
  includesAll(mobile, ['p4EnhanceToolbarMenus', "event.key === 'ArrowDown'", "event.key === 'ArrowUp'"]);
});

test('newsletter and visual viewport adapt to small screens and software keyboards', () => {
  includesAll(mobile, [
    'window.visualViewport',
    'p4ScaleNewsletter',
    "page.style.transform = 'scale('"
  ]);
  includesAll(css, ['.nw-block-palette', 'overflow-x: auto;']);
});

test('Phase 4 adds no OAuth scope or backend data mutation', () => {
  ['SpreadsheetApp', 'DriveApp', 'PropertiesService', 'setValue', 'appendRow', 'deleteRow']
    .forEach(token => assert.ok(!loader.includes(token), `unexpected backend mutation API: ${token}`));
  assert.ok(!manifest.includes('https://www.googleapis.com/auth/drive"'));
  assert.ok(manifest.includes('https://www.googleapis.com/auth/drive.file'));
});
