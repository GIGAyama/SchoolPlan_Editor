#!/usr/bin/env python3
"""アイコン名から、サブセットで残すべきグリフ名を決める。

なぜ要るか：
  Material Symbols は合字（"calendar_month" と打つと1つの絵に置き換わる）で描く。
  サブセットするとき、残すグリフを名前で指定するのだが、
  **アイコン名がそのままグリフ名とは限らない。**
  例：auto_fix_high は auto_fix というグリフに置換される。
  名前をそのまま渡すと、その名前のグリフが無いので何も残らず、
  画面には "auto_fix_high" という英単語が出る（実際に踏んだ）。

  そこで、まずグリフ名として存在するかを見て、無ければ合字表（GSUB）から
  置換先を引く。合字表の読み取りだけに頼らないのは、名前の復元が
  一部のアイコンで食い違うことがあったため（実測）。
  最終的な正しさは tools/verify-icons.mjs が実ブラウザで確かめる。

使い方: python3 tools/ms-ligatures.py <font> <name1,name2,...>
出力  : 「アイコン名<TAB>残すグリフ名」を1行ずつ。引けなかったものは glyph 側が空。
"""
import sys
from fontTools.ttLib import TTFont


def ligature_map(font):
    """{'calendar_month': 'glyphname', ...} を作る。"""
    gsub = font.get('GSUB')
    if gsub is None:
        return {}
    cmap = font.getBestCmap()
    char_of = {}
    for code, name in cmap.items():
        ch = chr(code)
        if ch.isascii() and (ch.islower() or ch.isdigit() or ch == '_'):
            # 1つのグリフが複数の符号位置から引ける場合、英小文字側を優先する
            char_of.setdefault(name, ch)
    out = {}
    for lookup in gsub.table.LookupList.Lookup:
        for sub in lookup.SubTable:
            if getattr(sub, 'ExtSubTable', None) is not None:  # LookupType 7
                sub = sub.ExtSubTable
            ligatures = getattr(sub, 'ligatures', None)
            if not ligatures:
                continue
            for first, ligs in ligatures.items():
                head = char_of.get(first)
                if head is None:
                    continue
                for lig in ligs:
                    tail = ''.join(char_of.get(c, '￿') for c in lig.Component)
                    if '￿' in tail:
                        continue
                    out.setdefault(head + tail, lig.LigGlyph)
    return out


def main():
    font = TTFont(sys.argv[1])
    names = [n for n in sys.argv[2].split(',') if n]
    glyphs = set(font.getGlyphOrder())
    table = ligature_map(font)
    for n in names:
        # ①グリフ名として存在すればそれを使う（いちばん確実）
        # ②無ければ合字表から置換先を引く
        g = n if n in glyphs else table.get(n, '')
        print(n + '\t' + g)


if __name__ == '__main__':
    main()
