// 印刷ページの最下端が用紙の描画領域に必ず収まることを、実ブラウザのレイアウトで確認する。
//
// 高さの測定はブラウザのレイアウトが要るので node --test では再現できない。
// このスクリプトは npm run quality には含めず、印刷まわりを触ったときに手で走らせる。
//   node tools/verify-print-fit.mjs
// Chromium の場所が既定と違うときは CHROMIUM_PATH で指定する。
import fs from 'node:fs';
import { chromium } from 'playwright';

const src=fs.readFileSync(new URL('../App_Js_03_Print.html', import.meta.url),'utf8');
const fn=(n)=>{const a=src.indexOf('function '+n+'(');if(a<0)throw new Error('no '+n);const o=src.indexOf('{',a);let d=0;for(let i=o;i<src.length;i++){if(src[i]==='{')d++;else if(src[i]==='}'&&--d===0)return src.slice(a,i+1);}};
const vf=(n)=>{const a=src.indexOf('var '+n+' = function');const o=src.indexOf('{',a);let d=0;for(let i=o;i<src.length;i++){if(src[i]==='{')d++;else if(src[i]==='}'&&--d===0)return src.slice(a,i+1)+';';}};
const consts=(src.match(/var (?:AUTOFIT_[A-Z_]+|MM_TO_PX) = [^;]+;/g)||[]).join('\n');
// buildPrintStyles_ は自己ホストの書体CSSを window 経由で取りにいく。
// Node には window が無いので空を返す形で差し替える（書体の有無は倍率の検証に影響しない）
const css=new Function('window', consts+'\n'+fn('buildPrintStyles_')+'\nreturn buildPrintStyles_;')({getSelfHostedFontCss:()=>''})({fontSize:10,autoFit:true});

const LONG='場面の移り変わりに注意して、登場人物の気持ちの変化を読み取り、自分の考えをノートにまとめて全体で交流する。';
const cell=(t)=>'<td><div class="subject">国語</div><div class="unit">「ごんぎつね」</div><div class="content">'+t+'</div></td>';

function compact(o){
  let h='<div class="page page-grow"><div class="doc-title">週間指導計画簿<div class="doc-week">第12週</div></div><table class="grid1 compact-grid">';
  h+='<tr><th class="row-header">日付<br>曜日</th>'+'<th>10/6<br>(月)</th>'.repeat(o.cols)+'</tr>';
  h+='<tr><td class="row-header">行事</td>'+'<td class="event-cell">避難訓練</td>'.repeat(o.cols)+'</tr>';
  for(let p=0;p<o.periods;p++){
    h+='<tr><td class="row-header">'+(p+1)+'</td>'+cell(o.text).repeat(o.cols)+'</tr>';
    if(p===1||p===3) h+='<tr class="recess-row"><td>中休み</td><td colspan="'+o.cols+'"></td></tr>';
  }
  h+='<tr><td class="row-header">放課後</td>'+'<td class="afterschool-cell">職員会議</td>'.repeat(o.cols)+'</tr></table>';
  if(o.summary) h+='<div class="summary-box compact-summary"><div class="summary-title">週のまとめ</div><div class="summary-text">'+o.summary+'</div></div>';
  h+='<div class="compact-bottom">';
  const half=Math.ceil(o.subs/2);
  const build=(f,t)=>{let s='<table class="stats-table"><tr><th></th><th>週時数</th><th>累計</th><th>年間進捗</th></tr>';
    for(let i=f;i<t;i++) s+='<tr><td style="background-color:#dcedc8;">国語</td><td>5</td><td>120</td><td>68%</td></tr>';
    return s+'</table>';};
  h+=build(0,half)+build(half,o.subs);
  h+='<table class="seal-table"><tr><td rowspan="2" class="seal-header" style="width:20px; font-weight:bold; vertical-align:middle; font-size:12px;">検<br><br>印</td><td class="seal-header">校長</td><td class="seal-header">副校長</td><td class="seal-header">担当者</td></tr><tr><td style="height:40px;"></td><td></td><td></td></tr></table>';
  return h+'</div></div>';
}
// 標準2ページ目: .page2-right が overflow:hidden。中で溢れても外の scrollHeight に伝わらない
function page2(o){
  let h='<div class="page"><div class="page2-layout"><div class="page2-left"><table class="grid1">';
  h+='<tr><th class="row-header">日付</th><th>10/11(土)</th></tr>';
  for(let p=0;p<6;p++) h+='<tr><td class="row-header">'+(p+1)+'</td>'+cell(o.text)+'</tr>';
  h+='</table></div><div class="page2-right">';
  if(o.todo){h+='<div class="todo-box"><div class="todo-title">やること</div><div class="todo-list-wrap">';
    for(let i=0;i<o.todo;i++) h+='<div class="todo-item">提出物の確認と保護者への連絡<span class="todo-due">10/9</span></div>';
    h+='</div></div>';}
  const half=Math.ceil(o.subs/2);
  const build=(f,t)=>{let s='<table class="stats-table"><tr><th></th><th>週時数</th><th>累計</th><th>年間進捗</th></tr>';
    for(let i=f;i<t;i++) s+='<tr><td>国語</td><td>5</td><td>120</td><td>68%</td></tr>';
    return s+'</table>';};
  h+=build(0,half)+build(half,o.subs);
  if(o.summary) h+='<div class="summary-box"><div class="summary-title">週のまとめ</div><div class="summary-text">'+o.summary+'</div></div>';
  h+='<div class="free-box">'+'<div class="line-row"></div>'.repeat(o.lines||10)+'</div>';
  h+='<table class="seal-table"><tr><td rowspan="2" class="seal-header" style="width:20px; font-weight:bold; vertical-align:middle; font-size:12px;">検<br><br>印</td><td class="seal-header">校長</td><td class="seal-header">副校長</td><td class="seal-header">担当者</td></tr><tr><td style="height:40px;"></td><td></td><td></td></tr></table>';
  return h+'</div></div></div>';
}

