/**
 * @fileoverview Phase 4: 端末最適化・アクセシビリティのクライアント資産を遅延配信します。
 * 初期週案描画を妨げないよう、App_Js_09_Utils.html から読み込みます。
 */
function getDeviceAccessibilityClientModule() {
  return {
    css: HtmlService.createHtmlOutputFromFile('App_Css_04_DeviceAccessibility').getContent(),
    modules: [
      'App_Js_16_Accessibility_Core',
      'App_Js_16_Accessibility_Grid',
      'App_Js_16_Accessibility_Mobile'
    ].map(name => HtmlService.createHtmlOutputFromFile(name).getContent())
  };
}
