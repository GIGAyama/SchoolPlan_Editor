/** @fileoverview Phase 5: 教師向けAIコパイロットのクライアント資産を遅延配信。 */
function getTeacherCopilotClientModule() {
  return {
    css: HtmlService.createHtmlOutputFromFile('App_Css_05_TeacherCopilot').getContent(),
    modules: [
      'App_Js_17_TeacherCopilot_Core',
      'App_Js_17_TeacherCopilot_UI'
    ].map(name => HtmlService.createHtmlOutputFromFile(name).getContent())
  };
}