const OLD_FIT = `var fitPagesToPrintArea = function(){
  var fdoc=printFrame.contentWindow.document, pages=fdoc.querySelectorAll('.page');
  for(var pi=0;pi<pages.length;pi++){var page=pages[pi];
    if(!page.querySelector('.page-fit')){var inner=fdoc.createElement('div');inner.className='page-fit';
      while(page.firstChild){inner.appendChild(page.firstChild);}page.appendChild(inner);}
    var fit=page.querySelector('.page-fit');
    var canGrow=page.className.indexOf('page-grow')!==-1;
    fit.style.height=canGrow?'auto':'100%';
    var avail=page.clientHeight;
    var measureAt=function(s){fit.style.transform='';fit.style.width=(100/s)+'%';return fit.scrollHeight;};
    var scale=pickFitScale_(measureAt,avail,AUTOFIT_MIN_SCALE,canGrow?AUTOFIT_MAX_SCALE:1);
    fit.style.transform='';fit.style.width='100%';
    if(Math.abs(scale-1)>0.005){fit.style.width=(100/scale)+'%';fit.style.transform='scale('+scale+')';}
  }};`;

// Chromium の実体が別の場所に置かれている環境（CI コンテナ等）向け
const exe=process.env.CHROMIUM_PATH || undefined;
const b=await chromium.launch(exe?{executablePath:exe}:{});
const pg=await b.newPage({viewport:{width:900,height:1200}});

async function run(body, mode){
  await pg.setContent('<!doctype html><html><head><meta charset="utf-8">'+css+'</head><body style="width:190mm;margin:0">'+body+'</body></html>');
  return pg.evaluate(function(a){
    var pick=a[0], fitSrc=a[1], cs=a[2], cbp=a[3];
    new Function('printFrame', cs+'\n'+cbp+'\n'+pick+'\n'+fitSrc+'\nfitPagesToPrintArea();')({contentWindow:{document:document}});
    var page=document.querySelector('.page'), fit=page.querySelector('.page-fit');
    var t=getComputedStyle(fit).transform;
    var sc=t==='none'?1:parseFloat(t.split('(')[1].split(',')[0]);
    // 真の最下端（変換後の実座標）
    var top=page.getBoundingClientRect().top, bot=top, who='';
    fit.querySelectorAll('*').forEach(function(el){var r=el.getBoundingClientRect();
      if(r.width===0&&r.height===0)return; if(r.bottom>bot){bot=r.bottom;who=el.className||el.tagName;}});
    return {sc:sc, real:bot-top, avail:page.clientHeight, who:who};
  },[fn('pickFitScale_'), mode==='new'?vf('fitPagesToPrintArea'):OLD_FIT, consts, fn('contentBottomPx_')]);
}

const cases=[
 ['compact 教科10 通常',      compact({cols:5,periods:6,subs:10,text:LONG,summary:''})],
 ['compact 土日+まとめ長文',  compact({cols:7,periods:6,subs:12,text:LONG,summary:'今週の振り返りとして、'.repeat(40)})],
 ['compact 詰込み',           compact({cols:7,periods:7,subs:14,text:LONG.repeat(3),summary:'運動会の練習が中心。'.repeat(20)})],
 ['page2 Todo多数+まとめ長文', page2({subs:12,todo:20,text:LONG,summary:'今週の振り返りとして、'.repeat(50),lines:14})],
 ['page2 教科16+Todo30',      page2({subs:16,todo:30,text:LONG,summary:'振り返り。'.repeat(30),lines:20})],
];
console.log('ケース                        | 変更前: 倍率  下端/紙        | 変更後: 倍率  下端/紙');
console.log('-'.repeat(100));
let bad=0;
for(const [name,body] of cases){
  const o=await run(body,'old'), n=await run(body,'new');
  const ov=(r)=>{const d=r.real-r.avail; return (d>1? '★+'+d.toFixed(0)+'px はみ出し':'OK          ');};
  if(n.real-n.avail>1) bad++;
  console.log(name.padEnd(28)+'| '+o.sc.toFixed(3)+'  '+o.real.toFixed(0).padStart(4)+'/'+o.avail+'px '+ov(o)+' | '+n.sc.toFixed(3)+'  '+n.real.toFixed(0).padStart(4)+'/'+n.avail+'px '+ov(n));
}
await b.close();
console.log('\n変更後にはみ出したケース: '+bad);
process.exit(bad?1:0);
